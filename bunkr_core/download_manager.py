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
        chunk_size: int = 65536,  # 64KB chunks for rapid UI updates with minimal overhead
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
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
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
        Uses a '.tmp' subfolder for partial files.
        """
        temp_dir = save_path.parent / ".tmp"
        temp_path = temp_dir / (save_path.name + ".part")
        
        # Ensure directories exist
        save_path.parent.mkdir(parents=True, exist_ok=True)
        temp_dir.mkdir(parents=True, exist_ok=True)

        for retry in range(self.max_retries):
            # Check for cancellation before each attempt
            if cancel_check and cancel_check():
                return "skipped"

            try:
                headers = {}
                resume_bytes = 0
                if temp_path.exists():
                    resume_bytes = temp_path.stat().st_size
                    if resume_bytes > 0:
                        headers["Range"] = f"bytes={resume_bytes}-"

                # Use the existing client from __aenter__
                async with self._client.stream("GET", url, headers=headers) as response:
                    if response.status_code == 404:
                        logger.error(f"404 Not Found: {url}")
                        return "error"
                    
                    response.raise_for_status()
                    
                    is_resume = response.status_code == 206
                    
                    if is_resume:
                        total = resume_bytes + int(response.headers.get("content-length", 0))
                        downloaded = resume_bytes
                        mode = "ab"
                    else:
                        total = int(response.headers.get("content-length", 0))
                        downloaded = 0
                        mode = "wb"

                    start_time = time.monotonic()
                    last_callback_time = start_time

                    with open(temp_path, mode) as f:
                        async for chunk in response.aiter_bytes(self.chunk_size):
                            if cancel_check and cancel_check():
                                # Clean up and return skipped
                                f.close()
                                if temp_path.exists(): temp_path.unlink(missing_ok=True)
                                return "skipped"

                            # Direct write: 1MB chunk into OS page cache
                            # (Avoids asyncio.to_thread context switch which murders the threadpool over time)
                            f.write(chunk)
                            downloaded += len(chunk)

                            # Throttle progress updates (~10Hz)
                            now = time.monotonic()
                            if progress_callback and (now - last_callback_time) >= 0.1:
                                elapsed = now - start_time
                                # Calculate speed based on bytes downloaded *this session*
                                session_downloaded = downloaded - resume_bytes
                                speed = int(session_downloaded / elapsed) if elapsed > 0 else 0
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
                        # Validation: Files under 50KB are rejected as likely error pages/maintenance responses
                        if temp_path.stat().st_size < 51200:
                            logger.error(f"Validation Failed: {filename} is too small ({temp_path.stat().st_size} bytes)")
                            temp_path.unlink(missing_ok=True)
                            return "error"

                        if save_path.exists():
                            save_path.unlink(missing_ok=True)
                        temp_path.rename(save_path)
                    return "ok"

            except httpx.HTTPError as e:
                logger.error(f"HTTP error (attempt {retry+1}): {e}")
                # Notice we do NOT unlink temp_path here. 
                # Keeping the partial file allows the next retry loop to resume it using Range.
                
                if retry < self.max_retries - 1:
                    await asyncio.sleep(self.retry_delay * (retry + 1))
                else:
                    return "error"
            except Exception as e:
                logger.error(f"Unexpected error (attempt {retry+1}): {e}")
                # Only delete on fatal non-network exceptions to be safe.
                if temp_path.exists():
                    temp_path.unlink(missing_ok=True)
                return "error"
        
        return "error"
