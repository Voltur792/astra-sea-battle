"""Best-effort local alerts; never executes a peer-supplied name as code."""
import asyncio
import logging
from pathlib import Path
import shutil
import sys
import subprocess
from contextlib import nullcontext

log = logging.getLogger(__name__)
TEXT = "Соперник найден. Открой Морской бой в Astra и расставь корабли."

async def _run(*args):
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, **kwargs)
    try: await asyncio.wait_for(process.wait(), 8)
    except asyncio.TimeoutError:
        process.kill(); await process.wait()
    except asyncio.CancelledError:
        if process.returncode is None: process.kill(); await process.wait()
        raise

async def sound():
    if sys.platform == "win32":
        import winsound
        await asyncio.to_thread(winsound.MessageBeep, winsound.MB_ICONASTERISK)
    elif sys.platform == "darwin":
        await _run("/usr/bin/osascript", "-e", "beep 2")
    else:
        player = shutil.which("paplay")
        sample = Path("/usr/share/sounds/freedesktop/stereo/complete.oga")
        if player and sample.is_file(): await _run(player, str(sample))

async def desktop():
    if sys.platform == "win32":
        # Constant PowerShell source only. No nickname, paths or network data interpolated.
        script = """Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notice=New-Object System.Windows.Forms.NotifyIcon
try {
 $notice.Icon=[System.Drawing.SystemIcons]::Information
 $notice.Visible=$true
 $notice.BalloonTipTitle='Морской бой · Astra'
 $notice.BalloonTipText='Соперник найден. Открой Морской бой в Astra и расставь корабли.'
 $notice.ShowBalloonTip(5000)
 Start-Sleep -Seconds 6
} finally { $notice.Dispose() }
"""
        import base64
        await _run("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", base64.b64encode(script.encode("utf-16-le")).decode())
    elif sys.platform == "darwin":
        await _run("/usr/bin/osascript", "-e", 'display notification "Соперник найден. Открой Морской бой в Astra." with title "Морской бой · Astra"')
    else:
        executable = shutil.which("notify-send")
        if executable: await _run(executable, "Морской бой · Astra", TEXT)

async def announce(host, settings, model_lock=None):
    tasks = []
    if settings["notifications"]: tasks.append(desktop())
    async def audio():
        if settings["alert"] == "voice":
            try:
                if host is None: raise RuntimeError("Host unavailable")
                answered = False
                async with asyncio.timeout(45):
                    async with model_lock or nullcontext():
                        async for chunk in host.send_chat_message(
                            "Это уведомление Морского боя, а не игровая команда. Не вызывай инструменты. Ответь только одной фразой: " + TEXT,
                            voice_enabled=True):
                            kind = chunk.WhichOneof("content")
                            if kind == "error": raise RuntimeError("Voice chat failed")
                            if kind == "text" and chunk.text: answered = True
                            if kind == "done": break
                if not answered: raise RuntimeError("Empty voice response")
                return
            except Exception:
                log.warning("Match voice alert unavailable; using system sound")
        if settings["alert"] in ("sound", "voice"): await sound()
    tasks.append(audio())
    for result in await asyncio.gather(*tasks, return_exceptions=True):
        if isinstance(result, Exception): log.warning("Match alert unavailable: %s", type(result).__name__)
