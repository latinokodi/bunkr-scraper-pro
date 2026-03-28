# Bunkr Scraper — How It Works

## The Problem (Original Bug)

The original scraper was treating the **intermediate page** (`get.bunkrr.su/file/{id}`) as if it were the actual media file. That page is just an HTML landing page (~7 KB), so every "downloaded" file was just a saved webpage, not the real video/image.

---

## The Correct 4-Step Download Chain

Bunkr uses a multi-hop redirect system to serve files. Every download follows this path:

```
Album Page  ──►  File Page  ──►  Intermediate Page  ──►  API  ──►  CDN File
bunkr.cr/a/…    bunkr.cr/f/…    get.bunkrr.su/file/{id}           *.scdn.st/…
```

### Step 1 — Album Page → File Page Links

**URL pattern:** `https://bunkr.cr/a/{albumId}`

The album page contains a grid of thumbnails. Each thumbnail is an `<a>` tag pointing to a file detail page:

```html
<a href="/f/EBKMQdqKpr3ED" …>…</a>
```

**Scraper action:** GET the album page, parse all `href` attributes matching `/f/[a-zA-Z0-9]+`, and deduplicate.

#### 🔄 Recent Improvements: Pagination & JSON Fallback
1.  **Pagination Crawl**: The scraper now detects `?page=X` links and traverses them automatically to find all files in large albums (>100 files).
2.  **Dynamic Grid Detection**: If the static HTML doesn't show the grid (common in "Advanced Mode" or during server migrations), the scraper applies a **Regex Fallback**. It searches for file slugs inside JSON blocks or script tags:
    -   Matches `"/f/([a-zA-Z0-9]+)"` across the entire HTML body.
    -   Deduplicates results to ensuring an accurate count.

---

### Step 2 — File Page → Intermediate Page URL

**URL pattern:** `https://bunkr.cr/f/{fileSlug}`

Each file detail page contains a **Download** button pointing to the intermediate page on `get.bunkrr.su`:

```html
<a class="btn btn-main btn-lg …"
   href="https://get.bunkrr.su/file/59120188">Download</a>
```

**Scraper action:** GET the file page, find the first `<a>` whose `href` contains `get.bunkrr.su`. This provides the numeric file ID needed for the API call.

---

### Step 3 — API Call → Encrypted CDN URL → Decrypt

**URL pattern:** `https://get.bunkrr.su/file/{numericId}`

This page fires a **POST request** to a private API when a download is initiated:

```
POST https://apidl.bunkr.ru/api/_001_v2
Content-Type: application/json
{"id": "59120188"}
```

API response:
```json
{
  "encrypted": true,
  "timestamp": 1774701216,
  "url": "OzE3IjZucGQm…"   ← base64 + XOR encrypted
}
```

#### XOR Decryption Algorithm
The `url` field is encrypted with a **XOR cipher** using a time-derived key:
`key = "SECRET_KEY_" + floor(timestamp / 3600)`

**Python implementation:**
```python
def decrypt_url(encrypted_b64: str, timestamp: int) -> str:
    key_str   = "SECRET_KEY_" + str(math.floor(timestamp / 3600))
    raw_bytes = base64.b64decode(encrypted_b64)
    key_bytes = key_str.encode("utf-8")
    decrypted = bytearray(b ^ key_bytes[i % len(key_bytes)] for i, b in enumerate(raw_bytes))
    return decrypted.decode("utf-8", errors="replace")
```

---

### Step 4 — Download from CDN URL

The decrypted URL points to the real file server (e.g., `*.scdn.st/*.mp4`).

**Scraper action:** Download the file using the header `Referer: https://get.bunkrr.su/`. This is critical; without it, Bunkr servers return a 403 Forbidden error.

---

## ⚖️ License & Usage

The project uses the **PolyForm Noncommercial License 1.0.0**.
- **Attribution**: Credit must be given to **latinokodi**.
- **Non-Commercial**: The software cannot be used for commercial advantage or monetary compensation.
