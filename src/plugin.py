"""Astra tools for Battleship, including conversations bridged from Telegram."""

import asyncio
import json
import logging

from astra_plugin_sdk import Plugin, tool, ui_call, ui_page, UiContribution

from . import game
from .tab_icon import TAB_ICON_SVG

logger = logging.getLogger(__name__)
_AI_TIMEOUT_SECONDS = 240


@ui_page(
    "sea-battle",
    "Морской бой",
    "index.html",
    icon_svg=TAB_ICON_SVG,
)
class SeaBattle(Plugin):
    def __init__(self):
        super().__init__()
        self._ai_locks: dict[str, asyncio.Lock] = {}
        self._ui_action_id = 0
        self._ui_action = None
        self._ui_task = None

    @tool("Начать новую партию Морского боя. Перед вызовом сам придумай расстановку флота Астры: 10 прямых горизонтальных или вертикальных отрезков без соприкосновения, длины строго 4,3,3,2,2,2,1,1,1,1. Передай bot_fleet строкой с координатами концов отрезков через дефис, корабли раздели точкой с запятой (например: А1-Г1;Е1-З1;К1-К3;А3-А4;В3-Г3;Е4-Ж4;Б6;Г6;Е7;З8). Без bot_fleet партию не начинай. Если расстановка неверная, исправь её и вызови инструмент повторно. Не раскрывай координаты флота Астры игроку. Покажи результат инструмента целиком, включая код партии и поле.")
    async def sea_battle_start(self, bot_fleet: str = "") -> str:
        if not bot_fleet.strip():
            return "Перед началом выбери расстановку флота Астры: укажи 10 прямых кораблей нужной длины без соприкосновения в параметре bot_fleet."
        return game.start(bot_fleet, mode="ai")

    @tool("Сделать ОДИН выстрел игрока в Морском бое. game_code — код партии; coordinate — клетка А1–К10. В режиме «Плагин» ответный ход считает инструмент. В режиме «ИИ Astra» после промаха передай модели компактный JSON observations и выбери ответную клетку вызовом sea_battle_ai_shot; после попадания продолжай выстрелы ИИ до промаха или победы.")
    async def sea_battle_fire(self, game_code: str, coordinate: str) -> str:
        if game.get_mode(game_code) == "ai":
            result = game.fire_ai_player(game_code, coordinate)
            if "error" in result:
                return result["error"]
            response = result["message"]
            if result.get("needs_bot"):
                observation = game.ai_observation(game_code)
                response += "\nAI_STATE_JSON=" + json.dumps(observation, ensure_ascii=False, separators=(",", ":"))
                response += "\nВыбери ещё не использованную клетку А1–К10 по списку shots и вызови sea_battle_ai_shot. После попадания повторяй до промаха или победы."
            return response
        return game.fire(game_code, coordinate)

    @tool("Сделать ОДИН ответный выстрел Астры в режиме «ИИ Astra». Выбирай любую клетку А1–К10, которой ещё нет в shots последнего AI_STATE_JSON. Если попала, выбери следующую клетку и вызови инструмент снова; после промаха ход возвращается игроку. Не используй в режиме «Плагин».")
    async def sea_battle_ai_shot(self, game_code: str, coordinate: str) -> str:
        result = game.fire_ai_bot(game_code, coordinate)
        if "error" in result:
            return result["error"]
        response = result["message"]
        if result.get("continues"):
            observation = game.ai_observation(game_code)
            response += "\nAI_STATE_JSON=" + json.dumps(observation, ensure_ascii=False, separators=(",", ":"))
            response += "\nАстра попала: выбери следующий выстрел и повтори sea_battle_ai_shot."
        return response

    @tool("Показать оба сохранённых поля и счёт партии Морского боя. game_code — код текущей партии. Передай поле без изменения строк и символов.")
    async def sea_battle_status(self, game_code: str) -> str:
        return game.status(game_code)

    @tool("Закончить партию Морского боя сдачей. Вызывай только по явной просьбе пользователя. game_code — код партии.")
    async def sea_battle_surrender(self, game_code: str) -> str:
        return game.surrender(game_code)

    async def get_ui_contributions(self) -> list[UiContribution]:
        contributions = await super().get_ui_contributions()
        for contribution in contributions:
            if contribution.slot == "page.custom":
                contribution.transparent = True
        return contributions

    @ui_call("sea_battle_ui_state")
    async def ui_state(self, **params):
        return self._ui_response(self._ui_snapshot(params.get("game_code", "")))

    @staticmethod
    def _ui_response(value):
        """Encode a UI result using Astra SDK's PluginUiCallResponse contract."""
        return {"result_json": json.dumps(value, ensure_ascii=False), "error": ""}

    def _ui_snapshot(self, code=""):
        snapshot = game.ui_state(code)
        action = self._ui_action
        if action:
            snapshot["ui_action"] = dict(action)
        selected = snapshot.get("selected")
        if selected:
            selected["bot_busy"] = bool(
                action
                and action.get("status") == "running"
                and action.get("kind") == "shot"
                and action.get("game_code") == selected.get("code")
            )
        return snapshot

    def _queue_ui_action(self, kind, code, message, operation):
        if self._ui_task and not self._ui_task.done():
            return {
                "message": "Дождись завершения предыдущего запроса к Астре.",
                "error": True,
                "state": self._ui_snapshot(code),
            }
        self._ui_action_id += 1
        action_id = self._ui_action_id
        self._ui_action = {
            "id": action_id,
            "kind": kind,
            "game_code": code,
            "status": "running",
            "message": message,
            "error": False,
        }
        self._ui_task = asyncio.create_task(
            self._run_ui_action(action_id, kind, code, operation)
        )
        return {"message": message, "error": False, "pending": True, "state": self._ui_snapshot(code)}

    async def _run_ui_action(self, action_id, kind, code, operation):
        try:
            result = await operation()
            message = result.get("message", "Готово.")
            error = bool(result.get("error"))
            code = result.get("game_code", code)
        except Exception as exc:
            logger.warning("Background UI action %s failed: %s", kind, exc)
            message = str(exc) or "Не удалось выполнить запрос к Астре."
            error = True
        if self._ui_action and self._ui_action.get("id") == action_id:
            self._ui_action.update(
                game_code=code,
                status="error" if error else "done",
                message=message,
                error=error,
            )

    async def _start_ai_from_ui(self):
        bot_fleet = await self._choose_fleet()
        result = game.start(bot_fleet, mode="ai")
        if "Код партии: " not in result:
            raise RuntimeError(result)
        code = result.split("Код партии: ", 1)[1].split(".", 1)[0]
        return {"message": "Астра выбрала расстановку. Партия началась.", "game_code": code}

    @ui_call("sea_battle_ui_start")
    async def ui_start(self, **params):
        mode = params.get("mode", "plugin")
        if mode == "ai":
            return self._ui_response(
                self._queue_ui_action("start", "", "Астра выбирает флот…", self._start_ai_from_ui)
            )
        else:
            result = game.start(mode="plugin")
            message = "Партия началась. Флот расставлен автоматически без вызова модели."
        if "Код партии: " not in result:
            return self._ui_response({"error": result, "message": result, "state": self._ui_snapshot()})
        code = result.split("Код партии: ", 1)[1].split(".", 1)[0]
        return self._ui_response({"message": message, "state": self._ui_snapshot(code)})

    @ui_call("sea_battle_ui_fire")
    async def ui_fire(self, **params):
        code = params.get("game_code", "")
        coordinate = params.get("coordinate", "")
        if game.get_mode(code) == "ai":
            if self._ui_task and not self._ui_task.done():
                return self._ui_response({"message": "Дождись завершения запроса к Астре.", "error": True, "state": self._ui_snapshot(code)})
            result = game.fire_ai_player(code, coordinate)
            if "error" in result:
                return self._ui_response({"message": result["error"], "error": True, "state": self._ui_snapshot(code)})
            if result.get("needs_bot"):
                queued = self._queue_ui_action(
                    "shot", code, "Астра выбирает выстрел…", lambda: self._run_ai_turn(code)
                )
                return self._ui_response({**queued, "message": result["message"], "state": self._ui_snapshot(code)})
            return self._ui_response({"message": result["message"], "error": False, "state": self._ui_snapshot(code)})
        result = game.fire(code, coordinate)
        message = result.split("\nПотоплено:", 1)[0]
        message = message.split("\n\nПоле Астры", 1)[0].split("\n\nПартия", 1)[0]
        return self._ui_response({"message": message, "state": self._ui_snapshot(code)})

    @ui_call("sea_battle_ui_surrender")
    async def ui_surrender(self, **params):
        code = params.get("game_code", "")
        result = game.surrender(code)
        return self._ui_response({"message": result.split("\n\n", 1)[0], "state": self._ui_snapshot(code)})

    @ui_call("sea_battle_ui_retry_ai")
    async def ui_retry_ai(self, **params):
        code = params.get("game_code", "")
        return self._ui_response(
            self._queue_ui_action("shot", code, "Астра выбирает выстрел…", lambda: self._run_ai_turn(code))
        )

    async def _ask_json(self, payload: dict) -> dict:
        """Ask Astra's configured model for one compact JSON game decision."""
        if self.host is None:
            raise RuntimeError("Нет соединения с моделью Astra.")
        request = (
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            if isinstance(payload, dict)
            else str(payload)
        )
        prompt = (
            "You are the decision engine for a Battleship game. Execute the task now. "
            "Reply with exactly one valid JSON object matching the requested output; "
            "do not echo the request, explain, add prose, or use Markdown fences.\n"
            + request
        )
        parts = []
        try:
            async with asyncio.timeout(_AI_TIMEOUT_SECONDS):
                async for chunk in self.host.send_chat_message(prompt, voice_enabled=False):
                    kind = chunk.WhichOneof("content")
                    if kind == "text":
                        parts.append(chunk.text)
                    elif kind == "error":
                        raise RuntimeError(str(chunk.error))
                    elif kind == "done":
                        break
        except asyncio.TimeoutError as exc:
            raise RuntimeError(f"Модель Astra не ответила за {_AI_TIMEOUT_SECONDS} секунд.") from exc
        except Exception as exc:
            message = str(exc)
            if "send_chat_message" in message and "PERMISSION_DENIED" in message:
                raise RuntimeError("Astra запретила вызов модели для плагина. Для AI-режима запусти sideload-команду `astra-plugin dev <папка плагина>` и разреши запрос чата.") from exc
            raise RuntimeError(message[:300] or "Не удалось получить ответ модели Astra.") from exc
        raw = "".join(parts).strip()
        if raw.startswith("```json"):
            raw = raw[7:].strip()
        elif raw.startswith("```"):
            raw = raw[3:].strip()
        if raw.endswith("```"):
            raw = raw[:-3].strip()
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            decoder = json.JSONDecoder()
            value = None
            candidates = []
            for index, char in enumerate(raw):
                if char != "{":
                    continue
                try:
                    candidate, _ = decoder.raw_decode(raw[index:])
                except ValueError:
                    continue
                if isinstance(candidate, dict):
                    candidates.append(candidate)
            for candidate in candidates:
                if any(key in candidate for key in ("fleet", "coordinate", "shot")):
                    value = candidate
                    continue
                if value is None and any(
                    isinstance(candidate.get(key), dict)
                    and any(field in candidate[key] for field in ("fleet", "coordinate", "shot"))
                    for key in ("format", "result", "output")
                ):
                    value = candidate
            if value is None and candidates:
                value = candidates[-1]
            if value is None:
                raise RuntimeError("Astra не вернула JSON с ходом или расстановкой.")
        if not isinstance(value, dict):
            raise RuntimeError("Ответ Astra должен быть JSON-объектом.")
        return value

    async def _choose_fleet(self) -> str:
        rules = (
            "Расставь флот для игры в морской бой на поле 10x10. Нужны 10 прямых кораблей: "
            "длины 4, 3, 3, 2, 2, 2, 1, 1, 1, 1. Корабли не должны пересекаться "
            "или соприкасаться, даже по диагонали. Столбцы: А, Б, В, Г, Д, Е, Ж, З, И, К; "
            "строки: 1-10. Верни только JSON-объект с верхнеуровневым ключом fleet, "
            "его значением должен быть массив из 10 строк координатных отрезков "
            "(например, А1-Г1 для корабля длиной 4 или Б7 для корабля длиной 1). "
            "Сам придумай координаты. Не копируй запрос и не пересказывай правила."
        )
        correction = ""
        for attempt in range(2):
            answer = await self._ask_json(rules + correction)
            fleet = answer.get("fleet")
            if not isinstance(fleet, list):
                # Some chat models echo the old request wrapper instead of
                # returning the requested result object. Accept its nested
                # fleet only after the same strict board validation.
                for wrapper_key in ("format", "result", "output"):
                    wrapper = answer.get(wrapper_key)
                    if isinstance(wrapper, dict) and isinstance(wrapper.get("fleet"), list):
                        fleet = wrapper["fleet"]
                        break
            if isinstance(fleet, list) and all(isinstance(ship, str) for ship in fleet):
                encoded = ";".join(fleet)
                try:
                    game.parse_bot_fleet(encoded)
                    return encoded
                except ValueError as exc:
                    reason = str(exc)
                    if "соприкасаться" in reason:
                        try:
                            repaired = game.repair_bot_fleet(encoded)
                            logger.info("Adjusted Astra fleet to remove touching ships")
                            return repaired
                        except ValueError as repair_exc:
                            reason = str(repair_exc)
            else:
                reason = "JSON должен содержать ключ fleet со списком из 10 координатных отрезков."
            if attempt == 0:
                correction = f"\nПредыдущий ответ не принят: {reason} Исправь его и верни новый JSON с ключом fleet."
        logger.warning("Astra returned an invalid fleet after retries: %s", reason)
        raise RuntimeError(f"Модель Astra не смогла предложить допустимую расстановку: {reason}")

    async def _run_ai_turn(self, code: str) -> dict:
        """Ask Astra for shots until it misses, validating every coordinate."""
        lock = self._ai_locks.setdefault(code.strip().upper(), asyncio.Lock())
        async with lock:
            messages = []
            while True:
                observation = game.ai_observation(code)
                if observation is None:
                    break
                prompt = (
                    "Морской бой, поле 10x10: столбцы АБВГДЕЖЗИК, строки 1-10. "
                    "Выбери одну клетку, которой нет в истории ниже. После попадания "
                    "обязательно продолжай охоту по соседним клеткам незатопленного корабля. "
                    "Если target_candidates не пуст, выбирай ТОЛЬКО из этого списка. "
                    'Верни только JSON вида {"coordinate":"Б7"}. Состояние: '
                    + json.dumps(observation["shots"], ensure_ascii=False, separators=(",", ":"))
                    + "; обязательные клетки для выстрела: "
                    + json.dumps(observation["target_candidates"], ensure_ascii=False, separators=(",", ":"))
                )
                for attempt in range(2):
                    answer = await self._ask_json(prompt)
                    coordinate = answer.get("coordinate")
                    if not isinstance(coordinate, str):
                        coordinate = answer.get("shot")
                    result = game.fire_ai_bot(code, coordinate) if isinstance(coordinate, str) else {"error": "JSON должен содержать coordinate со значением клетки."}
                    if "error" not in result:
                        messages.append(result["message"])
                        if result.get("over") or not result.get("continues"):
                            return {"message": " ".join(messages), "error": False}
                        break
                    if attempt == 0:
                        prompt += f"\nЭтот ход недопустим: {result['error']} Верни другую клетку в JSON."
                    else:
                        candidates = observation.get("target_candidates") or []
                        if candidates:
                            # Keep the target logic reliable even when the model
                            # ignores the allowed-neighbor constraint twice.
                            result = game.fire_ai_bot(code, candidates[0])
                            if "error" not in result:
                                messages.append(result["message"])
                                if result.get("over") or not result.get("continues"):
                                    return {"message": " ".join(messages), "error": False}
                                break
                        return {"message": " ".join(messages) or "Астра пока не смогла сделать выстрел.", "error": True}
            return {"message": " ".join(messages) or "Ответный ход Астры завершён.", "error": False}

if __name__ == "__main__":
    SeaBattle().run()
