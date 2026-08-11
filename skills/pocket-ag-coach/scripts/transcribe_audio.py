import argparse
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFS = ROOT / "references"
AUDIO_INDEX = REFS / "audio-index.json"
VIDEO_INDEX = REFS / "video-index.json"
TRANSCRIPT_DIR = REFS / "audio-transcripts"
OUT = REFS / "audio-transcript-index.json"


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def clean_titles() -> dict[str, str]:
    data = load_json(VIDEO_INDEX, {})
    return {video.get("bvid"): video.get("title", "") for video in data.get("videos", []) if video.get("bvid")}


def sanitize_error(error: Exception | str) -> str:
    text = str(error)
    text = re.sub(r"sk-[A-Za-z0-9_\-]+", "sk-***", text)
    text = re.sub(r"(Authorization: Bearer )[^\\s]+", r"\1***", text)
    return text


def find_ffmpeg() -> str | None:
    for name in ("ffmpeg", "ffmpeg.exe"):
        try:
            subprocess.run([name, "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            return name
        except FileNotFoundError:
            continue
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def transcribe_openai(file_path: Path, model: str, language: str, prompt: str, response_format: str, retries: int = 2) -> dict:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    try:
        import requests
    except ImportError as err:
        raise RuntimeError("requests is required for OpenAI transcription") from err

    last_error = None
    for attempt in range(retries + 1):
        try:
            with file_path.open("rb") as handle:
                response = requests.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    data={
                        "model": model,
                        "language": language,
                        "response_format": response_format,
                        "prompt": prompt,
                    },
                    files={
                        "file": (
                            file_path.name,
                            handle,
                            mimetypes.guess_type(str(file_path))[0] or "application/octet-stream",
                        )
                    },
                    timeout=300,
                )
            if response.status_code >= 400:
                raise RuntimeError(f"OpenAI transcription failed: HTTP {response.status_code} {response.text}")
            return response.json() if response_format == "json" else {"text": response.text}
        except Exception as err:
            last_error = err
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"OpenAI transcription failed after retries: {last_error}")


def load_faster_whisper_model(model: str, device: str, compute_type: str, batch_size: int):
    try:
        from faster_whisper import BatchedInferencePipeline, WhisperModel
    except ImportError as err:
        raise RuntimeError("faster-whisper is not installed") from err
    whisper = WhisperModel(model, device=device, compute_type=compute_type)
    if batch_size > 1:
        return BatchedInferencePipeline(model=whisper)
    return whisper


def transcribe_faster_whisper(file_path: Path, whisper, language: str, args: argparse.Namespace) -> dict:
    kwargs = {
        "language": language,
        "vad_filter": args.vad_filter,
        "beam_size": args.beam_size,
    }
    if args.batch_size > 1:
        kwargs["batch_size"] = args.batch_size
    segments, info = whisper.transcribe(str(file_path), **kwargs)
    body = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            body.append({"start": segment.start, "end": segment.end, "text": text})
    return {
        "text": "\n".join(item["text"] for item in body),
        "language": getattr(info, "language", language),
        "duration": getattr(info, "duration", None),
        "segments": body,
    }


def write_transcript(path: Path, result: dict) -> int:
    lines = []
    for segment in result.get("segments") or []:
        start = segment.get("start", segment.get("seek", ""))
        text = str(segment.get("text", "")).strip()
        if text:
            lines.append(f"[{start}] {text}")
    if not lines and result.get("text"):
        lines.append(f"[0] {str(result['text']).strip()}")
    path.write_text("\n".join(lines), encoding="utf-8")
    return len(lines)


def maybe_slice_audio(source: Path, seconds: int) -> Path:
    if seconds <= 0:
        return source
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("--max-seconds requires ffmpeg, but ffmpeg was not found")
    tmp = Path(tempfile.gettempdir()) / f"{source.stem}-slice-{seconds}{source.suffix}"
    subprocess.run(
        [ffmpeg, "-y", "-i", str(source), "-t", str(seconds), "-c", "copy", str(tmp)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    return tmp


def chunk_audio(source: Path, chunk_seconds: int) -> list[tuple[Path, float]]:
    if chunk_seconds <= 0:
        return [(source, 0.0)]
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("--chunk-seconds requires ffmpeg, but ffmpeg was not found")
    out_dir = TRANSCRIPT_DIR / "chunks" / source.stem / f"{chunk_seconds}s"
    out_dir.mkdir(parents=True, exist_ok=True)
    existing_chunks = sorted(out_dir.glob("chunk-*.m4a"))
    if existing_chunks:
        print(f"reuse chunks: {out_dir} count={len(existing_chunks)}", flush=True)
        return [(chunk, index * float(chunk_seconds)) for index, chunk in enumerate(existing_chunks)]
    pattern = out_dir / "chunk-%03d.m4a"
    print(f"create chunks: {source} -> {out_dir} seconds={chunk_seconds}", flush=True)
    started = time.time()
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-i",
            str(source),
            "-f",
            "segment",
            "-segment_time",
            str(chunk_seconds),
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            str(pattern),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    chunks = sorted(out_dir.glob("chunk-*.m4a"))
    print(f"created chunks: count={len(chunks)} elapsed={time.time() - started:.1f}s", flush=True)
    return [(chunk, index * float(chunk_seconds)) for index, chunk in enumerate(chunks)]


def offset_segments(result: dict, offset: float) -> dict:
    adjusted = dict(result)
    segments = []
    for segment in result.get("segments") or []:
        copy = dict(segment)
        if isinstance(copy.get("start"), (int, float)):
            copy["start"] = copy["start"] + offset
        if isinstance(copy.get("end"), (int, float)):
            copy["end"] = copy["end"] + offset
        segments.append(copy)
    if not segments and result.get("text"):
        segments.append({"start": offset, "text": str(result["text"]).strip()})
    adjusted["segments"] = segments
    return adjusted


def merge_results(results: list[dict]) -> dict:
    text_parts = []
    segments = []
    for result in results:
        if result.get("text"):
            text_parts.append(str(result["text"]).strip())
        segments.extend(result.get("segments") or [])
    return {"text": "\n".join(part for part in text_parts if part), "segments": segments}


def chunk_result_path(bvid: str, chunk_path: Path, args: argparse.Namespace) -> Path:
    safe_model = re.sub(r"[^A-Za-z0-9_.-]+", "_", args.model)
    safe_device = re.sub(r"[^A-Za-z0-9_.-]+", "_", args.device)
    safe_compute = re.sub(r"[^A-Za-z0-9_.-]+", "_", args.compute_type)
    return (
        TRANSCRIPT_DIR
        / "chunk-results"
        / bvid
        / f"{safe_model}-{safe_device}-{safe_compute}-b{args.batch_size}-{args.chunk_seconds}s-{chunk_path.stem}.json"
    )


def transcribe_chunk(bvid: str, chunk_path: Path, offset: float, args: argparse.Namespace, context: dict) -> dict:
    cache_path = chunk_result_path(bvid, chunk_path, args)
    if cache_path.exists():
        print(f"cache hit: {chunk_path.name} offset={offset:.0f}s", flush=True)
        return json.loads(cache_path.read_text(encoding="utf-8"))
    print(f"transcribe start: {chunk_path.name} offset={offset:.0f}s model={args.model}", flush=True)
    started = time.time()
    if args.backend == "openai":
        result = transcribe_openai(chunk_path, args.model, args.language, args.prompt, args.response_format)
    else:
        if context.get("whisper") is None:
            print(
                f"load model: {args.model} device={args.device} compute={args.compute_type} batch={args.batch_size}",
                flush=True,
            )
            context["whisper"] = load_faster_whisper_model(args.model, args.device, args.compute_type, args.batch_size)
        result = transcribe_faster_whisper(chunk_path, context["whisper"], args.language, args)
    adjusted = offset_segments(result, offset)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(adjusted, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"transcribe done: {chunk_path.name} segments={len(adjusted.get('segments') or [])} elapsed={time.time() - started:.1f}s",
        flush=True,
    )
    return adjusted


def select_chunks(chunks: list[tuple[Path, float]], start: int, limit: int) -> list[tuple[Path, float]]:
    selected = chunks[start:] if start > 0 else chunks
    if limit > 0:
        selected = selected[:limit]
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["openai", "faster-whisper"], default="openai")
    parser.add_argument("--model", default="gpt-4o-mini-transcribe")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--response-format", default="json")
    parser.add_argument("--device", default="auto", help="faster-whisper device: auto, cuda, cpu.")
    parser.add_argument("--compute-type", default="auto", help="faster-whisper compute type: auto, float16, int8_float16, int8.")
    parser.add_argument("--batch-size", type=int, default=1, help="faster-whisper batched inference size. Try 8 on a 6GB GPU.")
    parser.add_argument("--beam-size", type=int, default=1, help="Lower is faster. Use 1 for rough extraction, 3-5 for quality.")
    parser.add_argument("--vad-filter", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--delay", type=float, default=5.0)
    parser.add_argument("--bvid", default="", help="Only transcribe one specific Bilibili BV id.")
    parser.add_argument("--max-seconds", type=int, default=0, help="Optional smoke-test slice. Requires ffmpeg.")
    parser.add_argument("--chunk-seconds", type=int, default=180, help="Split audio before transcription. 0 disables chunking.")
    parser.add_argument("--chunk-start", type=int, default=0, help="Zero-based chunk offset for resumable long videos.")
    parser.add_argument("--chunk-limit", type=int, default=0, help="Maximum chunks to transcribe in this run. 0 means all chunks.")
    parser.add_argument(
        "--prompt",
        default=(
            "Chinese Pokemon battle commentary. Terms include VGC, Mega, team building, "
            "speed tier, Protect, switching, Fake Out, Tailwind, Trick Room, Encore, weather."
        ),
    )
    args = parser.parse_args()

    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    audio_index = load_json(AUDIO_INDEX, [])
    titles = clean_titles()
    existing = load_json(OUT, [])
    done = {item.get("bvid") for item in existing if item.get("status") == "ok"}
    written = list(existing)

    count = 0
    for audio in audio_index:
        if count >= args.limit:
            break
        if audio.get("status") != "ok" or audio.get("bvid") in done:
            continue
        bvid = audio.get("bvid")
        if args.bvid and bvid != args.bvid:
            continue
        audio_path = REFS / audio.get("audio_path", "")
        record = {
            "bvid": bvid,
            "title": titles.get(bvid) or audio.get("title", ""),
            "bucket": audio.get("bucket", ""),
            "backend": args.backend,
            "model": args.model,
            "status": "pending",
            "transcript_path": "",
            "line_count": 0,
            "error": "",
        }
        try:
            source = maybe_slice_audio(audio_path, args.max_seconds)
            chunks = chunk_audio(source, args.chunk_seconds)
            selected_chunks = select_chunks(chunks, args.chunk_start, args.chunk_limit)
            if not selected_chunks:
                raise RuntimeError("No chunks selected for transcription")
            print(
                f"selected chunks: start={args.chunk_start} limit={args.chunk_limit} count={len(selected_chunks)} total={len(chunks)}",
                flush=True,
            )
            context = {"whisper": None}
            results = [transcribe_chunk(bvid, chunk_path, offset, args, context) for chunk_path, offset in selected_chunks]
            result = merge_results(results)
            out_path = TRANSCRIPT_DIR / f"{bvid}.txt"
            record["line_count"] = write_transcript(out_path, result)
            record["chunk_seconds"] = args.chunk_seconds
            record["chunk_start"] = args.chunk_start
            record["chunk_limit"] = args.chunk_limit
            record["chunks_total"] = len(chunks)
            record["chunks_processed"] = len(selected_chunks)
            complete = args.chunk_start == 0 and (args.chunk_limit == 0 or len(selected_chunks) == len(chunks))
            record["status"] = "ok" if record["line_count"] and complete else ("partial" if record["line_count"] else "empty")
            record["transcript_path"] = str(out_path.relative_to(REFS))
            raw_path = TRANSCRIPT_DIR / f"{bvid}.json"
            raw_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            record["raw_path"] = str(raw_path.relative_to(REFS))
        except Exception as err:
            record["status"] = "error"
            record["error"] = sanitize_error(err)
        written.append(record)
        count += 1
        print(f"{record['status']}: {bvid} {record['title']}")
        time.sleep(args.delay)

    OUT.write_text(json.dumps(written, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
