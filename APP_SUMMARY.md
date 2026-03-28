# Bunkr Scraper PRO — Application Summary

A desktop app to download media from Bunkr albums.

## Architecture

| Layer | Tech | File |
|-------|------|------|
| Frontend | HTML/CSS/JS (Neon Cyberpunk UI) | `gui/` |
| Runtime | Electron (IPC bridge) | `electron/main.js`, `preload.js` |
| Backend | Python 3.12 (Requests + BS4) | `scraper_core.py` (Wrapper) |
| Core Engine | Modularized Package | `bunkr_core/` |

## Core Download Logic (4-Step Chain)

1. **Album Page** (`bunkr.cr/a/...`) → Extract `/f/` file links via HTML parsing + pagination crawling
2. **File Page** (`bunkr.cr/f/...`) → Find `get.bunkrr.su` download button URL
3. **API Call** (`apidl.bunkr.ru/api/_001_v2`) → POST `{id}` → XOR-encrypted CDN URL
4. **XOR Decryption** → `key = "SECRET_KEY_" + floor(timestamp/3600)` → XOR cipher → real CDN URL
5. **CDN Download** (`*.scdn.st/...`) → Stream download with `Referer: https://get.bunkrr.su/`

## Key Features

- **Queue system** — Persistent JSON queue in Electron's userData
- **Skip/Stop** — Real-time stdin injection to skip files or abort downloads
- **Progress tracking** — JSON events streamed from Python → Electron → GUI
- **Retry failed files** — Re-queue failed downloads from UI
- **Pagination handling** — Crawls `?page=X` links for albums >100 files
- **Validation** — Rejects files <50KB (likely error pages)

## Data Flow

```
User → Electron (IPC) → Python subprocess → stdout JSON → Electron → GUI update
```

## File Structure

```
bunkrscr/
├── scraper_core.py      # Main entry point (Thin wrapper)
├── bunkr_core/          # Modularized scraping engine
│   ├── __init__.py      # Package export
│   ├── scraper_engine.py# Main orchestration class
│   ├── site_parser.py   # Bunkr-specific HTML parsing
│   ├── crypto.py        # XOR Decryption logic
│   ├── ui_helpers.py    # Progress bars (tqdm/fallback)
│   └── utils.py         # OS & Filename helpers
├── gui/
│   ├── index.html       # Dashboard UI
│   ├── script.js        # Frontend logic
│   └── styles.css       # Neon Cyberpunk styling
├── electron/
│   ├── main.js          # Electron main process
│   ├── preload.js       # IPC contextBridge
│   └── assets/          # App icons
├── downloads/           # Default output directory
├── .venv/               # Python virtual environment
├── requirements.txt     # Python dependencies
├── start.bat            # Launcher script
└── README.md            # User documentation
```

## Dependencies

**Python:** `requests`, `beautifulsoup4`, `tqdm`

**Node.js:** Electron (see `electron/package.json`)