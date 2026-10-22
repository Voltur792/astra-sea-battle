"""The opt-in queue lives in the plugin process, never in an iframe."""
import asyncio
import base64
import hashlib
import json
import secrets
import time
from urllib.parse import quote
from . import online_store, preferences

CHANNEL = "sea-battle/matchmaking-v1"

def valid_id(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)

def new_session(config, identity, name):
    secret = secrets.token_hex(32)
    return {"v": 1, "config": config, "secret": secret,
            "room": hashlib.sha256(bytes.fromhex(secret)).hexdigest(),
            "id": identity, "role": "host", "opponent": "", "name": name, "opponent_name": "", "match": None}

def invitation(session):
    data = json.dumps({"v": 2, "secret": session["secret"], "name": session.get("name", "")}, separators=(",", ":")).encode()
    return "SB2." + base64.urlsafe_b64encode(data).decode().rstrip("=")

def join_session(code, config, identity, name):
    if not isinstance(code, str) or not 40 <= len(code) <= 1600 or not code.startswith("SB2."):
        raise ValueError("Неверное приглашение.")
    raw = code[4:]; data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    if not isinstance(data, dict) or data.get("v") != 2 or not valid_id(data.get("secret")):
        raise ValueError("Неверное приглашение.")
    secret = data["secret"]
    return {"v": 1, "config": config, "secret": secret, "room": hashlib.sha256(bytes.fromhex(secret)).hexdigest(),
            "id": identity, "role": "guest", "opponent": "", "name": name,
            "opponent_name": preferences.nickname(data.get("name")), "match": None}

class BackgroundSearch:
    def __init__(self, on_match, connector=None, duration=180):
        self.on_match = on_match; self.connector = connector; self.duration = duration
        self.task = None; self.ws = None; self.lock = None; self.members = {}
        self.stopping = False
        self.state = {"status": "idle", "count": None, "message": "Поиск выключен.", "room": ""}

    @property
    def active(self):
        return self.state["status"] in ("connecting", "waiting", "pairing")

    def snapshot(self):
        return dict(self.state)

    async def start(self, config, name=""):
        if self.active:
            return self.snapshot()
        await self.stop()
        self.config = online_store._config(config)
        if not self.config["key"]:
            raise ValueError("Не настроен публичный ключ комнат.")
        self.name = preferences.nickname(name); self.identity = secrets.token_hex(32)
        self.local_peer = ""; self.request = 0; self.subscribe_request = ""
        self.members = {}; self.lock = None; self.done = False
        self.stopping = False
        self.state = {"status": "connecting", "count": None, "room": "", "message": "Подключаемся к очереди поиска…"}
        self.task = asyncio.create_task(self.run())
        return self.snapshot()

    async def stop(self):
        task = self.task; self.task = None
        self.stopping = True
        if task and task is not asyncio.current_task() and not task.done():
            try: await asyncio.wait_for(asyncio.shield(task), 3)
            except asyncio.TimeoutError:
                task.cancel()
                try: await task
                except asyncio.CancelledError: pass
        self.ws = None; self.lock = None
        if self.active:
            self.state.update(status="idle", count=None, message="Поиск отменён.")

    async def request_server(self, kind, **fields):
        self.request += 1
        await self.ws.send(json.dumps({"type": kind, **fields, "requestId": str(self.request)}, separators=(",", ":")))

    async def send(self, data, peer=""):
        if peer: await self.request_server("send", to=peer, data={"sbq": 1, **data})
        else: await self.request_server("publish", channel=CHANNEL, data={"sbq": 1, **data})

    async def advertise(self):
        await self.send({"kind": "waiting", "id": self.identity, "busy": bool(self.lock) or self.done})

    def count(self):
        now = time.monotonic()
        self.members = {peer: m for peer, m in self.members.items() if now-m["seen"] <= 70}
        if not self.done: self.state["count"] = 1 + sum(not m["busy"] for m in self.members.values())

    async def release(self):
        if self.done: return
        self.lock = None; await self.advertise(); self.count()
        self.state.update(status="waiting", message="Соперник не подтвердил подключение. Продолжаем поиск…")
        self.retry_after = time.monotonic() + 0.7 + secrets.randbelow(1500)/1000

    async def consider(self):
        if self.lock or self.done or time.monotonic() < self.retry_after: return
        self.count()
        candidates = [(p, m) for p, m in self.members.items() if not m["busy"] and self.local_peer < p]
        if not candidates: return
        peer, member = secrets.choice(candidates)
        session = new_session(self.config, self.identity, self.name); session["opponent"] = member["id"]
        self.lock = {"peer": peer, "id": member["id"], "token": secrets.token_hex(32), "phase": "offer", "session": session,
                     "attempts": 0, "next": 0}
        self.lock["packet"] = {"kind": "offer", "token": self.lock["token"], "id": self.identity, "invite": invitation(session)}
        self.state.update(status="pairing", message="Соперник найден. Подтверждаем подключение…")
        await self.advertise()

    async def matched(self):
        if self.done: return
        # The callback must persist the session before any sound/voice is scheduled.
        await self.on_match(self.lock["session"])
        self.done = True; self.finished_at = time.monotonic()
        self.state.update(status="found", count=None, room=self.lock["session"]["room"], message="Соперник найден. Открой Морской бой и расставь корабли.")
        await self.advertise()

    async def on_server(self, message):
        kind = message.get("type")
        if kind == "welcome":
            self.local_peer = message["peerId"]
            await self.request_server("subscribe", channel=CHANNEL); self.subscribe_request = str(self.request)
        elif kind == "ack" and message.get("requestId") == self.subscribe_request and not self.healthy:
            self.healthy = True; self.state.update(status="waiting", message="Ищем соперника. Можно переключаться на другие вкладки Astra.")
            await self.advertise(); self.count()
        elif kind == "presence" and message.get("channel") == CHANNEL:
            for peer in message.get("left", []):
                peer = peer if isinstance(peer, str) else peer.get("peerId")
                self.members.pop(peer, None)
                if self.lock and self.lock["peer"] == peer and not self.done: await self.release()
            if not self.done and not self.lock and any(p.get("peerId") != self.local_peer for p in message.get("joined", [])):
                await self.advertise()
            self.count()
        elif kind == "error":
            if message.get("code") == "peer_not_found": await self.release()
            else: raise ValueError("Очередь поиска недоступна. Попробуй позже или пригласи друга.")
        elif kind == "direct" or (kind == "message" and message.get("channel") == CHANNEL):
            data = message.get("data"); peer = message.get("from")
            if not isinstance(data, dict) or data.get("sbq") != 1 or not isinstance(peer, str) or not 1 <= len(peer) <= 200 or peer == self.local_peer: return
            action = data.get("kind")
            if action == "waiting" and kind == "message" and valid_id(data.get("id")) and type(data.get("busy")) is bool:
                if self.done or (peer not in self.members and len(self.members) >= 100): return
                self.members[peer] = {"id": data["id"], "busy": data["busy"], "seen": time.monotonic()}
                self.count(); await self.consider(); return
            if kind != "direct" or not valid_id(data.get("token")): return
            lock = self.lock
            if action == "offer":
                if self.done or lock:
                    if lock and lock["peer"] == peer and lock["token"] == data["token"] and lock["phase"] == "accept": await self.send(lock["packet"], peer)
                    else: await self.send({"kind": "busy", "token": data["token"]}, peer)
                    return
                member = self.members.get(peer)
                if not member or member["id"] != data.get("id") or self.local_peer < peer: return
                try: session = join_session(data.get("invite"), self.config, self.identity, self.name)
                except (ValueError, TypeError, KeyError): return
                session["opponent"] = data["id"]
                self.lock = {"peer": peer, "id": data["id"], "token": data["token"], "phase": "accept", "session": session, "attempts": 0, "next": 0,
                             "packet": {"kind": "accept", "token": data["token"], "id": self.identity, "name": self.name}}
                self.state.update(status="pairing", message="Подтверждаем соперника…"); await self.advertise(); return
            if not lock or lock["peer"] != peer or lock["token"] != data["token"]: return
            if action == "accept" and lock["phase"] == "offer" and data.get("id") == lock["id"]:
                lock["session"]["opponent_name"] = preferences.nickname(data.get("name"))
                lock.update(phase="commit", packet={"kind": "commit", "token": lock["token"]}, next=0)
            elif action == "commit" and lock["phase"] == "accept":
                await self.send({"kind": "ready", "token": lock["token"]}, peer); await self.matched()
            elif action == "ready" and lock["phase"] == "commit": await self.matched()
            elif action == "busy" and not self.done:
                self.members.pop(peer, None); await self.release()

    async def run(self):
        try:
            connector = self.connector
            if connector is None:
                from websockets.asyncio.client import connect
                connector = connect
            self.healthy = False; self.retry_after = 0
            began = time.monotonic(); pulse_at = began + 30
            async with connector("wss://rms.metered.ca/v1?key=" + quote(self.config["key"], safe=""),
                                 open_timeout=15, close_timeout=2, max_size=65536, ping_interval=20, ping_timeout=20) as ws:
                self.ws = ws
                while not self.stopping:
                    now = time.monotonic()
                    if self.done and now-self.finished_at >= 8: break
                    if not self.done and now-began >= self.duration:
                        self.state.update(status="idle", count=None, message="Поиск остановлен через 3 минуты. Можно повторить поиск."); break
                    if not self.healthy and now-began >= 15: raise TimeoutError("Очередь не ответила за 15 секунд.")
                    if self.healthy and not self.done:
                        if now >= pulse_at: await self.advertise(); self.count(); pulse_at = now+30
                        await self.consider()
                        lock = self.lock
                        if lock and now >= lock["next"]:
                            if lock["attempts"] >= 8: await self.release()
                            else:
                                await self.send(lock["packet"], lock["peer"]); lock["attempts"] += 1; lock["next"] = now+1.5
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=0.25)
                    except asyncio.TimeoutError: continue
                    if not isinstance(raw, str) or len(raw) > 65536: continue
                    try: message = json.loads(raw)
                    except ValueError: continue
                    if isinstance(message, dict): await self.on_server(message)
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self.done:
                self.state.update(status="error", count=None, message="Очередь поиска недоступна. Попробуй позже или пригласи друга.")
        finally:
            self.ws = None
