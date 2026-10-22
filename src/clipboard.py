"""Copy invitation using the logged-in user's OS clipboard, without shell interpolation."""
import asyncio
import re
import shutil
import subprocess
import sys

async def copy_invite(text):
    if not isinstance(text, str) or not re.fullmatch(r'(?:SB[12]|SBM1)\.[A-Za-z0-9_-]{20,50000}', text):
        raise ValueError("Сначала создай корректное приглашение.")
    kwargs = {}
    if sys.platform == "win32":
        script = '[Console]::InputEncoding=New-Object System.Text.UTF8Encoding; $value=[Console]::In.ReadToEnd(); Set-Clipboard -Value $value -ErrorAction Stop'
        args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script]
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    elif sys.platform == "darwin": args = ["/usr/bin/pbcopy"]
    elif shutil.which("wl-copy"): args = [shutil.which("wl-copy")]
    elif shutil.which("xclip"): args = [shutil.which("xclip"), "-selection", "clipboard"]
    elif shutil.which("xsel"): args = [shutil.which("xsel"), "--clipboard", "--input"]
    else: raise ValueError("Нет системного буфера обмена. Установи wl-clipboard для Wayland или xclip для X11; можно выделить код и нажать Ctrl+C.")
    process = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, **kwargs)
    try: await asyncio.wait_for(process.communicate(text.encode("utf-8")), 6)
    except asyncio.TimeoutError:
        process.kill(); await process.wait(); raise ValueError("Буфер обмена не ответил. Попробуй ещё раз или скопируй выделенный код.")
    except asyncio.CancelledError:
        if process.returncode is None: process.kill(); await process.wait()
        raise
    if process.returncode: raise ValueError("Система отклонила копирование. Попробуй ещё раз или скопируй выделенный код.")
