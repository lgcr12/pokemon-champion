import argparse
import json
import os
import time
from pathlib import Path

from yt_dlp import YoutubeDL


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
TARGETS = REFS / "audio-targets.json"
VIDEO_INDEX = REFS / "video-index.json"
AUDIO_DIR = REFS / "audio"
OUT = REFS / "audio-index.json"


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def video_titles() -> dict[str, str]:
    data = load_json(VIDEO_INDEX, {})
    return {video.get("bvid"): video.get("title", "") for video in data.get("videos", []) if video.get("bvid")}


def cookiefile_from_env() -> Path | None:
    cookie = os.environ.get("BILIBILI_COOKIE", "").strip()
    if not cookie:
        return None
    tmp = AUDIO_DIR / ".bilibili-cookie.txt"
    lines = ["# Netscape HTTP Cookie File"]
    for part in cookie.split(";"):
        if "=" not in part:
            continue
        name, value = part.strip().split("=", 1)
        if not name:
            continue
        secure = "TRUE"
        include_subdomains = "TRUE"
        expiry = "2147483647"
        lines.append(f".bilibili.com\t{include_subdomains}\t/\t{secure}\t{expiry}\t{name}\t{value}")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return tmp


def remove_cookiefile(path: Path | None) -> None:
    if path and path.exists():
        path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--delay", type=float, default=10.0)
    parser.add_argument("--format", default="30216/bestaudio[abr<=80]/bestaudio/best")
    parser.add_argument("--force", action="store_true", help="Download again even when an ok audio record exists.")
    parser.add_argument("--extract-mp3", action="store_true", help="Extract MP3 with ffmpeg if ffmpeg is installed.")
    args = parser.parse_args()

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    target_data = load_json(TARGETS, {"targets": []})
    clean_titles = video_titles()
    existing = load_json(OUT, [])
    done = set() if args.force else {item.get("bvid") for item in existing if item.get("status") == "ok"}
    written = list(existing)

    cookiefile = cookiefile_from_env()
    try:
        count = 0
        for target in target_data.get("targets", []):
            if count >= args.limit:
                break
            bvid = target.get("bvid")
            if not bvid or bvid in done:
                continue

            record = {
                "bvid": bvid,
                "url": target.get("url") or f"https://www.bilibili.com/video/{bvid}",
                "title": clean_titles.get(bvid) or target.get("title", ""),
                "bucket": target.get("bucket", ""),
                "status": "pending",
                "audio_path": "",
                "error": "",
            }
            outtmpl = str(AUDIO_DIR / f"{bvid}.%(ext)s")
            options = {
                "format": args.format,
                "outtmpl": outtmpl,
                "noplaylist": True,
                "quiet": True,
                "no_warnings": True,
                "retries": 2,
                "fragment_retries": 2,
            }
            if cookiefile:
                options["cookiefile"] = str(cookiefile)
            if args.extract_mp3:
                options["postprocessors"] = [
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": "mp3",
                        "preferredquality": "64",
                    }
                ]

            try:
                with YoutubeDL(options) as ydl:
                    info = ydl.extract_info(record["url"], download=True)
                matches = sorted(AUDIO_DIR.glob(f"{bvid}.*"))
                expected = AUDIO_DIR / f"{bvid}.mp3" if args.extract_mp3 else (matches[0] if matches else AUDIO_DIR / f"{bvid}.m4a")
                record["status"] = "ok" if expected.exists() else "missing-output"
                record["audio_path"] = str(expected.relative_to(REFS)) if expected.exists() else ""
                record["duration"] = info.get("duration") if isinstance(info, dict) else None
                record["ext"] = expected.suffix.lstrip(".") if expected.exists() else ""
            except Exception as err:
                record["status"] = "error"
                record["error"] = str(err)

            written.append(record)
            count += 1
            print(f"{record['status']}: {bvid} {record['title']}")
            time.sleep(args.delay)
    finally:
        remove_cookiefile(cookiefile)

    OUT.write_text(json.dumps(written, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
