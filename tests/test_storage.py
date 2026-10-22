import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from src import storage


class StorageTests(unittest.TestCase):
    def test_platform_paths_override_and_existing_saves(self):
        with TemporaryDirectory() as tmp, patch.object(Path, 'home', return_value=Path(tmp)):
            home = Path(tmp)
            with patch.dict(os.environ, {'APPDATA': str(home / 'roaming')}, clear=True), patch.object(storage.sys, 'platform', 'win32'):
                self.assertEqual(storage.data_root('game', 'GAME_TEST_ROOT'), home / 'roaming' / 'game')
            with patch.dict(os.environ, {'XDG_DATA_HOME': str(home / 'xdg')}, clear=True), patch.object(storage.sys, 'platform', 'linux'):
                self.assertEqual(storage.data_root('game', 'GAME_TEST_ROOT'), home / 'xdg' / 'game')
                legacy = home / '.local' / 'share' / 'game'
                legacy.mkdir(parents=True)
                (legacy / 'games.json').write_text('old save')
                self.assertEqual(storage.data_root('game', 'GAME_TEST_ROOT'), legacy)
                current = home / 'xdg' / 'game'
                current.mkdir(parents=True)
                (current / 'games.json').write_text('current save')
                self.assertEqual(storage.data_root('game', 'GAME_TEST_ROOT'), current)
            with patch.dict(os.environ, {}, clear=True), patch.object(storage.sys, 'platform', 'darwin'):
                self.assertEqual(storage.data_root('new-game', 'GAME_TEST_ROOT'), home / 'Library' / 'Application Support' / 'new-game')
            with patch.dict(os.environ, {'GAME_TEST_ROOT': str(home / 'override')}, clear=True):
                self.assertEqual(storage.data_root('game', 'GAME_TEST_ROOT'), home / 'override')

    def test_relative_xdg_is_ignored(self):
        with TemporaryDirectory() as tmp, patch.object(Path, 'home', return_value=Path(tmp)), patch.object(storage.sys, 'platform', 'linux'), patch.dict(os.environ, {'XDG_DATA_HOME': 'relative'}, clear=True):
            self.assertEqual(storage.data_root('game', 'GAME_TEST_ROOT'), Path(tmp) / '.local' / 'share' / 'game')
