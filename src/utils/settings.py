import json
from pathlib import Path

class SettingsManager:
    def __init__(self, filename="bunkr_settings.json"):
        self.filename = Path(filename)
        self.settings = self._load()

    def _load(self) -> dict:
        if not self.filename.exists():
            return {
                "download_path": "",
                "selected_filetypes": [".mp4", ".mkv", ".mov", ".avi", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".zip", ".rar", ".7z", ".tar", ".gz"],
                "max_concurrent_downloads": 3
            }
        try:
            data = json.loads(self.filename.read_text("utf-8"))
            # Ensure filetype selection exists
            if "selected_filetypes" not in data:
                data["selected_filetypes"] = [".mp4", ".mkv", ".mov", ".avi", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".zip", ".rar", ".7z", ".tar", ".gz"]
            if "max_concurrent_downloads" not in data:
                data["max_concurrent_downloads"] = 3
            return data
        except Exception:
            return {
                "download_path": "",
                "selected_filetypes": [".mp4", ".mkv", ".mov", ".avi", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".zip", ".rar", ".7z", ".tar", ".gz"],
                "max_concurrent_downloads": 3
            }

    def get_download_path(self) -> str:
        return self.settings.get("download_path", "")

    def get_selected_filetypes(self) -> list:
        return self.settings.get("selected_filetypes", [])

    def get_max_concurrent(self) -> int:
        return self.settings.get("max_concurrent_downloads", 3)

    def get(self, key: str, default=None):
        return self.settings.get(key, default)

    def set(self, key: str, value):
        self.settings[key] = value
        self._save()

    def update_download_path(self, new_path: str):
        self.settings["download_path"] = new_path
        self._save()

    def update_selected_filetypes(self, filetypes: list):
        self.settings["selected_filetypes"] = filetypes
        self._save()

    def _save(self):
        try:
            self.filename.write_text(json.dumps(self.settings, indent=4), encoding="utf-8")
        except Exception:
            pass
