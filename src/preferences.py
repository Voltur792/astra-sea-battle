"""Small per-plugin UI preferences, independent of revision-checked games."""
import json
import os
import re
import tempfile
import threading
from .storage import data_root

_LOCK = threading.RLock()
DEFAULTS = {"mode": "", "nickname": "", "alert": "sound", "notifications": True}

def nickname(value):
    if not isinstance(value, str):
        return ""
    return re.sub(r'[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]', '', value).strip()[:32]

def _path():
    return data_root("sea-battle", "SEA_BATTLE_DATA_DIR") / "preferences.json"

def load():
    with _LOCK:
        result = dict(DEFAULTS)
        path = _path()
        if path.exists():
            if path.stat().st_size > 8192:
                raise ValueError("Файл настроек слишком большой.")
            saved = json.loads(path.read_text(encoding="utf-8"))
            result.update(_validate(saved))
        return result

def _validate(patch):
    if not isinstance(patch, dict):
        raise ValueError("Некорректные настройки.")
    result = {}
    if "mode" in patch:
        if patch["mode"] not in ("", "plugin", "ai", "online"):
            raise ValueError("Неизвестный режим игры.")
        result["mode"] = patch["mode"]
    if "nickname" in patch:
        result["nickname"] = nickname(patch["nickname"])
    if "alert" in patch:
        if patch["alert"] not in ("sound", "voice", "silent"):
            raise ValueError("Неизвестный сигнал.")
        result["alert"] = patch["alert"]
    if "notifications" in patch:
        if type(patch["notifications"]) is not bool:
            raise ValueError("Некорректное значение уведомлений.")
        result["notifications"] = patch["notifications"]
    return result

def update(patch):
    with _LOCK:
        values = load()
        values.update(_validate(patch))
        path = _path(); path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix="preferences-", suffix=".json", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(values, stream, ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
        return values
