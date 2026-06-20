"""
Download History Manager
Tracks downloaded files to prevent re-downloads
"""
import json
from pathlib import Path
from typing import Set, Optional
from datetime import datetime


from urllib.parse import urlparse

class HistoryManager:
    """Manages download history to prevent duplicates."""

    def __init__(self, filename="bunkr_history.json"):
        self.filename = Path(filename)
        self._history: Set[str] = set()  # Set of downloaded file URLs
        self._albums: dict = {}  # album_url -> {name, count, date}
        self._load()

    def _load(self):
        """Load history from file."""
        if not self.filename.exists():
            return
        try:
            data = json.loads(self.filename.read_text("utf-8"))
            self._history = set(data.get("files", []))
            self._albums = data.get("albums", {})
        except Exception:
            self._history = set()
            self._albums = {}

    def _save(self):
        """Save history to file."""
        try:
            data = {
                "files": list(self._history),
                "albums": self._albums,
                "last_updated": datetime.now().isoformat()
            }
            self.filename.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception:
            pass

    def is_downloaded(self, file_url: str) -> bool:
        """Check if a file URL was already downloaded."""
        if file_url in self._history:
            return True
            
        # Normalize dynamic Bunkr signed URLs to check history using the unique file UUID/slug
        try:
            parsed = urlparse(file_url)
            filename = Path(parsed.path).name
            if filename:
                for hist_url in self._history:
                    if filename in hist_url:
                        return True
        except Exception:
            pass
            
        return False

    def is_processed(self, album_url: str) -> bool:
        """Check if an album URL was already processed."""
        return album_url in self._albums

    @property
    def processed(self) -> list:
        """Get list of processed album URLs."""
        return list(self._albums.keys())

    def mark_downloaded(self, file_url: str, album_url: str = None, album_name: str = None):
        """Mark a file as downloaded."""
        self._history.add(file_url)
        if album_url and album_name:
            if album_url not in self._albums:
                self._albums[album_url] = {
                    "name": album_name,
                    "files": [],
                    "date": datetime.now().isoformat()
                }
            self._albums[album_url]["files"].append(file_url)
        self._save()

    def mark_album_downloaded(self, album_url: str, album_name: str, file_urls: list):
        """Mark entire album as downloaded."""
        for url in file_urls:
            self._history.add(url)
        self._albums[album_url] = {
            "name": album_name,
            "files": file_urls,
            "date": datetime.now().isoformat()
        }
        self._save()

    def filter_new_files(self, files: list) -> tuple:
        """
        Filter files, returning (new_files, already_downloaded).
        files: list of {url, filename} dicts
        Returns: (new_files list, count of already downloaded)
        """
        new_files = []
        already_count = 0
        for f in files:
            url = f.get("url", "")
            if url and url in self._history:
                already_count += 1
            else:
                new_files.append(f)
        return new_files, already_count

    def get_downloaded_count(self) -> int:
        """Get total number of downloaded files."""
        return len(self._history)

    def get_albums_count(self) -> int:
        """Get number of albums downloaded."""
        return len(self._albums)

    def clear_history(self):
        """Clear all history."""
        self._history.clear()
        self._albums.clear()
        self._save()

    def get_album_info(self, album_url: str) -> Optional[dict]:
        """Get info about a previously downloaded album."""
        return self._albums.get(album_url)