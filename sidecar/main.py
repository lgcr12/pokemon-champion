import asyncio
import json
import os
import sys
import threading
import traceback
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
from poke_env.concurrency import handle_threaded_coroutines
from poke_env.player import Player
from poke_env.player.battle_order import BattleOrder, DefaultBattleOrder, DoubleBattleOrder


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
    "startedAt": None,
    "connectedAt": None,
    "searchStartedAt": None,
    "battleStartedAt": None,
    "updatedAt": None,
    "policyVersion": "structured-visible-state-v1",
}


def now():
    return datetime.now(timezone.utc).isoformat()


def update_state(**values):
    with STATE_LOCK:
        STATE.update(values)
        STATE["updatedAt"] = now()


def public_state():
    with STATE_LOCK:
        return dict(STATE)


def mark_battle_active():
    if public_state()["status"] != "BATTLE":
        update_state(status="BATTLE", queueStatus="IN_BATTLE", battleStartedAt=now())


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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
                state = public_state()
                update_state(
                    decisionCount=int(state.get("decisionCount", 0)) + 1,
                    lastDecisionTurn=turn,
                    lastDecisionAt=now(),
                    lastDecisionError="",
                )
                return
            await super()._handle_battle_request(
                battle,
                from_teampreview_request=from_teampreview_request,
                maybe_default_order=maybe_default_order,
            )
            state = public_state()
            update_state(
                decisionCount=int(state.get("decisionCount", 0)) + 1,
                lastDecisionTurn=turn,
                lastDecisionAt=now(),
                lastDecisionError="",
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
    replay_dir.mkdir(parents=True, exist_ok=True)
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
        startedAt=now(),
        connectedAt=None,
        searchStartedAt=None,
        battleStartedAt=None,
    )
    player = StructuredPlayer(
        account_configuration=AccountConfiguration(payload["username"], payload["password"]),
        server_configuration=ShowdownServerConfiguration,
        battle_format=payload["showdownFormatId"],
        team=payload["team"],
        max_concurrent_battles=1,
        save_replays=str(replay_dir),
        accept_open_team_sheet=bool(payload.get("openTeamSheets")),
        start_timer_on_battle_start=True,
    )
    ACTIVE_PLAYER = player
    handle_message = player.ps_client._handle_message

    async def tracked_handle_message(message):
        for line in str(message).splitlines():
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

    player.ps_client._handle_message = tracked_handle_message
    send_message = player.ps_client.send_message

    async def tracked_send_message(message, room="", message_2=None):
        if room and str(room).startswith("battle-"):
            if not str(message).strip():
                state = public_state()
                message = "/choose default"
                update_state(fallbackCount=int(state.get("fallbackCount", 0)) + 1)
            update_state(lastSentMessage=str(message)[:500])
        return await send_message(message, room, message_2)

    player.ps_client.send_message = tracked_send_message
    try:
        await asyncio.wait_for(
            handle_threaded_coroutines(player.ps_client.logged_in.wait()),
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
        await player.ladder(payload["games"])
        summary = {
            "rulesetId": payload["rulesetId"],
            "showdownFormatId": payload["showdownFormatId"],
            "teamVersion": payload.get("teamVersion", "manual"),
            "policyVersion": STATE["policyVersion"],
            "games": int(player.n_finished_battles),
            "wins": int(player.n_won_battles),
            "losses": int(player.n_lost_battles),
            "ties": int(player.n_tied_battles),
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
    items = []
    for path in sorted(paths, reverse=True)[:200]:
        try:
            items.append(json.loads(path.read_text(encoding="utf-8")))
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
