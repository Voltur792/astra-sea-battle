import os
import random
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from src import game
from src.plugin import SeaBattle, ModelResponseError


class AIRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, SEA_BATTLE_DATA_DIR=self.temp.name)
        self.environment.start()
        self.plugin = SeaBattle()

    def tearDown(self):
        self.environment.stop()
        self.temp.cleanup()

    def encoded(self, ships):
        return ';'.join(game._label(game._unkey(s[0])) if len(s) == 1 else
                        game._label(game._unkey(s[0]))+'-'+game._label(game._unkey(s[-1])) for s in ships)

    async def test_invalid_ai_fleet_gets_legal_labeled_reserve(self):
        self.plugin._ask_json = AsyncMock(return_value={'fleet': ['А999'] * 10})
        choice = await self.plugin._choose_fleet()
        self.assertEqual(choice['source'], 'fallback')
        game.parse_bot_fleet(choice['fleet'])
        self.assertEqual(self.plugin._ask_json.await_count, 2)

    async def test_non_json_fleet_does_not_block_start(self):
        self.plugin._ask_json = AsyncMock(side_effect=ModelResponseError('not JSON'))
        choice = await self.plugin._choose_fleet()
        self.assertEqual(choice['source'], 'fallback')

    async def test_start_preserves_manual_player_fleet_and_provenance(self):
        player = [[int(k.split(',')[0])*10+int(k.split(',')[1]) for k in ship]
                  for ship in game.make_fleet(random.Random(3))]
        bot = self.encoded(game.make_fleet(random.Random(5)))
        self.plugin._choose_fleet = AsyncMock(return_value={'fleet': bot, 'source': 'fallback', 'message': 'Резервный флот'})
        result = await self.plugin._start_ai_from_ui(player)
        saved = game._load()[result['game_code']]
        self.assertEqual(saved['player_ships'], game.validate_player_fleet(player))
        self.assertEqual(saved['bot_placement'], 'fallback')
        self.assertEqual(game.ui_state(result['game_code'])['selected']['player_placement'], 'manual')

    async def test_invalid_shots_without_target_candidates_progress_legally(self):
        bot = self.encoded(game.make_fleet(random.Random(5)))
        code = game.start(bot, mode='ai').split('Код партии: ')[1].split('.')[0]
        saved = game._load()
        saved[code]['bot_pending'] = True
        empty = next((r, c) for r in range(10) for c in range(10)
                     if not game._ship_at(saved[code]['player_ships'], game._key((r, c))))
        game._save(saved)
        self.plugin._ask_json = AsyncMock(return_value={'coordinate': 'Я999'})
        with patch('src.plugin.random.choice', return_value=game._label(empty)):
            result = await self.plugin._run_ai_turn(code)
        self.assertFalse(result['error'])
        self.assertTrue(result['fallback'])
        self.assertIn('выбрал плагин', result['message'])
        saved = game._load()[code]
        self.assertEqual(saved['bot_shots'], [game._key(empty)])
        self.assertFalse(saved['bot_pending'])

    async def test_provider_failure_stays_retryable_and_is_not_fake_ai_move(self):
        bot = self.encoded(game.make_fleet(random.Random(5)))
        code = game.start(bot, mode='ai').split('Код партии: ')[1].split('.')[0]
        saved = game._load(); saved[code]['bot_pending'] = True; game._save(saved)
        self.plugin._ask_json = AsyncMock(side_effect=RuntimeError('provider 503'))
        with self.assertRaisesRegex(RuntimeError, 'provider 503'):
            await self.plugin._run_ai_turn(code)
        self.assertEqual(game._load()[code]['bot_shots'], [])
        self.assertTrue(game._load()[code]['bot_pending'])

    def test_rejects_incomplete_gapped_bool_and_touching_manual_fleets(self):
        fleet = [[int(k.split(',')[0])*10+int(k.split(',')[1]) for k in ship]
                 for ship in game.make_fleet(random.Random(3))]
        game.validate_player_fleet(fleet)
        for invalid in [fleet[:-1], [[True, 1, 2, 3]]+fleet[1:], [[0, 2, 3, 4]]+fleet[1:]]:
            with self.assertRaises(ValueError): game.validate_player_fleet(invalid)


if __name__ == '__main__':
    unittest.main()
