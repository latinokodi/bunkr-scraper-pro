import os
import logging
from pathlib import Path
from typing import List, Optional

log = logging.getLogger(__name__)


class IDMManager:
    def __init__(self):
        self.exe = self._find_idm()

    def _find_idm(self) -> Optional[Path]:
        # Common Windows installation paths
        search_paths = [
            Path(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")) / "Internet Download Manager" / "IDMan.exe",
            Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "Internet Download Manager" / "IDMan.exe",
            Path("C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe"),
            Path("C:\\Program Files\\Internet Download Manager\\IDMan.exe"),
        ]
        for p in search_paths:
            if p.exists():
                log.info(f"IDM found at: {p}")
                return p
        log.info("IDM not found in standard paths")
        return None

    def add_to_queue(self, items: List[dict], folder_path: Optional[str] = None) -> bool:
        """Add items to IDM download queue.
        
        Args:
            items: List of dicts with 'url' and 'filename' keys
            folder_path: Target folder path (optional)
            
        Returns:
            True if at least one item was successfully added
        """
        import subprocess
        if not self.exe:
            log.error("IDM executable not found")
            return False

        success_count = 0
        for item in items:
            url = item.get("url")
            filename = item.get("filename")

            if not url:
                continue

            cmd = [str(self.exe), "/d", url, "/a"]

            if filename:
                cmd.extend(["/f", filename])

            if folder_path:
                p = Path(folder_path)
                p.mkdir(parents=True, exist_ok=True)
                cmd.extend(["/p", str(p.absolute())])

            try:
                # CREATE_NO_WINDOW: 0x08000000 - prevents console window popup
                subprocess.run(cmd, creationflags=0x08000000 if os.name == 'nt' else 0, check=True)
                success_count += 1
                log.debug(f"Added to IDM: {filename[:30] if filename else url[:30]}")
            except subprocess.CalledProcessError as e:
                log.warning(f"IDM failed for {filename[:30] if filename else url[:30]}: {e}")
            except Exception as e:
                log.error(f"IDM error: {e}")
                continue

        log.info(f"IDM queue: {success_count}/{len(items)} items added")
        return success_count > 0
