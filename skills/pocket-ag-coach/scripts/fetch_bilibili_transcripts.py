import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
TARGETS = REFS / "evidence-targets.json"
TRANSCRIPTS = REFS / "transcripts"
META_OUT = REFS / "transcript-index.json"


def headers(referer: str = "https://www.bilibili.com/") -> dict[str, str]:
    result = {
        "User-Agent": "Mozilla/5.0",
        "Referer": referer,
    }
    cookie = os.environ.get("BILIBILI_COOKIE", "").strip()
    if cookie:
        result["Cookie"] = cookie
    return result


def fetch_json(url: str, *, referer: str = "https://www.bilibili.com/", retries: int = 2) -> dict:
    last_error = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers(referer))
            with urllib.request.urlopen(req, timeout=25) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            last_error = err
            if err.code in {412, 429}:
                time.sleep(8 * (attempt + 1))
                continue
            raise
        except Exception as err:
            last_error = err
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"request failed after retries: {last_error}")


def flatten_targets(bucket_filter: str = "") -> list[dict]:
    data = json.loads(TARGETS.read_text(encoding="utf-8"))
    seen = set()
    result = []
    for bucket, items in data.items():
        if bucket_filter and bucket != bucket_filter:
            continue
        for item in items:
            bvid = item.get("bvid")
            if not bvid or bvid in seen:
                continue
            seen.add(bvid)
            copy = dict(item)
            copy["bucket"] = bucket
            result.append(copy)
    return result


def get_cid(bvid: str) -> int | None:
    url = f"https://api.bilibili.com/x/player/pagelist?bvid={urllib.parse.quote(bvid)}"
    data = fetch_json(url, referer=f"https://www.bilibili.com/video/{bvid}")
    pages = data.get("data") or []
    return pages[0].get("cid") if pages else None


def subtitle_candidates(bvid: str, cid: int) -> dict:
    url = f"https://api.bilibili.com/x/player/v2?bvid={urllib.parse.quote(bvid)}&cid={cid}"
    data = fetch_json(url, referer=f"https://www.bilibili.com/video/{bvid}")
    return data.get("data", {}).get("subtitle", {}) or {}


def download_subtitle(subtitle_url: str, bvid: str) -> dict:
    if subtitle_url.startswith("//"):
        subtitle_url = "https:" + subtitle_url
    return fetch_json(subtitle_url, referer=f"https://www.bilibili.com/video/{bvid}")


def subtitle_to_text(data: dict) -> str:
    lines = []
    for item in data.get("body", []) or []:
        text = str(item.get("content", "")).strip()
        if not text:
            continue
        start = item.get("from", "")
        lines.append(f"[{start}] {text}")
    return "\n".join(lines)


def fix_mojibake(text: str) -> str:
    candidates = [text]
    for encoding in ("gbk", "cp936"):
        try:
            candidates.append(text.encode(encoding, errors="ignore").decode("utf-8", errors="ignore"))
        except Exception:
            pass

    def score(value: str) -> int:
        keywords = ["宝可梦", "太晶", "守住", "顺风", "空间", "对战", "精灵", "队伍", "回合", "输出", "速度"]
        cjk = sum(1 for ch in value if "\u4e00" <= ch <= "\u9fff")
        bad = value.count("�") + value.count("?")
        return cjk + sum(value.count(keyword) * 20 for keyword in keywords) - bad * 5

    return max(candidates, key=score)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--delay", type=float, default=3.0)
    parser.add_argument("--bucket", default="", help="Only fetch videos from one evidence target bucket.")
    args = parser.parse_args()

    TRANSCRIPTS.mkdir(parents=True, exist_ok=True)
    existing = json.loads(META_OUT.read_text(encoding="utf-8")) if META_OUT.exists() else []
    indexed = {item.get("bvid") for item in existing}
    written = list(existing)

    count = 0
    for video in flatten_targets(args.bucket):
        if count >= args.limit:
            break
        bvid = video.get("bvid")
        if not bvid or bvid in indexed:
            continue
        record = {
            "bvid": bvid,
            "title": video.get("title", ""),
            "url": video.get("url", ""),
            "bucket": video.get("bucket", ""),
            "status": "pending",
            "transcript_path": "",
            "error": "",
        }
        try:
            cid = get_cid(bvid)
            record["cid"] = cid
            if not cid:
                record["status"] = "no-cid"
            else:
                subtitles = subtitle_candidates(bvid, cid)
                record["need_login_subtitle"] = bool(subtitles.get("need_login_subtitle"))
                candidates = subtitles.get("subtitles") or []
                record["subtitle_count"] = len(candidates)
                if not candidates:
                    record["status"] = "no-subtitle"
                else:
                    selected = candidates[0]
                    data = download_subtitle(selected.get("subtitle_url", ""), bvid)
                    text = fix_mojibake(subtitle_to_text(data))
                    if text.strip():
                        out = TRANSCRIPTS / f"{bvid}.txt"
                        out.write_text(text, encoding="utf-8")
                        record["status"] = "ok"
                        record["transcript_path"] = str(out.relative_to(REFS))
                        record["line_count"] = len(text.splitlines())
                    else:
                        record["status"] = "empty-subtitle"
        except Exception as err:
            record["status"] = "error"
            record["error"] = str(err)
        written.append(record)
        indexed.add(bvid)
        count += 1
        print(f"{record['status']}: {bvid} {record['title']}")
        time.sleep(args.delay)

    META_OUT.write_text(json.dumps(written, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {META_OUT}")


if __name__ == "__main__":
    main()
