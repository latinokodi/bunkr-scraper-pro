import asyncio
import httpx
import time
import logging
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

class DownloadManager:
    """Async download manager with httpx streaming, progress tracking, and cancellation."""

    def __init__(
        self,
        chunk_size: int = 8192,
        timeout: float = 60.0,
        max_retries: int = 3,
        retry_delay: float = 2.0,
    ):
        self.chunk_size = chunk_size
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self._client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(
            timeout=self.timeout,
            follow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": "https://bunkr.cr/",
            }
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._client:
            await self._client.aclose()
            self._client = None

    async def download_file(
        self,
        url: str,
        filename: str,
        save_path: Path,
        progress_callback: Optional[Callable[[dict], None]] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
        attempt: int = 1
    ) -> str:
        """
        Download a file with streaming and progress updates.
        Returns "ok", "error", or "skipped".
        """
        temp_path = save_path.parent / (save_path.name + ".part")
        
        # Ensure directory exists
        save_path.parent.mkdir(parents=True, exist_ok=True)

        for retry in range(self.max_retries):
            # Check for cancellation before each attempt
            if cancel_check and cancel_check():
                return "skipped"

            try:
                # Use the existing client from __aenter__
                async with self._client.stream("GET", url) as response:
                    if response.status_code == 404:
                        logger.error(f"404 Not Found: {url}")
                        return "error"
                    response.raise_for_status()
                    
                    total = int(response.headers.get("content-length", 0))
                    downloaded = 0
                    start_time = time.monotonic()
                    last_callback_time = start_time

                    with open(temp_path, "wb") as f:
                        async for chunk in response.aiter_bytes(self.chunk_size):
                            if cancel_check and cancel_check():
                                # Clean up and return skipped
                                f.close()
                                if temp_path.exists(): temp_path.unlink()
                                return "skipped"

                            # Threaded write to avoid blocking the event loop
                            await asyncio.to_thread(f.write, chunk)
                            downloaded += len(chunk)

                            # Throttle progress updates (~10Hz)
                            now = time.monotonic()
                            if progress_callback and (now - last_callback_time) >= 0.1:
                                elapsed = now - start_time
                                speed = int(downloaded / elapsed) if elapsed > 0 else 0
                                percent = int((downloaded / total) * 100) if total > 0 else 0
                                eta = int((total - downloaded) / speed) if speed > 0 else 0
                                
                                progress_callback({
                                    "percent": percent,
                                    "speed": speed,
                                    "eta": eta,
                                    "downloaded": downloaded,
                                    "total": total,
                                    "attempt": attempt
                                })
                                last_callback_time = now

                    # Success: Move temp to final
                    if temp_path.exists():
                        if save_path.exists():
                            save_path.unlink()
                        temp_path.rename(save_path)
                    return "ok"

            except httpx.HTTPError as e:
                logger.error(f"HTTP error (attempt {retry+1}): {e}")
                if temp_path.exists():
                    temp_path.unlink(missing_ok=True)
                
                if retry < self.max_retries - 1:
                    await asyncio.sleep(self.retry_delay * (retry + 1))
                else:
                    return "error"
            except Exception as e:
                logger.error(f"Unexpected error (attempt {retry+1}): {e}")
                if temp_path.exists():
                    temp_path.unlink(missing_ok=True)
                return "error"
        
        return "error"
        
        return "error"
