import argparse
import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
AUDIO_TRANSCRIPT_INDEX = REFS / "audio-transcript-index.json"
TRANSCRIPT_INDEX = REFS / "transcript-index.json"
TRANSCRIPTS = REFS / "transcripts"


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    TRANSCRIPTS.mkdir(parents=True, exist_ok=True)
    audio_index = load_json(AUDIO_TRANSCRIPT_INDEX, [])
    transcript_index = load_json(TRANSCRIPT_INDEX, [])
    by_bvid = {item.get("bvid"): item for item in transcript_index if item.get("bvid")}

    imported = 0
    for item in audio_index:
        if item.get("status") != "ok":
            continue
        bvid = item.get("bvid")
        if not bvid:
            continue
        source = REFS / item.get("transcript_path", "")
        if not source.exists():
            continue
        dest = TRANSCRIPTS / f"{bvid}.txt"
        if dest.exists() and not args.overwrite:
            continue
        shutil.copyfile(source, dest)
        record = by_bvid.get(bvid)
        if record:
            record["status"] = "ok"
            record["transcript_path"] = str(dest.relative_to(REFS))
            record["line_count"] = item.get("line_count", 0)
            record["source"] = "audio-transcription"
            record["transcription_backend"] = item.get("backend")
            record["transcription_model"] = item.get("model")
            record["error"] = ""
        else:
            record = {
                "bvid": bvid,
                "title": item.get("title", ""),
                "url": f"https://www.bilibili.com/video/{bvid}",
                "bucket": item.get("bucket", ""),
                "status": "ok",
                "transcript_path": str(dest.relative_to(REFS)),
                "line_count": item.get("line_count", 0),
                "source": "audio-transcription",
                "transcription_backend": item.get("backend"),
                "transcription_model": item.get("model"),
                "error": "",
            }
            transcript_index.append(record)
            by_bvid[bvid] = record
        imported += 1

    TRANSCRIPT_INDEX.write_text(json.dumps(transcript_index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Imported {imported} audio transcripts")
    print(f"Wrote {TRANSCRIPT_INDEX}")


if __name__ == "__main__":
    main()
