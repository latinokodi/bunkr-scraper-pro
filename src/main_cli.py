"""
BunkrScr CLI - Shell-style album parser
Supports IDM queue and Direct HTTP download
"""
import sys
import asyncio
import re
import time
from pathlib import Path
from typing import List, Optional

import httpx
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.align import Align
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from rich.columns import Columns
from rich.box import ROUNDED

import questionary
from questionary import Style

from src.core.extractor import BunkrExtractor
from src.utils.idm import IDMManager
from src.utils.downloader import DirectDownloader
from src.utils.history import HistoryManager
from src.utils.settings import SettingsManager

console = Console()

# Custom questionary style
Q_STYLE = Style([
    ('qmark', 'fg:#FF00FF'),
    ('question', 'fg:#ffffff bold'),
    ('answer', 'fg:#00FFFF bold'),
    ('pointer', 'fg:#00FFFF bold'),
    ('highlighted', 'fg:#00FFFF bold'),
    ('selected', 'fg:#00FFFF'),
])

VERSION = "2.1"

VIDEO_TYPES = ['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.ts']
ARCHIVE_TYPES = ['.zip', '.rar', '.7z', '.tar', '.gz']
ALL_TYPES = VIDEO_TYPES + ARCHIVE_TYPES

DOWNLOAD_MODES = ["IDM", "Direct"]


class BunkrShell:
    """Shell-style interface for BunkrScr."""

    def __init__(self):
        self.summary_data = []
        self.last_report: Optional[str] = None
        self.dest_path = "IDM Defaults"
        self.file_types = ALL_TYPES
        self.download_mode = "Direct"  # Default to Direct (works without IDM)
        self.settings = SettingsManager()
        self.history = HistoryManager()
        self.idm = IDMManager()
        max_concurrent = self.settings.get_max_concurrent() or 3
        self.direct_dl = DirectDownloader(console, max_concurrent=max_concurrent)
        self.client = None
        self.extractor = None
        self.last_scraped_url: Optional[str] = None
        self.last_resolved_url: Optional[str] = None

    def setup(self):
        """Initialize components."""
        saved_path = self.settings.get_download_path()
        if saved_path:
            self.dest_path = saved_path

        saved_types = self.settings.get_selected_filetypes()
        if saved_types:
            self.file_types = saved_types

        saved_mode = self.settings.get("download_mode")
        if saved_mode in DOWNLOAD_MODES:
            self.download_mode = saved_mode

        # HTTP client
        self.client = httpx.AsyncClient(
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://bunkr.cr/",
            },
            follow_redirects=True,
            timeout=30,
        )
        self.extractor = BunkrExtractor(self.client)
        self.direct_dl.client = self.client

    def print_header(self):
        """ASCII header."""
        console.print("")
        console.print(Align.center("[bold magenta]BUNKRSCR[/bold magenta]"))
        mode_color = "cyan" if self.download_mode == "Direct" else "green"
        console.print(Align.center(f"[dim]v{VERSION}[/dim] | [{mode_color}]{self.download_mode} Download[/{mode_color}]"))
        console.print("")

    def print_startup_audit(self):
        """Show system status."""
        if self.download_mode == "IDM":
            idm_status = f"[green]IDM[/green]\n[dim]{self.idm.exe.name if self.idm.exe else 'Not Found'}[/dim]" if self.idm.exe else "[red]IDM[/red]\n[dim]Not Detected[/dim]"
        else:
            idm_status = "[cyan]DIRECT[/cyan]\n[dim]HTTP Downloader[/dim]"

        panels = [
            Panel(idm_status, border_style="dim", expand=True),
            Panel(f"[cyan]HISTORY[/cyan]\n[white]{len(self.history.processed)}[/white] Records", border_style="dim", expand=True),
            Panel(f"[cyan]CONCURRENT[/cyan]\n[white]{self.direct_dl.max_concurrent}[/white] slots", border_style="dim", expand=True),
        ]

        console.print(Panel(
            Columns(panels, equal=True),
            title="[bold green]SYSTEM READY[/bold green]",
            border_style="magenta",
            padding=(0, 1)
        ))

    def print_last_report(self):
        """Show last task report if available."""
        if self.last_report:
            console.print(self.last_report)

    def print_help(self):
        """Command reference."""
        table = Table(
            title="[cyan]COMMANDS[/cyan]",
            box=ROUNDED,
            border_style="magenta",
            header_style="bold magenta"
        )
        table.add_column("Command", style="cyan")
        table.add_column("Action", style="white")
        table.add_column("Info", style="dim")

        table.add_row("/help", "Show this reference", "Info")
        table.add_row("/mode", "Switch IDM / Direct download", "Config")
        table.add_row("/slots", "Change max concurrent downloads (1-5)", "Config")
        table.add_row("/types", "Change file type filter", "Config")
        table.add_row("/path", "Change download folder", "Config")
        table.add_row("/clear", "Wipe download history", "System")
        table.add_row("/status", "Show current config", "Info")
        table.add_row("/exit", "Quit application", "System")
        table.add_row("<URL>", "Paste album link to process", "Action")

        console.print(Align.center(table))

    def print_status(self):
        """Show current configuration."""
        mode_color = "cyan" if self.download_mode == "Direct" else "green"
        console.print(Panel(
            f"[cyan]Download Mode:[/cyan] [{mode_color}]{self.download_mode}[/{mode_color}]\n"
            f"[cyan]Download Path:[/cyan] [white]{self.dest_path}[/white]\n"
            f"[cyan]Max Concurrent:[/cyan] [white]{self.direct_dl.max_concurrent}[/white] simultaneous\n"
            f"[cyan]File Types:[/cyan] [white]{', '.join(self.file_types[:5])}...[/white]\n"
            f"[cyan]History:[/cyan] [white]{len(self.history.processed)}[/white] records",
            title="[bold cyan]CURRENT CONFIG[/bold cyan]",
            border_style="magenta"
        ))

    async def get_input(self) -> str:
        """Prompt for input."""
        hints = [
            "[cyan]/mode[/cyan] [dim]IDM/Direct[/dim]",
            "[cyan]/slots[/cyan] [dim]1-5[/dim]",
            "[cyan]/types[/cyan] [dim]filter[/dim]",
            "[cyan]/exit[/cyan] [dim]quit[/dim]"
        ]
        console.print(f"\n[cyan]QUICK ACTIONS:[/cyan] {' [dim]•[/dim] '.join(hints)}")

        try:
            return await questionary.text(
                " > ",
                instruction=f"┌──( bunkr@parser ) [{self.download_mode.lower()}] at {self.dest_path[:40]}\n└─",
                style=Q_STYLE
            ).ask_async()
        except EOFError:
            return "/exit"
        except Exception:
            return ""

    async def ask_confirm(self, message: str, default: bool = True) -> bool:
        """Yes/No selection."""
        choice = await questionary.select(
            message,
            choices=["Yes", "No"],
            default="Yes" if default else "No",
            style=Q_STYLE,
            qmark=">"
        ).ask_async()
        return choice == "Yes"

    async def change_slots(self):
        """Change max concurrent downloads."""
        choice = await questionary.select(
            "Max concurrent downloads:",
            choices=["1", "2", "3", "4", "5"],
            default=str(self.direct_dl.max_concurrent),
            style=Q_STYLE,
            qmark=">"
        ).ask_async()

        if choice:
            new_val = int(choice)
            self.direct_dl.max_concurrent = new_val
            self.direct_dl.semaphore = asyncio.Semaphore(new_val)
            self.settings.set("max_concurrent_downloads", new_val)
            self.last_report = f"[green]✓ Concurrent slots: {new_val}[/green]"

    async def select_mode(self):
        """Switch download mode."""
        choice = await questionary.select(
            "Select download mode:",
            choices=DOWNLOAD_MODES,
            default=self.download_mode,
            style=Q_STYLE,
            qmark=">"
        ).ask_async()

        if choice:
            self.download_mode = choice
            self.settings.set("download_mode", choice)

            if choice == "IDM" and not self.idm.exe:
                self.last_report = "[yellow]⚠ IDM not detected - downloads may fail[/yellow]"
            else:
                self.last_report = f"[green]✓ Mode: {choice}[/green]"

    async def select_types(self):
        """File type selection."""
        choice = await questionary.select(
            "Select file types:",
            choices=[
                "Videos only",
                "Archives only",
                "All types",
                "Custom...",
            ],
            style=Q_STYLE,
            qmark=">"
        ).ask_async()

        if choice == "Videos only":
            self.file_types = VIDEO_TYPES
        elif choice == "Archives only":
            self.file_types = ARCHIVE_TYPES
        elif choice == "All types":
            self.file_types = ALL_TYPES
        elif choice == "Custom...":
            selected = await questionary.checkbox(
                "Select types:",
                choices=[
                    questionary.Choice(".mp4", checked=True),
                    questionary.Choice(".mkv", checked=True),
                    questionary.Choice(".mov"),
                    questionary.Choice(".avi"),
                    questionary.Choice(".wmv"),
                    questionary.Choice(".flv"),
                    questionary.Choice(".webm"),
                    questionary.Choice(".zip", checked=True),
                    questionary.Choice(".rar", checked=True),
                    questionary.Choice(".7z"),
                ],
                style=Q_STYLE
            ).ask_async()
            if selected:
                self.file_types = selected

        self.settings.update_selected_filetypes(self.file_types)
        self.last_report = "[green]✓ Types updated[/green]"

    async def change_path(self):
        """Change download path."""
        new_path = await questionary.text(
            "New download folder:",
            default=self.dest_path,
            style=Q_STYLE,
            qmark=">"
        ).ask_async()

        if new_path:
            self.dest_path = new_path
            self.settings.update_download_path(new_path)
            Path(new_path).mkdir(parents=True, exist_ok=True)
            self.last_report = f"[green]✓ Path updated: {new_path}[/green]"

    def filter_files(self, files: list) -> list:
        """Filter by file types."""
        return [
            f for f in files
            if any(f.get('filename', '').lower().endswith(ext) for ext in self.file_types)
        ]

    def add_to_summary(self, name, found, resolved, downloaded, skipped, time_taken):
        """Add album to summary."""
        self.summary_data.append({
            "name": name,
            "found": found,
            "resolved": resolved,
            "downloaded": downloaded,
            "skipped": skipped,
            "time": time_taken,
        })

    def build_summary_report(self, total_time) -> str:
        """Build summary report as string for display."""
        if not self.summary_data:
            return ""

        lines = []
        lines.append("\n[bold cyan]LAST TASK REPORT[/bold cyan]")

        for s in self.summary_data:
            display_name = s["name"][:25] + "..." if len(s["name"]) > 25 else s["name"]
            lines.append(f"  [white]{display_name}[/white] | [cyan]{s['found']}[/cyan] found → [green]{s['downloaded']}[/green] downloaded | [dim]{s['time']:.1f}s[/dim]")

        total_downloaded = sum(s["downloaded"] for s in self.summary_data)
        total_skipped = sum(s["skipped"] for s in self.summary_data)
        lines.append("[dim]─────────────────────────────[/dim]")
        lines.append(f"  [dim]Total:[/dim] [green]{total_downloaded}[/green] downloaded, [yellow]{total_skipped}[/yellow] skipped | [dim]{total_time:.1f}s[/dim]")
        
        if self.last_scraped_url:
            lines.append(f"  [dim]Last Album Scraped:[/dim] [cyan]{self.last_scraped_url}[/cyan]")
        if self.last_resolved_url:
            trunc_url = self.last_resolved_url
            if len(trunc_url) > 75:
                trunc_url = trunc_url[:72] + "..."
            lines.append(f"  [dim]Last Direct URL Scraped:[/dim] [cyan]{trunc_url}[/cyan]")

        return "\n".join(lines)

    async def process_url(self, url: str, force: bool = False):
        """Process single album URL."""
        album_start = time.perf_counter()
        self.last_scraped_url = url

        # Fetch album
        with console.status("[cyan]Fetching album...[/cyan]"):
            album = await self.extractor.get_all_album_files(url)

        if not album or not album["files"]:
            self.last_report = f"[red]✗ No files found: {url}[/red]"
            return

        album_name = album["name"]
        entries = album["files"]

        console.print(f"\n[magenta]» ALBUM:[/magenta] [white]{album_name}[/white] | [dim]{len(entries)} files[/dim]")

        # Resolve links with progress
        with Progress(
            SpinnerColumn(),
            TextColumn("[cyan]{task.description}[/cyan]"),
            BarColumn(complete_style="magenta"),
            TaskProgressColumn(),
            console=console,
            transient=True,
        ) as progress:
            task = progress.add_task("Resolving links...", total=len(entries))

            tasks = [self.extractor.resolve_link(e) for e in entries]

            async def tracked(t):
                res = await t
                progress.advance(task)
                return res

            results = await asyncio.gather(*[tracked(t) for t in tasks])
            resolved = [r for r in results if r]
            if resolved:
                self.last_resolved_url = resolved[-1]["url"]

        if not resolved:
            self.last_report = f"[red]✗ Resolution failed for: {album_name}[/red]"
            return

        # Filter by type
        filtered = self.filter_files(resolved)

        if not filtered:
            self.last_report = f"[yellow]⊗ No matching file types in: {album_name}[/yellow]"
            return

        # Determine target folder
        target_folder = Path(self.dest_path) / album_name

        # Check history or disk
        if force:
            new_files = []
            skipped = 0
            for f in filtered:
                filename = f.get('filename', '')
                if (target_folder / filename).exists():
                    skipped += 1
                else:
                    new_files.append(f)
        else:
            new_files, skipped = self.history.filter_new_files(filtered)

        if not new_files:
            album_time = time.perf_counter() - album_start
            self.add_to_summary(album_name, len(entries), len(resolved), 0, len(filtered), album_time)
            return

        # Download based on mode
        if self.download_mode == "Direct":
            # Direct HTTP download with per-file progress
            console.print(f"\n[cyan]Downloading {len(new_files)} files...[/cyan]")

            items = [{'url': f.get('url'), 'filename': f.get('filename')} for f in new_files]
            results = await self.direct_dl.download_batch(items, target_folder)

            downloaded = sum(1 for r in results if r.success)

            # Save history
            for f in new_files:
                if any(r.filename == f.get('filename') and r.success for r in results):
                    self.history.mark_downloaded(f.get('url'), url, album_name)

            album_time = time.perf_counter() - album_start
            self.add_to_summary(album_name, len(entries), len(resolved), downloaded, skipped, album_time)

        elif self.download_mode == "IDM":
            if not self.idm.exe:
                self.last_report = "[red]✗ IDM not available - use /mode to switch to Direct[/red]"
                return

            items = [{'url': f.get('url'), 'filename': f.get('filename')} for f in new_files]

            with console.status("[magenta]Pushing to IDM...[/magenta]"):
                success = self.idm.add_to_queue(items, str(target_folder))

            if success:
                for f in new_files:
                    self.history.mark_downloaded(f.get('url'), url, album_name)

                album_time = time.perf_counter() - album_start
                self.add_to_summary(album_name, len(entries), len(resolved), len(new_files), skipped, album_time)
            else:
                self.last_report = f"[red]✗ IDM queue failed for: {album_name}[/red]"

    async def process_urls(self, urls_data: List[tuple]):
        """Process multiple URLs."""
        self.summary_data = []
        batch_start = time.perf_counter()

        for url, force in urls_data:
            if not url.startswith("http"):
                url = f"https://{url}"
            await self.process_url(url, force=force)

        batch_time = time.perf_counter() - batch_start
        report = self.build_summary_report(batch_time)
        if report:
            self.last_report = report

    async def cleanup(self):
        """Close client."""
        if self.client:
            await self.client.aclose()


async def main():
    """Main entry point."""
    shell = BunkrShell()
    shell.setup()

    # Initial setup if no path saved
    if not shell.settings.get_download_path():
        console.print(Panel(
            "[white]Set a download folder for your albums[/white]",
            title="[cyan]SETUP[/cyan]",
            border_style="magenta"
        ))
        path_input = await questionary.text(
            "Download folder:",
            default=str(Path.home()),
            style=Q_STYLE,
            qmark=">"
        ).ask_async()

        if path_input:
            shell.dest_path = path_input
            shell.settings.update_download_path(path_input)
            Path(path_input).mkdir(parents=True, exist_ok=True)

    # Main loop
    while True:
        console.clear()
        shell.print_header()
        shell.print_startup_audit()
        shell.print_last_report()

        raw_input = await shell.get_input()

        if not raw_input:
            continue

        # Command parser
        if raw_input.startswith("/"):
            cmd = raw_input.lower().split()[0]

            if cmd == "/exit":
                break
            elif cmd == "/help":
                shell.last_report = None
                console.clear()
                shell.print_header()
                shell.print_help()
            elif cmd == "/clear":
                if await shell.ask_confirm("Wipe all download history?", default=False):
                    shell.history.clear_history()
                    shell.last_report = "[green]✓ History cleared[/green]"
            elif cmd == "/mode":
                await shell.select_mode()
            elif cmd == "/slots":
                await shell.change_slots()
            elif cmd == "/path":
                await shell.change_path()
            elif cmd == "/types":
                await shell.select_types()
            elif cmd == "/status":
                shell.last_report = None
                console.clear()
                shell.print_header()
                shell.print_status()
            else:
                shell.last_report = f"[red]Unknown command: {cmd}[/red] | [dim]Type /help[/dim]"
            continue

        # URL processor
        urls = [u.strip() for u in re.split(r"[\s,]+", raw_input) if u.strip()]

        if not urls:
            continue

        urls_to_process = []
        for url in urls:
            if not url.startswith("http"):
                url = f"https://{url}"

            if shell.history.is_processed(url):
                console.print(f"[yellow]⊗ Already processed: {url.split('/')[-1]}[/yellow]")
                if await shell.ask_confirm("Process again?", default=False):
                    urls_to_process.append((url, True))
            else:
                urls_to_process.append((url, False))

        if urls_to_process:
            await shell.process_urls(urls_to_process)

    await shell.cleanup()
    console.print("\n[magenta]Goodbye![/magenta]")
    await asyncio.sleep(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted[/yellow]")
        sys.exit(0)