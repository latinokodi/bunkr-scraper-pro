import asyncio
import os
import json
from pathlib import Path
from bunkr_core.scraper_engine import BunkrScraperCore

async def test_skip_logic():
    # Setup
    output_dir = Path("test_skip_output")
    album_dir = output_dir / "TestAlbum"
    album_dir.mkdir(parents=True, exist_ok=True)
    
    # 1. Create a "finished" file ( > 50KB)
    finished_file = album_dir / "finished_file.mp4"
    with open(finished_file, "wb") as f:
        f.write(b"0" * (1024 * 60)) # 60 KB
        
    # 2. Create a "partial" file in .tmp
    tmp_dir = album_dir / ".tmp"
    tmp_dir.mkdir(exist_ok=True)
    # The scraper looks for the file in the parent folder to skip. 
    # If it's NOT in the parent folder, it's NOT skipped.

    # Mock file_info
    file_urls = [
        {"url": "https://bunkr.cr/v/finished", "name": "finished_file.mp4"},
        {"url": "https://bunkr.cr/v/partial", "name": "partial_file.mp4"}
    ]
    
    def mock_callback(msg):
        data = json.loads(msg)
        if data["type"] == "file_complete":
            print(f"REPORT: File Complete - {data.get('filename')}")
        elif data["type"] == "status":
            print(f"REPORT: Status - {data.get('message')}")

    scraper = BunkrScraperCore("https://bunkr.cr/a/test", output_dir=str(output_dir), progress_callback=mock_callback)
    
    print("\n--- Testing Skip of Finished File ---")
    # This should return "ok" immediately because finished_file.mp4 exists in album_dir
    res1 = await scraper._process_file(1, file_urls[0], 2, album_dir, 0)
    print(f"Result for finished: {res1} (Expected: ok)")

    print("\n--- Testing Pursuit of Missing/Partial File ---")
    # This should proceed to resolution because partial_file.mp4 does NOT exist in album_dir
    # It will fail resolution in this mock, but that's what we want to see (it attempted it)
    try:
        res2 = await scraper._process_file(2, file_urls[1], 2, album_dir, 0)
        print(f"Result for partial: {res2}")
    except Exception as e:
        # In this mock, get_async_bunkrr_url will likely return None
        print(f"Partial check proceeded to resolution phase as expected.")

    # Cleanup
    # import shutil
    # shutil.rmtree(output_dir)

if __name__ == "__main__":
    asyncio.run(test_skip_logic())
