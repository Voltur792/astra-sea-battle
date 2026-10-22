"""Atomic, revision-checked storage for one resumable network match.

The file is separate from local/AI games. No provider account secrets belong here.
"""
import json
import os
from pathlib import Path
import re
import tempfile
import threading

from .storage import data_root
from .preferences import nickname

_LOCK = threading.RLock()
_LIMIT = 512 * 1024


def _path() -> Path:
    return data_root("sea-battle", "SEA_BATTLE_DATA_DIR") / "online.json"


def _config(value):
    if not isinstance(value, dict):
        raise ValueError("Некорректные настройки сети.")
    result = {key: value.get(key, "") for key in ("key", "app", "turn")}
    if not all(isinstance(v, str) for v in result.values()):
        raise ValueError("Настройки сети должны быть строками.")
    if result["key"] and not re.fullmatch(r"pk_live_[A-Za-z0-9_-]{8,180}", result["key"]):
        raise ValueError("Разрешён только публичный ключ pk_live_… .")
    if result["app"] and not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", result["app"]):
        raise ValueError("Неверное имя проекта Metered.")
    if result["turn"] and (not result["app"] or not re.fullmatch(r"[A-Za-z0-9_-]{8,240}", result["turn"])):
        raise ValueError("Неверный ключ отдельного TURN credential.")
    return result


def _session(value):
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("v") != 1:
        raise ValueError("Неизвестная версия сетевого сохранения.")
    for key in ("room", "secret", "id"):
        if not isinstance(value.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", value[key]):
            raise ValueError("Повреждены данные сетевой партии.")
    if value.get("role") not in ("host", "guest"):
        raise ValueError("Неизвестная роль игрока.")
    if not re.fullmatch(r"(?:[a-f0-9]{64})?", value.get("opponent", "")):
        raise ValueError("Повреждён идентификатор соперника.")
    result = {key: value[key] for key in ("v", "room", "secret", "id", "role")}
    result["opponent"] = value.get("opponent", "")
    result["name"] = nickname(value.get("name"))
    result["opponent_name"] = nickname(value.get("opponent_name"))
    result["config"] = _config(value.get("config"))
    match = value.get("match")
    if match is not None and (not isinstance(match, dict) or not isinstance(match.get("history"), list)
                              or len(match["history"]) > 430):
        raise ValueError("Повреждён журнал сетевой партии.")
    result["match"] = match
    return result


def load() -> dict:
    with _LOCK:
        path = _path()
        if not path.exists():
            return {"revision": 0, "config": _config({}), "session": None}
        if path.stat().st_size > _LIMIT:
            raise ValueError("Сетевое сохранение слишком большое; исходный файл оставлен без изменений.")
        saved = json.loads(path.read_text(encoding="utf-8"))
        if type(saved.get("revision")) is not int or saved["revision"] < 0:
            raise ValueError("Повреждена версия сетевого сохранения.")
        return {"revision": saved["revision"], "config": _config(saved.get("config")),
                "session": _session(saved.get("session"))}


def save(revision, config, session) -> dict:
    with _LOCK:
        current = load()
        if type(revision) is not int or revision != current["revision"]:
            raise ValueError("Партия изменена в другом окне. Закрой вторую вкладку и заново открой Морской бой.")
        result = {"revision": revision + 1, "config": _config(config), "session": _session(session)}
        raw = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if len(raw.encode("utf-8")) > _LIMIT:
            raise ValueError("Превышен размер сетевого сохранения.")
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix="online-", suffix=".json", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {"revision": result["revision"]}
