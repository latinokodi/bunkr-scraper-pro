import os
import sys
import shutil
import zipfile
import requests
from pathlib import Path

ARIA2_VERSION = "1.37.0"
ARIA2_URL = f"https://github.com/aria2/aria2/releases/download/release-{ARIA2_VERSION}/aria2-{ARIA2_VERSION}-win-64bit-build1.zip"

def get_aria2_path():
    """Returns the absolute path to the aria2c.exe binary, downloading if missing."""
    root = Path(__file__).parent.parent
    bin_dir = root / "bin"
    binary = bin_dir / "aria2c.exe"

    if binary.exists():
        return str(binary)

    print(f"[*] aria2c.exe missing in {bin_dir}. Initiating self-download...")
    bin_dir.mkdir(parents=True, exist_ok=True)
    
    zip_path = bin_dir / "aria2.zip"
    try:
        # 1. Download
        response = requests.get(ARIA2_URL, stream=True, timeout=60)
        response.raise_for_status()
        with open(zip_path, "wb") as f:
            shutil.copyfileobj(response.raw, f)
        
        # 2. Extract
        with zipfile.ZipFile(zip_path, "r") as zip_ref:
            # Find the exe inside the nested folder in the zip
            exe_member = next((m for m in zip_ref.namelist() if m.endswith("aria2c.exe")), None)
            if not exe_member:
                raise Exception("Could not find aria2c.exe inside the downloaded archive.")
            
            # Extract only the exe to bin/
            with zip_ref.open(exe_member) as source, open(binary, "wb") as target:
                shutil.copyfileobj(source, target)
        
        print(f"[+] Successfully deployed aria2c.exe to {binary}")
        return str(binary)

    except Exception as e:
        print(f"[!] Failed to acquire aria2 binary: {e}")
        # Clean up partial downloads
        if zip_path.exists(): zip_path.unlink()
        if binary.exists(): binary.unlink()
        return None
    finally:
        if zip_path.exists(): zip_path.unlink()

if __name__ == "__main__":
    path = get_aria2_path()
    if path:
        print(f"Verified: {path}")
    else:
        sys.exit(1)
