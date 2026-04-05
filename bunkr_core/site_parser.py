import re
import httpx
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from .crypto import decrypt_url

BUNKR_API = "https://apidl.bunkr.ru/api/_001_v2"

def get_file_urls(html: str, base_url: str) -> list:
    """Extract list of dicts {"url": URL, "name": NAME} from album HTML."""
    soup  = BeautifulSoup(html, "html.parser")
    seen  = set()
    links = []
    
    # Method A: Static HTML extraction from the grid
    grid = soup.find("div", class_=re.compile(r"grid-images|grid-files|grid-root"))
    source = grid if grid else soup
    
    for a in source.find_all("a", href=re.compile(r"/(f|v)/[a-zA-Z0-9]+")):
        url = urljoin(base_url, a["href"])
        if url not in seen:
            seen.add(url)
            
            name = None
            name_tag = a.find(class_=re.compile(r"theName|title|name|filename"))
            if name_tag:
                name = name_tag.get_text(strip=True)
            
            if not name:
                title_tag = a.find(["h1", "p", "div", "span"], class_=re.compile(r"title|name|header"))
                if title_tag:
                    name = title_tag.get_text(strip=True)
            
            if not name:
                for child in a.children:
                    if isinstance(child, str):
                        t = child.strip()
                        if t:
                            name = t
                            break
            
            if not name:
                lines = [l.strip() for l in a.get_text("\n").split("\n") if l.strip()]
                if lines:
                    name = lines[0]
            
            links.append({"url": url, "name": name})
    
    if not links:
        found_slugs = re.findall(r'"/(f|v)/([a-zA-Z0-9]+)"', html)
        if not found_slugs:
            found_slugs = re.findall(r'slug:\s*"([a-zA-Z0-9]+)"', html)
        
        for slug in found_slugs:
            url = urljoin(base_url, f"/f/{slug}")
            if url not in seen:
                seen.add(url)
                links.append({"url": url, "name": None})
                
    return links

async def get_async_bunkrr_url(client: httpx.AsyncClient, file_page_url: str):
    """Fetch file page and extract the get.bunkrr.su link (Async)."""
    try:
        r = await client.get(file_page_url, timeout=30)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")

        # Primary: direct href containing get.bunkrr.su
        for a in soup.find_all("a", href=True):
            if "get.bunkrr.su" in a["href"]:
                return a["href"]

        # Fallback: btn-main
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

    except Exception:
        pass
    return None

async def get_async_cdn_url(client: httpx.AsyncClient, bunkrr_url: str):
    """Call XOR-API and decrypt the result (Async)."""
    m = re.search(r"/file/(\d+)", bunkrr_url)
    if not m:
        return None

    file_id = m.group(1)
    try:
        r = await client.post(
            BUNKR_API,
            headers={
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
            return decrypt_url(data["url"], data["timestamp"])
        if data.get("url"):
            return data["url"]

    except Exception:
        pass
    return None
