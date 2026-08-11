import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
OUT = REFS / "individual-analysis-log.json"

PATTERNS = {
    "individual-role": ["定位", "打手", "辅助", "核心", "输出", "收割", "盾", "耐久"],
    "recommendation": ["推荐", "好用", "强", "热门", "使用率", "可以用", "适合"],
    "move-template": ["技能", "招式", "带", "保护", "守住", "补盲", "本系", "最后一个"],
    "item-ability": ["道具", "特性", "性格", "努力值", "速度", "耐久"],
    "team-fit": ["队伍", "体系", "队友", "搭配", "联防", "不耽误", "位置"],
    "speed-control": ["速度", "顺风", "空间", "控速", "先手", "快过", "慢速"],
    "matchup-warning": ["怕", "打不过", "弱点", "缺点", "问题", "反制", "针对", "不好打"],
    "mega-slot": ["mega", "Mega", "超级", "进化"],
}


def parse_line(line: str) -> tuple[str, str]:
    match = re.match(r"^\[([^\]]+)\]\s*(.*)$", line)
    if not match:
        return "", line.strip()
    return match.group(1), match.group(2).strip()


def snippets(lines: list[str], index: int, radius: int = 3) -> str:
    start = max(0, index - radius)
    end = min(len(lines), index + radius + 1)
    return "\n".join(lines[start:end])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bvid", required=True)
    parser.add_argument("--path", required=True)
    parser.add_argument("--title", default="")
    parser.add_argument("--bucket", default="champions_individual_analysis")
    args = parser.parse_args()

    path = Path(args.path)
    if not path.is_absolute():
        path = REFS / path
    lines = path.read_text(encoding="utf-8").splitlines()

    evidence = []
    seen = set()
    for index, line in enumerate(lines):
        time, text = parse_line(line)
        if len(text) < 3:
            continue
        for tag, keywords in PATTERNS.items():
            if not any(keyword.lower() in text.lower() for keyword in keywords):
                continue
            key = (tag, index // 6)
            if key in seen:
                continue
            seen.add(key)
            evidence.append(
                {
                    "bvid": args.bvid,
                    "title": args.title,
                    "bucket": args.bucket,
                    "tag": tag,
                    "time": time,
                    "snippet": snippets(lines, index),
                    "source_path": str(path.relative_to(REFS)),
                }
            )

    existing = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else []
    existing = [item for item in existing if item.get("bvid") != args.bvid or item.get("source_path") != str(path.relative_to(REFS))]
    existing.extend(evidence)
    OUT.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")

    counts = {}
    for item in evidence:
        counts[item["tag"]] = counts.get(item["tag"], 0) + 1
    print(json.dumps(counts, ensure_ascii=False, indent=2))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
