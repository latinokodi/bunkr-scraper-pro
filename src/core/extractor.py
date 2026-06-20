import asyncio
import base64
import math
import re
from pathlib import Path
from typing import List, Dict, Optional
from urllib.parse import urljoin, urlparse, quote

import httpx
from bs4 import BeautifulSoup

from src.config import BUNKR_API, _KEY_DIVISOR, _KEY_PREFIX, MAX_RETRIES, RETRY_DELAY, console, ALLOWED_EXTENSIONS

class BunkrExtractor:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.semaphore = asyncio.Semaphore(10)

    @staticmethod
    def decrypt_url(encrypted_b64: str, timestamp: int) -> str:
        """Reverse-engineered XOR decryption."""
        key_str = _KEY_PREFIX + str(math.floor(timestamp / _KEY_DIVISOR))
        raw_bytes = base64.b64decode(encrypted_b64)
        key_bytes = key_str.encode("utf-8")
        return bytearray(
            b ^ key_bytes[i % len(key_bytes)] for i, b in enumerate(raw_bytes)
        ).decode("utf-8", errors="replace")

    async def _safe_get(self, url: str, **kwargs) -> httpx.Response:
        """Helper for GET requests with retries and exponential backoff."""
        for attempt in range(MAX_RETRIES):
            try:
                r = await self.client.get(url, **kwargs)
                r.raise_for_status()
                return r
            except (httpx.HTTPError, asyncio.TimeoutError) as e:
                if attempt == MAX_RETRIES - 1:
                    raise e
                wait = RETRY_DELAY * (2 ** attempt)
                await asyncio.sleep(wait)
        return None

    async def _safe_post(self, url: str, **kwargs) -> httpx.Response:
        """Helper for POST requests with retries."""
        for attempt in range(MAX_RETRIES):
            try:
                r = await self.client.post(url, **kwargs)
                r.raise_for_status()
                return r
            except (httpx.HTTPError, asyncio.TimeoutError) as e:
                if attempt == MAX_RETRIES - 1:
                    raise e
                wait = RETRY_DELAY * (2 ** attempt)
                await asyncio.sleep(wait)
        return None

    def _extract_file_links(self, html: str, base_url: str) -> List[Dict]:
        """Parse HTML to find file detail pages."""
        soup = BeautifulSoup(html, "html.parser")
        entries = []
        seen = set()

        # Strategy 1: Grid Search
        grid = soup.find("div", class_=re.compile(r"grid-images|grid-files|grid-root"))
        source = grid if grid else soup

        for a in source.find_all("a", href=re.compile(r"/(f|v)/[^\s\"'>]+")):
            url = urljoin(base_url, a["href"])
            if url not in seen:
                seen.add(url)
                name = None
                parent = a.find_parent("div", class_=re.compile(r"theItem|item|card"))
                if parent and parent.get("title"):
                    name = parent["title"]
                    # Skip early if title indicates it's unsupported
                    if "." in name and not name.lower().endswith(ALLOWED_EXTENSIONS):
                        continue
                entries.append({"url": url, "name": name})

        # Strategy 2: Regex Fallback
        if not entries:
            found = re.findall(r'"/(f|v)/([^\s"\'<>]+)"', html)
            for m in found:
                url = urljoin(base_url, f"/{m[0]}/{m[1]}")
                if url not in seen:
                    seen.add(url)
                    entries.append({"url": url, "name": None})

        return entries

    async def get_all_album_files(self, album_url: str) -> Dict:
        """Fetch all pages of an album and return full file list."""
        try:
            console.print(f"[dim]  → Requesting: {album_url}[/dim]")
            r = await self._safe_get(album_url)
            if not r:
                return None
                
            soup = BeautifulSoup(r.text, "html.parser")

            album_name = self._get_album_name(soup, album_url)
            all_entries = self._extract_file_links(r.text, album_url)

            # Pagination Discovery
            pages = set()
            for a in soup.find_all("a", href=re.compile(r"\?page=\d+")):
                full_page_url = urljoin(album_url, a["href"])
                if full_page_url != album_url: # Don't re-fetch the first page
                    pages.add(full_page_url)

            if pages:
                console.print(f"[dim]  → Found {len(pages)} additional pages[/dim]")
                # Fetch other pages concurrently with limited concurrency if needed, 
                # but for albums we usually just gather.
                results = await asyncio.gather(*[self._safe_get(p) for p in pages], return_exceptions=True)
                for resp in results:
                    if isinstance(resp, httpx.Response):
                        all_entries.extend(self._extract_file_links(resp.text, album_url))
                    elif isinstance(resp, Exception):
                        console.print(f"[warning]  ! Failed to fetch a page: {resp}[/warning]")

            # Deduplicate just in case
            unique_entries = []
            seen_urls = set()
            for e in all_entries:
                if e["url"] not in seen_urls:
                    seen_urls.add(e["url"])
                    unique_entries.append(e)

            return {"name": album_name, "files": unique_entries}
        except Exception as e:
            console.print(f"[error]Unexpected error fetching album: {e}[/error]")
            return None

    def _get_album_name(self, soup, url: str) -> str:
        h1 = soup.find("h1")
        name = "album"
        if h1 and h1.get_text(strip=True):
            name = h1.get_text(strip=True)
        else:
            name = urlparse(url).path.split("/")[-1] or "album"

        # Aggressive sanitization: Only alphanumeric and underscores
        name = re.sub(r'[^a-zA-Z0-9]+', "_", name).strip("_")
        return name if name else "album"

    async def resolve_link(self, item: Dict) -> Optional[Dict]:
        """Resolve a single file page to a direct CDN link, preserving metadata."""
        file_url = item["url"]
        original_name = item.get("name")

        async with self.semaphore:
            try:
                # 1. Fetch file page
                r = await self._safe_get(file_url)
                if not r or r.status_code != 200:
                    return None

                soup = BeautifulSoup(r.text, "html.parser")
                html = r.text

                # 2. Try Embedded Player Method (Instant & Direct)
                js_cdn_match = re.search(r'var\s+jsCDN\s*=\s*"([^"]+)"', html)
                js_slug_match = re.search(r'var\s+jsSlug\s*=\s*"([^"]+)"', html)
                sign_url_match = re.search(r'var\s+signUrl\s*=\s*"([^"]+)"', html)

                if js_cdn_match and js_slug_match and sign_url_match:
                    js_cdn = js_cdn_match.group(1).replace("\\/", "/")
                    js_slug = js_slug_match.group(1)
                    sign_url = sign_url_match.group(1).replace("\\/", "/")

                    parsed_cdn = urlparse(js_cdn)
                    path = parsed_cdn.path

                    # Request signature from signUrl
                    sign_request_url = f"{sign_url}?path={quote(path)}"
                    r_sign = await self._safe_get(
                        sign_request_url,
                        headers={
                            "Referer": file_url,
                        }
                    )
                    if r_sign and r_sign.status_code == 200:
                        sign_data = r_sign.json()
                        token = sign_data.get("token")
                        ex = sign_data.get("ex")

                        if token and ex:
                            # Determine pretty filename
                            pretty_name = None
                            title = soup.find("title")
                            if title:
                                title_text = title.get_text(strip=True)
                                if "|" in title_text:
                                    title_name = title_text.split("|")[0].strip()
                                    if title_name and "." in title_name:
                                        pretty_name = title_name

                            if not pretty_name:
                                cdn_filename = Path(parsed_cdn.path).name
                                pretty_name = original_name if original_name else cdn_filename

                            pretty_name = re.sub(r'[<>:"/\\|?*]', '_', pretty_name)

                            # Final signed URL
                            final_url = f"{js_cdn}?token={token}&ex={ex}"

                            # Validate extension (using either pretty name or cdn path)
                            check_name = pretty_name if pretty_name else js_cdn
                            if any(check_name.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                                return {"url": final_url, "filename": pretty_name}

                # 3. Fallback: Modern API resolution (no get.bunkrr.su calls!)
                file_id = None
                for elem in soup.find_all(attrs={"data-file-id": True}):
                    file_id = elem.get("data-file-id")
                    if file_id:
                        break

                if not file_id:
                    fid_match = re.search(r'data-file-id["\']?\s*[:=]\s*["\'](\d+)', html)
                    if fid_match:
                        file_id = fid_match.group(1)

                if not file_id:
                    # Search a tags with download or file patterns
                    for a in soup.find_all("a", href=True):
                        if "/file/" in a["href"]:
                            fid_match = re.search(r"/file/(\d+)", a["href"])
                            if fid_match:
                                file_id = fid_match.group(1)
                                break

                if file_id:
                    parsed_url = urlparse(file_url)
                    netloc = parsed_url.netloc
                    if not netloc.startswith("dl."):
                        parts = netloc.split('.')
                        if len(parts) >= 2:
                            dl_netloc = f"dl.{parts[-2]}.{parts[-1]}"
                        else:
                            dl_netloc = f"dl.{netloc}"
                    else:
                        dl_netloc = netloc
                    
                    api_url = f"https://{dl_netloc}/api/_001_v2"
                    dl_page_url = f"https://{dl_netloc}/file/{file_id}"
                    
                    # Request metadata from the API
                    r_api = await self._safe_post(
                        api_url,
                        json={"id": file_id},
                        headers={
                            "Referer": dl_page_url,
                            "Content-Type": "application/json",
                        }
                    )
                    
                    if r_api and r_api.status_code == 200:
                        meta = r_api.json()
                        mediafiles = meta.get("mediafiles")
                        path = meta.get("path")
                        ogname = meta.get("original") or original_name
                        
                        if mediafiles and path:
                            raw_cdn_url = f"{mediafiles.rstrip('/')}/{path.lstrip('/')}"
                            
                            # Determine sign URL
                            sign_url = "https://glb-apisign.cdn.cr/sign"
                            if sign_url_match:
                                sign_url = sign_url_match.group(1).replace("\\/", "/")
                            
                            parsed_cdn = urlparse(raw_cdn_url)
                            sign_request_url = f"{sign_url}?path={quote(parsed_cdn.path)}"
                            
                            r_sign = await self._safe_get(
                                sign_request_url,
                                headers={
                                    "Referer": dl_page_url,
                                }
                            )
                            
                            if r_sign and r_sign.status_code == 200:
                                sign_data = r_sign.json()
                                token = sign_data.get("token")
                                ex = sign_data.get("ex")
                                
                                if token and ex:
                                    final_url = f"{raw_cdn_url}?token={token}&ex={ex}"
                                    if ogname:
                                        final_url += f"&n={quote(ogname)}"
                                    
                                    check_name = ogname if ogname else path
                                    if any(check_name.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
                                        pretty_name = ogname if ogname else Path(parsed_cdn.path).name
                                        pretty_name = re.sub(r'[<>:"/\\|?*]', '_', pretty_name)
                                        return {"url": final_url, "filename": pretty_name}
                return None

            except httpx.HTTPStatusError:
                return None
            except httpx.RequestError:
                return None
            except Exception:
                return None