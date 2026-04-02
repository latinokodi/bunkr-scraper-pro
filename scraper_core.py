#!/usr/bin/env python3
"""
Bunkr Scraper PRO - Main Entry Point (Refactored)
All core logic is now modularized in the 'bunkr_core' package.
"""

import sys
import argparse
import json
from bunkr_core import BunkrScraperCore

# Compatibility: Export _decrypt_url if needed for manual use
from bunkr_core.crypto import decrypt_url as _decrypt_url

def main():
    # Ensure UTF-8 output even on Windows CP1252 consoles
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        
    parser = argparse.ArgumentParser(description="Bunkr Scraper PRO")
    parser.add_argument("url", nargs="?", help="Bunkr album URL or file URL")
    parser.add_argument("output", nargs="?", default="downloads", help="Output directory")
    parser.add_argument("--threads", type=int, default=1, help="Max parallel downloads")
    parser.add_argument("--retries", type=int, default=10, help="Max retries per file")
    parser.add_argument("--links-only", action="store_true", help="Scrape links only")
    parser.add_argument("--cleanup", action="store_true", help="Clean up the output directory")
    args = parser.parse_args()

    # Handle Cleanup Mode
    if args.cleanup:
        from bunkr_core.cleaner import run_cleanup
        try:
            stats = run_cleanup(args.output)
            print(json.dumps({"success": True, "type": "cleanup_result", "stats": stats}), flush=True)
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}), flush=True)
            sys.exit(1)

    if not args.url:
        parser.error("url is required unless --cleanup is used")

    
    # Broadcast JSON progress to stdout for the Electron/GUI
    scraper = BunkrScraperCore(
        args.url, 
        output_dir=args.output, 
        progress_callback=lambda msg: print(msg, flush=True), 
        max_workers=args.threads,
        max_retries=args.retries,
        links_only=args.links_only
    )
    
    try:
        result = scraper.scrape()
        # Print JSON result for main.js to intercept if needed
        print(json.dumps(result), flush=True)
        sys.exit(0 if result.get("success") else 1)
    except Exception as exc:
        import traceback
        err_out = {
            "success": False,
            "error": f"Internal Error: {str(exc)}",
            "traceback": traceback.format_exc()
        }
        print(json.dumps(err_out), flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
