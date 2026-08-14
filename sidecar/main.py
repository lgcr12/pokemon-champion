import asyncio
import hashlib
import json
import os
import sys
import threading
import traceback
import inspect
import time
import random
from uuid import uuid4
from datetime import datetime, timezone
from pathlib import Path


SHOWDOWN_NO_PROXY_HOSTS = (
    "sim3.psim.us",
    "play.pokemonshowdown.com",
    ".psim.us",
    ".pokemonshowdown.com",
)
existing_no_proxy = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
no_proxy = ",".join(filter(None, (existing_no_proxy, *SHOWDOWN_NO_PROXY_HOSTS)))
os.environ["NO_PROXY"] = no_proxy
os.environ["no_proxy"] = no_proxy

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from poke_env import AccountConfiguration, ShowdownServerConfiguration
from poke_env.concurrency import POKE_LOOP, handle_threaded_coroutines
from poke_env.player import Player
from poke_env.player.battle_order import BattleOrder, DefaultBattleOrder, DoubleBattleOrder
from poke_env.teambuilder.teambuilder import Teambuilder


def sanitize_text(value):
    """Remove lone UTF-16 surrogate code points before UTF-8 I/O."""
    if not isinstance(value, str):
        return value
    return "".join(char for char in value if not 0xD800 <= ord(char) <= 0xDFFF)


def sanitize_value(value):
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, list):
        return [sanitize_value(item) for item in value]
    if isinstance(value, dict):
        return {sanitize_text(key): sanitize_value(item) for key, item in value.items()}
    return value


def run_threaded_coroutine(coro, loop=None):
    """Bridge poke-env versions without assuming PSClient exposes a loop."""
    if len(inspect.signature(handle_threaded_coroutines).parameters) >= 2:
        return handle_threaded_coroutines(coro, loop or POKE_LOOP)
    return handle_threaded_coroutines(coro)


class RotatingTeambuilder(Teambuilder):
    """Select a different validated rental team before each ladder search."""

    def __init__(self, teams, on_select=None):
        self.teams = list(teams or [])
        self.on_select = on_select
        self.recent_ids = []

    def yield_team(self):
        selected = choose_rotation_team(self.teams, self.recent_ids)
        if selected is None:
            return None
        team_id = str(selected.get("id", ""))
        self.recent_ids = (self.recent_ids + [team_id])[-min(12, max(1, len(self.teams) - 1)) :]
        if self.on_select:
            self.on_select(selected, self.recent_ids)
        return sanitize_text(str(selected.get("packedTeam") or ""))


LAPLACE_ROOT = Path(os.environ.get("LAPLACE_ROOT", "")).expanduser() if os.environ.get("LAPLACE_ROOT") else None
LAPLACE_ENGINE = None
LAPLACE_LOAD_ERROR = ""
if LAPLACE_ROOT and (LAPLACE_ROOT / "src" / "engine_search.py").exists():
    try:
        sys.path.insert(0, str(LAPLACE_ROOT / "src"))
        from engine_search import EnginePlayer as LAPLACE_ENGINE  # type: ignore
    except Exception as error:
        LAPLACE_LOAD_ERROR = f"{error.__class__.__name__}: {error}"
LAPLACE_AVAILABLE = LAPLACE_ENGINE is not None


ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = Path(os.environ.get("AGENT_DATA_ROOT", ROOT / "data" / "agent")).resolve()
STATE_LOCK = threading.Lock()
EVENT_LOOP = asyncio.new_event_loop()
ACTIVE_TASK = None
ACTIVE_PLAYER = None

STATE = {
    "status": "IDLE",
    "mode": "ladder",
    "rulesetId": "",
    "showdownFormatId": "",
    "battleType": "",
    "username": "",
    "gamesRequested": 0,
    "gamesFinished": 0,
    "wins": 0,
    "losses": 0,
    "ties": 0,
    "batchGamesRequested": 0,
    "batchGamesFinished": 0,
    "sessionId": "",
    "sessionGamesRequested": 0,
    "sessionGamesFinished": 0,
    "sessionWins": 0,
    "sessionLosses": 0,
    "sessionTies": 0,
    "continuous": False,
    "teamPoolSize": 0,
    "currentTeamId": "",
    "currentTeamTitle": "",
    "recentTeamIds": [],
    "rating": None,
    "ratingChange": None,
    "ratingUpdatedAt": None,
    "ratingRulesetId": "",
    "ratingShowdownFormatId": "",
    "ratingSource": "",
    "lastError": "",
    "connectionStatus": "DISCONNECTED",
    "queueStatus": "IDLE",
    "searchConfirmed": False,
    "serverSearchPayload": "",
    "activeBattleId": "",
    "lastServerEvent": "",
    "serverMessage": "",
    "requestCount": 0,
    "turnEventCount": 0,
    "decisionCount": 0,
    "fallbackCount": 0,
    "lastDecisionTurn": 0,
    "lastDecisionAt": None,
    "lastDecisionError": "",
    "lastRequestSummary": "",
    "lastSentMessage": "",
    "lastActivityAt": None,
    "lastBattleEventAt": None,
    "lastActionAt": None,
    "staleForSeconds": 0,
    "battleHealth": "IDLE",
    "staleThresholdSeconds": int(os.environ.get("AGENT_STALE_SECONDS", "45")),
    "startedAt": None,
    "connectedAt": None,
    "searchStartedAt": None,
    "battleStartedAt": None,
    "updatedAt": None,
    "policyVersion": "structured-visible-state-v1",
    "policyRequested": "structured",
    "policyFallback": "",
    "teamSource": "workbench",
    "teamId": "",
    "teamTitle": "",
    "submittedTeam": [],
    "battleSnapshot": {
        "turn": 0,
        "weather": "",
        "terrain": "",
        "own": {"slots": [], "active": []},
        "opponent": {"slots": [], "active": [], "revealedCount": 0},
        "lastEvent": "",
    },
}


def now():
    return datetime.now(timezone.utc).isoformat()


def update_state(**values):
    with STATE_LOCK:
        STATE.update(values)
        STATE["updatedAt"] = now()


def rating_path(ruleset_id, showdown_format_id):
    return DATA_ROOT / "ratings" / str(ruleset_id) / f"{str(showdown_format_id)}.json"


def load_rating_snapshot(ruleset_id, showdown_format_id):
    path = rating_path(ruleset_id, showdown_format_id)
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def numeric_rating(value):
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def persist_rating(payload, battle, result, battle_id):
    """Persist only the rating explicitly reported by Showdown/poke-env."""
    rating = numeric_rating(getattr(battle, "rating", None))
    if rating is None:
        return None
    opponent_rating = numeric_rating(getattr(battle, "opponent_rating", None))
    previous = load_rating_snapshot(payload["rulesetId"], payload["showdownFormatId"])
    previous_rating = numeric_rating(previous.get("rating"))
    change = rating - previous_rating if previous_rating is not None else None
    snapshot = {
        "rulesetId": payload["rulesetId"],
        "showdownFormatId": payload["showdownFormatId"],
        "battleType": payload.get("battleType", ""),
        "username": payload.get("username", ""),
        "rating": rating,
        "previousRating": previous_rating,
        "ratingChange": change,
        "opponentRating": opponent_rating,
        "result": result,
        "battleId": str(battle_id),
        "updatedAt": now(),
        "source": "poke-env battle.rating",
    }
    write_json(rating_path(payload["rulesetId"], payload["showdownFormatId"]), snapshot)
    update_state(
        rating=rating,
        ratingChange=change,
        ratingUpdatedAt=snapshot["updatedAt"],
        ratingRulesetId=snapshot["rulesetId"],
        ratingShowdownFormatId=snapshot["showdownFormatId"],
        ratingSource=snapshot["source"],
    )
    return snapshot


def list_rating_snapshots():
    root = DATA_ROOT / "ratings"
    items = []
    if not root.exists():
        return items
    for path in root.glob("*/*.json"):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(item, dict) and item.get("rulesetId") and item.get("showdownFormatId"):
                items.append(item)
        except Exception:
            continue
    items.sort(key=lambda item: str(item.get("updatedAt", "")), reverse=True)
    return items


def public_state():
    with STATE_LOCK:
        state = dict(STATE)
    activity = state.get("lastBattleEventAt") or state.get("lastActivityAt")
    stale_for = 0
    if activity and state.get("status") in {"SEARCHING", "BATTLE", "AUTHENTICATED"}:
        try:
            stale_for = max(0, int(time.time() - datetime.fromisoformat(activity.replace("Z", "+00:00")).timestamp()))
        except (TypeError, ValueError):
            stale_for = 0
    state["staleForSeconds"] = stale_for
    state["battleHealth"] = "STALE" if stale_for >= state.get("staleThresholdSeconds", 45) and state.get("status") == "BATTLE" else "ACTIVE" if state.get("status") in {"SEARCHING", "BATTLE"} else state.get("status", "IDLE")
    return state


def mark_battle_active():
    if public_state()["status"] != "BATTLE":
        update_state(status="BATTLE", queueStatus="IN_BATTLE", battleStartedAt=now())


def choose_rotation_team(team_pool, recent_ids):
    if not team_pool:
        return None
    recent = {str(value) for value in (recent_ids or [])}
    available = [item for item in team_pool if str(item.get("id", "")) not in recent]
    candidates = available or list(team_pool)
    weights = [max(1.0, float(item.get("rate", 0) or 0) + max(0.0, 1400.0 - float(item.get("rank", 9999) or 9999)) / 50.0) for item in candidates]
    return random.choices(candidates, weights=weights, k=1)[0]


def snapshot_pokemon(pokemon, active=False):
    if pokemon is None:
        return None
    species = str(getattr(pokemon, "species", "") or getattr(pokemon, "name", "") or "")
    slug = species.lower().replace("'", "").replace(".", "").replace(" ", "-")
    ident = str(getattr(pokemon, "ident", "") or "")
    hp_fraction = getattr(pokemon, "current_hp_fraction", None)
    try:
        hp_fraction = max(0.0, min(1.0, float(hp_fraction))) if hp_fraction is not None else None
    except (TypeError, ValueError):
        hp_fraction = None
    moves = getattr(pokemon, "moves", {}) or {}
    move_names = []
    if isinstance(moves, dict):
        move_names = [str(getattr(move, "id", "") or getattr(move, "name", "")) for move in moves.values()]
    elif isinstance(moves, (list, tuple, set)):
        move_names = [str(getattr(move, "id", "") or getattr(move, "name", "") or move) for move in moves]
    raw_status = getattr(pokemon, "status", "")
    status_name = getattr(raw_status, "name", None) or getattr(raw_status, "value", None) or raw_status
    status_text = str(status_name or "").strip()
    if "fnt" in status_text.lower() or "fainted" in status_text.lower():
        status_text = "fnt"
    return {
        "id": ident or species.lower().replace(" ", "-"),
        "species": species,
        "slug": slug,
        "sprite": slug,
        "name": species,
        "ident": ident,
        "active": bool(active),
        "fainted": bool(getattr(pokemon, "fainted", False)),
        "hpFraction": hp_fraction,
        "status": status_text,
        "types": [str(item) for item in (getattr(pokemon, "types", ()) or ()) if item],
        "item": str(getattr(pokemon, "item", "") or ""),
        "ability": str(getattr(pokemon, "ability", "") or ""),
        "moves": [item for item in move_names if item],
    }


def pokemon_collection(value):
    """Normalize poke-env's single and double battle slot shapes."""
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [item for item in value if item is not None]
    return [value]


def battle_snapshot(battle, last_event=""):
    own_values = list((getattr(battle, "team", {}) or {}).values())
    opponent_values = list((getattr(battle, "opponent_team", {}) or {}).values())
    own_active = pokemon_collection(getattr(battle, "active_pokemon", None))
    opponent_active = pokemon_collection(getattr(battle, "opponent_active_pokemon", None))
    own_active_ids = {id(item) for item in own_active if item is not None}
    opponent_active_ids = {id(item) for item in opponent_active if item is not None}
    own_slots = [snapshot_pokemon(item, id(item) in own_active_ids) for item in own_values]
    opponent_slots = [snapshot_pokemon(item, id(item) in opponent_active_ids) for item in opponent_values]
    own_slots = [item for item in own_slots if item]
    opponent_slots = [item for item in opponent_slots if item]
    return {
        "turn": int(getattr(battle, "turn", 0) or 0),
        "weather": str(getattr(battle, "weather", "") or ""),
        "terrain": str(getattr(battle, "terrain", "") or ""),
        "own": {"slots": own_slots, "active": [item for item in own_slots if item["active"]]},
        "opponent": {"slots": opponent_slots, "active": [item for item in opponent_slots if item["active"]], "revealedCount": len(opponent_slots)},
        "lastEvent": str(last_event or ""),
    }


def submitted_team_snapshot():
    return [
        {
            **member,
            "active": False,
            "fainted": False,
            "hpFraction": 1.0,
            "status": "",
        }
        for member in public_state().get("submittedTeam", [])
        if isinstance(member, dict)
    ]


def merge_battle_snapshot(battle, last_event=""):
    snapshot = battle_snapshot(battle, last_event) if battle is not None else {
        "turn": 0,
        "weather": "",
        "terrain": "",
        "own": {"slots": [], "active": []},
        "opponent": {"slots": [], "active": [], "revealedCount": 0},
        "lastEvent": last_event,
    }
    submitted = submitted_team_snapshot()
    if submitted:
        if not snapshot["own"]["slots"]:
            snapshot["own"]["slots"] = submitted
        else:
            known = {str(item.get("species") or item.get("name") or "").lower().replace("-", "") for item in snapshot["own"]["slots"]}
            snapshot["own"]["slots"] = submitted + [item for item in snapshot["own"]["slots"] if str(item.get("species") or item.get("name") or "").lower().replace("-", "") not in known]
        snapshot["own"]["active"] = [item for item in snapshot["own"]["slots"] if item.get("active")]
    return snapshot


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sanitize_value(payload), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def session_state_path(session_id):
    return DATA_ROOT / "sessions" / f"{session_id}.json"


def persist_session_state():
    session_id = public_state().get("sessionId")
    if not session_id:
        return
    state = public_state()
    safe = {
        key: state.get(key)
        for key in (
            "sessionId", "status", "rulesetId", "showdownFormatId", "battleType", "username",
            "gamesRequested", "gamesFinished", "wins", "losses", "ties", "batchGamesRequested",
            "batchGamesFinished", "sessionGamesRequested", "sessionGamesFinished", "sessionWins",
            "sessionLosses", "sessionTies", "continuous", "teamPoolSize", "currentTeamId",
            "currentTeamTitle", "recentTeamIds", "teamSource", "policyVersion", "startedAt",
            "updatedAt", "lastError", "queueStatus", "rating", "ratingChange", "ratingUpdatedAt",
        )
    }
    write_json(session_state_path(session_id), safe)


def battle_room_from_message(message):
    for line in str(message).splitlines():
        if line.startswith(">battle-"):
            return line[1:].split("\t", 1)[0].strip()
    return ""


def public_battle_event(line):
    """Keep only public Showdown protocol data for later analysis."""
    raw = str(line or "").strip()
    if not raw or raw.startswith(">" ):
        return None
    parts = raw.split("|")
    if len(parts) < 2:
        return None
    event = parts[1]
    allowed = {
        "player", "teamsize", "poke", "switch", "drag", "move", "-damage",
        "-heal", "-status", "-curestatus", "-boost", "-unboost", "-weather",
        "-fieldstart", "-fieldend", "-sidestart", "-sideend", "-activate",
        "-immune", "-miss", "faint", "turn", "win", "tie", "draw", "request",
    }
    if event not in allowed:
        return None
    if event == "request":
        try:
            request = json.loads(parts[2] or "{}")
        except Exception:
            return {"type": "request", "parseError": True}
        # The request is the authoritative visible action space. It never
        # contains the opponent's unrevealed set.
        return {
            "type": "request",
            "turn": int(request.get("turn", 0) or 0),
            "teamPreview": bool(request.get("teamPreview")),
            "wait": bool(request.get("wait")),
            "forceSwitch": request.get("forceSwitch", []),
            "active": request.get("active", []),
            "side": request.get("side", {}),
        }
    return {"type": event, "line": raw[:1200]}


class StructuredPlayer(Player):
    @staticmethod
    def pokemon_preview_score(pokemon, opponents):
        moves = list((getattr(pokemon, "moves", {}) or {}).values())
        score = max((float(getattr(move, "base_power", 0) or 0) for move in moves), default=0.0)
        move_ids = {getattr(move, "id", "") for move in moves}
        score += 24.0 * bool(move_ids & {"tailwind", "trickroom", "icywind", "electroweb"})
        score += 18.0 * bool(move_ids & {"fakeout", "followme", "ragepowder"})
        score += 8.0 * bool(move_ids & {"protect", "detect", "wideguard"})
        for move in moves:
            if not getattr(move, "type", None) or not getattr(move, "base_power", 0):
                continue
            for opponent in opponents:
                try:
                    score += max(0.0, float(opponent.damage_multiplier(move)) - 1.0) * 12.0
                except Exception:
                    continue
        return score

    def teampreview(self, battle):
        mark_battle_active()
        members = list((getattr(battle, "team", {}) or {}).values())
        opponents = list((getattr(battle, "opponent_team", {}) or {}).values())
        ranked = sorted(
            enumerate(members, start=1),
            key=lambda item: (-self.pokemon_preview_score(item[1], opponents), item[0]),
        )
        team_size = int(getattr(battle, "max_team_size", 0) or len(ranked))
        return "/team " + "".join(str(index) for index, _ in ranked[:team_size])

    async def _handle_battle_request(
        self,
        battle,
        from_teampreview_request=False,
        maybe_default_order=False,
    ):
        turn = int(getattr(battle, "turn", 0) or 0)
        try:
            if any(getattr(battle, "force_switch", []) or []):
                choice = self.choose_doubles_move(battle)
                message = choice.message or "/choose default"
                await self.ps_client.send_message(message, battle.battle_tag)
                return
            await super()._handle_battle_request(
                battle,
                from_teampreview_request=from_teampreview_request,
                maybe_default_order=maybe_default_order,
            )
        except Exception as error:
            state = public_state()
            update_state(
                lastDecisionTurn=turn,
                lastDecisionAt=now(),
                lastDecisionError=f"{error.__class__.__name__}: {error}",
            )
            if getattr(battle, "teampreview", False):
                message = self.teampreview(battle)
            else:
                message = self.choose_random_move(battle).message
            await self.ps_client.send_message(message, battle.battle_tag)
            update_state(fallbackCount=int(state.get("fallbackCount", 0)) + 1)

    @staticmethod
    def move_score(move, mon=None, target=0):
        move_id = getattr(move, "id", "")
        value = float(getattr(move, "base_power", 0) or 0)
        if mon and getattr(move, "type", None) in (getattr(mon, "types", ()) or ()):
            value *= 1.5
        if move_id in {"tailwind", "trickroom", "icywind", "electroweb", "thunderwave"}:
            value = max(value, 88.0)
        elif move_id in {"fakeout", "ragepowder", "followme", "wideguard"}:
            value = max(value, 74.0)
        elif move_id in {"protect", "detect", "spikyshield", "kingsshield"}:
            hp = float(getattr(mon, "current_hp_fraction", 1.0) or 1.0)
            value = 76.0 if hp < 0.45 else 38.0
        elif value <= 0:
            value = 28.0
        if target < 0 and float(getattr(move, "base_power", 0) or 0) > 0:
            value -= 200.0
        return value

    def choose_doubles_move(self, battle):
        if any(battle.force_switch):
            selected = []
            orders = []
            for forced, switches in zip(battle.force_switch, battle.available_switches):
                available = [pokemon for pokemon in switches if pokemon not in selected]
                if forced and available:
                    choice = max(available, key=lambda pokemon: float(getattr(pokemon, "current_hp_fraction", 0) or 0))
                    selected.append(choice)
                    orders.append(BattleOrder(choice))
                else:
                    orders.append(None)
            return DoubleBattleOrder(orders[0], orders[1])

        slot_orders = [[], []]
        for index, (mon, moves, switches) in enumerate(zip(battle.active_pokemon, battle.available_moves, battle.available_switches)):
            if not mon:
                continue
            for move in moves:
                for target in battle.get_possible_showdown_targets(move, mon):
                    slot_orders[index].append((self.move_score(move, mon, target), BattleOrder(move, move_target=target)))
            hp = float(getattr(mon, "current_hp_fraction", 1.0) or 1.0)
            for switch in switches:
                switch_score = 62.0 if hp < 0.25 else 18.0
                slot_orders[index].append((switch_score, BattleOrder(switch)))
            slot_orders[index].sort(key=lambda item: item[0], reverse=True)
            slot_orders[index] = slot_orders[index][:8]

        joint = DoubleBattleOrder.join_orders(
            [item[1] for item in slot_orders[0]],
            [item[1] for item in slot_orders[1]],
        )
        if not joint:
            return DefaultBattleOrder()

        score_by_message = {
            order.message: score
            for slot in slot_orders
            for score, order in slot
        }
        return max(joint, key=lambda order: score_by_message.get(order.first_order.message if order.first_order else "", 0) + score_by_message.get(order.second_order.message if order.second_order else "", 0))

    def choose_move(self, battle):
        mark_battle_active()
        if getattr(battle, "teampreview", False):
            return self.teampreview(battle)
        if getattr(battle, "is_doubles", False):
            return self.choose_doubles_move(battle)
        moves = list(getattr(battle, "available_moves", []) or [])
        if not moves:
            return self.choose_random_move(battle)
        active = getattr(battle, "active_pokemon", None)
        opponent = getattr(battle, "opponent_active_pokemon", None)

        def score(move):
            value = float(getattr(move, "base_power", 0) or 0)
            if active and getattr(move, "type", None) in (getattr(active, "types", ()) or ()):
                value *= 1.5
            if opponent and getattr(move, "type", None):
                try:
                    value *= opponent.damage_multiplier(move)
                except Exception:
                    pass
            if getattr(move, "category", None) and str(move.category).lower().endswith("status"):
                value = max(value, 35.0)
            return value

        best = max(moves, key=score)
        return self.create_order(best)


def model_registry_path(ruleset_id):
    return DATA_ROOT / "models" / ruleset_id / "registry.json"


def load_model_registry(ruleset_id):
    path = model_registry_path(ruleset_id)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "rulesetId": ruleset_id,
        "champion": {"version": "structured-visible-state-v1", "status": "active"},
        "challengers": [],
        "updatedAt": now(),
    }


POLICY_METADATA = {
    "structured-visible-state-v1": {
        "label": "结构化可见状态策略",
        "description": "规则约束、合法动作掩码与数值启发式",
        "availability": "ladder",
    },
    "laplace-engine-v1": {
        "label": "Laplace 单打策略",
        "description": "Laplace / poke-engine 单打决策策略",
        "availability": "ladder-single",
    },
    "replay-import": {
        "label": "历史回放导入",
        "description": "从本地 Showdown 回放提取训练与配队反馈",
        "availability": "analysis-only",
    },
}


def strategy_metadata(version, battle_type=""):
    metadata = POLICY_METADATA.get(version, {})
    availability = metadata.get("availability", "analysis-only")
    if version == "laplace-engine-v1" and battle_type == "double":
        availability = "analysis-only"
    return {
        "id": version,
        "version": version,
        "label": metadata.get("label", version),
        "description": metadata.get("description", "按 trace 自动发现的策略"),
        "availability": availability,
    }


def strategy_stats(ruleset_id, battle_type=""):
    trace_dir = DATA_ROOT / "traces" / ruleset_id
    stats = {}
    if not trace_dir.exists():
        return []
    for path in trace_dir.glob("*.json"):
        try:
            trace = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if trace.get("rulesetId") != ruleset_id:
            continue
        trace_type = str(trace.get("battleType") or "").lower()
        if battle_type and ((battle_type == "double" and trace_type != "double") or (battle_type != "double" and trace_type == "double")):
            continue
        result = str(trace.get("result") or "").lower()
        if result not in {"win", "loss", "tie"}:
            continue
        version = str(trace.get("policyVersion") or "structured-visible-state-v1")
        item = stats.setdefault(version, {"games": 0, "wins": 0, "losses": 0, "ties": 0, "lastPlayedAt": ""})
        item["games"] += 1
        item["wins"] += int(result == "win")
        item["losses"] += int(result == "loss")
        item["ties"] += int(result == "tie")
        played_at = str(trace.get("finishedAt") or trace.get("startedAt") or "")
        if played_at > item["lastPlayedAt"]:
            item["lastPlayedAt"] = played_at
    return [
        {
            **strategy_metadata(version, battle_type),
            **item,
            "winRate": round(item["wins"] / item["games"] * 1000) / 10 if item["games"] else 0,
        }
        for version, item in sorted(stats.items(), key=lambda pair: (pair[1]["lastPlayedAt"], pair[0]), reverse=True)
    ]


def enrich_model_registry(registry, battle_type=""):
    result = dict(registry or {})
    ruleset_id = str(result.get("rulesetId") or "")
    strategies = {item["id"]: item for item in strategy_stats(ruleset_id, battle_type)}
    champion_version = str((result.get("champion") or {}).get("version") or "structured-visible-state-v1")
    if champion_version not in strategies:
        strategies[champion_version] = strategy_metadata(champion_version, battle_type) | {
            "games": 0, "wins": 0, "losses": 0, "ties": 0, "winRate": 0, "lastPlayedAt": "",
        }
    result["strategies"] = list(strategies.values())
    result["totalGames"] = sum(item["games"] for item in strategies.values())
    result["wins"] = sum(item["wins"] for item in strategies.values())
    result["losses"] = sum(item["losses"] for item in strategies.values())
    result["ties"] = sum(item["ties"] for item in strategies.values())
    result["winRate"] = round(result["wins"] / result["totalGames"] * 1000) / 10 if result["totalGames"] else 0
    policy_root = DATA_ROOT / "models" / ruleset_id / "policies"
    unique_challengers = []
    seen_training_signatures = set()
    for item in result.get("challengers", []):
        policy_path = policy_root / f"{item.get('version', '')}.json"
        if not policy_path.exists():
            continue
        try:
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
        except Exception:
            policy = {}
        fingerprint = str(item.get("trainingFingerprint") or policy.get("trainingFingerprint") or "")
        if fingerprint:
            signature = f"fingerprint:{fingerprint}"
            item = {**item, "trainingFingerprint": fingerprint}
        else:
            legacy_training_input = {
                "rulesetId": ruleset_id,
                "format": policy.get("format") or battle_type,
                "parentVersion": policy.get("parentVersion") or item.get("parentVersion"),
                "weights": policy.get("weights") or {},
                "sourceTraceIds": policy.get("sourceTraceIds") or [],
            }
            signature = "legacy:" + hashlib.sha256(
                json.dumps(legacy_training_input, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
        if signature in seen_training_signatures:
            continue
        seen_training_signatures.add(signature)
        unique_challengers.append(item)
    result["challengers"] = unique_challengers
    result["updatedAt"] = result.get("updatedAt") or now()
    return result


def register_training_checkpoint(summary):
    ruleset_id = summary["rulesetId"]
    registry = load_model_registry(ruleset_id)
    registry["updatedAt"] = now()
    write_json(model_registry_path(ruleset_id), registry)


async def _run_ladder_batch(payload):
    global ACTIVE_PLAYER
    payload = sanitize_value(payload)
    replay_dir = DATA_ROOT / "showdown-replays" / payload["rulesetId"]
    trace_dir = DATA_ROOT / "traces" / payload["rulesetId"]
    replay_dir.mkdir(parents=True, exist_ok=True)
    trace_dir.mkdir(parents=True, exist_ok=True)
    requested_policy = str(payload.get("policy") or os.environ.get("AGENT_POLICY", "structured")).strip().lower()
    saved_rating = load_rating_snapshot(payload["rulesetId"], payload["showdownFormatId"])
    team_pool = [item for item in (payload.get("teamPool") or []) if item.get("packedTeam")]
    continuous = bool(payload.get("continuous")) and bool(team_pool)
    session_id = str(payload.get("sessionId") or f"session-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}")
    previous_state = public_state()
    resuming_session = previous_state.get("sessionId") == session_id
    initial_recent_team_ids = list(payload.get("recentTeamIds") or (previous_state.get("recentTeamIds", []) if resuming_session else []))
    use_laplace = requested_policy in {"laplace", "laplace-v1"} and payload.get("battleType") == "single"
    policy_version = "laplace-engine-v1" if use_laplace else "structured-visible-state-v1"
    policy_fallback = ""
    if use_laplace and not LAPLACE_AVAILABLE:
        use_laplace = False
        policy_fallback = "Laplace 未加载：请配置 LAPLACE_ROOT，并安装其 poke-engine 依赖。"
        if LAPLACE_LOAD_ERROR:
            policy_fallback += f" ({LAPLACE_LOAD_ERROR})"
    if requested_policy.startswith("laplace") and payload.get("battleType") != "single":
        policy_fallback = "Laplace 当前仅接入单打；双打已回退 structured-visible-state-v1。"
    update_state(
        status="CONNECTING",
        mode="ladder",
        rulesetId=payload["rulesetId"],
        showdownFormatId=payload["showdownFormatId"],
        battleType=payload["battleType"],
        username=payload["username"],
        gamesRequested=payload["games"],
        gamesFinished=0,
        batchGamesRequested=payload["games"],
        batchGamesFinished=0,
        sessionId=session_id,
        sessionGamesRequested=(int(previous_state.get("sessionGamesRequested", 0)) if resuming_session else 0) if continuous else payload["games"],
        sessionGamesFinished=int(previous_state.get("sessionGamesFinished", 0)) if resuming_session else 0,
        sessionWins=int(previous_state.get("sessionWins", 0)) if resuming_session else 0,
        sessionLosses=int(previous_state.get("sessionLosses", 0)) if resuming_session else 0,
        sessionTies=int(previous_state.get("sessionTies", 0)) if resuming_session else 0,
        continuous=continuous,
        teamPoolSize=len(team_pool),
        currentTeamId=str(payload.get("teamId") or ""),
        currentTeamTitle=str(payload.get("teamTitle") or ""),
        recentTeamIds=initial_recent_team_ids,
        wins=0,
        losses=0,
        ties=0,
        rating=numeric_rating(saved_rating.get("rating")),
        ratingChange=None,
        ratingUpdatedAt=saved_rating.get("updatedAt"),
        ratingRulesetId=payload["rulesetId"] if saved_rating else "",
        ratingShowdownFormatId=payload["showdownFormatId"] if saved_rating else "",
        ratingSource=saved_rating.get("source", "") if saved_rating else "",
        lastError="",
        connectionStatus="CONNECTING",
        queueStatus="IDLE",
        searchConfirmed=False,
        serverSearchPayload="",
        activeBattleId="",
        lastServerEvent="",
        serverMessage="",
        requestCount=0,
        turnEventCount=0,
        decisionCount=0,
        fallbackCount=0,
        lastDecisionTurn=0,
        lastDecisionAt=None,
        lastDecisionError="",
        lastRequestSummary="",
        lastSentMessage="",
        lastActivityAt=now(),
        lastBattleEventAt=None,
        lastActionAt=None,
        staleForSeconds=0,
        battleHealth="CONNECTING",
        startedAt=now(),
        connectedAt=None,
        searchStartedAt=None,
        battleStartedAt=None,
        policyVersion=policy_version,
        policyRequested=requested_policy,
        policyFallback=policy_fallback,
        teamSource=str(payload.get("teamSource") or "workbench"),
        teamId=str(payload.get("teamId") or ""),
        teamTitle=str(payload.get("teamTitle") or ""),
        submittedTeam=payload.get("teamMembers") or [],
        battleSnapshot={
            "turn": 0,
            "weather": "",
            "terrain": "",
            "own": {"slots": [], "active": []},
            "opponent": {"slots": [], "active": [], "revealedCount": 0},
            "lastEvent": "",
        },
    )
    persist_session_state()
    player_class = LAPLACE_ENGINE if use_laplace else StructuredPlayer
    selected_team_meta = {
        "id": str(payload.get("teamId") or ""),
        "title": str(payload.get("teamTitle") or ""),
        "members": payload.get("teamMembers") or [],
    }

    def select_team(selected, recent):
        selected_team_meta.update({
            "id": str(selected.get("id", "")),
            "title": str(selected.get("title", "当前规则热门队伍")),
            "members": selected.get("teamMembers") or [],
        })
        update_state(
            currentTeamId=selected_team_meta["id"],
            currentTeamTitle=selected_team_meta["title"],
            teamSource="hot-rotation",
            teamId=selected_team_meta["id"],
            teamTitle=selected_team_meta["title"],
            submittedTeam=selected_team_meta["members"],
            recentTeamIds=recent,
        )
        persist_session_state()

    rotating_team = RotatingTeambuilder(team_pool, on_select=select_team) if team_pool else None
    if rotating_team:
        rotating_team.recent_ids = initial_recent_team_ids[-min(12, max(1, len(team_pool) - 1)) :]
    player_kwargs = {
        "account_configuration": AccountConfiguration(payload["username"], payload["password"]),
        "server_configuration": ShowdownServerConfiguration,
        "battle_format": payload["showdownFormatId"],
        "team": rotating_team or payload["team"],
        "max_concurrent_battles": 1,
        "save_replays": str(replay_dir),
        "accept_open_team_sheet": bool(payload.get("openTeamSheets")),
        "start_timer_on_battle_start": True,
    }
    player = player_class(**player_kwargs)
    ACTIVE_PLAYER = player
    handle_message = player.ps_client._handle_message
    traces = {}
    current_battle_id = ""

    def trace_for(battle_id):
        key = str(battle_id or "unknown-battle")
        if key not in traces:
            current_state = public_state()
            traces[key] = {
                "schemaVersion": 1,
                "rulesetId": payload["rulesetId"],
                "showdownFormatId": payload["showdownFormatId"],
                "battleType": payload["battleType"],
                "teamVersion": payload.get("teamVersion", "manual"),
                "teamSource": current_state.get("teamSource") or payload.get("teamSource", "workbench"),
                "teamId": current_state.get("currentTeamId") or payload.get("teamId", ""),
                "teamTitle": current_state.get("currentTeamTitle") or payload.get("teamTitle", ""),
                "teamMembers": current_state.get("submittedTeam") or payload.get("teamMembers") or [],
                "username": payload.get("username", ""),
                "policyVersion": policy_version,
                "battleId": key,
                "startedAt": now(),
                "events": [],
                "actions": [],
                "result": "unknown",
                "replayFile": "",
                "eligibleForBuildFeedback": True,
            }
        return traces[key]

    def append_trace_event(battle_id, event):
        trace = trace_for(battle_id)
        if event and len(trace["events"]) < 2000:
            trace["events"].append({"at": now(), **event})

    async def tracked_handle_message(message):
        nonlocal current_battle_id
        message_battle_id = battle_room_from_message(message)
        if message_battle_id:
            current_battle_id = message_battle_id
            update_state(activeBattleId=message_battle_id)
        update_state(lastActivityAt=now())
        for line in str(message).splitlines():
            event = public_battle_event(line)
            if event:
                append_trace_event(message_battle_id or current_battle_id, event)
                update_state(
                    lastActivityAt=now(),
                    lastBattleEventAt=now(),
                    lastServerEvent=str(event.get("type") or "BATTLE_EVENT").upper(),
                )
            parts = line.split("|")
            if len(parts) > 1 and parts[1] == "request":
                state = public_state()
                request_summary = {}
                try:
                    request = json.loads(parts[2] or "{}")
                    request_summary = {
                        "keys": sorted(request.keys()),
                        "teamPreview": bool(request.get("teamPreview")),
                        "wait": bool(request.get("wait")),
                        "forceSwitch": request.get("forceSwitch", []),
                        "activeSlots": len(request.get("active", []) or []),
                        "moveSlots": [len(slot.get("moves", []) or []) for slot in request.get("active", []) or []],
                        "switchSlots": [len(slot.get("switches", []) or []) for slot in request.get("active", []) or []],
                    }
                except Exception:
                    request_summary = {"parseError": True}
                update_state(
                    requestCount=int(state.get("requestCount", 0)) + 1,
                    lastRequestSummary=json.dumps(request_summary, ensure_ascii=True),
                )
            elif len(parts) > 1 and parts[1] == "turn":
                state = public_state()
                update_state(turnEventCount=int(state.get("turnEventCount", 0)) + 1)
            if len(parts) > 2 and parts[1] == "updatesearch":
                raw_search_payload = parts[2] or "{}"
                try:
                    search_state = json.loads(raw_search_payload)
                    searching = search_state.get("searching", [])
                    games = search_state.get("games") or {}
                except Exception:
                    searching = []
                    games = {}
                confirmed = payload["showdownFormatId"] in searching
                if games:
                    current_battle_id = next(iter(games))
                    trace_for(current_battle_id)["matchedAt"] = now()
                    update_state(
                        status="BATTLE",
                        searchConfirmed=False,
                        queueStatus="IN_BATTLE",
                        serverSearchPayload=raw_search_payload[:500],
                        activeBattleId=next(iter(games)),
                        battleStartedAt=now(),
                        lastServerEvent="BATTLE_MATCHED",
                    )
                else:
                    update_state(
                        searchConfirmed=confirmed,
                        queueStatus="SEARCH_CONFIRMED" if confirmed else "SEARCH_SENT",
                        serverSearchPayload=raw_search_payload[:500],
                        lastServerEvent="UPDATESEARCH",
                    )
            elif len(parts) > 1 and parts[1] == "popup":
                server_message = " ".join(part for part in parts[2:] if part).strip()
                update_state(lastServerEvent="POPUP", serverMessage=server_message[:1000])
        await handle_message(message)
        battle = getattr(player, "battles", {}).get(current_battle_id) if getattr(player, "battles", None) and current_battle_id else None
        update_state(battleSnapshot=merge_battle_snapshot(battle, public_state().get("lastServerEvent", "")))

    player.ps_client._handle_message = tracked_handle_message
    send_message = player.ps_client.send_message

    async def tracked_send_message(message, room="", message_2=None):
        message = sanitize_text(str(message or ""))
        room = sanitize_text(str(room or ""))
        message_2 = sanitize_text(str(message_2)) if message_2 is not None else None
        if room and str(room).startswith("battle-"):
            if not str(message).strip():
                state = public_state()
                message = "/choose default"
                update_state(fallbackCount=int(state.get("fallbackCount", 0)) + 1)
            command = str(message)[:500]
            state = public_state()
            action_update = {
                "lastSentMessage": command,
                "lastActionAt": now(),
                "lastActivityAt": now(),
            }
            battle = getattr(player, "battles", {}).get(room) if getattr(player, "battles", None) else None
            if battle is not None:
                action_update["lastDecisionTurn"] = int(getattr(battle, "turn", 0) or 0)
                action_update["battleSnapshot"] = merge_battle_snapshot(battle, public_state().get("lastServerEvent", ""))
            if command.startswith("/choose") or command.startswith("/team"):
                action_update["decisionCount"] = int(state.get("decisionCount", 0)) + 1
                action_update["lastDecisionAt"] = now()
                action_update["lastDecisionError"] = ""
            update_state(**action_update)
            append_trace_event(room, {
                "type": "agent-action",
                "turn": int(public_state().get("lastDecisionTurn", 0) or 0),
                "command": str(message)[:500],
            })
        try:
            return await send_message(message, room, message_2)
        except Exception as error:
            update_state(lastDecisionError=f"{error.__class__.__name__}: {error}", lastServerEvent="SEND_ERROR")
            raise

    player.ps_client.send_message = tracked_send_message
    try:
        await asyncio.wait_for(
            run_threaded_coroutine(player.ps_client.logged_in.wait(), getattr(player.ps_client, "loop", None)),
            timeout=20,
        )
        update_state(
            status="AUTHENTICATED",
            connectionStatus="AUTHENTICATED",
            queueStatus="IDLE",
            connectedAt=now(),
        )
        search_ladder_game = player.ps_client.search_ladder_game

        async def tracked_search_ladder_game(format_id, packed_team):
            await search_ladder_game(format_id, packed_team)
            state = public_state()
            update_state(
                status="SEARCHING",
                queueStatus="SEARCH_SENT",
                searchStartedAt=now(),
                batchGamesFinished=int(state.get("batchGamesFinished", 0)),
            )
            persist_session_state()

        player.ps_client.search_ladder_game = tracked_search_ladder_game
        finished_battles = set()
        finished_trace_files = []
        observed = {"games": 0, "wins": 0, "losses": 0, "ties": 0}

        def battle_result(battle):
            if bool(getattr(battle, "won", False)):
                return "win"
            if bool(getattr(battle, "lost", False)):
                return "loss"
            if bool(getattr(battle, "finished", False)):
                return "tie"
            return "unknown"

        def replay_files_for_batch():
            started = public_state().get("startedAt")
            try:
                started_timestamp = datetime.fromisoformat(started.replace("Z", "+00:00")).timestamp()
            except (AttributeError, ValueError):
                started_timestamp = 0
            return [
                path.name
                for path in sorted(replay_dir.glob("*.html"), key=lambda item: item.stat().st_mtime, reverse=True)
                if path.stat().st_mtime >= started_timestamp - 2
            ]

        def persist_finished_battle(battle_id, battle, replay_files):
            key = str(battle_id)
            if key in finished_battles:
                return
            result = battle_result(battle)
            if result == "unknown":
                return
            finished_battles.add(key)
            observed["games"] += 1
            observed["wins"] += int(result == "win")
            observed["losses"] += int(result == "loss")
            observed["ties"] += int(result == "tie")
            trace = trace_for(key)
            trace["finishedAt"] = now()
            trace["turns"] = int(getattr(battle, "turn", 0) or 0)
            trace["result"] = result
            rating_snapshot = persist_rating(payload, battle, result, key)
            if rating_snapshot:
                trace["rating"] = rating_snapshot["rating"]
                trace["ratingChange"] = rating_snapshot["ratingChange"]
                trace["opponentRating"] = rating_snapshot["opponentRating"]
                trace["ratingUpdatedAt"] = rating_snapshot["updatedAt"]
            trace["replayFile"] = replay_files[min(observed["games"] - 1, len(replay_files) - 1)] if replay_files else ""
            trace_name = trace.get("traceFile") or f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{observed['games']}-{key.replace('/', '_')}.json"
            trace["traceFile"] = trace_name
            write_json(trace_dir / trace_name, trace)
            finished_trace_files.append(trace_name)
            update_state(
                gamesFinished=observed["games"],
                batchGamesFinished=observed["games"],
                sessionGamesFinished=int(public_state().get("sessionGamesFinished", 0)) + 1,
                sessionWins=int(public_state().get("sessionWins", 0)) + int(result == "win"),
                sessionLosses=int(public_state().get("sessionLosses", 0)) + int(result == "loss"),
                sessionTies=int(public_state().get("sessionTies", 0)) + int(result == "tie"),
                wins=observed["wins"],
                losses=observed["losses"],
                ties=observed["ties"],
                activeBattleId="",
                lastBattleEventAt=now(),
                lastServerEvent="BATTLE_FINISHED",
            )
            persist_session_state()

        async def observe_finished_battles():
            while True:
                replay_files = replay_files_for_batch()
                for battle_id, battle in list((getattr(player, "battles", {}) or {}).items()):
                    persist_finished_battle(battle_id, battle, replay_files)
                await asyncio.sleep(0.5)

        observer_task = asyncio.create_task(observe_finished_battles())
        try:
            await player.ladder(payload["games"])
        finally:
            observer_task.cancel()
            try:
                await observer_task
            except asyncio.CancelledError:
                pass
        replay_files = replay_files_for_batch()
        for battle_id, battle in list((getattr(player, "battles", {}) or {}).items()):
            persist_finished_battle(battle_id, battle, replay_files)
        # A replay can be written just after the server sends the win event.
        # Refresh already persisted traces so the UI can open it immediately.
        for trace_name in finished_trace_files:
            trace_path = trace_dir / trace_name
            try:
                trace = json.loads(trace_path.read_text(encoding="utf-8"))
                if not trace.get("replayFile") and replay_files:
                    trace["replayFile"] = replay_files[min(finished_trace_files.index(trace_name), len(replay_files) - 1)]
                    write_json(trace_path, trace)
            except Exception:
                continue
        summary = {
            "rulesetId": payload["rulesetId"],
            "showdownFormatId": payload["showdownFormatId"],
            "teamVersion": payload.get("teamVersion", "manual"),
            "teamSource": payload.get("teamSource", "workbench"),
            "teamId": payload.get("teamId", ""),
            "teamTitle": payload.get("teamTitle", ""),
            "policyVersion": STATE["policyVersion"],
            "policyRequested": STATE.get("policyRequested", "structured"),
            "policyFallback": STATE.get("policyFallback", ""),
            "replayFiles": replay_files[: int(player.n_finished_battles)],
            "traceFiles": finished_trace_files,
            "traceCount": len(finished_trace_files),
            "games": observed["games"],
            "wins": observed["wins"],
            "losses": observed["losses"],
            "ties": observed["ties"],
            "rating": public_state().get("rating"),
            "ratingChange": public_state().get("ratingChange"),
            "ratingUpdatedAt": public_state().get("ratingUpdatedAt"),
            "ratingSource": public_state().get("ratingSource", ""),
            "finishedAt": now(),
        }
        write_json(DATA_ROOT / "replays" / payload["rulesetId"] / f"batch-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json", summary)
        register_training_checkpoint(summary)
        update_state(
            status="IDLE",
            queueStatus="COMPLETE",
            gamesFinished=summary["games"],
            wins=summary["wins"],
            losses=summary["losses"],
            ties=summary["ties"],
            activeBattleId="",
            battleHealth="IDLE",
        )
        persist_session_state()
    except asyncio.CancelledError:
        update_state(status="STOPPED", queueStatus="STOPPED", lastError="Emergency stop requested.")
        persist_session_state()
        raise
    except asyncio.TimeoutError:
        update_state(
            status="FAILED",
            connectionStatus="DISCONNECTED",
            queueStatus="FAILED",
            lastError="Showdown 登录连接在 20 秒内未完成，请检查账号密码或网络后重试。",
        )
    except Exception as error:
        update_state(
            status="FAILED",
            queueStatus="FAILED",
            lastError=str(error) or error.__class__.__name__,
        )
    finally:
        try:
            await player.ps_client.stop_listening()
        except Exception:
            pass
        update_state(connectionStatus="DISCONNECTED")
        ACTIVE_PLAYER = None


async def run_ladder(payload):
    """Run batches continuously when automatic hot-team rotation is enabled."""
    continuous = bool(payload.get("continuous")) and bool(payload.get("teamPool"))
    session_id = str(payload.get("sessionId") or f"session-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}")
    while True:
        batch_payload = dict(payload)
        batch_payload["sessionId"] = session_id
        batch_payload["continuous"] = continuous
        batch_payload["recentTeamIds"] = public_state().get("recentTeamIds", [])
        await _run_ladder_batch(batch_payload)
        state = public_state()
        if not continuous or state.get("status") in {"FAILED", "STOPPED"}:
            return
        update_state(
            status="CONNECTING",
            queueStatus="NEXT_BATCH",
            batchGamesFinished=0,
            gamesFinished=0,
            wins=0,
            losses=0,
            ties=0,
            lastServerEvent="NEXT_BATCH",
            lastActivityAt=now(),
        )
        persist_session_state()
        await asyncio.sleep(0.75)


def list_replays(ruleset_id=""):
    root = DATA_ROOT / "replays"
    paths = list((root / ruleset_id).glob("*.json")) if ruleset_id else list(root.glob("*/*.json")) if root.exists() else []
    replay_root = DATA_ROOT / "showdown-replays"
    replay_files = {}
    if replay_root.exists():
        replay_paths = list((replay_root / ruleset_id).glob("*.html")) if ruleset_id else list(replay_root.glob("*/*.html"))
        for replay_path in replay_paths:
            replay_files.setdefault(replay_path.parent.name, []).append({
                "fileName": replay_path.name,
                "size": replay_path.stat().st_size,
                "updatedAt": datetime.fromtimestamp(replay_path.stat().st_mtime, timezone.utc).isoformat(),
            })
        for files in replay_files.values():
            files.sort(key=lambda item: item["updatedAt"], reverse=True)
    items = []
    cursors = {key: 0 for key in replay_files}
    for path in sorted(paths, reverse=True)[:200]:
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            item.setdefault("batchId", path.stem)
            pool = replay_files.get(path.parent.name, [])
            start = cursors.get(path.parent.name, 0)
            count = int(item.get("games", 0) or 0)
            item["replays"] = pool[start:start + count] if count else []
            cursors[path.parent.name] = start + len(item["replays"])
            if item.get("replayFiles"):
                item["replays"] = [entry for entry in pool if entry["fileName"] in set(item["replayFiles"])] or item["replays"]
            item["replayFiles"] = [entry["fileName"] for entry in item["replays"]]
            item["replayCount"] = len(item["replays"])
            items.append(item)
        except Exception:
            continue
    return items


def list_models(ruleset_id=""):
    if ruleset_id:
        battle_type = "double" if "double" in str(ruleset_id).lower() else "single"
        return enrich_model_registry(load_model_registry(ruleset_id), battle_type)
    root = DATA_ROOT / "models"
    items = []
    if root.exists():
        for path in root.glob("*/registry.json"):
            try:
                registry = json.loads(path.read_text(encoding="utf-8"))
                battle_type = "double" if "double" in str(registry.get("rulesetId") or path.parent.name).lower() else "single"
                items.append(enrich_model_registry(registry, battle_type))
            except Exception:
                continue
    return {"items": items}


def ratings(ruleset_id="", showdown_format_id=""):
    items = list_rating_snapshots()
    if ruleset_id:
        items = [item for item in items if item.get("rulesetId") == ruleset_id]
    if showdown_format_id:
        items = [item for item in items if item.get("showdownFormatId") == showdown_format_id]
    return {"items": items}


def promote(payload):
    ruleset_id = payload.get("rulesetId", "")
    version = payload.get("version", "")
    metrics = payload.get("metrics", {})
    registry = load_model_registry(ruleset_id)
    challenger = next((item for item in registry["challengers"] if item.get("version") == version), None)
    if challenger is None:
        raise ValueError("Challenger model not found for this rulesetId.")
    score = (
        0.35 * float(metrics.get("strengthAdjustedWinRate", 0))
        + 0.25 * float(metrics.get("ratingScore", 0))
        + 0.15 * float(metrics.get("recentWinRate", 0))
        + 0.15 * float(metrics.get("fixedSetWinRate", 0))
        + 0.10 * float(metrics.get("generalization", 0))
    )
    challenger["metrics"] = metrics
    challenger["score"] = score
    if score < 0.55 or float(metrics.get("fixedSetWinRate", 0)) < 0.5:
        challenger["status"] = "rejected"
    else:
        challenger["status"] = "active"
        registry["champion"] = {"version": version, "status": "active", "promotedAt": now(), "score": score}
        for item in registry["challengers"]:
            if item is not challenger and item.get("status") == "active":
                item["status"] = "archived"
    registry["updatedAt"] = now()
    write_json(model_registry_path(ruleset_id), registry)
    return registry


def loop_worker():
    asyncio.set_event_loop(EVENT_LOOP)
    EVENT_LOOP.run_forever()


def respond(request_id, ok=True, result=None, error="", code=""):
    safe_error = sanitize_text(str(error or ""))
    print(json.dumps(sanitize_value({"id": request_id, "ok": ok, "result": result, "error": safe_error, "code": code}), ensure_ascii=False), flush=True)


def main():
    global ACTIVE_TASK
    threading.Thread(target=loop_worker, daemon=True).start()
    print(json.dumps({"event": "ready", "state": public_state()}), flush=True)
    for raw_line in sys.stdin:
        message = {}
        try:
            message = sanitize_value(json.loads(raw_line))
            request_id = message.get("id")
            command = message.get("command")
            payload = message.get("payload") or {}
            if command == "status":
                respond(request_id, result=public_state())
            elif command == "start":
                if ACTIVE_TASK and not ACTIVE_TASK.done():
                    raise RuntimeError("Agent is already running one battle session.")
                ACTIVE_TASK = asyncio.run_coroutine_threadsafe(run_ladder(payload), EVENT_LOOP)
                respond(request_id, result={**public_state(), "status": "STARTING"})
            elif command == "stop":
                if ACTIVE_TASK and not ACTIVE_TASK.done():
                    ACTIVE_TASK.cancel()
                if ACTIVE_PLAYER:
                    asyncio.run_coroutine_threadsafe(ACTIVE_PLAYER.ps_client.stop_listening(), EVENT_LOOP)
                update_state(
                    status="STOPPED",
                    connectionStatus="DISCONNECTED",
                    queueStatus="STOPPED",
                    lastError="Emergency stop requested.",
                )
                respond(request_id, result=public_state())
            elif command == "replays":
                respond(request_id, result={"items": list_replays(payload.get("rulesetId", ""))})
            elif command == "models":
                respond(request_id, result=list_models(payload.get("rulesetId", "")))
            elif command == "ratings":
                respond(request_id, result=ratings(payload.get("rulesetId", ""), payload.get("showdownFormatId", "")))
            elif command == "promote":
                respond(request_id, result=promote(payload))
            else:
                respond(request_id, ok=False, error="Unknown sidecar command.", code="UNKNOWN_COMMAND")
        except Exception as error:
            respond(message.get("id") if isinstance(message, dict) else None, ok=False, error=str(error), code="SIDECAR_ERROR")
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
