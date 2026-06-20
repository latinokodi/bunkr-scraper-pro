"""
Direct HTTP downloader for Bunkr files - bypasses IDM
Supports concurrent downloads with per-file progress bars
"""
import asyncio
import logging
from pathlib import Path
from typing import List, Dict, Optional, Callable
from dataclasses import dataclass

import httpx
from rich.progress import Progress, BarColumn, DownloadColumn, TransferSpeedColumn, TimeRemainingColumn, TextColumn
from rich.console import Console

from src.config import MAX_RETRIES, RETRY_DELAY

log = logging.getLogger(__name__)


@dataclass
class DownloadResult:
    """Result of a single file download."""
    filename: str
    success: bool
    size_bytes: int
    error: Optional[str] = None


class DirectDownloader:
    """Async downloader with progress tracking."""

    def __init__(self, console: Console, max_concurrent: int = 3, client: Optional[httpx.AsyncClient] = None):
        self.console = console
        self.max_concurrent = max_concurrent
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.client = client

    async def download_batch(
        self,
        items: List[Dict],
        dest_dir: Path,
        headers: Optional[Dict] = None
    ) -> List[DownloadResult]:
        """Download multiple files with concurrent progress bars."""
        if not items:
            return []

        dest_dir.mkdir(parents=True, exist_ok=True)

        # Default headers for Bunkr
        if headers is None:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": "https://bunkr.cr/",
            }

        client = self.client
        own_client = False
        if client is None:
            client = httpx.AsyncClient(
                headers=headers,
                follow_redirects=True,
                timeout=60.0,
            )
            own_client = True

        results = []
        completed_count = 0
        failed_count = 0
        total_bytes = 0
        skipped_on_disk = 0

        def on_file_complete(filename: str, success: bool, size: int, error: str = None):
            nonlocal completed_count, failed_count, total_bytes
            if success:
                completed_count += 1
                total_bytes += size
            else:
                failed_count += 1

        try:
            with Progress(
                TextColumn("[bold cyan]#[/bold cyan]{task.fields[idx]}", justify="right"),
                BarColumn(bar_width=40, complete_style="green", finished_style="bold green"),
                DownloadColumn(),
                TransferSpeedColumn(),
                TimeRemainingColumn(),
                console=self.console,
                refresh_per_second=4,
            ) as progress:
                
                async def tracked_download(idx, item):
                    nonlocal skipped_on_disk
                    url = item.get("url")
                    filename = item.get("filename", "unknown")
                    dest_path = dest_dir / filename
                    
                    # Check existence BEFORE semaphore to avoid any delay or clutter
                    if dest_path.exists():
                        skipped_on_disk += 1
                        size = dest_path.stat().st_size
                        on_file_complete(filename, True, size)
                        return DownloadResult(filename, True, size)
                    
                    async with self.semaphore:
                        task_id = progress.add_task(
                            f"[cyan]{filename[:40]}[/cyan]",
                            total=0,
                            idx=idx,
                        )
                        try:
                            res = await self.download_file_no_sem(
                                client, url, filename, dest_dir, progress, task_id, on_file_complete
                            )
                            progress.remove_task(task_id)
                            return res
                        except Exception as e:
                            progress.remove_task(task_id)
                            return DownloadResult(filename, False, 0, str(e))

                # Create tasks for all files
                tasks = [tracked_download(idx, item) for idx, item in enumerate(items, 1)]
                results = await asyncio.gather(*tasks)

        finally:
            if own_client:
                await client.aclose()

        # Summary
        if skipped_on_disk:
            self.console.print(f"[yellow]⊗ Skipped {skipped_on_disk} existing files[/yellow]")
        
        self.console.print()
        if completed_count:
            self.console.print(f"[green]✓ Downloaded:[/green] {completed_count} files ({self._format_size(total_bytes)})")
        if failed_count:
            self.console.print(f"[red]✗ Failed:[/red] {failed_count} files")
        self.console.print(f"[cyan]Location:[/cyan] {dest_dir}")

        return results

    async def download_file_no_sem(
        self,
        client: httpx.AsyncClient,
        url: str,
        filename: str,
        dest_dir: Path,
        progress: Progress,
        task_id: int,
        on_complete: Optional[Callable] = None
    ) -> DownloadResult:
        """Download logic without semaphore (called from tracked_download)."""
        dest_path = dest_dir / filename
        size_bytes = 0

        for attempt in range(MAX_RETRIES):
            try:
                # Reset progress for each attempt to avoid cumulative overflow
                progress.update(task_id, completed=0, description=f"[cyan]{filename[:40]}[/cyan]")
                size_bytes = 0

                # Stream download
                async with client.stream("GET", url, follow_redirects=True) as response:
                    response.raise_for_status()

                    total_size = int(response.headers.get("content-length", 0))
                    if total_size > 0:
                        progress.update(task_id, total=total_size)
                    else:
                        progress.update(task_id, total=None) # Unknown size

                    with open(dest_path, "wb") as f:
                        async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                            f.write(chunk)
                            size_bytes += len(chunk)
                            progress.update(task_id, advance=len(chunk))

                if on_complete:
                    on_complete(filename, True, size_bytes)

                return DownloadResult(filename, True, size_bytes)

            except httpx.HTTPStatusError as e:
                if e.response.status_code in (502, 503, 504, 429) and attempt < MAX_RETRIES - 1:
                    wait = RETRY_DELAY * (2 ** attempt)
                    progress.update(task_id, description=f"[yellow]Retry {attempt+1}...[/yellow] {filename[:40]}")
                    await asyncio.sleep(wait)
                    if dest_path.exists():
                        dest_path.unlink()
                    size_bytes = 0
                    continue
                
                error_msg = f"HTTP {e.response.status_code}"
                log.warning(f"Download failed: {filename} - {error_msg}")
                if dest_path.exists():
                    dest_path.unlink()
                if on_complete:
                    on_complete(filename, False, 0, error_msg)
                return DownloadResult(filename, False, 0, error_msg)

            except Exception as e:
                if attempt < MAX_RETRIES - 1:
                    wait = RETRY_DELAY * (2 ** attempt)
                    progress.update(task_id, description=f"[yellow]Retry {attempt+1}...[/yellow] {filename[:40]}")
                    await asyncio.sleep(wait)
                    if dest_path.exists():
                        dest_path.unlink()
                    size_bytes = 0
                    continue

                error_msg = str(e)[:50]
                log.error(f"Download error: {filename} - {e}")
                if dest_path.exists():
                    dest_path.unlink()
                if on_complete:
                    on_complete(filename, False, 0, error_msg)
                return DownloadResult(filename, False, 0, error_msg)

    def _format_size(self, bytes: int) -> str:
        """Format bytes to human readable."""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if bytes < 1024:
                return f"{bytes:.1f} {unit}"
            bytes /= 1024
        return f"{bytes:.1f} TB"