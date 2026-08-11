import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
TRANSCRIPTS = REFS / "transcripts"
INDEX = REFS / "transcript-index.json"
OUT = REFS / "evidence-log.json"

PATTERNS = {
    "lead-choice": ["首发", "开局", "第一把", "第一局", "先手"],
    "speed-control": ["顺风", "空间", "控速", "速度", "高速", "慢速"],
    "protect": ["守住", "保护", "防守", "广防", "广域防守"],
    "switching": ["换", "轮换", "换人", "退", "上场"],
    "focus-fire": ["集火", "双点", "秒掉", "压低", "收掉"],
    "team-axis": ["队伍", "核心", "体系", "配置", "打法", "思路"],
    "mega-slot": ["mega", "Mega", "超级"],
    "endgame": ["残局", "收割", "最后", "终盘", "赢点"],
    "support": ["辅助", "干扰", "威吓", "击掌", "挑衅", "再来一次"],
}


def parse_line(line: str) -> tuple[str, str]:
    match = re.match(r"^\[([^\]]+)\]\s*(.*)$", line)
    if not match:
        return "", line.strip()
    return match.group(1), match.group(2).strip()


def snippets(lines: list[str], index: int, radius: int = 2) -> str:
    start = max(0, index - radius)
    end = min(len(lines), index + radius + 1)
    return "\n".join(lines[start:end])


def main() -> None:
    meta = json.loads(INDEX.read_text(encoding="utf-8")) if INDEX.exists() else []
    by_bvid = {item.get("bvid"): item for item in meta}
    evidence = []
    for path in sorted(TRANSCRIPTS.glob("*.txt")):
        bvid = path.stem
        video = by_bvid.get(bvid, {})
        lines = path.read_text(encoding="utf-8").splitlines()
        seen = set()
        for i, line in enumerate(lines):
            _, text = parse_line(line)
            if len(text) < 3:
                continue
            for tag, keywords in PATTERNS.items():
                if not any(keyword.lower() in text.lower() for keyword in keywords):
                    continue
                key = (bvid, tag, i // 8)
                if key in seen:
                    continue
                seen.add(key)
                evidence.append(
                    {
                        "bvid": bvid,
                        "title": video.get("title", ""),
                        "url": video.get("url", ""),
                        "bucket": video.get("bucket", ""),
                        "tag": tag,
                        "time": parse_line(line)[0],
                        "snippet": snippets(lines, i),
                    }
                )
    OUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    counts = {}
    for item in evidence:
        counts[item["tag"]] = counts.get(item["tag"], 0) + 1
    print(json.dumps(counts, ensure_ascii=False, indent=2))
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
