import os
import time
import json
import shutil
import threading
import sys
import re
import math
import random
import asyncio
import httpx
from pathlib import Path
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse

from .ui_helpers import get_progress_bar
from .utils import sanitize_filename, get_filename_from_url, get_album_name, VIDEO_EXTENSIONS, ARCHIVE_EXTENSIONS
from .site_parser import get_file_urls, get_async_bunkrr_url, get_async_cdn_url
from .download_manager import DownloadManager

class BunkrScraperCore:
    """Core scraper orchestration engine - Modernized for Async Performance."""

    _MIN_VALID_BYTES = 1024 * 50   # 50 KB

    def __init__(self, album_url, output_dir="downloads", progress_callback=None, max_workers=1, max_retries=5, links_only=False, no_subdir=False):
        self.album_url         = album_url
        self.output_dir        = output_dir
        self.progress_callback = progress_callback
        self.max_workers       = max_workers
        self.max_retries       = max_retries
        self.links_only        = links_only
        self.no_subdir         = no_subdir
        self._print_lock       = threading.Lock()
        
        self.cancel_flags      = {}
        self.slot_events       = {} # url -> asyncio.Event
        self.loop              = None
        
        if self.progress_callback:
            self._stdin_thread = threading.Thread(target=self._stdin_listener, daemon=True)
            self._stdin_thread.start()

        # Download manager state
        self.download_mgr = None

        self.client = httpx.AsyncClient(
            headers={
                "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Referer":         "https://bunkr.cr/",
            },
            timeout=20.0,
            follow_redirects=True
        )

    def _stdin_listener(self):
        """Asynchronously listens to stdin for Skip/Cancel injects from Electron."""
        for line in sys.stdin:
            try:
                data = json.loads(line)
                if data.get("action") == "skip" and "filename" in data:
                    self.cancel_flags[data["filename"]] = True
                elif data.get("action") == "grant_slot" and "url" in data:
                    url = data["url"]
                    if self.loop and url in self.slot_events:
                        self.loop.call_soon_threadsafe(self.slot_events[url].set)
            except:
                pass

    def _emit(self, progress_type, message, **kw):
        """Send progress events to the callback."""
        if self.progress_callback:
            with self._print_lock:
                self.progress_callback(json.dumps({
                    "type": progress_type,
                    "message": message, 
                    **kw
                }))

    def _safe_print(self, *args, **kwargs):
        """Thread-safe print."""
        with self._print_lock:
            kwargs.setdefault('flush', True)
            print(*args, **kwargs)

    def _cancel_check(self, filename):
        """Check if a file download has been cancelled."""
        return self.cancel_flags.get(filename, False)

    def _progress_callback(self, filename, data):
        """Forward progress from DownloadManager to UI."""
        self._emit("file_progress", f"Downloading {filename}",
                   filename=filename, **data)


    async def _process_file(self, idx, file_info, total, album_dir, overall_start):
        """Process a single file: Resolution, Slot Handshake, Download (Async)."""
        file_url = file_info["url"]
        provided_name = file_info.get("name")
        self._emit("status", f"Processing {idx}/{total}")

        for attempt in range(1, self.max_retries + 1):
            try:
                # Step 1: Resolve Bunkrr URL
                bunkrr_url = await get_async_bunkrr_url(self.client, file_url)
                if not bunkrr_url:
                    if attempt < self.max_retries:
                        await asyncio.sleep(2 * attempt)
                        continue
                    slug = file_url.split("/")[-1]
                    self._emit("file_error", f"Resolution Failed: {slug}", filename=f"File_{slug}", reason="error", fileurl=file_url, attempt=attempt, is_final=True)
                    return "error"

                # Step 2: Resolve CDN URL
                cdn_url = await get_async_cdn_url(self.client, bunkrr_url)
                if not cdn_url:
                    if attempt < self.max_retries:
                        await asyncio.sleep(2 * attempt)
                        continue
                    slug = file_url.split("/")[-1]
                    self._emit("file_error", f"Source Hidden: {slug}", filename=f"File_{slug}", reason="error", fileurl=file_url, attempt=attempt, is_final=True)
                    return "error"

                actual_cdn_filename = get_filename_from_url(cdn_url)
                cdn_ext = Path(actual_cdn_filename).suffix.lower()
                
                filename = sanitize_filename(provided_name) if provided_name else actual_cdn_filename
                if provided_name and not filename.lower().endswith(cdn_ext) and cdn_ext:
                    current_ext = Path(filename).suffix.lower()
                    if current_ext in VIDEO_EXTENSIONS or current_ext in ARCHIVE_EXTENSIONS:
                        filename = f"{Path(filename).stem}{cdn_ext}"
                    else:
                        filename = f"{filename}{cdn_ext}"

                filepath = album_dir / filename
                ext = Path(filename).suffix.lower()

                # SKIP LOGIC: If a file is in the main album folder, it is considered complete
                if filepath.exists() and filepath.is_file():
                    if filepath.stat().st_size >= self._MIN_VALID_BYTES:
                        self._emit("status", f"Existing: {filename}")
                        self._emit("file_start", f"Detecting: {filename}", filename=filename, fileurl=cdn_url)
                        self._emit("file_complete", f"Finished (Existing): {filename}", filename=filename, fileurl=cdn_url)
                        return "ok"

                if ext not in VIDEO_EXTENSIONS and ext not in ARCHIVE_EXTENSIONS:
                    self._emit("status", f"Silent Skip: {filename}")
                    self._emit("file_error", f"Skipped: {filename}", filename=filename, reason="skipped", fileurl=file_url, attempt=attempt, is_final=True)
                    return "skipped"

                # EMIT START SIGNAL FOR UI
                self._emit("file_start", f"Starting: {filename}", filename=filename, fileurl=cdn_url, bunkr_url=file_url)

                # GLOBAL SLOT HANDSHAKE
                slot_ev = asyncio.Event()
                self.slot_events[file_url] = slot_ev
                
                try:
                    self._emit("request_slot", f"Waiting for slot: {filename}", filename=filename, url=file_url)
                    await slot_ev.wait()
                    
                    # Start Download (Native)
                    result = await self.download_mgr.download_file(
                        url=cdn_url,
                        filename=filename,
                        save_path=filepath,
                        progress_callback=lambda d: self._progress_callback(filename, d),
                        cancel_check=lambda: self._cancel_check(filename),
                        attempt=attempt
                    )
                finally:
                    # ALWAYS release the slot, even if the download failed, was cancelled, 
                    # or never even started (e.g. if wait() was interrupted).
                    # This prevents 'stuck' slots in Electron's SlotManager.
                    self._emit("release_slot", f"Releasing slot: {filename}", filename=filename, url=file_url)
                    if file_url in self.slot_events:
                        del self.slot_events[file_url]

                if result == "ok":
                    self._emit("file_complete", f"Done: {filename}", filename=filename, fileurl=cdn_url)
                    return "ok"
                elif result == "skipped":
                    self._emit("file_error", f"Skipped: {filename}", filename=filename, reason="skipped", fileurl=file_url, attempt=attempt, is_final=True)
                    return "skipped"
                
                if attempt < self.max_retries:
                    await asyncio.sleep(2 * attempt)
                    continue

                self._emit("file_error", f"Failed: {filename}", filename=filename, reason="error", fileurl=file_url, attempt=attempt, is_final=(attempt == self.max_retries))
                return "error"

            except Exception as e:
                if attempt < self.max_retries: 
                    await asyncio.sleep(2 * attempt)
                    continue
                return "error"

    async def _async_scrape(self):
        """Async core of the scraping process."""
        self.loop = asyncio.get_running_loop()
        
        async with DownloadManager(max_retries=self.max_retries) as self.download_mgr:
            # Initial Page Retrieval
            try:
                r = await self.client.get(self.album_url)
                html = r.text
                soup = BeautifulSoup(html, "html.parser")
            except Exception as e:
                self._emit("status", f"Failed to load album: {e}")
                return {"success": False, "error": f"Failed to load album: {e}"}

            album_name = get_album_name(soup, self.album_url)
            self._emit("album_info", f"Album: {album_name}", name=album_name)

            # Discovery phase (Pages)
            file_urls = get_file_urls(html, self.album_url)
            
            total = len(file_urls)
            if total == 0:
                return {"success": True, "message": "No files found", "total": 0}

            # Shuffle the file list so the app downloads different files randomly 
            # across restarts, preventing localized CDN throttling.
            random.shuffle(file_urls)

            self._emit("found_files", f"Found {total} files", total=total)
            
            if self.no_subdir:
                album_dir = Path(self.output_dir)
            else:
                album_dir = Path(self.output_dir) / sanitize_filename(album_name)
            
            album_dir.mkdir(parents=True, exist_ok=True)

            overall_start = time.time()
            
            # Parallel processing with Semaphore
            sem = asyncio.Semaphore(self.max_workers)
            
            async def sem_task(idx, f):
                async with sem:
                    return await self._process_file(idx, f, total, album_dir, overall_start)

            tasks = [sem_task(i+1, f) for i, f in enumerate(file_urls)]
            results = await asyncio.gather(*tasks)
            
            self._emit("album_complete", "Finished Album")
            return {"success": True, "total": total, "results": results}

    def scrape(self):
        """Entry point for the scraper (Sync wrapper)."""
        try:
            return asyncio.run(self._async_scrape())
        except KeyboardInterrupt:
            return {"success": False, "error": "Cancelled"}
        except Exception as e:
            return {"success": False, "error": str(e)}
        finally:
            if self.progress_callback:
                self._stdin_thread.join(timeout=0.1)
