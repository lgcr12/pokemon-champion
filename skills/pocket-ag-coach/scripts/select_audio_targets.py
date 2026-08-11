import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
VIDEO_INDEX = REFS / "video-index.json"
TRANSCRIPT_INDEX = REFS / "transcript-index.json"
MANUAL = REFS / "manual-sources.json"
OUT = REFS / "audio-targets.json"

PRIORITY_BUCKETS = {
    "champions_individual_analysis": 150,
    "mega_slot": 120,
    "champions_team_core": 110,
    "usage_analysis": 45,
    "vgc_commentary": 15,
}

STATUS_SCORE = {
    "manual-audio-target": 80,
    "no-subtitle": 60,
    "error": 25,
}


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def by_bvid_from_video_index() -> dict[str, dict]:
    data = load_json(VIDEO_INDEX, {})
    result = {}
    for video in data.get("videos", []):
        bvid = video.get("bvid")
        if bvid:
            result[bvid] = video
    return result


def manual_video_records() -> list[dict]:
    data = load_json(MANUAL, {"sources": []})
    records = []
    for source in data.get("sources", []):
        if source.get("kind") != "bilibili-video":
            continue
        records.append(
            {
                "bvid": source.get("bvid"),
                "url": source.get("url"),
                "title": source.get("title", ""),
                "bucket": source.get("bucket", "manual"),
                "status": "manual-audio-target",
                "cid": None,
                "duration_seconds": source.get("duration_seconds", 0),
                "view": source.get("view", 0),
                "manual_priority": 120,
            }
        )
    return records


def score(record: dict, video: dict) -> int:
    title = record.get("title") or video.get("title") or ""
    value = PRIORITY_BUCKETS.get(record.get("bucket"), 0)
    value += STATUS_SCORE.get(record.get("status"), 0)
    value += int(record.get("manual_priority", 0) or 0)
    value += min(int(record.get("view") or video.get("view") or 0) // 50000, 15)
    if "mega" in title.lower():
        value += 40
    if "冠军" in title or "宝可梦冠军" in title:
        value += 45
    if "VGC2026" in title:
        value -= 20
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument(
        "--status",
        action="append",
        default=[],
        help="Transcript status to include. Defaults to no-subtitle, error, and manual-audio-target.",
    )
    args = parser.parse_args()

    statuses = set(args.status or ["no-subtitle", "error", "manual-audio-target"])
    videos = by_bvid_from_video_index()
    transcript_index = load_json(TRANSCRIPT_INDEX, []) + manual_video_records()

    targets = []
    seen = set()
    for record in transcript_index:
        bvid = record.get("bvid")
        if not bvid or bvid in seen or record.get("status") not in statuses:
            continue
        seen.add(bvid)
        video = videos.get(bvid, {})
        priority = score(record, video)
        item = {
            "bvid": bvid,
            "url": record.get("url") or video.get("url") or f"https://www.bilibili.com/video/{bvid}",
            "title": record.get("title") or video.get("title") or "",
            "bucket": record.get("bucket") or "",
            "status": record.get("status") or "",
            "cid": record.get("cid"),
            "duration_seconds": record.get("duration_seconds") or video.get("duration_seconds", 0),
            "view": record.get("view") or video.get("view", 0),
            "priority": priority,
            "reason": "public subtitle unavailable, failed, or manually marked critical; use audio transcription",
        }
        targets.append(item)

    targets.sort(key=lambda item: (item["priority"], item.get("view", 0)), reverse=True)
    payload = {
        "source": "transcript-index.json + manual-sources.json",
        "target_count": min(len(targets), args.limit),
        "targets": targets[: args.limit],
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {OUT}")
    for item in payload["targets"]:
        print(f"{item['priority']:>3} {item['bucket']:<30} {item['status']:<20} {item['bvid']} {item['title']}")


if __name__ == "__main__":
    main()
