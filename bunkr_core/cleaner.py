import os
import shutil
from pathlib import Path
from hachoir.metadata import extractMetadata
from hachoir.parser import createParser
from hachoir.core import config as hachoir_config
from .utils import VIDEO_EXTENSIONS

# Disable hachoir logging to stdout
hachoir_config.quiet = True

def get_video_duration(file_path):
    """Returns video duration in seconds using hachoir."""
    try:
        parser = createParser(str(file_path))
        if not parser:
            return None
        with parser:
            metadata = extractMetadata(parser)
            if metadata and metadata.has('duration'):
                return metadata.get('duration').total_seconds()
    except Exception:
        pass
    return None

def run_cleanup(base_dir):
    """
    Recursively cleans:
    - Images: (.jpg, .jpeg, .png, .webp, .gif, .bmp)
    - Small Videos: (duration <= 60s)
    - .tmp folders
    """
    stats = {
        "videos": 0,
        "folders": 0,
        "errors": 0
    }
    
    base_path = Path(base_dir)
    if not base_path.exists():
        return stats

    video_exts = VIDEO_EXTENSIONS

    # Walk through the directory (bottom-up to allow folder deletion)
    for root, dirs, files in os.walk(base_dir, topdown=False):
        current_path = Path(root)
        
        # 1. Clean .tmp folders
        for d in dirs:
            if d.lower() == ".tmp":
                tmp_folder = current_path / d
                try:
                    shutil.rmtree(tmp_folder)
                    stats["folders"] += 1
                except Exception:
                    stats["errors"] += 1

        # 2. Clean files
        for f in files:
            file_path = current_path / f
            ext = file_path.suffix.lower()
            
            # Videos
            if ext in video_exts:
                duration = get_video_duration(file_path)
                if duration is not None and duration <= 60:
                    try:
                        file_path.unlink()
                        stats["videos"] += 1
                    except Exception:
                        stats["errors"] += 1

    return stats
