import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
INDEX = REFS / "video-index.json"
MANUAL = REFS / "manual-sources.json"
OUT = REFS / "evidence-targets.json"


BUCKETS = {
    "champions_individual_analysis": ["好用的宝可梦", "推荐", "个体", "用法"],
    "champions_team_core": ["宝可梦冠军", "队", "版本答案", "空间", "顺风", "晴天"],
    "mega_slot": ["mega", "Mega"],
    "usage_analysis": ["用法分析"],
    "vgc_commentary": ["VGC2026", "决赛", "day1", "day2"],
}

BUCKET_PRIORITY = {
    "champions_individual_analysis": 140,
    "champions_team_core": 120,
    "mega_slot": 110,
    "usage_analysis": 45,
    "vgc_commentary": 10,
}


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def manual_videos() -> list[dict]:
    data = load_json(MANUAL, {"sources": []})
    result = []
    for source in data.get("sources", []):
        if source.get("kind") != "bilibili-video":
            continue
        result.append(
            {
                "source_id": source.get("id", "manual-source"),
                "season_id": "",
                "season_title": "manual-sources",
                "page_number": "",
                "aid": "",
                "bvid": source.get("bvid", ""),
                "url": source.get("url", ""),
                "title": source.get("title", ""),
                "pubdate": source.get("pubdate", ""),
                "duration_seconds": source.get("duration_seconds", 0),
                "view": source.get("view", 0),
                "danmaku": 0,
                "tags": [source.get("bucket", ""), "manual", "critical"],
                "matched_keywords": [],
            }
        )
    return result


def score_video(video: dict, bucket: str, keywords: list[str]) -> int:
    title = video.get("title", "")
    score = BUCKET_PRIORITY.get(bucket, 0)
    score += sum(10 for keyword in keywords if keyword.lower() in title.lower())
    score += min(int(video.get("view", 0)) // 50000, 15)
    if "manual" in video.get("tags", []):
        score += 100
    if "宝可梦冠军" in title:
        score += 30
    if "VGC2026" in title:
        score -= 20
    return score


def main() -> None:
    data = load_json(INDEX, {"videos": []})
    videos = data.get("videos", []) + manual_videos()
    targets = {}
    for bucket, keywords in BUCKETS.items():
        matches = [
            video
            for video in videos
            if any(keyword.lower() in video.get("title", "").lower() for keyword in keywords)
            or bucket in video.get("tags", [])
        ]
        targets[bucket] = sorted(matches, key=lambda video: score_video(video, bucket, keywords), reverse=True)[:12]

    OUT.write_text(json.dumps(targets, ensure_ascii=False, indent=2), encoding="utf-8")
    for bucket, items in targets.items():
        print(f"{bucket}: {len(items)}")
        for item in items[:5]:
            print(f"- {item['title']} {item['url']}")


if __name__ == "__main__":
    main()
