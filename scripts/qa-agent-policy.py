import sys
from pathlib import Path

from poke_env.environment import Move, Pokemon
from poke_env.player.battle_order import DoubleBattleOrder

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sidecar.main import StructuredPlayer


def pokemon(species, moves):
    member = Pokemon(gen=9, species=species)
    for move_id in moves:
        member.moves[move_id] = Move(move_id, gen=9)
    return member


class FakeDoubleBattle:
    def __init__(self):
        self.force_switch = [False, False]
        self.active_pokemon = [
            pokemon("pikachu", ["thunderbolt", "protect"]),
            pokemon("whimsicott", ["moonblast", "tailwind"]),
        ]
        self.available_moves = [
            [Move("thunderbolt", gen=9), Move("protect", gen=9)],
            [Move("moonblast", gen=9), Move("tailwind", gen=9)],
        ]
        self.available_switches = [[], []]

    @staticmethod
    def get_possible_showdown_targets(move, _mon):
        return [0] if move.id in {"protect", "tailwind"} else [1, 2]


player = object.__new__(StructuredPlayer)
battle = FakeDoubleBattle()
order = player.choose_doubles_move(battle)
assert isinstance(order, DoubleBattleOrder)
assert order.first_order is not None and order.second_order is not None
assert order.message.startswith("/choose move ")
assert ", move " in order.message

preview_team = [
    pokemon("charizard", ["heatwave", "protect"]),
    pokemon("whimsicott", ["tailwind", "moonblast"]),
    pokemon("incineroar", ["fakeout", "flareblitz"]),
    pokemon("amoonguss", ["ragepowder", "spore"]),
    pokemon("dragonite", ["extremespeed", "protect"]),
    pokemon("garchomp", ["earthquake", "protect"]),
]
preview = type("Preview", (), {
    "team": {str(index): member for index, member in enumerate(preview_team, start=1)},
    "opponent_team": {},
})()
first = player.teampreview(preview)
second = player.teampreview(preview)
assert first == second
assert first.startswith("/team ")
assert sorted(first.removeprefix("/team ")) == list("123456")

print("Agent policy QA passed.")
