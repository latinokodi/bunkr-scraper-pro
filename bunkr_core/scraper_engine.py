import os
import time
import json
import shutil
import requests
import threading
import sys
import re
import math
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse

from .ui_helpers import get_progress_bar
from .utils import sanitize_filename, get_filename_from_url, get_album_name
from .site_parser import get_file_urls, get_bunkrr_url, get_cdn_url
from .bin_fetcher import get_aria2_path
from .aria2_manager import Aria2Manager

class BunkrScraperCore:
    """Core scraper orchestration engine."""

    _MIN_VALID_BYTES = 1024 * 50   # 50 KB

    def __init__(self, album_url, output_dir="downloads", progress_callback=None, max_workers=1, max_retries=10, links_only=False):
        self.album_url         = album_url
        self.output_dir        = output_dir
        self.progress_callback = progress_callback
        self.max_workers       = max_workers
        self.max_retries       = max_retries
        self.links_only        = links_only
        self._print_lock       = threading.Lock()
        
        self.cancel_flags      = {}
        if self.progress_callback:
            self._stdin_thread = threading.Thread(target=self._stdin_listener, daemon=True)
            self._stdin_thread.start()

        # Aria2 downloader state
        self.aria2_mgr         = None
        self.aria2_api         = None
        self._aria2_lock      = threading.Lock()

        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer":         "https://bunkr.cr/",
        })

    def _stdin_listener(self):
        """Asynchronously listens to stdin for Skip/Cancel injects from Electron."""
        for line in sys.stdin:
            try:
                data = json.loads(line)
                if data.get("action") == "skip" and "filename" in data:
                    self.cancel_flags[data["filename"]] = True
            except:
                pass

    def _safe_print(self, *args, **kwargs):
        """Thread-safe print for GUI/CLI."""
        with self._print_lock:
            kwargs.setdefault('flush', True)
            print(*args, **kwargs)

    def _ensure_aria2(self):
        """Ensures the aria2c daemon is running and API is connected."""
        with self._aria2_lock:
            if self.aria2_api:
                return True
            
            try:
                binary = get_aria2_path()
                if not binary:
                    self._emit("status", "Error: aria2c.exe missing. Please check your bin folder.")
                    return False
                
                self.aria2_mgr = Aria2Manager(binary)
                self.aria2_api = self.aria2_mgr.start_daemon() # Returns api instance
                return True
            except Exception as e:
                self._emit("status", f"Error initializing aria2: {e}")
                return False

    def _emit(self, progress_type, message, **kw):
        """Send progress events to the callback (typically JSON for Electron)."""
        if self.progress_callback:
            with self._print_lock:
                self.progress_callback(json.dumps({
                    "type": progress_type,
                    "message": message, 
                    **kw
                }))

    def _check_url_exists(self, url: str) -> bool:
        """Verify if the CDN URL is actually reachable and not a 404 with retries for transient errors."""
        for attempt in range(1, 4):
            try:
                # Use GET with stream=True to check status without downloading content.
                # Some CDNs block HEAD or return 405/403 for it.
                r = self.session.get(url, timeout=15, stream=True)
                
                # If we get a valid response (2xx), it exists
                if r.status_code < 400:
                    return True
                
                # If it's a 404 (Not Found), it's likely permanently missing
                if r.status_code == 404:
                    return False
                
                # For other errors (429, 5xx), retry after a short delay
                if r.status_code >= 400:
                    if attempt < 3:
                        time.sleep(1 * attempt)
                        continue
                    return False
            except Exception:
                if attempt < 3:
                    time.sleep(1 * attempt)
                    continue
                return False
        return False


    def _download_file(self, cdn_url: str, filepath: Path, filename: str, fileurl: str = None, attempt: int = 1) -> str:
        """Download logic using aria2p with multi-connection support and real-time progress polling."""
        if not self._ensure_aria2():
            self._emit("file_error", f"Aria2 Error: {filename}", filename=filename, reason="error", fileurl=fileurl, attempt=attempt, is_final=(attempt == self.max_retries))
            return "error"

        # Setup hidden .tmp dir for staging
        tmp_dir = filepath.parent / ".tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        
        self._emit("file_start", f"Queuing {filename}", filename=filename, fileurl=fileurl, attempt=attempt)

        # 1. Check if already exists in final location
        # Since we don't have content-length yet, we'll rely on aria2 to check or we check if file exists
        if filepath.exists():
            return "already_exists"

        # 2. Add to aria2
        options = {
            "dir": str(tmp_dir),
            "out": f"{filename}.part",
            "header": [
                f"User-Agent: {self.session.headers['User-Agent']}",
                "Referer: https://get.bunkrr.su/"
            ],
            "split": "10",            # 10 connections per file as requested
            "max-connection-per-server": "10",
            "min-split-size": "1M",
            "continue": "true",
            "check-certificate": "false"
        }

        try:
            download = self.aria2_api.add_uris([cdn_url], options=options)
            gid = download.gid
        except Exception as e:
            self._safe_print(f"    ✗ aria2 add error: {e}")
            self._emit("file_error", f"Queue Error: {filename}", filename=filename, reason="error", fileurl=fileurl, attempt=attempt, is_final=(attempt == self.max_retries))
            return "error"

        # 3. Monitor progress
        last_pct = -1
        try:
            while True:
                # Refresh download info
                download = self.aria2_api.get_download(gid)
                
                if download.status == "complete":
                    break
                elif download.status in ("error", "removed"):
                    self._safe_print(f"    ✗ aria2 status {download.status}: {download.error_message}")
                    reason = "maintenance" if "maintenance" in (download.error_message or "").lower() else "error"
                    self._emit("file_error", f"Download {download.status}: {filename}", filename=filename, reason=reason, fileurl=fileurl, attempt=attempt, is_final=(attempt == self.max_retries))
                    return "error"
                
                if self.cancel_flags.get(filename, False):
                    self.aria2_api.remove([download], force=True, files=True)
                    self._emit("file_error", f"Skipped: {filename}", filename=filename, reason="skipped", fileurl=fileurl, attempt=attempt, is_final=True)
                    return "skipped"

                # Emit progress
                total = download.total_length
                completed = download.completed_length
                if total > 0:
                    pct = int(completed / total * 100)
                    if (pct - last_pct) >= 2 or pct == 100:
                        speed = download.download_speed
                        eta = download.eta.total_seconds() if download.eta else 0
                        self._emit("file_progress", f"Downloading {filename}",
                                   filename=filename, percent=pct, eta=int(eta), speed=int(speed), attempt=attempt)
                        last_pct = pct

                time.sleep(1) # Poll every second

            # 4. Success: Move from .tmp/filename.part to final location
            temp_path = tmp_dir / f"{filename}.part"
            if temp_path.exists():
                shutil.move(str(temp_path), str(filepath))
                return "ok"
            else:
                return "error"

        except Exception as e:
            self._safe_print(f"    ✗ aria2 monitor error: {e}")
            self._emit("file_error", f"Monitor Error: {filename}", filename=filename, reason="error", fileurl=fileurl, attempt=attempt, is_final=(attempt == self.max_retries))
            return "error"


    def scrape(self):
        """Main entry point for scraping and downloading an album."""
        self._emit("status", "Loading album page…")

        try:
            r = self.session.get(self.album_url, timeout=30)
            r.raise_for_status()
        except Exception as exc:
            msg = f"Cannot load album: {exc}"
            self._emit("status", msg)
            return {"success": False, "error": msg}

        soup       = BeautifulSoup(r.content, "html.parser")
        album_name = get_album_name(soup, self.album_url)
        album_dir  = Path(self.output_dir) / album_name
        
        if not self.links_only:
            album_dir.mkdir(parents=True, exist_ok=True)
        
        self._emit("album_info", "Album Discovered", name=album_name)

        # File discovery
        if re.search(r"/(f|v)/[a-zA-Z0-9]+", self.album_url):
            file_urls = [self.album_url]
        else:
            file_urls = get_file_urls(r.text, self.album_url)
        
        # Pagination traversal
        processed_pages = {self.album_url}
        discovery_queue = [self.album_url]
        page_count = 0
        while discovery_queue and page_count < 50:
            page_count += 1
            current_p_url = discovery_queue.pop(0)
            current_soup = soup if page_count == 1 else None
            if not current_soup:
                try:
                    pr = self.session.get(current_p_url, timeout=20)
                    if pr.status_code == 200:
                        current_soup = BeautifulSoup(pr.text, "html.parser")
                        new_links = get_file_urls(pr.text, current_p_url)
                        file_urls.extend([l for l in new_links if l not in file_urls])
                except: continue

            if current_soup:
                p_links = current_soup.find_all("a", href=re.compile(r"\?page=\d+"))
                for p_link in p_links:
                    p_url = urljoin(current_p_url, p_link["href"])
                    if p_url not in processed_pages:
                        processed_pages.add(p_url)
                        discovery_queue.append(p_url)

        file_urls = list(dict.fromkeys(file_urls))
        total = len(file_urls)
        self._emit("found_files", f"Found {total} files", total=total)

        ok_count = error_count = maintenance_count = skipped_count = 0
        overall_start = time.time()

        def _download_task(idx, file_url):
            self._emit("status", f"Processing {idx}/{total}")
            
            for attempt in range(1, self.max_retries + 1):
                try:
                    # Step 1: Resolve Bunkrr URL
                    bunkrr_url = get_bunkrr_url(self.session, file_url)
                    if not bunkrr_url:
                        # We don't have a filename yet, so we use the slug from the URL if possible
                        slug = file_url.split("/")[-1]
                        if attempt < self.max_retries:
                            time.sleep(2 * attempt)
                            continue
                        self._emit("file_error", f"Resolution Failed: {slug}", filename=f"File_{slug}", reason="error", fileurl=file_url, attempt=attempt, is_final=True)
                        return "error"

                    # Step 2: Resolve CDN URL
                    cdn_url = get_cdn_url(self.session.headers, bunkrr_url)
                    if not cdn_url:
                        slug = file_url.split("/")[-1]
                        if attempt < self.max_retries:
                            time.sleep(2 * attempt)
                            continue
                        self._emit("file_error", f"Source Hidden: {slug}", filename=f"File_{slug}", reason="error", fileurl=file_url, attempt=attempt, is_final=True)
                        return "error"

                    filename = get_filename_from_url(cdn_url)
                    filepath = album_dir / filename

                    # Step 3: Existence Check (Pre-download)
                    if not self._check_url_exists(cdn_url):
                        if attempt < self.max_retries:
                            # Maybe the link is temporary, retry resolution too
                            time.sleep(2 * attempt)
                            continue
                        self._emit("file_error", f"Missing on Server: {filename}", filename=filename, reason="error", fileurl=cdn_url, attempt=attempt, is_final=True)
                        return "error"

                    overall_eta = 0
                    if idx > 1:
                        overall_eta = (time.time() - overall_start) / (idx - 1) * (total - idx + 1)

                    if self.links_only:
                        self._emit("file_complete", f"Link Resolved: {filename}", filename=filename, overall_eta=int(overall_eta), fileurl=cdn_url)
                        return "ok"

                    result = self._download_file(cdn_url, filepath, filename, fileurl=cdn_url, attempt=attempt)
                    if result == "ok":
                        self._emit("file_complete", f"Done: {filename}", filename=filename, overall_eta=int(overall_eta), fileurl=cdn_url)
                        return "ok"
                    elif result == "already_exists":
                        self._emit("file_complete", f"Exists: {filename}", filename=filename, fileurl=cdn_url)
                        return "ok"
                    elif result == "skipped":
                        return "skipped"
                    
                    # If it's a generic "error", loop will retry
                    if attempt < self.max_retries:
                        time.sleep(2 * attempt)
                        continue
                    
                    # Definitively failed after all retries: cleanup residue
                    tmp_dir = album_dir / ".tmp"
                    part_file = tmp_dir / f"{filename}.part"
                    aria_file = tmp_dir / f"{filename}.part.aria2"
                    try:
                        if part_file.exists(): part_file.unlink()
                        if aria_file.exists(): aria_file.unlink()
                    except: pass
                    
                except Exception as e:
                    if attempt < self.max_retries:
                        time.sleep(2 * attempt)
                        continue
                    self._safe_print(f"    ✗ Task exception on {file_url}: {e}")
                    
                    # Also cleanup on exception if final attempt
                    try:
                        # Attempt to resolve info if possible
                        if 'filename' in locals() and 'album_dir' in locals():
                            tmp_dir = album_dir / ".tmp"
                            part_file = tmp_dir / f"{filename}.part"
                            aria_file = tmp_dir / f"{filename}.part.aria2"
                            if part_file.exists(): part_file.unlink()
                            if aria_file.exists(): aria_file.unlink()
                    except: pass

            return "error"


        try:
            with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                futures = {executor.submit(_download_task, idx, url): url for idx, url in enumerate(file_urls, 1)}
                for future in as_completed(futures):
                    res = future.result()
                    if res == "ok": ok_count += 1
                    elif res == "skipped": skipped_count += 1
                    elif res == "maintenance": maintenance_count += 1
                    else: error_count += 1
        finally:
            if self.aria2_mgr:
                self.aria2_mgr.stop_daemon()

        return {
            "success": True, "total": total, "downloaded": ok_count, 
            "maintenance": maintenance_count, "skipped": skipped_count, 
            "failed": error_count, "output_dir": str(album_dir),
        }
