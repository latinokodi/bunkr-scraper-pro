# Bunkr Scraper PRO: Future Roadmap

This document outlines 5 high-impact improvements to evolve **Bunkr Scraper PRO** from a powerful downloader into a comprehensive media management ecosystem.

---

## 1. "Live" Watcher & Auto-Sync
**Concept**: A background service that monitors specific albums for updates.
- **How it works**: Users can mark an album as "Watched". The app periodically (e.g., every 6 hours) crawls the album URL.
- **Benefit**: Automatically downloads new additions without manual intervention, ensuring your local collection is always in sync with the source.

## 2. AI-Powered Content Tagging
**Concept**: Local AI analysis for automated organization.
- **How it works**: Use a lightweight model (like CLIP or a dedicated NSFW classifier) to "see" what's in the downloaded files.
- **Benefit**: Automatically tags files (e.g., "Outdoor", "Portrait", "NSFW") and can move them into sorted subfolders or allow for "Search by Content" in your local library.

## 3. Unified "Multi-Locker" Engine
**Concept**: Expanding support to other similar file hosting platforms.
- **How it works**: Refactor the core to support "Provider Plugins" for sites like **Gofile, Cyberdrop, 1Fichier, and Pixeldrain**.
- **Benefit**: Leverages the existing Neon UI and `aria2` backend to become a universal bulk downloader for the entire "cyber-locker" ecosystem.

## 4. Integrated Media Library & SQL Database
**Concept**: Moving from a simple downloader to a media gallery.
- **How it works**: Implement a local SQLite database to track every file ever downloaded, including its original URL, download date, and a generated thumbnail.
- **Benefit**: Provides an instant, searchable gallery view within the app where you can play videos and view images without using an external file explorer.

## 5. Browser Extension "Quick-Send"
**Concept**: A seamless bridge between the browser and the desktop app.
- **How it works**: A Chrome/Firefox extension that injects a "Grab with Bunkr PRO" button directly on Bunkr pages.
- **Benefit**: Eliminates the copy-paste workflow. One click in the browser sends the album or file directly to the desktop app's queue via a local WebSocket.

---

> [!TIP]
> **Technical Debt Consideration**: Before implementing these, a migration to a more robust **SQLite-backed queue** (replacing the current JSON-based one) would provide the stability needed for these large-scale features.
