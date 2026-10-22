import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src import online_store


class OnlineStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, SEA_BATTLE_DATA_DIR=self.temporary.name)
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def test_revision_blocks_second_tab_and_keeps_local_games(self):
        local = Path(self.temporary.name) / 'games.json'
        local.write_text('{"existing":true}', encoding='utf-8')
        self.assertEqual(online_store.load()['revision'], 0)
        online_store.save(0, {'key': 'pk_live_test12345678'}, None)
        with self.assertRaisesRegex(ValueError, 'другом окне'):
            online_store.save(0, {}, None)
        self.assertEqual(json.loads(local.read_text()), {'existing': True})

    def test_account_secret_and_oversized_or_corrupt_state_not_overwritten(self):
        with self.assertRaisesRegex(ValueError, 'публичный'):
            online_store.save(0, {'key': 'sk_secret_never_store'}, None)
        path = Path(self.temporary.name) / 'online.json'
        path.write_text('{invalid', encoding='utf-8')
        with self.assertRaises(ValueError):
            online_store.save(0, {}, None)
        self.assertEqual(path.read_text(), '{invalid')

    def test_roundtrip_preserves_session_but_drops_unknown_top_level_fields(self):
        session = {'v': 1, 'room': 'a'*64, 'secret': 'b'*64, 'id': 'c'*64, 'role': 'guest',
                   'config': {'key': 'pk_live_test12345678'}, 'opponent': '',
                   'match': {'history': [], 'fleet': []}, 'unrelated': 'not stored'}
        online_store.save(0, {}, session)
        saved = online_store.load()['session']
        self.assertEqual(saved['secret'], 'b'*64)
        self.assertNotIn('unrelated', saved)


if __name__ == '__main__':
    unittest.main()
