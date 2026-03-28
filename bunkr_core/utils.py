import re
import os
from urllib.parse import urlparse, parse_qs, unquote

def sanitize_filename(name: str) -> str:
    """Removes invalid characters for Windows/Linux filesystems."""
    name = re.sub(r'[<>:"/\\|?*]', "_", name).strip(". ")
    return name or "file"

def get_filename_from_url(cdn_url: str) -> str:
    """Extract best filename: prefer ?n= param, fall back to URL path."""
    qs = parse_qs(urlparse(cdn_url).query)
    if "n" in qs:
        return sanitize_filename(unquote(qs["n"][0]))
    path = urlparse(cdn_url).path
    return sanitize_filename(unquote(os.path.basename(path))) or "file"

def get_album_name(soup, album_url: str) -> str:
    """Extract album title from H1 or fallback to URL slug."""
    h1 = soup.find("h1")
    if h1:
        name = h1.get_text(strip=True)
        if name:
            return sanitize_filename(name)
    return urlparse(album_url).path.split("/")[-1] or "album"
