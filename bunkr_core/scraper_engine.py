import os
import time
import json
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

class BunkrScraperCore:
    """Core scraper orchestration engine."""

    _MIN_VALID_BYTES = 1024 * 50   # 50 KB
    _CHUNK_COUNT = 2               # Use exactly 2 parallel segments
    _CHUNK_MIN_SIZE = 1024 * 1024 * 5 # 5 MB minimum for chunking

    def __init__(self, album_url, output_dir="downloads", progress_callback=None, max_workers=1):
        self.album_url         = album_url
        self.output_dir        = output_dir
        self.progress_callback = progress_callback
        self.max_workers       = max_workers
        self._print_lock       = threading.Lock()
        
        self.cancel_flags      = {}
        if self.progress_callback:
            self._stdin_thread = threading.Thread(target=self._stdin_listener, daemon=True)
            self._stdin_thread.start()

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

    def _emit(self, progress_type, message, **kw):
        """Send progress events to the callback (typically JSON for Electron)."""
        if self.progress_callback:
            with self._print_lock:
                self.progress_callback(json.dumps({
                    "type": progress_type,
                    "message": message, 
                    **kw
                }))

    def _download_chunk(self, cdn_url, start_byte, end_byte, chunk_path, filename):
        """Worker function for downloading a single byte range."""
        headers = {**self.session.headers, "Referer": "https://get.bunkrr.su/", "Range": f"bytes={start_byte}-{end_byte}"}
        try:
            with requests.get(cdn_url, headers=headers, stream=True, timeout=30) as r:
                if r.status_code not in (200, 206):
                    return False
                with open(chunk_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=65536):
                        if self.cancel_flags.get(filename, False):
                            return False
                        if chunk:
                            f.write(chunk)
            return True
        except:
            return False

    def _download_file_chunked(self, cdn_url: str, filepath: Path, filename: str, total: int, fileurl: str) -> str:
        """Downloads a file in parallel using 2 chunks and staging in a .chunks folder."""
        temp_dir = filepath.parent / ".chunks" / filename
        temp_dir.mkdir(parents=True, exist_ok=True)

        chunk_size = math.ceil(total / self._CHUNK_COUNT)
        futures = []
        
        self._safe_print(f"    ⚡ Chunked Download (2 parts): {filename}")

        with ThreadPoolExecutor(max_workers=self._CHUNK_COUNT) as executor:
            for i in range(self._CHUNK_COUNT):
                start = i * chunk_size
                end   = min(start + chunk_size - 1, total - 1)
                chunk_path = temp_dir / f"part_{i}"
                futures.append(executor.submit(self._download_chunk, cdn_url, start, end, chunk_path, filename))

            # Monitor progress
            start_time = time.time()
            last_pct = -1
            while any(f.running() for f in futures):
                if self.cancel_flags.get(filename, False):
                    executor.shutdown(wait=False, cancel_futures=True)
                    return "skipped"

                downloaded = sum(p.stat().st_size for p in temp_dir.glob("part_*") if p.exists())
                pct = int(downloaded / total * 100)
                if (pct - last_pct) >= 2 or pct == 100:
                    elapsed = time.time() - start_time
                    speed   = downloaded / elapsed if elapsed > 0 else 0
                    eta     = (total - downloaded) / speed if speed > 0 else 0
                    self._emit("file_progress", f"Downloading {filename}", 
                               filename=filename, percent=pct, eta=int(eta), speed=int(speed))
                    last_pct = pct
                time.sleep(0.5)

            if not all(f.result() for f in futures):
                return "error"

        # Merge chunks
        try:
            with open(filepath, "wb") as final_f:
                for i in range(self._CHUNK_COUNT):
                    chunk_path = temp_dir / f"part_{i}"
                    with open(chunk_path, "rb") as part_f:
                        final_f.write(part_f.read())
                    chunk_path.unlink()
            temp_dir.rmdir()
            # Try removing .chunks parent if empty
            try: (filepath.parent / ".chunks").rmdir()
            except: pass
            return "ok"
        except Exception as e:
            self._safe_print(f"    ✗ Merge error: {e}")
            return "error"

    def _perform_streaming_download(self, r, filepath: Path, filename: str, total: int) -> str:
        """Helper to execute a non-chunked, sequential stream download."""
        try:
            desc = f"  {filename[:40]:<40}"
            with get_progress_bar(total, desc, disable=bool(self.progress_callback)) as bar, open(filepath, "wb") as fh:
                downloaded = 0
                start = time.time()
                last_pct = -1
                for chunk in r.iter_content(chunk_size=65536):
                    if self.cancel_flags.get(filename, False):
                        return "skipped"

                    if chunk:
                        fh.write(chunk)
                        bar.update(len(chunk))
                        downloaded += len(chunk)

                        if total > 0 and self.progress_callback:
                            pct = int(downloaded / total * 100)
                            if (pct - last_pct) >= 2 or pct == 100:
                                elapsed = time.time() - start
                                speed   = downloaded / elapsed if elapsed > 0 else 0
                                eta     = (total - downloaded) / speed if speed > 0 else 0
                                self._emit("file_progress", f"Downloading {filename}",
                                           filename=filename, percent=pct, eta=int(eta), speed=int(speed))
                                last_pct = pct

            if self.cancel_flags.get(filename, False):
                return "skipped"

            if filepath.stat().st_size < self._MIN_VALID_BYTES:
                filepath.unlink(missing_ok=True)
                return "too_small"

            return "ok"
        except Exception as e:
            self._safe_print(f"    ✗ stream error: {e}")
            return "error"

    def _download_file(self, cdn_url: str, filepath: Path, filename: str, fileurl: str = None) -> str:
        """Download logic with automatic selection between chunked and streaming."""
        self._emit("file_start", f"Downloading {filename}", filename=filename, fileurl=fileurl)
        dl_headers = {**self.session.headers, "Referer": "https://get.bunkrr.su/"}

        # ─── ATTEMPT 1: Best Choice (Chunked if Large) ───
        try:
            with requests.get(cdn_url, headers=dl_headers, stream=True, timeout=60) as r:
                r.raise_for_status()
                
                content_type = r.headers.get("content-type", "")
                if "text/html" in content_type:
                    self._emit("file_error", f"Maintenance: {filename}", filename=filename, reason="maintenance")
                    return "maintenance"

                total = int(r.headers.get("content-length", 0))
                if filepath.exists() and total > 0 and filepath.stat().st_size == total:
                    return "already_exists"

                if total >= self._CHUNK_MIN_SIZE:
                    r.close() 
                    result = self._download_file_chunked(cdn_url, filepath, filename, total, fileurl)
                else:
                    result = self._perform_streaming_download(r, filepath, filename, total)
                
                if result != "error" and result != "too_small":
                    return result
                
                if result == "too_small":
                    self._emit("file_error", f"File too small: {filename}", filename=filename, reason="too_small")
                    return "maintenance"

        except Exception as exc:
            self._safe_print(f"    ✗ Attempt 1 failed: {exc}")

        # ─── ATTEMPT 2: Automatic Retry (No Chunks) ───
        if self.cancel_flags.get(filename, False):
            return "skipped"

        self._safe_print(f"    ↻ Retrying... (Standard Mode): {filename}")
        self._emit("file_progress", f"Retrying {filename}...", filename=filename, percent=0)
        
        if filepath.exists(): filepath.unlink()
        time.sleep(2)

        try:
            with requests.get(cdn_url, headers=dl_headers, stream=True, timeout=60) as r:
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0))
                result = self._perform_streaming_download(r, filepath, filename, total)
                
                if result == "too_small":
                    self._emit("file_error", f"File too small: {filename}", filename=filename, reason="too_small")
                    return "maintenance"
                
                if result == "error":
                    self._emit("file_error", f"Error: {filename}", filename=filename, reason="failed_after_retry")
                
                return result

        except Exception as exc:
            self._safe_print(f"    ✗ Retry failed: {exc}")
            filepath.unlink(missing_ok=True)
            self._emit("file_error", f"Error: {filename}", filename=filename, error=str(exc))
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
            bunkrr_url = get_bunkrr_url(self.session, file_url)
            if not bunkrr_url: return "error"

            cdn_url = get_cdn_url(self.session.headers, bunkrr_url)
            if not cdn_url: return "error"

            filename = get_filename_from_url(cdn_url)
            filepath = album_dir / filename

            overall_eta = 0
            if idx > 1:
                overall_eta = (time.time() - overall_start) / (idx - 1) * (total - idx + 1)

            result = self._download_file(cdn_url, filepath, filename, fileurl=file_url)
            if result == "ok":
                self._emit("file_complete", f"Done: {filename}", filename=filename, overall_eta=int(overall_eta), fileurl=file_url)
            elif result == "already_exists":
                self._emit("file_complete", f"Exists: {filename}", filename=filename, fileurl=file_url)
            return result

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {executor.submit(_download_task, idx, url): url for idx, url in enumerate(file_urls, 1)}
            for future in as_completed(futures):
                res = future.result()
                if res == "ok": ok_count += 1
                elif res == "skipped": skipped_count += 1
                elif res == "maintenance": maintenance_count += 1
                else: error_count += 1

        return {
            "success": True, "total": total, "downloaded": ok_count, 
            "maintenance": maintenance_count, "skipped": skipped_count, 
            "failed": error_count, "output_dir": str(album_dir),
        }
