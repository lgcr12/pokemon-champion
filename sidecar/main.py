import asyncio
import json
import os
import sys
import threading
import traceback
import inspect
import time
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


def run_threaded_coroutine(coro, loop=None):
    """Bridge poke-env versions without assuming PSClient exposes a loop."""
    if len(inspect.signature(handle_threaded_coroutines).parameters) >= 2:
        return handle_threaded_coroutines(coro, loop or POKE_LOOP)
    return handle_threaded_coroutines(coro)


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
DATA_ROOT = ROOT / "data" / "agent"
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
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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


def register_training_checkpoint(summary):
    ruleset_id = summary["rulesetId"]
    registry = load_model_registry(ruleset_id)
    replay_dir = DATA_ROOT / "replays" / ruleset_id
    total_games = 0
    if replay_dir.exists():
        for path in replay_dir.glob("*.json"):
            try:
                total_games += int(json.loads(path.read_text(encoding="utf-8")).get("games", 0))
            except Exception:
                continue
    if total_games and total_games % 50 == 0:
        version = f"challenger-{total_games}"
        if not any(item.get("version") == version for item in registry["challengers"]):
            registry["challengers"].append({
                "version": version,
                "status": "pending_evaluation",
                "createdAt": now(),
                "trainingGames": total_games,
                "sourcePolicy": STATE["policyVersion"],
            })
    registry["updatedAt"] = now()
    write_json(model_registry_path(ruleset_id), registry)


async def run_ladder(payload):
    global ACTIVE_PLAYER
    replay_dir = DATA_ROOT / "showdown-replays" / payload["rulesetId"]
    trace_dir = DATA_ROOT / "traces" / payload["rulesetId"]
    replay_dir.mkdir(parents=True, exist_ok=True)
    trace_dir.mkdir(parents=True, exist_ok=True)
    requested_policy = str(payload.get("policy") or os.environ.get("AGENT_POLICY", "structured")).strip().lower()
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
        wins=0,
        losses=0,
        ties=0,
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
    player_class = LAPLACE_ENGINE if use_laplace else StructuredPlayer
    player_kwargs = {
        "account_configuration": AccountConfiguration(payload["username"], payload["password"]),
        "server_configuration": ShowdownServerConfiguration,
        "battle_format": payload["showdownFormatId"],
        "team": payload["team"],
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
            traces[key] = {
                "schemaVersion": 1,
                "rulesetId": payload["rulesetId"],
                "showdownFormatId": payload["showdownFormatId"],
                "battleType": payload["battleType"],
                "teamVersion": payload.get("teamVersion", "manual"),
                "teamSource": payload.get("teamSource", "workbench"),
                "teamId": payload.get("teamId", ""),
                "teamTitle": payload.get("teamTitle", ""),
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
            update_state(status="SEARCHING", queueStatus="SEARCH_SENT", searchStartedAt=now())

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
            trace["replayFile"] = replay_files[min(observed["games"] - 1, len(replay_files) - 1)] if replay_files else ""
            trace_name = trace.get("traceFile") or f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{observed['games']}-{key.replace('/', '_')}.json"
            trace["traceFile"] = trace_name
            write_json(trace_dir / trace_name, trace)
            finished_trace_files.append(trace_name)
            update_state(
                gamesFinished=observed["games"],
                wins=observed["wins"],
                losses=observed["losses"],
                ties=observed["ties"],
                activeBattleId="",
                lastBattleEventAt=now(),
                lastServerEvent="BATTLE_FINISHED",
            )

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
    except asyncio.CancelledError:
        update_state(status="STOPPED", queueStatus="STOPPED", lastError="Emergency stop requested.")
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
        return load_model_registry(ruleset_id)
    root = DATA_ROOT / "models"
    items = []
    if root.exists():
        for path in root.glob("*/registry.json"):
            try:
                items.append(json.loads(path.read_text(encoding="utf-8")))
            except Exception:
                continue
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
    print(json.dumps({"id": request_id, "ok": ok, "result": result, "error": error, "code": code}), flush=True)


def main():
    global ACTIVE_TASK
    threading.Thread(target=loop_worker, daemon=True).start()
    print(json.dumps({"event": "ready", "state": public_state()}), flush=True)
    for raw_line in sys.stdin:
        message = {}
        try:
            message = json.loads(raw_line)
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
            elif command == "promote":
                respond(request_id, result=promote(payload))
            else:
                respond(request_id, ok=False, error="Unknown sidecar command.", code="UNKNOWN_COMMAND")
        except Exception as error:
            respond(message.get("id") if isinstance(message, dict) else None, ok=False, error=str(error), code="SIDECAR_ERROR")
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
