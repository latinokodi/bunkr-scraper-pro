#!/usr/bin/env python3
"""
Bunkr Scraper Core - Requests-based implementation
Downloads images and videos from Bunkr album URLs without Selenium

Download chain:
  1. Album page  (bunkr.cr/a/…)        → extract /f/ file-page links
  2. File page   (bunkr.cr/f/…)        → find Download button → get.bunkrr.su/file/{id}
  3. API call    (apidl.bunkr.ru)       → POST {id} → XOR-encrypted URL → decrypt
  4. CDN URL     (*.scdn.st/…)          → stream-download the actual file
"""

import os
import re
import time
import json
import math
import base64
import requests
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
from bs4 import BeautifulSoup
from pathlib import Path
from urllib.parse import urljoin, urlparse, parse_qs, unquote

try:
    from tqdm import tqdm
    TQDM_AVAILABLE = True
except ImportError:
    TQDM_AVAILABLE = False


# ─────────────────────────────────────────────────────────────────────────────
# Decryption  (reverse-engineered from get.bunkrr.su/js/src.enc.js)
# key = "SECRET_KEY_" + floor(timestamp / 3600)
# cipher = base64_decode(url) XOR repeated_key
# ─────────────────────────────────────────────────────────────────────────────

_KEY_DIVISOR = 3600
_KEY_PREFIX  = "SECRET_KEY_"


def _decrypt_url(encrypted_b64: str, timestamp: int) -> str:
    key_str   = _KEY_PREFIX + str(math.floor(timestamp / _KEY_DIVISOR))
    raw_bytes = base64.b64decode(encrypted_b64)
    key_bytes = key_str.encode("utf-8")
    return bytearray(
        b ^ key_bytes[i % len(key_bytes)] for i, b in enumerate(raw_bytes)
    ).decode("utf-8", errors="replace")


# ─────────────────────────────────────────────────────────────────────────────
# Minimal fallback progress bar (when tqdm is not installed)
# ─────────────────────────────────────────────────────────────────────────────

class _FallbackBar:
    """Simple text-based progress bar used when tqdm is unavailable."""
    def __init__(self, total=0, desc="", unit="B", unit_scale=True, disable=False, **_):
        self.total       = total
        self.desc        = desc
        self.n           = 0
        self._last_pct   = -1
        self.disable     = disable

    def update(self, n):
        self.n += n
        if self.total > 0 and not self.disable:
            pct = int(self.n / self.total * 100)
            if pct != self._last_pct and pct % 10 == 0:
                bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
                mb  = self.n / 1_048_576
                print(f"\r  [{bar}] {pct:3d}%  {mb:.1f} MB", end="", flush=True)
                self._last_pct = pct

    def close(self):
        if self.total > 0 and not self.disable:
            print()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def _progress_bar(total, desc, unit="B", disable=False):
    if TQDM_AVAILABLE:
        return tqdm(
            total=total,
            desc=desc,
            unit=unit,
            unit_scale=True,
            unit_divisor=1024,
            dynamic_ncols=True,
            bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}]",
            colour="cyan",
            disable=disable
        )
    return _FallbackBar(total=total, desc=desc, unit=unit, disable=disable)


# ─────────────────────────────────────────────────────────────────────────────

class BunkrScraperCore:
    """Core scraper — requests + BeautifulSoup, no browser/Selenium needed."""

    _BUNKR_API = "https://apidl.bunkr.ru/api/_001_v2"

    # Minimum sane file size: anything ≤ this is treated as an error page
    _MIN_VALID_BYTES = 1024 * 50   # 50 KB

    def __init__(self, album_url, output_dir="downloads", progress_callback=None, max_workers=1):
        self.album_url         = album_url
        self.output_dir        = output_dir
        self.progress_callback = progress_callback
        self.max_workers       = max_workers
        self._print_lock       = threading.Lock()

        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) "
                               "Chrome/120.0.0.0 Safari/537.36",
            "Accept":          "text/html,application/xhtml+xml,application/xml;"
                               "q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer":         "https://bunkr.cr/",
        })

    # ── Progress helpers ──────────────────────────────────────────────────────

    def _safe_print(self, *args, **kwargs):
        """Thread-safe print to avoid garbled console output."""
        with self._print_lock:
            # Force flush for immediate GUI stream consumption
            kwargs.setdefault('flush', True)
            print(*args, **kwargs)

    def _emit(self, progress_type, message, **kw):
        if self.progress_callback:
            with self._print_lock:
                self.progress_callback(json.dumps({"type": progress_type,
                                                   "message": message, **kw}))

    # ── Filename helpers ──────────────────────────────────────────────────────

    def sanitize_filename(self, name: str) -> str:
        name = re.sub(r'[<>:"/\\|?*]', "_", name).strip(". ")
        return name or "file"

    def _filename_from_cdn_url(self, cdn_url: str) -> str:
        """Extract best filename: prefer ?n= param, fall back to URL path."""
        qs = parse_qs(urlparse(cdn_url).query)
        if "n" in qs:
            return self.sanitize_filename(unquote(qs["n"][0]))
        path = urlparse(cdn_url).path
        return self.sanitize_filename(unquote(os.path.basename(path))) or "file"

    def _album_name(self, soup) -> str:
        h1 = soup.find("h1")
        if h1:
            name = h1.get_text(strip=True)
            if name:
                return self.sanitize_filename(name)
        return urlparse(self.album_url).path.split("/")[-1] or "album"

    # ── Step 1 ─ Album page → /f/ links ──────────────────────────────────────

    def _get_file_urls(self, html: str, base_url: str) -> list:
        soup  = BeautifulSoup(html, "html.parser")
        seen  = set()
        links = []
        
        # Method A: Static HTML extraction from the grid
        grid = soup.find("div", class_=re.compile(r"grid-images|grid-files|grid-root"))
        source = grid if grid else soup
        
        for a in source.find_all("a", href=re.compile(r"/f/[a-zA-Z0-9]+")):
            url = urljoin(base_url, a["href"])
            if url not in seen:
                seen.add(url)
                links.append(url)
        
        # Method B: JSON Fallback (for JS-rendered "Advanced Mode" or cached pages)
        # Bunkr often stores file slugs in a JSON block like const files = [...] or similar
        if not links:
            # Look for /f/ slugs in script tags or raw HTML
            found_slugs = re.findall(r'"/f/([a-zA-Z0-9]+)"', html)
            if not found_slugs:
                # Also try matching object property slugs like { slug: "ABC" }
                found_slugs = re.findall(r'slug:\s*"([a-zA-Z0-9]+)"', html)
            
            for slug in found_slugs:
                url = urljoin(base_url, f"/f/{slug}")
                if url not in seen:
                    seen.add(url)
                    links.append(url)
                    
        return links

    # ── Step 2 ─ File page → get.bunkrr.su URL ───────────────────────────────

    def _get_bunkrr_url(self, file_page_url: str):
        try:
            r = self.session.get(file_page_url, timeout=30)
            r.raise_for_status()
            soup = BeautifulSoup(r.content, "html.parser")

            # Primary: direct href containing get.bunkrr.su
            for a in soup.find_all("a", href=True):
                if "get.bunkrr.su" in a["href"]:
                    return a["href"]

            # Fallback: btn-main (Download button)
            for a in soup.find_all("a", href=True):
                if "btn-main" in " ".join(a.get("class", [])):
                    href = a["href"]
                    if href and href != "#":
                        return urljoin(file_page_url, href)

            # Fallback 2: text matches "download"
            for a in soup.find_all("a", href=True):
                if a.get_text(strip=True).lower() == "download":
                    href = a["href"]
                    if href and href != "#":
                        return urljoin(file_page_url, href)

        except Exception as exc:
            print(f"    ⚠  fetch error ({file_page_url}): {exc}")
        return None

    # ── Step 3 ─ API → decrypt → CDN URL ─────────────────────────────────────

    def _get_cdn_url(self, bunkrr_url: str):
        m = re.search(r"/file/(\d+)", bunkrr_url)
        if not m:
            return None

        file_id = m.group(1)
        try:
            r = requests.post(
                self._BUNKR_API,
                headers={
                    "User-Agent":   self.session.headers["User-Agent"],
                    "Content-Type": "application/json",
                    "Referer":      "https://get.bunkrr.su/",
                    "Origin":       "https://get.bunkrr.su",
                },
                json={"id": file_id},
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()

            if data.get("encrypted") and data.get("url") and data.get("timestamp"):
                return _decrypt_url(data["url"], data["timestamp"])
            if data.get("url"):
                return data["url"]

            print(f"    ⚠  unexpected API response: {data}")
        except Exception as exc:
            print(f"    ⚠  API error (id={file_id}): {exc}")
        return None

    # ── Step 4 ─ Download from CDN ────────────────────────────────────────────

    def _download_file(self, cdn_url: str, filepath: Path, filename: str) -> str:
        """
        Download the file at cdn_url to filepath.

        Returns one of:
          "ok"          – downloaded successfully
          "maintenance" – server responded but content looks like HTML / too small
          "error"       – network / HTTP error
        """
        self._emit("file_start", f"Downloading {filename}", filename=filename)

        dl_headers = {**self.session.headers, "Referer": "https://get.bunkrr.su/"}

        try:
            with requests.get(cdn_url, headers=dl_headers,
                              stream=True, timeout=60) as r:
                r.raise_for_status()

                content_type = r.headers.get("content-type", "")
                # If the server returns HTML it's a maintenance / error page
                if "text/html" in content_type:
                    self._emit("file_error", f"Maintenance/unavailable: {filename}",
                               filename=filename, reason="maintenance")
                    return "maintenance"

                total = int(r.headers.get("content-length", 0))
                desc  = f"  {filename[:40]:<40}"

                with _progress_bar(total, desc, disable=bool(self.progress_callback)) as bar, open(filepath, "wb") as fh:
                    downloaded = 0
                    start = time.time()
                    last_pct = -1
                    for chunk in r.iter_content(chunk_size=65536):
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
                                    self._emit("file_progress",
                                               f"Downloading {filename}",
                                               filename=filename,
                                               percent=pct, eta=int(eta))
                                    last_pct = pct

            # Validate: reject suspiciously small files
            size = filepath.stat().st_size
            if size < self._MIN_VALID_BYTES:
                self._safe_print(f"    !  file too small ({size} B) — likely maintenance page")
                filepath.unlink(missing_ok=True)
                self._emit("file_error", f"File too small (server maintenance?): {filename}",
                           filename=filename, reason="too_small")
                return "maintenance"

            return "ok"

        except requests.HTTPError as exc:
            code = exc.response.status_code if exc.response is not None else "?"
            self._safe_print(f"    ✗  HTTP {code} for {filename}")
            filepath.unlink(missing_ok=True)
            self._emit("file_error", f"HTTP {code}: {filename}",
                       filename=filename, error=str(exc))
            return "error"

        except Exception as exc:
            self._safe_print(f"    ✗  download error: {exc}")
            filepath.unlink(missing_ok=True)
            self._emit("file_error", f"Error: {filename}",
                       filename=filename, error=str(exc))
            return "error"

    # -- Orchestration ---------------------------------------------------------

    def scrape(self):
        W = 60
        print(f"\n{'-'*W}")
        print(f"  Bunkr Media Scraper")
        print(f"{'-'*W}")
        print(f"  Album: {self.album_url}")
        print(f"{'-'*W}\n")

        self._emit("status", "Loading album page…")

        # URL Normalization
        target_url = self.album_url

        try:
            r = self.session.get(target_url, timeout=30)
            r.raise_for_status()
        except Exception as exc:
            msg = f"Cannot load album: {exc}"
            print(f"x {msg}")
            self._emit("status", msg)
            return {"success": False, "error": msg,
                    "total": 0, "downloaded": 0, "failed": 0, "skipped": 0}

        soup       = BeautifulSoup(r.content, "html.parser")
        album_name = self._album_name(soup)
        album_dir  = Path(self.output_dir) / album_name
        album_dir.mkdir(parents=True, exist_ok=True)

        print(f"  Name  : {album_name}")
        print(f"  Output: {album_dir}\n")

        self._emit("status", f"Scanning album: {album_name}")

        # Initial extraction
        file_urls = self._get_file_urls(r.text, target_url)
        
        # ── Pagination Traversal ──────────────────────────────────────────────
        # Standard albums (not 'advanced=1') use ?page=X links
        processed_pages = {target_url}
        discovery_queue = [target_url]
        
        # Limit to 50 pages to prevent infinite loops if Bunkr malfunctions
        max_pages = 50 
        page_count = 0
        
        while discovery_queue and page_count < max_pages:
            page_count += 1
            current_p_url = discovery_queue.pop(0)
            
            # Re-parse if it's not the first page (which we already have in 'soup')
            current_soup = soup if page_count == 1 else None
            if not current_soup:
                try:
                    pr = self.session.get(current_p_url, timeout=20)
                    if pr.status_code == 200:
                        current_soup = BeautifulSoup(pr.text, "html.parser")
                        new_links = self._get_file_urls(pr.text, current_p_url)
                        file_urls.extend([l for l in new_links if l not in file_urls])
                except:
                    continue

            if current_soup:
                # Find links that look like pagination
                # Bunkr uses /a/[id]?page=X or similar
                p_links = current_soup.find_all("a", href=re.compile(r"\?page=\d+"))
                for p_link in p_links:
                    p_url = urljoin(current_p_url, p_link["href"])
                    if p_url not in processed_pages:
                        processed_pages.add(p_url)
                        discovery_queue.append(p_url)
                        print(f"  Found extra page: {p_url.split('?')[-1]}")

        if not file_urls:
            # Final desperate attempt: if still 0 files, try advanced mode
            if "advanced=1" not in target_url:
                adv_url = f"{target_url}{'&' if '?' in target_url else '?'}advanced=1"
                print("  Trying Advanced Mode fallback...")
                try:
                    ar = self.session.get(adv_url, timeout=25)
                    file_urls = self._get_file_urls(ar.text, adv_url)
                except:
                    pass

        if not file_urls:
            msg = "No files found in album (check if it's private or empty)."
            print(f"!  {msg}")
            self._emit("status", msg)
            return {"success": False, "error": msg,
                    "total": 0, "downloaded": 0, "failed": 0, "skipped": 0}

        # Final cleanup
        file_urls = list(dict.fromkeys(file_urls))
        total = len(file_urls)
        print(f"  Found {total} total file(s)\n")
        self._emit("found_files", f"Found {total} files", total=total)

        # ── Overall progress bar ──────────────────────────────────────────────
        overall_bar = _progress_bar(total, "  Overall", unit="file", disable=bool(self.progress_callback))

        def _download_task(idx, file_url):
            self._safe_print(f"\n  [{idx}/{total}] {file_url}")
            self._emit("status", f"Processing {idx}/{total}")

            bunkrr_url = self._get_bunkrr_url(file_url)
            if not bunkrr_url:
                self._safe_print("    ✗  Could not find get.bunkrr.su link — skipping")
                self._emit("file_error", f"No download link for {file_url}", filename=file_url, reason="no_link")
                return "error"

            self._safe_print(f"    ↳ {bunkrr_url}")

            cdn_url = self._get_cdn_url(bunkrr_url)
            if not cdn_url:
                self._safe_print("    ✗  Could not resolve CDN URL — skipping")
                self._emit("file_error", f"No CDN URL for {bunkrr_url}", filename=bunkrr_url, reason="no_cdn")
                return "error"

            filename = self._filename_from_cdn_url(cdn_url)
            filepath = album_dir / filename

            if filepath.exists() and filepath.stat().st_size >= self._MIN_VALID_BYTES:
                self._safe_print(f"    ⊙  Already exists: {filename}")
                self._emit("file_complete", f"Skipped {filename} (already exists)", filename=filename)
                time.sleep(0.3)
                return "ok"

            overall_eta = 0
            if idx > 1:
                elapsed = time.time() - overall_start
                avg = elapsed / (idx - 1)
                overall_eta = avg * (total - idx + 1)
                if self.max_workers == 1:
                    self._safe_print(f"    ETA ≈ {int(overall_eta//60)}m {int(overall_eta%60)}s")

            result = self._download_file(cdn_url, filepath, filename)

            if result == "ok":
                self._safe_print(f"    ✓  Saved: {filename}")
                self._emit("file_complete", f"Downloaded {filename}", filename=filename, overall_eta=int(overall_eta))
            elif result == "maintenance":
                self._safe_print(f"    !  Skipped (server maintenance): {filename}")

            time.sleep(1)
            return result

        ok_count          = 0
        maintenance_count = 0
        error_count       = 0
        overall_start     = time.time()
        
        mode_str = f"Parallel ({self.max_workers}x)" if self.max_workers > 1 else "Sequential"
        self._safe_print(f"  Mode: {mode_str}\n")

        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {executor.submit(_download_task, idx, url): url for idx, url in enumerate(file_urls, 1)}
            for future in as_completed(futures):
                try:
                    res = future.result()
                    if res == "ok":
                        ok_count += 1
                    elif res == "maintenance":
                        maintenance_count += 1
                    else:
                        error_count += 1
                except Exception as e:
                    self._safe_print(f"    ✗  Task crashed: {e}")
                    error_count += 1
                
                overall_bar.update(1)

        overall_bar.close()

        # -- Summary -----------------------------------------------------------
        self._safe_print(f"\n{'-'*W}")
        self._safe_print(f"  Download Summary")
        self._safe_print(f"{'-'*W}")
        self._safe_print(f"  Total          : {total}")
        self._safe_print(f"  v  Downloaded  : {ok_count}")
        if maintenance_count:
            self._safe_print(f"  !  Maintenance : {maintenance_count}  (server temporarily unavailable)")
        if error_count:
            self._safe_print(f"  x  Errors      : {error_count}")
        self._safe_print(f"  Output folder  : {album_dir}")
        self._safe_print(f"{'-'*W}\n")

        return {
            "success":     True,
            "total":       total,
            "downloaded":  ok_count,
            "maintenance": maintenance_count,
            "failed":      error_count,
            "output_dir":  str(album_dir),
        }


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    
    # Ensure UTF-8 output even on Windows CP1252 consoles
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        
    parser = argparse.ArgumentParser(description="Bunkr Scraper PRO")
    parser.add_argument("url", help="Bunkr album URL")
    parser.add_argument("output", nargs="?", default="downloads", help="Output directory")
    parser.add_argument("--threads", type=int, default=1, help="Max parallel downloads")
    args = parser.parse_args()
    
    # Passing print as the callback so _emit outputs JSON to stdout for the Electron/GUI
    scraper = BunkrScraperCore(
        args.url, 
        output_dir=args.output, 
        progress_callback=lambda msg: print(msg, flush=True), 
        max_workers=args.threads
    )
    result = scraper.scrape()
    sys.exit(0 if result.get("success") else 1)
