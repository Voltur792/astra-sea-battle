"""Rules and persistent state for a text-first Battleship game."""

from __future__ import annotations

import json
import os
import random
import secrets
import tempfile
import threading
from pathlib import Path

SIZE = 10
FLEET = (4, 3, 3, 2, 2, 2, 1, 1, 1, 1)
LETTERS = "АБВГДЕЖЗИК"
LATIN = "ABCDEFGHIJ"
_LOCK = threading.RLock()


def _state_path() -> Path:
    root = os.environ.get("SEA_BATTLE_DATA_DIR")
    if not root:
        root = str(Path(os.environ.get("APPDATA") or Path.home() / ".local" / "share") / "sea-battle")
    return Path(root) / "games.json"


def _load() -> dict:
    path = _state_path()
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _save(games: dict) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="games-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(games, out, ensure_ascii=False, separators=(",", ":"))
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _key(cell: tuple[int, int]) -> str:
    return f"{cell[0]},{cell[1]}"


def _unkey(value: str) -> tuple[int, int]:
    row, col = value.split(",")
    return int(row), int(col)


def _label(cell: tuple[int, int]) -> str:
    return f"{LETTERS[cell[1]]}{cell[0] + 1}"


def parse_cell(value: str) -> tuple[int, int]:
    value = value.strip().upper().replace("-", "").replace(" ", "").replace(",", "")
    if len(value) < 2:
        raise ValueError("Укажи клетку, например Б7.")
    if value[0].isdigit():
        value = value[-1] + value[:-1]
    col = LETTERS.find(value[0])
    if col < 0:
        col = LATIN.find(value[0])
    if col < 0 or not value[1:].isdigit() or not 1 <= int(value[1:]) <= SIZE:
        raise ValueError("Клетка должна быть от А1 до К10 (можно A1–J10).")
    return int(value[1:]) - 1, col


def _neighbors(cell: tuple[int, int]):
    row, col = cell
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            nr, nc = row + dr, col + dc
            if 0 <= nr < SIZE and 0 <= nc < SIZE:
                yield nr, nc


def make_fleet(rng: random.Random) -> list[list[str]]:
    """Place the standard ten-ship fleet with no touching, even diagonally."""
    for _ in range(100):
        ships: list[list[str]] = []
        blocked: set[tuple[int, int]] = set()
        for length in FLEET:
            choices = []
            for row in range(SIZE):
                for col in range(SIZE):
                    for dr, dc in ((1, 0), (0, 1)):
                        cells = [(row + dr * i, col + dc * i) for i in range(length)]
                        if all(0 <= r < SIZE and 0 <= c < SIZE and (r, c) not in blocked for r, c in cells):
                            choices.append(cells)
            if not choices:
                break
            cells = rng.choice(choices)
            ships.append([_key(cell) for cell in cells])
            for cell in cells:
                blocked.update(_neighbors(cell))
        if len(ships) == len(FLEET):
            return ships
    raise RuntimeError("Не удалось расставить флот.")


def parse_bot_fleet(value: str) -> list[list[str]]:
    """Validate a fleet proposed by Astra as semicolon-separated ranges."""
    raw_ships = [part.strip() for part in value.split(";") if part.strip()]
    if len(raw_ships) != len(FLEET):
        raise ValueError("Нужно указать 10 кораблей: длины 4, 3, 3, 2, 2, 2, 1, 1, 1 и 1.")
    ships: list[list[str]] = []
    occupied: set[tuple[int, int]] = set()
    for raw in raw_ships:
        ends = [point.strip() for point in raw.split("-")]
        if len(ends) not in (1, 2):
            raise ValueError(f"Не понял координаты корабля «{raw}». Указывай прямые отрезки, например А1-А4.")
        start = parse_cell(ends[0])
        finish = parse_cell(ends[-1])
        if start[0] != finish[0] and start[1] != finish[1]:
            raise ValueError(f"Корабль «{raw}» должен стоять горизонтально или вертикально.")
        dr = (finish[0] > start[0]) - (finish[0] < start[0])
        dc = (finish[1] > start[1]) - (finish[1] < start[1])
        length = max(abs(finish[0] - start[0]), abs(finish[1] - start[1])) + 1
        cells = [(start[0] + dr * i, start[1] + dc * i) for i in range(length)]
        if any(cell in occupied for cell in cells):
            raise ValueError("Корабли не должны занимать одни и те же клетки.")
        if any(neighbor in occupied for cell in cells for neighbor in _neighbors(cell)):
            raise ValueError("Корабли не должны соприкасаться даже по диагонали.")
        occupied.update(cells)
        ships.append([_key(cell) for cell in cells])
    if sorted(map(len, ships)) != sorted(FLEET):
        raise ValueError("Длины кораблей должны быть 4, 3, 3, 2, 2, 2, 1, 1, 1 и 1 клеток.")
    return ships


def _ship_at(ships: list[list[str]], shot: str) -> list[str] | None:
    return next((ship for ship in ships if shot in ship), None)


def _all_sunk(ships: list[list[str]], shots: set[str]) -> bool:
    return all(set(ship) <= shots for ship in ships)


def _sunk_count(ships: list[list[str]], shots: list[str]) -> int:
    shot_set = set(shots)
    return sum(set(ship) <= shot_set for ship in ships)


LEGEND = "Обозначения: □ неизвестно, · мимо, ✕ попадание, ◆ потоплен, ■ твой корабль."


def _board(ships: list[list[str]], shots: list[str], show_ships: bool) -> str:
    shot_set = set(shots)
    occupied = {cell for ship in ships for cell in ship}
    sunk = {cell for ship in ships if set(ship) <= shot_set for cell in ship}
    lines = ["     " + " ".join(LETTERS)]
    for row in range(SIZE):
        cells = []
        for col in range(SIZE):
            key = _key((row, col))
            cells.append("◆" if key in sunk else "✕" if key in shot_set and key in occupied else "·" if key in shot_set else "■" if show_ships and key in occupied else "□")
        lines.append(f"{row + 1:>2} │ " + " ".join(cells))
    return "\n".join(lines)


def _map(ships: list[list[str]], shots: list[str], reveal: bool = False) -> list[list[str]]:
    """Return a UI-safe 10x10 map using semantic cell states."""
    shot_set = set(shots)
    occupied = {cell for ship in ships for cell in ship}
    sunk = {cell for ship in ships if set(ship) <= shot_set for cell in ship}
    result = []
    for row in range(SIZE):
        cells = []
        for col in range(SIZE):
            key = _key((row, col))
            if key in sunk:
                cells.append("sunk")
            elif key in shot_set and key in occupied:
                cells.append("hit")
            elif key in shot_set:
                cells.append("miss")
            elif reveal and key in occupied:
                cells.append("ship")
            else:
                cells.append("unknown")
        result.append(cells)
    return result


def ui_state(code: str = "") -> dict:
    """Return active game summaries and maps without leaking hidden ships."""
    with _LOCK:
        games = _load()
        summaries = []
        for game_code, saved in reversed(list(games.items())):
            bot_sunk = _sunk_count(saved["bot_ships"], saved["player_shots"])
            player_sunk = _sunk_count(saved["player_ships"], saved["bot_shots"])
            summaries.append({
                "code": game_code,
                "over": bool(saved["over"]),
                "winner": saved["winner"],
                "bot_placement": saved.get("bot_placement", "random"),
                "mode": saved.get("mode", "plugin"),
                "bot_pending": bool(saved.get("bot_pending", False)),
                "player_shots": len(saved["player_shots"]),
                "bot_shots": len(saved["bot_shots"]),
                "bot_sunk": bot_sunk,
                "player_sunk": player_sunk,
            })
        selected = games.get(code.strip().upper()) if code else None
        if selected is None and summaries:
            code = summaries[0]["code"]
            selected = games[code]
        if selected is None:
            return {"games": summaries, "selected": None}
        return {
            "games": summaries,
            "selected": {
                "code": code.strip().upper(),
                "over": bool(selected["over"]),
                "winner": selected["winner"],
                "bot_placement": selected.get("bot_placement", "random"),
                "mode": selected.get("mode", "plugin"),
                "bot_pending": bool(selected.get("bot_pending", False)),
                "player_shots": len(selected["player_shots"]),
                "bot_shots": len(selected["bot_shots"]),
                "bot_sunk": _sunk_count(selected["bot_ships"], selected["player_shots"]),
                "player_sunk": _sunk_count(selected["player_ships"], selected["bot_shots"]),
                "target_map": _map(selected["bot_ships"], selected["player_shots"], bool(selected["over"])),
                "own_map": _map(selected["player_ships"], selected["bot_shots"], True),
            },
        }


def _bot_shot(game: dict) -> tuple[str, str]:
    shots = set(game["bot_shots"])
    # Old saved games did not track what the bot had learned. Reconstruct that
    # information once so existing parties remain playable after upgrading.
    if "bot_hits" not in game:
        game["bot_hits"] = [shot for shot in game["bot_shots"] if _ship_at(game["player_ships"], shot)]
    if "bot_sunk" not in game:
        game["bot_sunk"] = [ship for ship in game["player_ships"] if set(ship) <= shots]
    sunk = {cell for ship in game["bot_sunk"] for cell in ship}
    unresolved = set(game["bot_hits"]) - sunk
    forbidden = set(shots)
    for hit in sunk:
        forbidden.update(_key(cell) for cell in _neighbors(_unkey(hit)))
    candidates = set()
    unresolved_cells = {_unkey(hit) for hit in unresolved}
    for hit in unresolved:
        row, col = _unkey(hit)
        horizontal = (row, col - 1) in unresolved_cells or (row, col + 1) in unresolved_cells
        vertical = (row - 1, col) in unresolved_cells or (row + 1, col) in unresolved_cells
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            cell = (row + dr, col + dc)
            if 0 <= cell[0] < SIZE and 0 <= cell[1] < SIZE and _key(cell) not in forbidden:
                # Two adjacent hits identify the direction of a ship.
                if not (horizontal or vertical) or (horizontal and dr == 0) or (vertical and dc == 0):
                    candidates.add(cell)
    if candidates:
        cell = random.choice(sorted(candidates))
    else:
        remaining = [(r, c) for r in range(SIZE) for c in range(SIZE) if _key((r, c)) not in forbidden]
        if not remaining:
            remaining = [(r, c) for r in range(SIZE) for c in range(SIZE) if _key((r, c)) not in shots]
        checkerboard = [cell for cell in remaining if (cell[0] + cell[1]) % 2 == 0]
        cell = random.choice(checkerboard or remaining)
    key = _key(cell)
    game["bot_shots"].append(key)
    ship = _ship_at(game["player_ships"], key)
    result = "мимо" if ship is None else "потопила корабль" if set(ship) <= set(game["bot_shots"]) else "попала"
    if ship is not None:
        game["bot_hits"].append(key)
        if result == "потопила корабль":
            game["bot_sunk"].append(ship)
    return _label(cell), result


def start(bot_fleet: str = "", mode: str = "plugin") -> str:
    mode = mode if mode in ("ai", "plugin") else "plugin"
    if mode == "ai" and not bot_fleet.strip():
        return "Для режима против ИИ нужна расстановка флота, выбранная моделью Astra."
    try:
        bot_ships = parse_bot_fleet(bot_fleet) if bot_fleet.strip() else None
    except ValueError as exc:
        return f"Не удалось начать партию: {exc} Проверь расстановку и попробуй ещё раз."
    with _LOCK:
        games = _load()
        code = secrets.token_hex(4).upper()
        while code in games:
            code = secrets.token_hex(4).upper()
        rng = random.Random(secrets.randbits(64))
        game = {
            "player_ships": make_fleet(rng),
            "bot_ships": bot_ships or make_fleet(rng),
            "bot_placement": "model" if bot_ships else "random",
            "mode": mode,
            "bot_pending": False,
            "player_shots": [],
            "bot_shots": [],
            "bot_hits": [],
            "bot_sunk": [],
            "over": False,
            "winner": "",
        }
        games[code] = game
        _save(games)
        placement = "Астра сама выбрала и проверила расстановку своего флота." if bot_ships else "Флот Астры расставлен автоматически."
        opponent = "Астра будет выбирать ответные выстрелы." if mode == "ai" else "Ответные выстрелы рассчитывает плагин."
        return (f"Морской бой начался. Код партии: {code}. {placement} {opponent}\n"
                "Ты ходишь первым: назови клетку, например Б7 (можно B7 или 7Б).\n\n"
                f"Твои корабли:\n{_board(game['player_ships'], [], True)}\n\n{LEGEND}")


def get_mode(code: str) -> str | None:
    with _LOCK:
        saved = _load().get(code.strip().upper())
        return saved.get("mode", "plugin") if saved else None


def fire_ai_player(code: str, coordinate: str) -> dict:
    """Apply the player's shot in model-opponent mode, deferring bot shots."""
    try:
        cell = parse_cell(coordinate)
    except ValueError as exc:
        return {"error": str(exc), "needs_bot": False}
    code = code.strip().upper()
    with _LOCK:
        games = _load()
        saved = games.get(code)
        if saved is None:
            return {"error": "Партия не найдена.", "needs_bot": False}
        if saved.get("mode", "plugin") != "ai":
            return {"error": "Эта партия запущена в режиме «Плагин».", "needs_bot": False}
        if saved["over"]:
            return {"error": "Партия уже завершена.", "needs_bot": False}
        if saved.get("bot_pending"):
            return {"error": "Астра ещё делает ответный ход. Дождись его или нажми «Повторить ход Астры».", "needs_bot": False}
        key = _key(cell)
        if key in saved["player_shots"]:
            return {"error": f"По {_label(cell)} уже стреляли. Выбери другую клетку.", "needs_bot": False}
        saved["player_shots"].append(key)
        ship = _ship_at(saved["bot_ships"], key)
        if _all_sunk(saved["bot_ships"], set(saved["player_shots"])):
            saved["over"] = True
            saved["winner"] = "ты"
            message = f"Твой выстрел {_label(cell)}: корабль потоплен. Ты победил!"
            needs_bot = False
        elif ship is not None:
            message = f"Твой выстрел {_label(cell)}: {'корабль потоплен' if set(ship) <= set(saved['player_shots']) else 'попадание'}. Стреляй ещё раз."
            needs_bot = False
        else:
            message = f"Твой выстрел {_label(cell)}: мимо. Теперь ход Астры."
            saved["bot_pending"] = True
            needs_bot = True
        _save(games)
        return {"message": message, "needs_bot": needs_bot, "over": bool(saved["over"])}


def ai_observation(code: str) -> dict | None:
    """Expose only information the AI has learned about the player's board."""
    code = code.strip().upper()
    with _LOCK:
        saved = _load().get(code)
        if saved is None or saved["over"] or not saved.get("bot_pending"):
            return None
        shots = list(saved["bot_shots"])
        hit_set = set(saved.get("bot_hits", []))
        sunk_set = {cell for ship in saved.get("bot_sunk", []) for cell in ship}
        observations = []
        for key in shots:
            result = "sunk" if key in sunk_set else "hit" if key in hit_set else "miss"
            observations.append([_label(_unkey(key)), result])
        return {
            "game_code": code,
            "shots": observations,
        }


def fire_ai_bot(code: str, coordinate: str) -> dict:
    """Record one AI-selected shot and report whether it retains the turn."""
    try:
        cell = parse_cell(coordinate)
    except ValueError as exc:
        return {"error": str(exc), "continues": False}
    code = code.strip().upper()
    with _LOCK:
        games = _load()
        saved = games.get(code)
        if saved is None or saved["over"] or not saved.get("bot_pending"):
            return {"error": "Сейчас Астра не может сделать выстрел.", "continues": False}
        key = _key(cell)
        if key in saved["bot_shots"]:
            return {"error": f"По {_label(cell)} Астра уже стреляла.", "continues": False}
        saved.setdefault("bot_hits", [])
        saved.setdefault("bot_sunk", [])
        saved["bot_shots"].append(key)
        ship = _ship_at(saved["player_ships"], key)
        if ship is None:
            result = "мимо"
            saved["bot_pending"] = False
        else:
            saved["bot_hits"].append(key)
            if set(ship) <= set(saved["bot_shots"]):
                if ship not in saved["bot_sunk"]:
                    saved["bot_sunk"].append(ship)
                result = "потопила корабль"
            else:
                result = "попала"
            if _all_sunk(saved["player_ships"], set(saved["bot_shots"])):
                saved["over"] = True
                saved["winner"] = "Астра"
                saved["bot_pending"] = False
                result = "потопила последний корабль — Астра победила"
        _save(games)
        return {
            "message": f"Астра стреляет {_label(cell)}: {result}.",
            "continues": bool(saved.get("bot_pending")),
            "over": bool(saved["over"]),
        }


def status(code: str) -> str:
    with _LOCK:
        game = _load().get(code.strip().upper())
        if game is None:
            return "Партия не найдена. Начни новую или проверь код."
        reveal = game["over"]
        turn = "Астра выбирает выстрел" if game.get("bot_pending") else "твой ход"
        lead = f"Партия {code.strip().upper()}: " + (f"победитель — {game['winner']}" if reveal else turn)
        score = (f"Потоплено: кораблей Астры {_sunk_count(game['bot_ships'], game['player_shots'])}/10, "
                 f"твоих {_sunk_count(game['player_ships'], game['bot_shots'])}/10.")
        return (f"{lead}. {score}\n\nПоле Астры (сюда стреляй):\n"
                f"{_board(game['bot_ships'], game['player_shots'], reveal)}\n\n"
                f"Твои корабли:\n{_board(game['player_ships'], game['bot_shots'], True)}\n\n{LEGEND}")


def fire(code: str, coordinate: str) -> str:
    try:
        cell = parse_cell(coordinate)
    except ValueError as exc:
        return str(exc)
    code = code.strip().upper()
    with _LOCK:
        games = _load()
        game = games.get(code)
        if game is None:
            return "Партия не найдена. Начни новую или проверь код."
        if game["over"]:
            return status(code)
        key = _key(cell)
        if key in game["player_shots"]:
            return f"По {_label(cell)} уже стреляли. Назови другую клетку."
        game["player_shots"].append(key)
        ship = _ship_at(game["bot_ships"], key)
        result = "мимо" if ship is None else "корабль потоплен" if set(ship) <= set(game["player_shots"]) else "попадание"
        text = f"Партия {code}. Твой выстрел {_label(cell)}: {result}."
        if _all_sunk(game["bot_ships"], set(game["player_shots"])):
            game["over"] = True
            game["winner"] = "ты"
            text += " Ты победил!"
        elif ship is not None:
            text += "\nТы стреляешь ещё раз."
        else:
            bot_turn = []
            while True:
                bot_cell, bot_result = _bot_shot(game)
                bot_turn.append(f"{bot_cell} — {bot_result}")
                if _all_sunk(game["player_ships"], set(game["bot_shots"])):
                    game["over"] = True
                    game["winner"] = "Астра"
                    break
                if bot_result == "мимо":
                    break
            text += "\nАстра: " + "; ".join(bot_turn) + "."
            text += "\nАстра победила." if game["over"] else "\nТвой ход."
        _save(games)
        if game["over"]:
            return text + "\n\n" + status(code)
        score = (f"Потоплено: кораблей Астры {_sunk_count(game['bot_ships'], game['player_shots'])}/10, "
                 f"твоих {_sunk_count(game['player_ships'], game['bot_shots'])}/10.")
        return (f"{text}\n{score}\n\nПоле Астры (сюда стреляй):\n"
                f"{_board(game['bot_ships'], game['player_shots'], False)}\n\n"
                "□ неизвестно, · мимо, ✕ попадание, ◆ потоплен. Назови следующую клетку.")


def surrender(code: str) -> str:
    code = code.strip().upper()
    with _LOCK:
        games = _load()
        game = games.get(code)
        if game is None:
            return "Партия не найдена."
        if not game["over"]:
            game["over"] = True
            game["winner"] = "Астра"
            _save(games)
        return status(code)
