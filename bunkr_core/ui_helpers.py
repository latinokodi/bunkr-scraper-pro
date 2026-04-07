import sys
import json

try:
    from tqdm import tqdm
    TQDM_AVAILABLE = True
except ImportError:
    TQDM_AVAILABLE = False


class FallbackBar:
    """Simple text-based progress bar used when tqdm is unavailable."""
    def __init__(self, total=0, desc="", unit="B", unit_scale=True, disable=False, **_):
        self.total       = total
        self.desc        = desc
        self.n           = 0
        self._last_pct   = -1
        self.disable     = disable

    def update(self, n):
        self.n += n
        if self.total > 0 and not self.disable:
            pct = int(self.n / self.total * 100)
            if pct != self._last_pct and pct % 10 == 0:
                bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
                mb  = self.n / 1_048_576
                print(f"\r  [{bar}] {pct:3d}%  {mb:.1f} MB", end="", flush=True)
                self._last_pct = pct

    def close(self):
        if self.total > 0 and not self.disable:
            print()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def get_progress_bar(total, desc, unit="B", disable=False):
    """Factory to return either a tqdm bar or a FallbackBar."""
    if TQDM_AVAILABLE:
        return tqdm(
            total=total,
            desc=desc,
            unit=unit,
            unit_scale=True,
            unit_divisor=1024,
            dynamic_ncols=True,
            bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}, {rate_fmt}]",
            colour="cyan",
            disable=disable
        )
    return FallbackBar(total=total, desc=desc, unit=unit, disable=disable)
