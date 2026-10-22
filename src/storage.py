"""User-writable game storage, retaining existing saves after an upgrade."""
import os
from pathlib import Path
import sys


def data_root(name: str, override: str) -> Path:
    if os.environ.get(override):
        return Path(os.environ[override])
    home = Path.home()
    legacy = Path(os.environ.get("APPDATA") or home / ".local" / "share") / name
    if sys.platform == "win32":
        return legacy
    if sys.platform == "darwin":
        target = home / "Library" / "Application Support" / name
    else:
        xdg = Path(os.environ.get("XDG_DATA_HOME", ""))
        target = (xdg if xdg.is_absolute() else home / ".local" / "share") / name
    if not (target / "games.json").exists() and (legacy / "games.json").exists():
        return legacy
    return target
