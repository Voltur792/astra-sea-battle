import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from src.matchmaking import BackgroundSearch, new_session
from src import preferences, online_store, notifications, clipboard
from src.plugin import SeaBattle

CONFIG = {"key": "pk_live_fixture_only_123456", "app": "", "turn": ""}

async def until(predicate):
    async with asyncio.timeout(4):
        while not predicate(): await asyncio.sleep(.005)

class Hub:
    def __init__(self): self.clients = {}; self.index = 0; self.public = []
    def connect(self, *args, **kwargs):
        hub = self
        class WS:
            async def __aenter__(self):
                hub.index += 1; self.id = f"peer-{hub.index}"; self.messages = asyncio.Queue(); self.channel = ""
                hub.clients[self.id] = self
                await self.emit({"type": "welcome", "peerId": self.id}); return self
            async def __aexit__(self, *exc):
                hub.clients.pop(self.id, None)
                for s in list(hub.clients.values()):
                    await s.emit({"type": "presence", "channel": self.channel, "left": [{"peerId": self.id}]})
            async def emit(self, data): await self.messages.put(json.dumps(data))
            async def recv(self): return await self.messages.get()
            async def send(self, raw):
                msg = json.loads(raw)
                if msg["type"] == "subscribe":
                    self.channel = msg["channel"]; await self.emit({"type": "ack", "requestId": msg["requestId"]})
                    for s in list(hub.clients.values()):
                        if s.channel == self.channel: await s.emit({"type": "presence", "channel": self.channel, "joined": [{"peerId": self.id}]})
                elif msg["type"] == "publish":
                    hub.public.append(msg)
                    for s in list(hub.clients.values()):
                        if s.channel == msg["channel"]: await s.emit({"type": "message", "channel": self.channel, "from": self.id, "data": msg["data"]})
                elif msg["type"] == "send":
                    other = hub.clients.get(msg["to"])
                    if other: await other.emit({"type": "direct", "from": self.id, "data": msg["data"]})
                    else: await self.emit({"type": "error", "code": "peer_not_found"})
        return WS()

class BackgroundTests(unittest.IsolatedAsyncioTestCase):
    async def test_queue_survives_absent_page_then_pairs_and_exchanges_names_privately(self):
        hub=Hub(); found=[]
        async def matched(session): found.append(session)
        a=BackgroundSearch(matched,hub.connect); b=BackgroundSearch(matched,hub.connect)
        try:
            await a.start(CONFIG,"Voltur"); await until(lambda:a.snapshot()["count"]==1)
            # No frontend polls or page object exists while background task remains alive.
            await asyncio.sleep(.05); self.assertTrue(a.active)
            await b.start(CONFIG,"Моряк"); await until(lambda:len(found)==2)
            self.assertEqual(found[0]["room"],found[1]["room"])
            self.assertEqual({s["name"] for s in found},{"Voltur","Моряк"})
            self.assertEqual({s["opponent_name"] for s in found},{"Voltur","Моряк"})
            wire=json.dumps(hub.public); self.assertNotIn("SB2.",wire); self.assertNotIn("Voltur",wire)
        finally: await a.stop(); await b.stop()

    async def test_cancel_removes_process_queue_and_timeout_is_bounded(self):
        hub=Hub(); callback=AsyncMock(); q=BackgroundSearch(callback,hub.connect,duration=.04)
        await q.start(CONFIG); await until(lambda:q.state["status"]=="idle")
        self.assertIsNone(q.state["count"]); callback.assert_not_awaited(); await q.stop()
        q.duration=180; await q.start(CONFIG); await until(lambda:q.active)
        await q.stop(); self.assertEqual(q.state["status"],"idle"); self.assertFalse(hub.clients)

    async def test_subscription_failure_is_unknown_not_zero(self):
        hub=Hub(); q=BackgroundSearch(AsyncMock(),hub.connect)
        await q.start(CONFIG); await until(lambda:q.state["status"]=="waiting")
        await q.ws.emit({"type":"error","code":"channel_not_authorized"})
        await until(lambda:q.state["status"]=="error"); self.assertIsNone(q.state["count"]); await q.stop()

    async def test_match_is_persisted_and_alerted_once_without_frontend(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,SEA_BATTLE_DATA_DIR=directory), patch('src.notifications.announce',new_callable=AsyncMock) as alert:
            plugin=SeaBattle(); session=new_session(CONFIG,'a'*64,'Моряк'); session['opponent']='b'*64
            await plugin._match_found(session); await asyncio.sleep(0)
            self.assertEqual(online_store.load()['session']['name'],'Моряк'); alert.assert_awaited_once()
            await plugin.on_shutdown()

class PreferencesTests(unittest.TestCase):
    def test_mode_nickname_and_alert_survive_reload_independent_of_games(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,SEA_BATTLE_DATA_DIR=directory):
            preferences.update({'mode':'ai','nickname':' Моряк\u202e\x00 ','alert':'voice'})
            self.assertEqual(preferences.load()['mode'],'ai'); self.assertEqual(preferences.load()['nickname'],'Моряк')
            preferences.update({'mode':'online'})
            self.assertEqual(preferences.load()['alert'],'voice'); self.assertIsNone(online_store.load()['session'])

class AlertTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_voice_falls_back_to_sound_and_notification(self):
        class Host:
            async def send_chat_message(self,*args,**kwargs):
                raise RuntimeError('provider offline')
                yield
        with patch('src.notifications.sound',new_callable=AsyncMock) as sound, patch('src.notifications.desktop',new_callable=AsyncMock) as desktop:
            await notifications.announce(Host(),{'alert':'voice','notifications':True})
            sound.assert_awaited_once(); desktop.assert_awaited_once()

    async def test_clipboard_uses_stdin_and_reports_os_failure(self):
        process=AsyncMock(); process.returncode=0
        with patch('src.clipboard.sys.platform','win32'), patch('src.clipboard.subprocess.CREATE_NO_WINDOW',0,create=True), patch('src.clipboard.asyncio.create_subprocess_exec',new_callable=AsyncMock,return_value=process) as spawn:
            code='SB2.'+'a'*80; await clipboard.copy_invite(code)
            self.assertNotIn(code,str(spawn.call_args)); process.communicate.assert_awaited_once_with(code.encode())
            process.returncode=1
            with self.assertRaises(ValueError): await clipboard.copy_invite(code)
        with self.assertRaises(ValueError): await clipboard.copy_invite('not an invitation; injected command')
