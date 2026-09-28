"""Regenerate the Astra navigation icon from the store icon."""

import base64
import io
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
SIDE = 48
image = Image.open(ROOT / "icon.png").convert("RGBA").resize(
    (SIDE, SIDE), Image.Resampling.LANCZOS
)
buffer = io.BytesIO()
image.save(buffer, "PNG", optimize=True)
encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIDE} {SIDE}" '
    'role="img" aria-label="Морской бой">'
    f'<image x="0" y="0" width="{SIDE}" height="{SIDE}" '
    f'href="data:image/png;base64,{encoded}"/></svg>'
)
module = '"""Navigation icon embedded from the plugin store icon."""\n\nTAB_ICON_SVG = ' + repr(svg) + "\n"
(ROOT / "src" / "tab_icon.py").write_text(module, encoding="utf-8")
print(f"Generated src/tab_icon.py from icon.png ({(ROOT / 'icon.png').stat().st_size} bytes)")
