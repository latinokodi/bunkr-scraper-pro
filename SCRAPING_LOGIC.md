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

---

### Step 2 — File Page → Intermediate Page URL

**URL pattern:** `https://bunkr.cr/f/{fileSlug}`

Each file detail page contains a **Download** button pointing to the intermediate page on `get.bunkrr.su`:

```html
<a class="btn btn-main btn-lg …"
   href="https://get.bunkrr.su/file/59120188">Download</a>
```

**Scraper action:** GET the file page, find the first `<a>` whose `href` contains `get.bunkrr.su`. That gives the numeric file ID needed for the next step.

---

### Step 3 — API Call → Encrypted CDN URL → Decrypt

**URL pattern:** `https://get.bunkrr.su/file/{numericId}`

This page does **not** embed the real download URL in HTML. Its JavaScript (`src.enc.js`) fires a **POST request** to a private API when the user clicks Download:

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

#### Decryption Algorithm (reverse-engineered from `src.enc.js`)

The `url` field is encrypted with a **XOR cipher** using a time-derived key:

```
key = "SECRET_KEY_" + floor(timestamp / 3600)
```

Decryption steps:

1. Base64-decode the `url` string → raw bytes
2. XOR each byte with `key[i % len(key)]`
3. UTF-8 decode the result → the real CDN URL

**Python implementation:**

```python
import base64, math

def decrypt_url(encrypted_b64: str, timestamp: int) -> str:
    key_str   = "SECRET_KEY_" + str(math.floor(timestamp / 3600))
    raw_bytes = base64.b64decode(encrypted_b64)
    key_bytes = key_str.encode("utf-8")
    decrypted = bytearray(
        b ^ key_bytes[i % len(key_bytes)]
        for i, b in enumerate(raw_bytes)
    )
    return decrypted.decode("utf-8", errors="replace")
```

---

### Step 4 — Download from CDN URL

The decrypted URL looks like:

```
https://c4s5.scdn.st/6d0e633f-2d8d-40e8-b018-368bd3bd20de.mp4
```

**Scraper action:** GET this URL with `Referer: https://get.bunkrr.su/` (required to avoid 403 errors), streaming the response in chunks.

The CDN URL may carry a `?n=originalFilename.mp4` query parameter that the site JS appends. The scraper uses that as the saved filename when present.

---

## Old vs. Fixed Behaviour

| Step | Old | Fixed |
|------|-----|-------|
| Album → file page links | ✅ Correct | ✅ Correct |
| File page → download URL | ❌ Tried to download intermediate page directly | ✅ Extracts link to `get.bunkrr.su` |
| Intermediate page → CDN | ❌ Not implemented | ✅ POSTs to API, decrypts XOR response |
| CDN download | ❌ Saved HTML error page (~7 KB) | ✅ Downloads real file with correct `Referer` |
