import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parents[1]
REFS = ROOT / "references"
DATA = WORKSPACE / "data"

TRANSCRIPT_PATH = REFS / "audio-transcripts" / "BV1ufDwBEEnM.partial.txt"
INDIVIDUAL_LOG = REFS / "individual-analysis-log.json"
CHAMPION_DATA = DATA / "champion-data.json"
BATTLE_KNOWLEDGE = DATA / "battle-knowledge.json"
TEAM_DATA = DATA / "team-data.json"

OUT_JSON = REFS / "individual-pokemon-cards.json"
OUT_MD = REFS / "individual-pokemon-cards.md"

SOURCE_BVID = "BV1ufDwBEEnM"
SOURCE_TITLE = "《宝可梦冠军》给大家推荐一些好用的宝可梦"
SOURCE_BUCKET = "champions_individual_analysis"

TAG_KEYWORDS = {
    "recommendation": ["推荐", "好用", "可以用", "值得", "热门", "强"],
    "not-recommended": ["不推荐", "不太推荐", "不好用", "没必要", "不如", "不清楚"],
    "role": ["定位", "打手", "辅助手", "核心", "输出", "收割", "耐久", "肉"],
    "moveset": ["技能", "招式", "保护", "守住", "顺风", "空气", "大地", "本系"],
    "item-ability": ["道具", "特性", "性格", "努力", "加点", "腰带", "眼镜", "命玉", "mega", "Mega"],
    "speed": ["速度", "顺风", "空间", "控速", "先手", "快过", "慢速"],
    "team-fit": ["队伍", "体系", "队友", "搭配", "联防", "配合", "核心"],
    "matchup-warning": ["怕", "打不过", "弱点", "缺点", "问题", "反制", "针对", "不好打"],
    "mega-slot": ["mega", "Mega", "超级", "进化", "马杆", "马拉"],
}

NOISE_KEYWORDS = [
    "关注",
    "投币",
    "三连",
    "直播",
    "广告",
    "加速器",
    "抽",
    "送",
    "箱子",
    "传过去",
    "演示",
    "账号",
    "登录",
    "监狱",
]

MANUAL_ALIASES = {
    "charizard": ["喷火龙", "噴火龙", "噴火龍", "盆火龙", "盆火龍", "喷龙", "噴龍", "盆火融", "喷火融"],
    "salamence": ["暴飞龙", "暴飛龍", "暴费龙", "暴費龍", "报废龙", "報費龍", "包飞龙", "包飛龍"],
    "dragonite": ["快龙", "快龍", "快隆", "快努"],
    "garchomp": ["烈咬陆鲨", "烈咬陸鯊", "地龙", "地龍"],
    "pelipper": ["大嘴鸥", "大嘴鷗", "海鸥", "海鷗"],
    "heracross": ["赫拉克罗斯", "赫拉克羅斯", "喝拉克罗斯", "和南克罗斯"],
    "pinsir": ["凯罗斯", "凱羅斯"],
    "mawile": ["大嘴娃"],
    "sableye": ["勾魂眼"],
    "whimsicott": ["风妖精", "風妖精", "棉花"],
    "kangaskhan": ["袋兽", "袋獸"],
    "metagross": ["巨金怪"],
    "scizor": ["巨钳螳螂", "巨鉗螳螂"],
    "swampert": ["巨沼怪"],
    "venusaur": ["妙蛙花"],
    "tyranitar": ["班基拉斯"],
    "gengar": ["耿鬼"],
    "manectric": ["雷电兽", "雷電獸", "电狗", "電狗", "电轴", "電軸"],
    "grimmsnarl": ["长毛巨魔", "長毛巨魔", "长毛巨牧", "長毛群", "长毛巨坡"],
    "amoonguss": ["败露球菇", "盾菇", "盾孤", "蘑菇"],
    "dondozo": ["吃吼霸", "吃吧", "吃的吧"],
}

MANUAL_CURATIONS = {
    "venusaur": [
        {
            "time_window": [1161, 1445],
            "tags": ["item-ability", "mega-slot", "moveset", "recommendation", "role", "speed", "team-fit"],
            "summary": "Mega 妙蛙花更像耐久受向轴，不是单纯输出手；厚脂肪改善火/冰弱点，适合靠种子、回复和慢节奏消耗建立优势。",
            "claims": [
                "输出不高，推荐按耐久受向流理解。",
                "Mega 后厚脂肪是核心价值，火/冰压力被显著缓和。",
                "速度不快，睡眠粉/速度相关选择要看环境与具体配招。",
                "如果普通妙蛙花更能配合体系，不应为了 Mega 而强行 Mega。",
            ],
        }
    ],
    "charizard": [
        {
            "time_window": [1614, 2080],
            "tags": ["item-ability", "mega-slot", "moveset", "recommendation", "speed", "team-fit", "matchup-warning"],
            "summary": "喷火龙是典型 Mega 位核心；Y 形态/晴天火力和天气价值明显，但要根据速度线和耐久选择极速输出或肉喷路线。",
            "claims": [
                "普通喷火龙常围绕火本输出与天气收益展开，Mega Y 的晴天与特攻提升是主要价值。",
                "可考虑顺风、空气斩/飞本、大地之力、日光束、过热等技能位，但要确认宝可梦冠军内技能可用性。",
                "肉喷不是装饰，目的是吃下岩崩等关键打击后继续转换输出。",
                "速度投资要围绕 100 线、200 线、顺风后速度和队友控速共同判断。",
            ],
        }
    ],
    "gengar": [
        {
            "time_window": [5721, 5840],
            "tags": ["item-ability", "mega-slot", "moveset", "not-recommended", "speed", "matchup-warning"],
            "summary": "耿鬼/ Mega 耿鬼更依赖精确速度线和配置分工；不要只看 Mega 后速度，技能、耐久和要过谁都要先定。",
            "claims": [
                "速度线应先决定要过谁，例如 100/120/130 相关线。",
                "不同耿鬼配置努力值会差很多，不能套一个固定模板。",
                "如果特性或技能收益不足，强行 Mega 可能浪费 Mega 位。",
            ],
        }
    ],
    "manectric": [
        {
            "time_window": [12000, 12295],
            "tags": ["item-ability", "mega-slot", "moveset", "recommendation", "role", "speed", "team-fit"],
            "summary": "雷电兽是偏高速辅助/骚扰型 Mega 候选，价值不只在火力，而在高速威吓、换位和干扰带来的队伍节奏。",
            "claims": [
                "Mega 后更像辅助手，能靠高速和威吓来回制造回合。",
                "格子紧张，保护、帮助、同命、开墙/极光幕等选择要按队伍需要取舍。",
                "它不是顶级纯输出，但推荐准备一只用于特定节奏和对局。",
            ],
        }
    ],
    "grimmsnarl": [
        {
            "time_window": [13230, 13480],
            "tags": ["item-ability", "moveset", "recommendation", "role", "speed", "team-fit"],
            "summary": "长毛巨魔是开墙与恶作剧之心支援的代表；它的价值在先手墙、反射壁/光墙、电磁波和灵魂冲击等干扰组合。",
            "claims": [
                "开墙体系基本绕不开长毛巨魔这一类恶作剧之心支援。",
                "活下来很重要，因为一回合只能开一个墙，没死才能继续补另一面墙或电磁波。",
                "可以有开墙型和不开墙干扰型两套思路，别只把它当固定双墙机器。",
            ],
        }
    ],
    "amoonguss": [
        {
            "time_window": [15124, 15260],
            "tags": ["item-ability", "moveset", "recommendation", "role", "speed", "team-fit"],
            "summary": "盾菇定义了空间低速线，45 速和再生力让它成为慢速支援/消耗核心；配招通常围绕愤怒粉、蘑菇孢子、花粉团和草本输出取舍。",
            "claims": [
                "45 速是空间相关的重要低速参考线。",
                "再生力和耐久分配决定它能否反复进出制造安全回合。",
                "如果草系目标多，草本输出位更值得保留；否则可按队伍需要换花粉团等支援技能。",
            ],
        }
    ],
    "dondozo": [
        {
            "time_window": [18323, 18590],
            "tags": ["item-ability", "moveset", "recommendation", "role", "team-fit", "matchup-warning"],
            "summary": "吃吼霸可以作为高压输出或耐久消耗路线；它不怕一部分常规干扰，适合准备两种配置以覆盖不同对局。",
            "claims": [
                "不要命输出型可以直接施压，逼迫对手处理。",
                "耐久型更适合拖回合、消耗和等待后排打手收割。",
                "可以准备两只不同吃吼霸，应按对局选择输出型或耐久型。",
                "开不开顺风不是第一问题，关键是它能不能吃住并转换压力。",
            ],
        }
    ],
}


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def parse_time(line: str) -> tuple[float, str]:
    match = re.match(r"^\[([0-9.]+)\]\s*(.*)$", line)
    if not match:
        return 0.0, line.strip()
    return float(match.group(1)), match.group(2).strip()


def mojibake_variant(text: str) -> str:
    """Return the common UTF-8-as-GBK mojibake form for fuzzy transcript matching."""
    return text.encode("utf-8").decode("gbk", errors="replace").replace("�", "")


def normalize_token(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", text).lower()


def is_mega_slug(slug: str, name: str) -> bool:
    return "mega" in slug.lower() or "Mega" in name or "-Mega" in name


def base_slug_for(slug: str) -> str:
    return re.sub(r"mega(?:x|y)?$", "", slug, flags=re.IGNORECASE)


def build_catalog() -> dict:
    champion = load_json(CHAMPION_DATA, {})
    battle = load_json(BATTLE_KNOWLEDGE, {})

    catalog = {}
    for fmt in ("single", "double"):
        for item in champion.get("formats", {}).get(fmt, {}).get("pokemon", []):
            slug = item.get("slug", "")
            if not slug:
                continue
            slot = catalog.setdefault(
                slug,
                {
                    "slug": slug,
                    "name": item.get("name", slug),
                    "english": "",
                    "types": item.get("types", []),
                    "stats": item.get("stats", {}),
                    "formats": {},
                    "mega_forms": [],
                    "aliases": set(),
                },
            )
            slot["formats"][fmt] = {
                "rank": item.get("rank"),
                "usage_rank": item.get("usage", {}).get("rank"),
                "usage_percent": item.get("usage", {}).get("usagePercent"),
                "team_count": item.get("usage", {}).get("teamCount"),
            }
            slot["aliases"].update({slug, item.get("name", "")})

    for slug, item in battle.get("pokemon", {}).items():
        showdown = item.get("showdown", {})
        name = showdown.get("name", "")
        base = base_slug_for(slug)
        if is_mega_slug(slug, name):
            if base in catalog:
                catalog[base]["mega_forms"].append({"slug": slug, "name": name})
                catalog[base]["aliases"].update({slug, name})
            continue
        slot = catalog.setdefault(
            slug,
            {
                "slug": slug,
                "name": name or slug,
                "english": name,
                "types": showdown.get("types", []),
                "stats": showdown.get("baseStats", {}),
                "formats": {},
                "mega_forms": [],
                "aliases": set(),
            },
        )
        if name:
            slot["english"] = name
            slot["aliases"].update({slug, name})

    for slot in catalog.values():
        extra_aliases = set()
        for alias in list(slot["aliases"]):
            if not alias:
                continue
            extra_aliases.add(normalize_token(alias))
            if re.search(r"[\u4e00-\u9fff]", alias):
                extra_aliases.add(mojibake_variant(alias))
        slot["aliases"].update(alias for alias in extra_aliases if alias)

    for slug, aliases in MANUAL_ALIASES.items():
        if slug not in catalog:
            continue
        for alias in aliases:
            catalog[slug]["aliases"].add(alias)
            catalog[slug]["aliases"].add(normalize_token(alias))
            catalog[slug]["aliases"].add(mojibake_variant(alias))

    return catalog


def build_team_usage() -> dict:
    teams = load_json(TEAM_DATA, {}).get("teams", [])
    usage = defaultdict(lambda: {"teams": 0, "items": Counter(), "abilities": Counter(), "moves": Counter(), "partners": Counter()})
    for team in teams:
        members = [member.get("slug") for member in team.get("members", []) if member.get("slug")]
        for slug in members:
            usage[slug]["teams"] += 1
            for partner in members:
                if partner != slug:
                    usage[slug]["partners"][partner] += 1
        for config in team.get("configurations", []):
            slug = config.get("slug")
            if not slug:
                continue
            if config.get("item"):
                usage[slug]["items"][config["item"]] += 1
            if config.get("ability"):
                usage[slug]["abilities"][config["ability"]] += 1
            for move in config.get("moves", []):
                if move:
                    usage[slug]["moves"][move] += 1
    return usage


def top_counter(counter: Counter, limit: int = 8) -> list[dict]:
    return [{"name": key, "count": count} for key, count in counter.most_common(limit)]


def transcript_records() -> list[dict]:
    if not TRANSCRIPT_PATH.exists():
        return []
    records = []
    for index, line in enumerate(TRANSCRIPT_PATH.read_text(encoding="utf-8").splitlines()):
        time, text = parse_time(line)
        if text:
            records.append({"index": index, "time": time, "text": text})
    return records


def classify_text(text: str) -> set[str]:
    tags = set()
    lower = text.lower()
    for tag, keywords in TAG_KEYWORDS.items():
        if any(keyword.lower() in lower for keyword in keywords):
            tags.add(tag)
    return tags


def noise_score(text: str, time: float) -> int:
    score = 0
    if time < 560:
        score += 2
    score += sum(1 for keyword in NOISE_KEYWORDS if keyword in text)
    if text.count("克") > 20 or text.count("机会") > 20:
        score += 2
    return score


def find_mentions(records: list[dict], catalog: dict) -> dict[str, list[dict]]:
    alias_index = []
    for slug, item in catalog.items():
        aliases = sorted({a for a in item["aliases"] if len(str(a)) >= 2}, key=len, reverse=True)
        for alias in aliases:
            alias_index.append((alias.lower(), slug))

    by_slug = defaultdict(list)
    for record in records:
        text = record["text"]
        searchable = f"{text} {normalize_token(text)}".lower()
        matched = []
        for alias, slug in alias_index:
            if alias and alias in searchable:
                matched.append(slug)
                if len(matched) >= 5:
                    break
        for slug in set(matched):
            start = max(0, record["index"] - 2)
            end = min(len(records), record["index"] + 3)
            snippet = "\n".join(f"[{records[i]['time']:.2f}] {records[i]['text']}" for i in range(start, end))
            tags = classify_text(snippet)
            by_slug[slug].append(
                {
                    "time": round(record["time"], 2),
                    "transcript_index": record["index"],
                    "tags": sorted(tags),
                    "noise_score": noise_score(snippet, record["time"]),
                    "snippet": snippet,
                    "source": {
                        "bvid": SOURCE_BVID,
                        "title": SOURCE_TITLE,
                        "path": str(TRANSCRIPT_PATH.relative_to(REFS)),
                    },
                }
            )
    return by_slug


def is_curated_time(time: float) -> bool:
    for entries in MANUAL_CURATIONS.values():
        for entry in entries:
            start, end = entry["time_window"]
            if start <= time <= end:
                return True
    return False


def build_unassigned_clusters(records: list[dict], mentions: dict[str, list[dict]]) -> list[dict]:
    mentioned_indices = {entry["transcript_index"] for entries in mentions.values() for entry in entries}
    clusters = defaultdict(lambda: {"tags": Counter(), "samples": [], "line_count": 0})
    for record in records:
        if record["time"] < 560 or record["index"] in mentioned_indices or is_curated_time(record["time"]):
            continue
        tags = classify_text(record["text"])
        if not tags:
            continue
        if noise_score(record["text"], record["time"]) >= 3:
            continue
        bucket = int(record["time"] // 300) * 300
        slot = clusters[bucket]
        slot["line_count"] += 1
        slot["tags"].update(tags)
        if len(slot["samples"]) < 5:
            slot["samples"].append(
                {
                    "time": round(record["time"], 2),
                    "tags": sorted(tags),
                    "text": record["text"],
                    "source": {
                        "bvid": SOURCE_BVID,
                        "title": SOURCE_TITLE,
                        "path": str(TRANSCRIPT_PATH.relative_to(REFS)),
                    },
                }
            )
    result = []
    for start, data in sorted(clusters.items()):
        if data["line_count"] < 2:
            continue
        result.append(
            {
                "time_window": [start, start + 300],
                "line_count": data["line_count"],
                "tags": dict(data["tags"]),
                "samples": data["samples"],
                "needs_manual_pokemon_assignment": True,
            }
        )
    result.sort(key=lambda item: (-item["line_count"], item["time_window"][0]))
    return result[:80]


def seed_from_champion_data(catalog: dict, limit_each_format: int = 80) -> set[str]:
    seeded = set()
    for slug, item in catalog.items():
        formats = item.get("formats", {})
        for fmt in ("single", "double"):
            rank = formats.get(fmt, {}).get("rank")
            if isinstance(rank, int) and rank <= limit_each_format:
                seeded.add(slug)
    return seeded


def curated_samples(slug: str, records: list[dict]) -> list[dict]:
    samples = []
    for entry in MANUAL_CURATIONS.get(slug, []):
        start, end = entry["time_window"]
        window_records = [record for record in records if start <= record["time"] <= end]
        text_lines = [f"[{record['time']:.2f}] {record['text']}" for record in window_records[:8]]
        samples.append(
            {
                "time_window": entry["time_window"],
                "tags": entry["tags"],
                "summary": entry["summary"],
                "claims": entry["claims"],
                "snippet": "\n".join(text_lines),
                "source": {
                    "bvid": SOURCE_BVID,
                    "title": SOURCE_TITLE,
                    "path": str(TRANSCRIPT_PATH.relative_to(REFS)),
                },
            }
        )
    return samples


def confidence_for(evidence: list[dict], formats: dict, has_mega: bool) -> str:
    useful = [item for item in evidence if item["noise_score"] < 3 and item["time"] >= 560]
    if len(useful) >= 3:
        return "high"
    if useful or has_mega:
        return "medium"
    if any((formats.get(fmt, {}).get("rank") or 999) <= 30 for fmt in ("single", "double")):
        return "medium"
    return "low"


def build_cards() -> dict:
    catalog = build_catalog()
    usage = build_team_usage()
    records = transcript_records()
    mentions = find_mentions(records, catalog)
    unassigned_clusters = build_unassigned_clusters(records, mentions)
    seeded = seed_from_champion_data(catalog)
    selected = sorted(seeded | set(mentions.keys()) | set(MANUAL_CURATIONS.keys()))

    cards = []
    review_counts = Counter()
    for slug in selected:
        item = catalog[slug]
        ev = sorted(mentions.get(slug, []), key=lambda x: x["time"])
        curated = curated_samples(slug, records)
        evidence_tags = Counter(tag for entry in ev for tag in entry["tags"])
        evidence_tags.update(tag for entry in curated for tag in entry["tags"])
        team_usage = usage.get(slug, {})
        confidence = "high" if curated else confidence_for(ev, item.get("formats", {}), bool(item.get("mega_forms")))
        needs_review = (confidence != "high" or any(entry["noise_score"] >= 3 for entry in ev[:5])) and not curated
        if needs_review:
            review_counts["needs_manual_review"] += 1
        if confidence == "high":
            review_counts["high_confidence"] += 1

        notes = []
        if item.get("mega_forms"):
            notes.append("存在 Mega 形态；配队时可作为 Mega 位候选，但仍需检查队伍联动。")
        if evidence_tags.get("not-recommended"):
            notes.append("AG 片段里出现不推荐/谨慎表述，必须结合上下文复核。")
        if evidence_tags.get("speed"):
            notes.append("片段涉及速度线或控速，应纳入单双打速度计划。")
        if evidence_tags.get("team-fit"):
            notes.append("片段涉及队友/体系适配，优先作为联动证据使用。")

        cards.append(
            {
                "slug": slug,
                "name": item.get("name", slug),
                "english": item.get("english", ""),
                "types": item.get("types", []),
                "stats": item.get("stats", {}),
                "formats": item.get("formats", {}),
                "mega_forms": item.get("mega_forms", []),
                "team_data": {
                    "team_count": team_usage.get("teams", 0),
                    "common_items": top_counter(team_usage.get("items", Counter())),
                    "common_abilities": top_counter(team_usage.get("abilities", Counter())),
                    "common_moves": top_counter(team_usage.get("moves", Counter()), 12),
                    "common_partners": top_counter(team_usage.get("partners", Counter())),
                },
                "ag_evidence": {
                    "count": len(ev),
                    "tags": dict(evidence_tags),
                    "samples": ev[:6],
                },
                "curated_ag_summary": curated[0]["summary"] if curated else "",
                "curated_ag_claims": [claim for entry in curated for claim in entry["claims"]],
                "curated_evidence": curated,
                "confidence": confidence,
                "needs_manual_review": needs_review,
                "notes": notes,
            }
        )

    cards.sort(
        key=lambda card: (
            {"high": 0, "medium": 1, "low": 2}.get(card["confidence"], 3),
            -(card["ag_evidence"]["count"]),
            min((card.get("formats", {}).get("double", {}).get("rank") or 999), (card.get("formats", {}).get("single", {}).get("rank") or 999)),
        )
    )

    return {
        "version": "0.1",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "source": {
            "bvid": SOURCE_BVID,
            "title": SOURCE_TITLE,
            "bucket": SOURCE_BUCKET,
            "transcript": str(TRANSCRIPT_PATH.relative_to(REFS)),
        },
        "method": {
            "summary": "Automatic v0 card build from AG individual-analysis transcript plus local Pokemon Champions usage/team data.",
            "caveats": [
                "Whisper tiny transcript is noisy; cards with low/medium confidence need manual curation before being treated as AG's final view.",
                "Champion rank/usage and team configurations are environment data, not direct AG claims.",
                "Mega forms are merged into base Pokemon cards so team-building logic can judge Mega-slot pressure.",
            ],
        },
        "summary": {
            "cards": len(cards),
            "high_confidence": review_counts["high_confidence"],
            "needs_manual_review": review_counts["needs_manual_review"],
            "with_ag_evidence": sum(1 for card in cards if card["ag_evidence"]["count"]),
            "with_curated_ag_summary": sum(1 for card in cards if card.get("curated_ag_summary")),
            "with_mega_forms": sum(1 for card in cards if card["mega_forms"]),
            "unassigned_evidence_clusters": len(unassigned_clusters),
        },
        "unassigned_evidence_clusters": unassigned_clusters,
        "cards": cards,
    }


def render_md(data: dict) -> str:
    lines = [
        "# Individual Pokemon Cards",
        "",
        f"Generated: {data['generated_at']}",
        "",
        "This is an automatic v0 structure for product use and manual curation. Medium/low confidence cards should not be treated as final AG conclusions.",
        "",
        "## Summary",
        "",
        f"- Cards: {data['summary']['cards']}",
        f"- High confidence: {data['summary']['high_confidence']}",
        f"- Needs manual review: {data['summary']['needs_manual_review']}",
        f"- With AG evidence: {data['summary']['with_ag_evidence']}",
        f"- With curated AG summary: {data['summary'].get('with_curated_ag_summary', 0)}",
        f"- With Mega forms: {data['summary']['with_mega_forms']}",
        f"- Unassigned evidence clusters: {data['summary']['unassigned_evidence_clusters']}",
        "",
        "## Top Cards",
        "",
    ]
    for card in data["cards"][:40]:
        fmt = card.get("formats", {})
        single_rank = fmt.get("single", {}).get("rank", "-")
        double_rank = fmt.get("double", {}).get("rank", "-")
        tags = ", ".join(f"{k}:{v}" for k, v in card["ag_evidence"]["tags"].items()) or "none"
        mega = ", ".join(form["name"] for form in card.get("mega_forms", [])) or "-"
        lines.extend(
            [
                f"### {card['name']} / {card['slug']}",
                "",
                f"- Confidence: {card['confidence']}",
                f"- Rank: single {single_rank}, double {double_rank}",
                f"- Mega forms: {mega}",
                f"- AG evidence: {card['ag_evidence']['count']} snippets ({tags})",
                f"- Curated summary: {card.get('curated_ag_summary') or '-'}",
                f"- Common items: {', '.join(x['name'] for x in card['team_data']['common_items'][:4]) or '-'}",
                f"- Common moves: {', '.join(x['name'] for x in card['team_data']['common_moves'][:6]) or '-'}",
                "",
            ]
        )
    return "\n".join(lines)


def main() -> None:
    data = build_cards()
    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT_MD.write_text(render_md(data), encoding="utf-8")
    print(f"Wrote {OUT_JSON}")
    print(f"Wrote {OUT_MD}")
    print(json.dumps(data["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
