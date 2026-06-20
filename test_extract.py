"""Test BunkrScr extractor against a specific album URL."""
import asyncio
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
from src.core.extractor import BunkrExtractor


async def test():
    client = httpx.AsyncClient(
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://bunkr.cr/",
        },
        follow_redirects=True,
        timeout=30,
    )
    extractor = BunkrExtractor(client)

    url = "https://bunkr.cr/a/lYdpR0IS"

    # Step 1: Fetch album
    print("\n=== STEP 1: Fetch album ===")
    album = await extractor.get_all_album_files(url)

    if not album:
        print("FAILED: Could not fetch album")
        await client.aclose()
        return 1

    print(f"Album name: {album['name']}")
    print(f"Files found: {len(album['files'])}")

    if album['files']:
        print("\nFirst 5 file entries:")
        for f in album['files'][:5]:
            print(f"  URL: {f['url']}")
            print(f"  Name: {f.get('name')}")

    # Step 2: Resolve first 3 files
    if album['files']:
        print("\n=== STEP 2: Resolve first 3 files to downloadable URLs ===")
        for entry in album['files'][:3]:
            result = await extractor.resolve_link(entry)
            if result:
                print(f"  OK {entry['url'].split('/')[-1]}")
                print(f"    filename: {result['filename']}")
                print(f"    resolved URL: {result['url'][:140]}...")
            else:
                print(f"  FAILED: {entry['url']}")

    # Step 3: Resolve all
    if album['files']:
        print(f"\n=== STEP 3: Resolve all {len(album['files'])} files ===")
        results = await asyncio.gather(
            *[extractor.resolve_link(e) for e in album['files']],
            return_exceptions=True
        )
        resolved = [r for r in results if r and not isinstance(r, Exception)]
        exceptions = [r for r in results if isinstance(r, Exception)]
        failed = len(album['files']) - len(resolved) - len(exceptions)
        print(f"Resolved: {len(resolved)}")
        print(f"Failed (None): {failed}")
        print(f"Exceptions: {len(exceptions)}")
        if exceptions:
            for e in exceptions[:3]:
                print(f"  Exception: {e}")

        if resolved:
            from collections import Counter
            exts = Counter()
            for r in resolved:
                fn = r['filename']
                ext = '.' + fn.rsplit('.', 1)[-1].lower() if '.' in fn else 'unknown'
                exts[ext] += 1
            print(f"File types: {dict(exts)}")

    print(f"\n=== VERDICT ===")
    if album and album['files'] and resolved:
        print(f"DOWNLOADABLE: Yes ({len(resolved)}/{len(album['files'])} files resolved)")
    else:
        print("DOWNLOADABLE: No (resolution failed)")

    await client.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(test()))
