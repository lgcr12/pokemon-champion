import json
import math
from collections import Counter
from datetime import datetime
from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = ROOT.parents[1]
REFS = ROOT / "references"

VIDEO_INDEX = REFS / "video-index.json"
TRANSCRIPT_INDEX = REFS / "transcript-index.json"
EVIDENCE_LOG = REFS / "evidence-log.json"
QUALITY_REPORT = REFS / "quality-report.json"
MANUAL_SOURCES = REFS / "manual-sources.json"
TRANSCRIPTION_PLAN = REFS / "transcription-plan.json"
PARTIAL_TRANSCRIPT_INDEX = REFS / "partial-transcript-index.json"
INDIVIDUAL_ANALYSIS_LOG = REFS / "individual-analysis-log.json"
INDIVIDUAL_CARDS = REFS / "individual-pokemon-cards.json"
AUDIO_INDEX = REFS / "audio-index.json"
COACH_RULES = REFS / "coach-rules.json"
SERVER_MJS = PROJECT_ROOT / "server.mjs"

OUT_JSON = REFS / "progress-report.json"
OUT_HTML = REFS / "progress-dashboard.html"

CRITICAL_SOURCE_TARGETS = {
    "critical-season-vgc2026",
    "critical-season-pokemon-champions",
    "individual-analysis-bv1ufdwbeenm",
}

SEASON_LABELS = {
    "6356913": "2026 官方比赛大全（通用理论参考）",
    "7859672": "宝可梦冠军（主环境 / 规则语料）",
    "7932882": "宝可梦冠军热门分析（环境补强）",
    "1021365": "朱紫精灵用法分析（历史参考）",
}

BUCKET_LABELS = {
    "champions_team_core": "宝可梦冠军主环境",
    "champions_individual_analysis": "个体宝可梦推荐",
    "mega_slot": "Mega 与冠军热门分析",
    "vgc_commentary": "VGC 通用对战理论",
    "usage_analysis": "历史用法分析",
}

EVIDENCE_TARGETS = {
    "team-axis": 100,
    "mega-slot": 40,
    "speed-control": 500,
    "support": 300,
    "protect": 250,
    "switching": 150,
    "lead-choice": 80,
    "focus-fire": 80,
    "endgame": 180,
}

CARD_TARGETS = {
    "cards": 100,
    "with_ag_evidence": 20,
    "high_confidence": 12,
    "with_curated_ag_summary": 20,
}


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def pct(done: float, total: float) -> float:
    if total <= 0:
        return 0.0
    return round(max(0.0, min(100.0, done / total * 100)), 1)


def bar_status(percent: float) -> str:
    if percent >= 80:
        return "good"
    if percent >= 45:
        return "warn"
    return "low"


def count_by(items, key):
    result = Counter()
    for item in items:
        result[str(item.get(key, ""))] += 1
    return result


def transcript_summary(transcripts):
    by_bucket = {}
    for item in transcripts:
        bucket = item.get("bucket", "unknown") or "unknown"
        slot = by_bucket.setdefault(bucket, {"total": 0, "ok": 0, "no_subtitle": 0, "error": 0, "lines": 0})
        slot["total"] += 1
        status = item.get("status", "")
        if status == "ok":
            slot["ok"] += 1
        elif "subtitle" in status:
            slot["no_subtitle"] += 1
        elif status:
            slot["error"] += 1
        slot["lines"] += int(item.get("line_count") or 0)
    return by_bucket


def card_progress(summary):
    if not summary:
        return 0.0
    scores = [
        pct(summary.get("cards", 0), CARD_TARGETS["cards"]),
        pct(summary.get("with_ag_evidence", 0), CARD_TARGETS["with_ag_evidence"]),
        pct(summary.get("high_confidence", 0), CARD_TARGETS["high_confidence"]),
        pct(summary.get("with_curated_ag_summary", 0), CARD_TARGETS["with_curated_ag_summary"]),
    ]
    return round(sum(scores) / len(scores), 1)


def coach_rules_status():
    rules = load_json(COACH_RULES, {})
    server_text = SERVER_MJS.read_text(encoding="utf-8-sig") if SERVER_MJS.exists() else ""
    exists = bool(rules)
    integrated = "POCKET_AG_COACH_RULES_PATH" in server_text and "formatPocketAgCoachRules" in server_text
    global_rules = len(rules.get("global_rules", []))
    pokemon_rules = len(rules.get("pokemon_rules", []))
    product_checks = len(rules.get("product_checks", []))
    score = round(
        pct(int(exists), 1) * 0.25
        + pct(int(integrated), 1) * 0.35
        + pct(global_rules, 10) * 0.20
        + pct(pokemon_rules, 12) * 0.15
        + pct(product_checks, 6) * 0.05,
        1,
    )
    return {
        "path": "references/coach-rules.json",
        "exists": exists,
        "server_integrated": integrated,
        "global_rules": global_rules,
        "pokemon_rules": pokemon_rules,
        "product_checks": product_checks,
        "progress": score,
    }


def build_report():
    video_index = load_json(VIDEO_INDEX, {})
    videos = video_index.get("videos", [])
    transcripts = load_json(TRANSCRIPT_INDEX, [])
    evidence = load_json(EVIDENCE_LOG, [])
    quality = load_json(QUALITY_REPORT, {})
    manual_sources = load_json(MANUAL_SOURCES, {"sources": []}).get("sources", [])
    transcription_plan = load_json(TRANSCRIPTION_PLAN, {"plans": []}).get("plans", [])
    partial_transcripts = load_json(PARTIAL_TRANSCRIPT_INDEX, [])
    individual_log = load_json(INDIVIDUAL_ANALYSIS_LOG, [])
    individual_cards = load_json(INDIVIDUAL_CARDS, {})
    audio_index = load_json(AUDIO_INDEX, [])

    season_counts = count_by(videos, "season_id")
    transcript_by_bucket = transcript_summary(transcripts)
    evidence_by_bucket = count_by(evidence, "bucket")
    evidence_by_tag = count_by(evidence, "tag")
    individual_by_tag = count_by(individual_log, "tag")
    cards_summary = individual_cards.get("summary", {})
    cards_progress = card_progress(cards_summary)
    coach_rules = coach_rules_status()

    critical_registered = {
        source_id: any(item.get("id") == source_id for item in manual_sources)
        for source_id in CRITICAL_SOURCE_TARGETS
    }

    critical_video = next((p for p in transcription_plan if p.get("bvid") == "BV1ufDwBEEnM"), {})
    critical_audio = next((a for a in audio_index if a.get("bvid") == "BV1ufDwBEEnM"), {})
    critical_partial = next((p for p in partial_transcripts if p.get("bvid") == "BV1ufDwBEEnM"), {})
    segment_seconds = int(critical_video.get("segment_seconds") or 600)
    duration_seconds = int(critical_video.get("duration_seconds") or 0)
    expected_chunks = max(1, math.ceil(duration_seconds / segment_seconds)) if duration_seconds else 0
    completed_chunks = int(critical_partial.get("chunk_count") or 0)

    source_index_progress = pct(video_index.get("video_count", len(videos)), video_index.get("video_count", len(videos)))
    critical_source_progress = pct(sum(1 for ok in critical_registered.values() if ok), len(CRITICAL_SOURCE_TARGETS))
    champions_indexed = season_counts.get("7859672", 0)
    champions_transcripts = transcript_by_bucket.get("champions_team_core", {})
    champions_transcript_progress = pct(champions_transcripts.get("ok", 0), champions_indexed or 21)
    hot_analysis_indexed = season_counts.get("7932882", 0)
    mega_transcripts = transcript_by_bucket.get("mega_slot", {})
    mega_transcript_progress = pct(mega_transcripts.get("ok", 0), hot_analysis_indexed or 10)
    individual_transcript_progress = pct(completed_chunks, expected_chunks)

    evidence_scores = [pct(evidence_by_tag.get(tag, 0), target) for tag, target in EVIDENCE_TARGETS.items()]
    evidence_progress = round(sum(evidence_scores) / len(evidence_scores), 1) if evidence_scores else 0.0
    doc_progress = 85.0 if (ROOT / "SKILL.md").exists() and (REFS / "distillation.md").exists() else 35.0

    overall = round(
        source_index_progress * 0.06
        + critical_source_progress * 0.07
        + champions_transcript_progress * 0.13
        + mega_transcript_progress * 0.06
        + individual_transcript_progress * 0.18
        + evidence_progress * 0.12
        + cards_progress * 0.15
        + coach_rules["progress"] * 0.15
        + doc_progress * 0.08,
        1,
    )

    return {
        "version": "0.4",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "overall": {
            "label": "Pocket AG Skill 成熟度",
            "percent": overall,
            "status": bar_status(overall),
            "summary": "关键个体视频已完成转写，个体卡片库已生成，教练规则层已产品化并接入服务端提示。",
        },
        "source_index": {
            "videos_indexed": len(videos),
            "video_count_reported": video_index.get("video_count", len(videos)),
            "season_count": video_index.get("season_count", len(video_index.get("seasons", []))),
            "progress": source_index_progress,
        },
        "critical_sources": {
            "registered": sum(1 for ok in critical_registered.values() if ok),
            "target": len(CRITICAL_SOURCE_TARGETS),
            "progress": critical_source_progress,
            "items": critical_registered,
        },
        "collections": [
            {
                "id": season_id,
                "label": SEASON_LABELS.get(season_id, season_id),
                "indexed": count,
                "progress": 100.0 if count else 0.0,
            }
            for season_id, count in sorted(season_counts.items())
        ],
        "transcripts": {
            "total_records": len(transcripts),
            "ok": sum(1 for item in transcripts if item.get("status") == "ok"),
            "by_bucket": transcript_by_bucket,
        },
        "evidence": {
            "total": len(evidence),
            "by_bucket": dict(evidence_by_bucket),
            "by_tag": dict(evidence_by_tag),
            "targets": EVIDENCE_TARGETS,
            "progress": evidence_progress,
        },
        "critical_individual_video": {
            "bvid": "BV1ufDwBEEnM",
            "title": "《宝可梦冠军》给大家推荐一些好用的宝可梦",
            "duration_seconds": duration_seconds,
            "audio_status": critical_audio.get("status", "unknown"),
            "audio_path": critical_audio.get("audio_path", ""),
            "segment_seconds": segment_seconds,
            "expected_chunks": expected_chunks,
            "completed_chunks": completed_chunks,
            "line_count": int(critical_partial.get("line_count") or 0),
            "snippets": len(individual_log),
            "by_tag": dict(individual_by_tag),
            "progress": individual_transcript_progress,
        },
        "individual_cards": {
            "path": "references/individual-pokemon-cards.json",
            "summary": cards_summary,
            "targets": CARD_TARGETS,
            "progress": cards_progress,
        },
        "coach_rules": coach_rules,
        "quality": {
            "source_version": quality.get("version", ""),
            "status": quality.get("status", ""),
            "next_step": quality.get("next_step", ""),
            "limitations": quality.get("limitations", []),
            "confidence": quality.get("confidence", {}),
        },
        "next_actions": [
            "继续人工复核未归属证据簇，把高价值片段绑定到具体宝可梦。",
            "继续补宝可梦冠军主环境与热门分析视频；VGC 只作为通用对战理论参考。",
            "在产品侧继续观察 AI 输出，按失败案例补充 coach-rules 的规则和个体卡片。",
        ],
    }


def render_bar(label, percent, meta=""):
    percent_text = f"{percent:.1f}%"
    safe_label = escape(label)
    safe_meta = escape(meta)
    return f"""
      <div class="bar-row">
        <div class="bar-head">
          <span>{safe_label}</span>
          <strong>{percent_text}</strong>
        </div>
        <div class="track" aria-label="{safe_label} {percent_text}">
          <div class="fill {bar_status(percent)}" style="width: {percent}%"></div>
        </div>
        {f'<p>{safe_meta}</p>' if meta else ''}
      </div>
    """


def render_report(report):
    source = report["source_index"]
    critical = report["critical_sources"]
    individual = report["critical_individual_video"]
    cards = report["individual_cards"]
    card_summary = cards.get("summary", {})
    coach = report["coach_rules"]
    transcripts = report["transcripts"]
    evidence = report["evidence"]

    transcript_rows = "\n".join(
        f"""
        <tr>
          <td>{escape(BUCKET_LABELS.get(bucket, bucket))}</td>
          <td>{data.get('ok', 0)}</td>
          <td>{data.get('total', 0)}</td>
          <td>{data.get('lines', 0)}</td>
          <td>{data.get('no_subtitle', 0)}</td>
          <td>{data.get('error', 0)}</td>
        </tr>
        """
        for bucket, data in sorted(transcripts["by_bucket"].items())
    )

    collection_cards = "\n".join(
        f"""
        <section class="mini-card">
          <h3>{escape(item['label'])}</h3>
          {render_bar('索引完成度', item['progress'], f"{item['indexed']} 个视频已登记")}
        </section>
        """
        for item in report["collections"]
    )

    evidence_rows = "\n".join(
        f"""
        <tr>
          <td>{escape(tag)}</td>
          <td>{count}</td>
          <td>{target}</td>
          <td>{render_bar('', pct(count, target))}</td>
        </tr>
        """
        for tag, target in evidence["targets"].items()
        for count in [evidence["by_tag"].get(tag, 0)]
    )

    individual_tags = "\n".join(
        f"<span>{escape(tag)} <strong>{count}</strong></span>"
        for tag, count in sorted(individual["by_tag"].items())
    )

    next_actions = "\n".join(f"<li>{escape(item)}</li>" for item in report["next_actions"])
    limitations = "\n".join(f"<li>{escape(item)}</li>" for item in report["quality"].get("limitations", [])[:6])

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>Pocket AG Skill 进度面板</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --text: #18202f;
      --muted: #667085;
      --line: #d9e0ea;
      --good: #16875d;
      --warn: #c47a13;
      --low: #bd3440;
      --accent: #2764d8;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.55 "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
    }}
    main {{
      width: min(1180px, calc(100vw - 40px));
      margin: 28px auto 48px;
    }}
    header {{
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-end;
      margin-bottom: 18px;
    }}
    h1, h2, h3, p {{ margin: 0; }}
    h1 {{ font-size: 28px; letter-spacing: 0; }}
    h2 {{ font-size: 17px; margin-bottom: 12px; }}
    h3 {{ font-size: 14px; margin-bottom: 10px; }}
    .muted {{ color: var(--muted); }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 14px;
    }}
    .card, .mini-card {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }}
    .span-8 {{ grid-column: span 8; }}
    .span-6 {{ grid-column: span 6; }}
    .span-4 {{ grid-column: span 4; }}
    .span-12 {{ grid-column: span 12; }}
    .metric {{
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 14px;
    }}
    .metric div {{
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
    }}
    .metric strong {{
      display: block;
      font-size: 22px;
      line-height: 1.1;
    }}
    .bar-row {{ margin: 10px 0; }}
    .bar-head {{
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
      color: var(--muted);
    }}
    .bar-head span:empty {{ display: none; }}
    .bar-row p {{ margin-top: 6px; color: var(--muted); font-size: 12px; }}
    .track {{
      width: 100%;
      height: 12px;
      background: #e8edf5;
      border: 1px solid #d8e0eb;
      border-radius: 999px;
      overflow: hidden;
    }}
    .fill {{
      height: 100%;
      min-width: 2px;
      border-radius: inherit;
      background: var(--accent);
    }}
    .fill.good {{ background: var(--good); }}
    .fill.warn {{ background: var(--warn); }}
    .fill.low {{ background: var(--low); }}
    table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }}
    th, td {{
      text-align: left;
      border-bottom: 1px solid var(--line);
      padding: 9px 8px;
      vertical-align: middle;
    }}
    th {{ color: var(--muted); font-weight: 600; }}
    td .bar-row {{ margin: 0; min-width: 160px; }}
    td .bar-head {{ display: none; }}
    .tags {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }}
    .tags span {{
      border: 1px solid var(--line);
      background: #fbfcfe;
      border-radius: 999px;
      padding: 5px 9px;
      color: var(--muted);
    }}
    ul {{ margin: 8px 0 0; padding-left: 20px; }}
    li {{ margin: 5px 0; }}
    @media (max-width: 860px) {{
      main {{ width: min(100vw - 24px, 1180px); margin-top: 18px; }}
      header {{ display: block; }}
      .span-8, .span-6, .span-4 {{ grid-column: span 12; }}
      .metric {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
      table {{ display: block; overflow-x: auto; white-space: nowrap; }}
    }}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Pocket AG Skill 进度面板</h1>
        <p class="muted">生成时间：{escape(report['generated_at'])}</p>
      </div>
      <p class="muted">主目标：宝可梦冠军环境；VGC 仅作通用对战理论参考。</p>
    </header>

    <div class="grid">
      <section class="card span-8">
        <h2>总进度</h2>
        {render_bar(report['overall']['label'], report['overall']['percent'], report['overall']['summary'])}
        <div class="metric">
          <div><strong>{source['videos_indexed']}</strong><span class="muted">视频已索引</span></div>
          <div><strong>{critical['registered']}/{critical['target']}</strong><span class="muted">关键源登记</span></div>
          <div><strong>{transcripts['ok']}</strong><span class="muted">可用转写</span></div>
          <div><strong>{evidence['total']}</strong><span class="muted">证据片段</span></div>
        </div>
      </section>

      <section class="card span-4">
        <h2>关键个体源 BV1ufDwBEEnM</h2>
        {render_bar('分段转写', individual['progress'], f"{individual['completed_chunks']}/{individual['expected_chunks']} 个片段，{individual['line_count']} 行，{individual['snippets']} 条抽取")}
        <p class="muted">音频状态：{escape(individual['audio_status'])}</p>
        <div class="tags">{individual_tags}</div>
      </section>

      <section class="card span-6">
        <h2>结构化个体卡片</h2>
        {render_bar('卡片库完成度', cards['progress'], f"{card_summary.get('cards', 0)} 张卡片，{card_summary.get('with_ag_evidence', 0)} 张有 AG 证据，{card_summary.get('with_curated_ag_summary', 0)} 张已精修摘要，{card_summary.get('high_confidence', 0)} 张高置信")}
        <div class="metric">
          <div><strong>{card_summary.get('cards', 0)}</strong><span class="muted">卡片</span></div>
          <div><strong>{card_summary.get('with_ag_evidence', 0)}</strong><span class="muted">含 AG 证据</span></div>
          <div><strong>{card_summary.get('with_curated_ag_summary', 0)}</strong><span class="muted">已精修摘要</span></div>
          <div><strong>{card_summary.get('unassigned_evidence_clusters', 0)}</strong><span class="muted">待归属证据簇</span></div>
        </div>
      </section>

      <section class="card span-6">
        <h2>产品化教练规则</h2>
        {render_bar('规则层接入度', coach['progress'], f"规则文件：{coach['exists']}；服务端接入：{coach['server_integrated']}；全局规则 {coach['global_rules']} 条；个体规则 {coach['pokemon_rules']} 条")}
        <div class="metric">
          <div><strong>{coach['global_rules']}</strong><span class="muted">全局规则</span></div>
          <div><strong>{coach['pokemon_rules']}</strong><span class="muted">个体规则</span></div>
          <div><strong>{coach['product_checks']}</strong><span class="muted">产品自检</span></div>
          <div><strong>{'是' if coach['server_integrated'] else '否'}</strong><span class="muted">服务端接入</span></div>
        </div>
      </section>

      <section class="card span-6">
        <h2>证据抽取</h2>
        <table>
          <thead><tr><th>标签</th><th>已抽取</th><th>目标</th><th>进度</th></tr></thead>
          <tbody>{evidence_rows}</tbody>
        </table>
      </section>

      <section class="card span-12">
        <h2>合集索引</h2>
        <div class="grid">{collection_cards}</div>
      </section>

      <section class="card span-6">
        <h2>转写状态</h2>
        <table>
          <thead><tr><th>语料框</th><th>可用</th><th>记录</th><th>行数</th><th>无字幕</th><th>错误</th></tr></thead>
          <tbody>{transcript_rows}</tbody>
        </table>
      </section>

      <section class="card span-6">
        <h2>下一步</h2>
        <ul>{next_actions}</ul>
      </section>

      <section class="card span-12">
        <h2>当前限制</h2>
        <ul>{limitations}</ul>
      </section>
    </div>
  </main>
</body>
</html>
"""


def main():
    report = build_report()
    OUT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT_HTML.write_text(render_report(report), encoding="utf-8")
    print(f"Wrote {OUT_JSON}")
    print(f"Wrote {OUT_HTML}")
    print(json.dumps(report["overall"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
