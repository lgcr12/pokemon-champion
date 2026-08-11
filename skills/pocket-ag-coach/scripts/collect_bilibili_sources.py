import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


MID = "343348"
ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
OUT = REFS / "video-index.json"
SOURCES = REFS / "sources.json"

SEASONS = [
    {"id": 6356913, "title": "vgc2026-official-events", "tags": ["vgc2026", "commentary", "battle"]},
    {"id": 7859672, "title": "pokemon-champions-battles", "tags": ["pokemon-champions", "battle"]},
    {"id": 7932882, "title": "pokemon-champions-meta-analysis", "tags": ["pokemon-champions", "usage-analysis", "mega"]},
    {"id": 1021365, "title": "scarlet-violet-usage-analysis", "tags": ["usage-analysis", "scarlet-violet"]},
]

KEYWORDS = ["VGC2026", "mega", "Mega"]


def headers(referer: str = "https://space.bilibili.com/343348/lists") -> dict[str, str]:
    result = {
        "User-Agent": "Mozilla/5.0",
        "Referer": referer,
    }
    cookie = os.environ.get("BILIBILI_COOKIE", "").strip()
    if cookie:
        result["Cookie"] = cookie
    return result


def fetch_json(url: str, *, referer: str = "https://space.bilibili.com/343348/lists", retries: int = 2) -> dict:
    last_error = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers(referer))
            with urllib.request.urlopen(req, timeout=20) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            last_error = err
            if err.code in {412, 429}:
                time.sleep(5 * (attempt + 1))
                continue
            raise
        except Exception as err:
            last_error = err
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"request failed after retries: {last_error}")


def video_url(bvid: str) -> str:
    return f"https://www.bilibili.com/video/{bvid}" if bvid else ""


def collect_season(season: dict) -> list[dict]:
    page = 1
    videos = []
    while True:
        url = (
            "https://api.bilibili.com/x/polymer/web-space/seasons_archives_list"
            f"?mid={MID}&season_id={season['id']}&sort_reverse=false&page_num={page}&page_size=30"
        )
        data = fetch_json(url)
        if data.get("code") == -352:
            print(f"rate limited season={season['id']} page={page}; stopping this season")
            break
        if data.get("code") != 0:
            raise RuntimeError(f"Bilibili API error for season {season['id']} page {page}: {data}")
        archives = data.get("data", {}).get("archives") or []
        if not archives:
            break
        for item in archives:
            title = item.get("title", "")
            videos.append(
                {
                    "source_id": f"season-{season['id']}",
                    "season_id": season["id"],
                    "season_title": season["title"],
                    "page_number": page,
                    "aid": item.get("aid"),
                    "bvid": item.get("bvid"),
                    "url": video_url(item.get("bvid", "")),
                    "title": title,
                    "pubdate": datetime.fromtimestamp(item.get("pubdate", 0), tz=timezone.utc).date().isoformat()
                    if item.get("pubdate")
                    else "",
                    "duration_seconds": item.get("duration", 0),
                    "view": item.get("stat", {}).get("view", 0),
                    "danmaku": item.get("stat", {}).get("danmaku", 0),
                    "tags": season["tags"],
                    "matched_keywords": [keyword for keyword in KEYWORDS if keyword.lower() in title.lower()],
                }
            )
        if len(archives) < 30:
            break
        page += 1
        time.sleep(1.5)
    return videos


def main() -> None:
    REFS.mkdir(parents=True, exist_ok=True)
    videos = []
    for season in SEASONS:
        videos.extend(collect_season(season))
        time.sleep(2)

    if not videos and OUT.exists():
        print(f"No new videos collected; keeping cache {OUT}")
        return

    relevant = [video for video in videos if video["matched_keywords"] or video["season_id"] in {6356913, 7859672, 7932882}]
    payload = {
        "creator": "Pocket AG",
        "profile_id": MID,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "season_count": len(SEASONS),
        "video_count": len(videos),
        "relevant_count": len(relevant),
        "seasons": SEASONS,
        "videos": videos,
        "relevant_videos": relevant,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    sources = json.loads(SOURCES.read_text(encoding="utf-8-sig")) if SOURCES.exists() else {}
    sources["collected_at"] = payload["collected_at"]
    sources["video_index"] = str(OUT.name)
    sources["videos"] = relevant
    SOURCES.write_text(json.dumps(sources, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Collected {len(videos)} videos, {len(relevant)} relevant videos.")
    print(OUT)


if __name__ == "__main__":
    main()
