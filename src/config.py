from rich.theme import Theme
from rich.console import Console

# --- Constants & Config ---
VERSION = "2.2.0"
BUNKR_API = "https://apidl.bunkr.ru/api/_001_v2"
_KEY_DIVISOR = 3600
_KEY_PREFIX = "SECRET_KEY_"
MAX_RETRIES = 5
RETRY_DELAY = 2  # base delay in seconds
ALLOWED_EXTENSIONS = ('.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.zip', '.rar', '.7z', '.tar', '.gz')

# UI Styling - Cyber-Neon Theme (CLI)
custom_theme = Theme({
    "info": "cyan",
    "warning": "yellow",
    "error": "bold red",
    "success": "bold green",
    "highlight": "bold magenta",
    "neon": "bold #00f2fe",
    "purple": "#bf5af2",
    "dim": "grey50",
    "gold": "#FFD700",
    "cyber_pink": "bold #FF00E5",
    "cyber_blue": "bold #00E5FF",
    "muted": "grey30"
})

console = Console(theme=custom_theme)

# GUI Color Palette (used by dark_theme.py)
GUI_COLORS = {
    "bg_dark": "#1e1e2e",
    "bg_card": "#252535",
    "accent_pink": "#FF00E5",
    "accent_blue": "#00E5FF",
    "success": "#00f2fe",
    "error": "#ff4444",
}
