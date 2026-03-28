#!/usr/bin/env python3
"""
Bunkr Scraper PRO - Main Entry Point (Refactored)
All core logic is now modularized in the 'bunkr_core' package.
"""

import sys
import argparse
from bunkr_core import BunkrScraperCore

# Compatibility: Export _decrypt_url if needed for manual use
from bunkr_core.crypto import decrypt_url as _decrypt_url

def main():
    # Ensure UTF-8 output even on Windows CP1252 consoles
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        
    parser = argparse.ArgumentParser(description="Bunkr Scraper PRO")
    parser.add_argument("url", help="Bunkr album URL or file URL")
    parser.add_argument("output", nargs="?", default="downloads", help="Output directory")
    parser.add_argument("--threads", type=int, default=1, help="Max parallel downloads")
    args = parser.parse_args()
    
    # Broadcast JSON progress to stdout for the Electron/GUI
    scraper = BunkrScraperCore(
        args.url, 
        output_dir=args.output, 
        progress_callback=lambda msg: print(msg, flush=True), 
        max_workers=args.threads
    )
    
    result = scraper.scrape()
    sys.exit(0 if result.get("success") else 1)

if __name__ == "__main__":
    main()
