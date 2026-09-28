import os
import random
import tempfile
import unittest
from unittest.mock import patch

from src import game


class SeaBattleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["SEA_BATTLE_DATA_DIR"] = self.tmp.name

    def tearDown(self):
        os.environ.pop("SEA_BATTLE_DATA_DIR", None)
        self.tmp.cleanup()

    def test_fleet_shape_and_separation(self):
        ships = game.make_fleet(random.Random(7))
        self.assertEqual(sorted(map(len, ships)), sorted(game.FLEET))
        for i, first in enumerate(ships):
            for other in ships[i + 1:]:
                for a in first:
                    for b in other:
                        ar, ac = game._unkey(a)
                        br, bc = game._unkey(b)
                        self.assertGreater(max(abs(ar - br), abs(ac - bc)), 1)

    def test_game_persists_and_hides_opponent(self):
        opening = game.start()
        code = opening.split("Код партии: ")[1].split(".")[0]
        saved = game._load()[code]
        board = game.status(code).split("Поле Астры (сюда стреляй):\n")[1].split("\n\n")[0]
        self.assertNotIn("■", board)
        self.assertEqual(len(saved["bot_ships"]), 10)
        shot = game.fire(code, "A1")
        self.assertEqual(len(game._load()[code]["player_shots"]), 1)
        bot_shots = len(game._load()[code]["bot_shots"])
        self.assertEqual(bot_shots == 0, game._key((0, 0)) in {cell for ship in saved["bot_ships"] for cell in ship})
        self.assertEqual("Астра: " in shot, bot_shots > 0)
        repeated = game.fire(code, "А1")
        self.assertIn("уже стреляли", repeated)
        self.assertEqual(len(game._load()[code]["bot_shots"]), bot_shots)

    def test_surrender_reveals_board(self):
        code = game.start().split("Код партии: ")[1].split(".")[0]
        self.assertIn("победитель — Астра", game.surrender(code))
        self.assertIn("■", game.status(code).split("Поле Астры (сюда стреляй):\n")[1].split("\n\n")[0])

    def test_coordinates_and_board_mark_sunk_ship(self):
        self.assertEqual(game.parse_cell("Б7"), game.parse_cell("B-7"))
        self.assertEqual(game.parse_cell("7, Б"), game.parse_cell("Б7"))
        self.assertEqual(game.parse_cell("К10"), (9, 9))
        board = game._board([["0,0", "0,1"]], ["0,0", "0,1", "1,1"], False)
        self.assertEqual(board.count("◆"), 2)
        self.assertIn("·", board)

    def test_hit_grants_extra_turn_and_miss_invokes_bot(self):
        code = game.start().split("Код партии: ")[1].split(".")[0]
        games = game._load()
        match = games[code]
        match["bot_ships"] = [["0,0", "0,1"]]
        match["player_ships"] = [["9,9"]]
        game._save(games)
        first = game.fire(code, "А1")
        self.assertIn("ещё раз", first)
        self.assertEqual(game._load()[code]["bot_shots"], [])
        self.assertIn("◆", game.fire(code, "Б1"))
        self.assertEqual(game._load()[code]["winner"], "ты")

    def test_bot_targets_known_hits_without_peeking_at_fleet(self):
        observed = {"bot_shots": ["4,4"], "bot_hits": ["4,4"], "bot_sunk": []}
        first = {**observed, "bot_shots": observed["bot_shots"].copy(), "bot_hits": observed["bot_hits"].copy(), "player_ships": [["4,4", "4,5"]]}
        second = {**observed, "bot_shots": observed["bot_shots"].copy(), "bot_hits": observed["bot_hits"].copy(), "player_ships": [["4,4", "5,4"]]}
        with patch.object(game.random, "choice", side_effect=lambda cells: cells[0]):
            first_cell = game._bot_shot(first)[0]
            second_cell = game._bot_shot(second)[0]
        self.assertEqual(first_cell, second_cell)

    def test_old_game_migrates_bot_knowledge(self):
        old = {"bot_shots": ["4,4"], "player_ships": [["4,4", "4,5"]]}
        game._bot_shot(old)
        self.assertIn("4,4", old["bot_hits"])
        self.assertIn("bot_sunk", old)

    def test_complete_game_has_no_repeated_shots(self):
        code = game.start().split("Код партии: ")[1].split(".")[0]
        for row in range(game.SIZE):
            for col in range(game.SIZE):
                if game._load()[code]["over"]:
                    break
                game.fire(code, f"{game.LETTERS[col]}{row + 1}")
        saved = game._load()[code]
        self.assertTrue(saved["over"])
        self.assertEqual(len(saved["player_shots"]), len(set(saved["player_shots"])))
        self.assertEqual(len(saved["bot_shots"]), len(set(saved["bot_shots"])))
        self.assertIn(saved["winner"], ("ты", "Астра"))


if __name__ == "__main__":
    unittest.main()
