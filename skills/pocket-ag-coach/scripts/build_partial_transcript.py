import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
TRANSCRIPT_DIR = REFS / "audio-transcripts"
OUT = REFS / "partial-transcript-index.json"


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def chunk_sort_key(path: Path) -> tuple[int, str]:
    match = re.search(r"chunk-(\d+)", path.stem)
    return (int(match.group(1)) if match else 999999, path.name)


def write_transcript(path: Path, results: list[dict]) -> int:
    lines = []
    for result in results:
        for segment in result.get("segments") or []:
            text = str(segment.get("text", "")).strip()
            if not text:
                continue
            lines.append(f"[{segment.get('start', '')}] {text}")
    path.write_text("\n".join(lines), encoding="utf-8")
    return len(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bvid", required=True)
    parser.add_argument("--model", default="")
    parser.add_argument("--device", default="")
    parser.add_argument("--compute-type", default="")
    parser.add_argument("--batch-size", type=int, default=0)
    parser.add_argument("--chunk-seconds", type=int, default=0)
    args = parser.parse_args()

    source_dir = TRANSCRIPT_DIR / "chunk-results" / args.bvid
    if not source_dir.exists():
        raise SystemExit(f"No chunk results found: {source_dir}")

    paths = sorted(source_dir.glob("*.json"), key=chunk_sort_key)
    if args.model:
        paths = [path for path in paths if path.name.startswith(args.model + "-")]
    if args.device:
        marker = f"-{args.device}-"
        paths = [path for path in paths if marker in path.name]
    if args.compute_type:
        marker = f"-{args.compute_type}-"
        paths = [path for path in paths if marker in path.name]
    if args.batch_size:
        marker = f"-b{args.batch_size}-"
        paths = [path for path in paths if marker in path.name]
    if args.chunk_seconds:
        marker = f"-{args.chunk_seconds}s-"
        paths = [path for path in paths if marker in path.name]

    results = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
    out_path = TRANSCRIPT_DIR / f"{args.bvid}.partial.txt"
    line_count = write_transcript(out_path, results)

    index = load_json(OUT, [])
    index = [item for item in index if item.get("bvid") != args.bvid]
    index.append(
        {
            "bvid": args.bvid,
            "status": "partial",
            "transcript_path": str(out_path.relative_to(REFS)),
            "chunk_count": len(paths),
            "line_count": line_count,
            "model_filter": args.model,
            "device_filter": args.device,
            "compute_type_filter": args.compute_type,
            "batch_size_filter": args.batch_size,
            "chunk_seconds_filter": args.chunk_seconds,
        }
    )
    OUT.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"chunks={len(paths)} lines={line_count}")


if __name__ == "__main__":
    main()
