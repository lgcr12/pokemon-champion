import json
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"

CARDS_JSON = REFS / "individual-pokemon-cards.json"
DISTILLATION_MD = REFS / "distillation.md"
OUT_JSON = REFS / "coach-rules.json"
OUT_MD = REFS / "coach-rules.md"


GLOBAL_RULES = [
    {
        "id": "pc-default-format",
        "title": "默认以宝可梦冠军为主环境",
        "when": "用户没有明确指定其他规则时",
        "do": "按宝可梦冠军环境、Mega 机制、登场率、常见配置和当前候选池构筑",
        "why": "VGC 解说只作为可迁移对战理论，不能直接覆盖宝可梦冠军规则",
        "priority": "hard",
        "tags": ["pokemon-champions", "format-boundary"],
    },
    {
        "id": "team-axis-before-power",
        "title": "先定队伍轴，再评价单体强度",
        "when": "选择核心、补位或评价候选宝可梦时",
        "do": "先说明主胜利路线、副轴、开局、中盘和终盘，再解释每只宝可梦服务哪条链",
        "why": "强单体如果不连接队友、速度和安全上场，就会变成六个散件",
        "priority": "hard",
        "tags": ["team-axis", "synergy", "phase-plan"],
    },
    {
        "id": "mega-slot-resource",
        "title": "Mega 位是胜利路线资源",
        "when": "规则允许 Mega 且候选池存在可用 Mega 时",
        "do": "通常至少规划一个 Mega 候选；两个 Mega 只作为不同对局分支或真实备选路线",
        "why": "Mega 要占用核心资源，必须有安全进场、速度支持、弱点覆盖和终盘价值",
        "priority": "hard",
        "tags": ["mega-slot", "resource"],
    },
    {
        "id": "do-not-force-mega",
        "title": "不能为了凑 Mega 打断联动",
        "when": "Mega 候选会破坏主轴、抢道具资源、造成天气/速度/弱点冲突时",
        "do": "允许不选 Mega，或把 Mega 写成 matchup branch，并明确不硬凑原因",
        "why": "配队合理性高于形式指标",
        "priority": "hard",
        "tags": ["mega-slot", "synergy", "exception"],
    },
    {
        "id": "support-enables-damage",
        "title": "辅助价值取决于它创造的回合",
        "when": "选择击掌、威吓、双墙、掩护、状态、顺风、空间或干扰位时",
        "do": "写清它让谁安全上场、谁获得输出窗口、谁完成收割",
        "why": "辅助过多但没有伤害转换，会让队伍站场空转",
        "priority": "hard",
        "tags": ["support", "safe-entry", "damage-conversion"],
    },
    {
        "id": "prankster-small-boost",
        "title": "恶作剧之心只给轻微加权",
        "when": "候选拥有恶作剧之心且正在补辅助位",
        "do": "只有当它补 speed-control、anti-setup、status-pressure、screens、core-support 或 protection 缺口时才提高权重",
        "why": "恶作剧之心是手段，不是独立选人理由",
        "priority": "medium",
        "tags": ["support-priority", "prankster", "disruption"],
    },
    {
        "id": "speed-is-board-plan",
        "title": "速度控制是整队计划",
        "when": "队伍速度层级不完整、核心偏慢或被高速压制时",
        "do": "说明原速线、控速手、保护控速回合的人、控速后的收益者和先制/围巾/耐久中转备选",
        "why": "顺风或空间如果不能转成输出和站位优势，就只是浪费回合",
        "priority": "hard",
        "tags": ["speed-control", "tempo"],
    },
    {
        "id": "protect-and-switching-are-tempo",
        "title": "守住和轮换是节奏工具",
        "when": "双打配置、面对集火、或核心需要安全上场时",
        "do": "把守住、换入、击掌、掩护、转场和耐久中转写成具体回合序列",
        "why": "宝可梦冠军双打需要把站位转换成伤害或信息优势",
        "priority": "hard",
        "tags": ["protect", "switching", "safe-entry"],
    },
    {
        "id": "singles-doubles-split",
        "title": "单双打分开决策",
        "when": "同时输出 single 和 double 配队建议时",
        "do": "单打看撒场/清场/换血/强化/终盘；双打看首发组合/守住/控速/集火/范围压力/反首发",
        "why": "同一宝可梦在两个格式里的资源价值和行动链不同",
        "priority": "hard",
        "tags": ["singles", "doubles", "format-split"],
    },
    {
        "id": "usage-is-evidence-not-proof",
        "title": "使用率是证据，不是答案",
        "when": "热门队伍、登场率或 rank 与队伍缺口冲突时",
        "do": "先用使用率判断关注对象，再按队伍联动、机会成本、环境威胁和配置完整度决定是否选用",
        "why": "高登场率不等于适合当前队伍",
        "priority": "medium",
        "tags": ["usage", "opportunity-cost"],
    },
]


FORMAT_RULES = {
    "single": [
        "先明确主轴和副轴，避免只有六个热门单体。",
        "必须检查进场答案、撒场/清场或替代节奏、状态/回复/轮换资源、终盘收割点。",
        "速度计划要包含高速压制、控速、先制、围巾或耐久中转中的至少两类。",
        "Mega 核心要说明谁帮它上场、谁覆盖岩石/电/冰/妖等关键弱点，谁负责主轴被挡后的副轴。",
    ],
    "double": [
        "必须给出至少两组首发组合，并说明谁控速、谁输出、谁保护队友、遇到反首发如何切换。",
        "守住、击掌、威吓、掩护、广域防守、顺风/空间要服务明确输出窗口。",
        "携带地震、热风、浊流等范围压力时，要检查队友免疫、守住或站位路线。",
        "双 Mega 只能是分支选择，不能写成同局同时 Mega 的双核心。",
    ],
}


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def distillation_rule_count() -> int:
    if not DISTILLATION_MD.exists():
        return 0
    text = DISTILLATION_MD.read_text(encoding="utf-8")
    return text.count("### ")


def short_list(values, key="name", limit=5):
    result = []
    for value in values[:limit]:
        if isinstance(value, dict):
            result.append(str(value.get(key) or value.get("id") or value))
        else:
            result.append(str(value))
    return result


def mega_names(mega_forms) -> list[str]:
    names = []
    for form in mega_forms or []:
        if isinstance(form, dict):
            names.append(str(form.get("name") or form.get("id") or form))
        else:
            names.append(str(form))
    return names


def card_rule(card: dict) -> dict:
    evidence = card.get("ag_evidence", {})
    team_data = card.get("team_data", {})
    formats = card.get("formats", {})
    tags = sorted((evidence.get("tags") or {}).keys())
    mega_forms = mega_names(card.get("mega_forms") or [])
    common_items = short_list(team_data.get("common_items", []), "name")
    common_moves = short_list(team_data.get("common_moves", []), "name", 8)
    common_partners = short_list(team_data.get("common_partners", []), "name", 6)
    rank_single = formats.get("single", {}).get("rank")
    rank_double = formats.get("double", {}).get("rank")

    compact = {
        "slug": card.get("slug"),
        "name": card.get("name"),
        "english": card.get("english"),
        "confidence": card.get("confidence"),
        "needs_manual_review": bool(card.get("needs_manual_review")),
        "summary": card.get("curated_ag_summary") or "",
        "claims": card.get("curated_ag_claims", [])[:6],
        "ag_evidence_count": evidence.get("count", 0),
        "ag_tags": tags,
        "mega_forms": mega_forms,
        "champions_context": {
            "single_rank": rank_single,
            "double_rank": rank_double,
            "common_items": common_items,
            "common_moves": common_moves,
            "common_partners": common_partners,
        },
        "coach_notes": list(card.get("notes", []))[:4],
    }

    if mega_forms:
        compact["coach_notes"].append("有 Mega 形态时先判断是否承担主胜利路线，不能只因有 Mega 就入队。")
    if "speed" in tags or "speed-control" in tags:
        compact["coach_notes"].append("涉及速度线，应在配队输出中说明要过谁或由谁控速。")
    if "team-fit" in tags:
        compact["coach_notes"].append("涉及队友适配，应优先作为联动链证据使用。")
    if "not-recommended" in tags:
        compact["coach_notes"].append("存在谨慎或不推荐语境，必须结合队伍缺口复核。")
    return compact


def build_rules() -> dict:
    cards_data = load_json(CARDS_JSON, {"summary": {}, "cards": []})
    cards = cards_data.get("cards", [])
    curated_cards = [card for card in cards if card.get("curated_ag_summary")]
    high_cards = [card for card in cards if card.get("confidence") == "high"]
    usable_cards = []
    seen = set()
    for card in curated_cards + high_cards:
        slug = card.get("slug")
        if slug in seen:
            continue
        seen.add(slug)
        usable_cards.append(card_rule(card))

    prompt_lines = [
        "默认按宝可梦冠军环境判断，VGC 只作通用理论参考。",
        "先定主轴、副轴、开局、中盘、终盘，再选成员；不要只堆热门或高 rank 单体。",
        "允许 Mega 时通常至少规划一个 Mega 候选，但必须解释安全进场、速度支持、弱点覆盖和终盘用途。",
        "可以出现两个 Mega 候选，但只能作为不同 matchup 分支；不能把两个都写成同局核心，也不能为凑 Mega 打断联动。",
        "选择辅助手时，恶作剧之心只在补控速、反展开、状态压力、双墙、保护核心等缺口时轻微加权。",
        "速度控制必须写成回合计划：谁开控速，谁保护该回合，控速后谁输出或收割。",
        "双打要把守住、换入、击掌、威吓、掩护和集火视作节奏资源；单打要补撒场/清场或替代节奏。",
        "使用率和热门队伍是环境证据，不是直接答案；最终选择要服从队友联动和机会成本。",
    ]

    return {
        "version": "0.1",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "source": {
            "distillation": "references/distillation.md",
            "individual_cards": "references/individual-pokemon-cards.json",
            "critical_individual_video": "BV1ufDwBEEnM",
            "distillation_rule_sections": distillation_rule_count(),
        },
        "status": {
            "productized": True,
            "confidence": "v0 usable coaching layer; still not a perfect imitation of Pocket AG",
            "cards_summary": cards_data.get("summary", {}),
            "pokemon_rules_included": len(usable_cards),
        },
        "global_rules": GLOBAL_RULES,
        "format_rules": FORMAT_RULES,
        "pokemon_rules": usable_cards,
        "prompt_injection": {
            "title": "Pocket AG 宝可梦冠军理解层",
            "lines": prompt_lines,
            "max_pokemon_rules_in_prompt": 12,
            "usage": "服务端会把这些规则作为配队提示的可执行约束；中低置信卡片只作参考，不能覆盖 Champions 合法性和当前数据。",
        },
        "product_checks": [
            "输出前检查 Mega 位是否真的服务主轴。",
            "输出前检查至少两组队友联动链。",
            "输出前检查单双打是否分开使用对应 formatModels。",
            "输出前检查恶作剧之心是否补了真实缺口。",
            "输出前检查速度计划是否有设置者、保护者和收益者。",
            "输出前检查热门度是否被队伍适配性复核。",
        ],
    }


def render_md(data: dict) -> str:
    lines = [
        "# Pocket AG Coach Rules",
        "",
        f"Generated: {data['generated_at']}",
        f"Version: {data['version']}",
        "",
        "## Product Status",
        "",
        f"- Productized: {data['status']['productized']}",
        f"- Confidence: {data['status']['confidence']}",
        f"- Pokemon rules included: {data['status']['pokemon_rules_included']}",
        "",
        "## Global Rules",
        "",
    ]
    for rule in data["global_rules"]:
        lines.extend(
            [
                f"### {rule['title']}",
                "",
                f"- When: {rule['when']}",
                f"- Do: {rule['do']}",
                f"- Why: {rule['why']}",
                f"- Priority: {rule['priority']}",
                "",
            ]
        )

    lines.extend(["## Pokemon Rules", ""])
    for card in data["pokemon_rules"]:
        summary = card.get("summary") or "No curated summary yet; use only as structured draft evidence."
        lines.extend(
            [
                f"### {card['name']} / {card['slug']}",
                "",
                f"- Confidence: {card['confidence']}",
                f"- AG evidence: {card['ag_evidence_count']}",
                f"- Mega forms: {', '.join(card['mega_forms']) or '-'}",
                f"- Summary: {summary}",
                "",
            ]
        )
    return "\n".join(lines)


def main() -> None:
    data = build_rules()
    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT_MD.write_text(render_md(data), encoding="utf-8")
    print(f"Wrote {OUT_JSON}")
    print(f"Wrote {OUT_MD}")
    print(json.dumps(data["status"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
