# Pocket AG Skill 提速方案

## 结论

当前机器有 RTX 3060 Laptop GPU，`faster-whisper` 和 `ctranslate2` 都能看到 CUDA。

最优先的提速方式：

1. 显式使用 GPU：`--device cuda --compute-type float16`
2. 开启批处理：`--batch-size 8`
3. 先用小模型扫全片，再对高价值片段重转写
4. 复用已切好的音频 chunk，避免每次重切 5 小时音频

烟测结果：`tiny + cuda + float16 + batch 8` 转写 60 秒音频约 6 秒完成。

## 快速摸底模式

用于先把 `BV1ufDwBEEnM` 全片扫出粗略文本，后续靠关键词定位推荐、配置、队友适配、克制关系。

```powershell
python "E:\Codex\pokemon-champion\skills\pocket-ag-coach\scripts\transcribe_audio.py" `
  --backend faster-whisper `
  --model tiny `
  --device cuda `
  --compute-type float16 `
  --batch-size 8 `
  --beam-size 1 `
  --bvid BV1ufDwBEEnM `
  --limit 1 `
  --chunk-seconds 600 `
  --chunk-start 1 `
  --chunk-limit 4 `
  --delay 0
```

说明：

- `--chunk-start 1` 从第 2 个 10 分钟片段开始，避开已做过的开头。
- `--chunk-limit 4` 每次只跑 40 分钟，降低中途失败成本。
- 跑完一批后把 `chunk-start` 加 4。

## 正式抽取模式

用于质量更高的中文转写，适合对已经定位出的关键片段重跑。

```powershell
python "E:\Codex\pokemon-champion\skills\pocket-ag-coach\scripts\transcribe_audio.py" `
  --backend faster-whisper `
  --model small `
  --device cuda `
  --compute-type float16 `
  --batch-size 8 `
  --beam-size 1 `
  --bvid BV1ufDwBEEnM `
  --limit 1 `
  --chunk-seconds 600 `
  --chunk-start 1 `
  --chunk-limit 2 `
  --delay 0
```

如果显存不足，把 `--batch-size 8` 改成 `--batch-size 4`。

## 拼接局部转写

快速摸底模式：

```powershell
python "E:\Codex\pokemon-champion\skills\pocket-ag-coach\scripts\build_partial_transcript.py" `
  --bvid BV1ufDwBEEnM `
  --model tiny `
  --device cuda `
  --compute-type float16 `
  --batch-size 8 `
  --chunk-seconds 600
```

正式抽取模式：

```powershell
python "E:\Codex\pokemon-champion\skills\pocket-ag-coach\scripts\build_partial_transcript.py" `
  --bvid BV1ufDwBEEnM `
  --model small `
  --device cuda `
  --compute-type float16 `
  --batch-size 8 `
  --chunk-seconds 600
```

## 抽取个体分析证据

```powershell
python "E:\Codex\pokemon-champion\skills\pocket-ag-coach\scripts\extract_individual_analysis.py" `
  --bvid BV1ufDwBEEnM `
  --path "audio-transcripts/BV1ufDwBEEnM.partial.txt" `
  --title "《宝可梦冠军》给大家推荐一些好用的宝可梦"
```

## 刷新进度面板

```powershell
python "E:\Codex\pokemon-champion\skills\pocket-ag-coach\scripts\build_progress_report.py"
```

打开：

```text
E:\Codex\pokemon-champion\skills\pocket-ag-coach\references\progress-dashboard.html
```

## 推荐工作流

1. 用 `tiny` 每次跑 4 个 10 分钟 chunk。
2. 拼接 partial transcript。
3. 抽取 individual analysis。
4. 刷新进度面板。
5. 对命中“推荐/配置/队友/克制/Mega”的高价值片段，再用 `small` 重跑。

这样不会被 5 小时 36 分钟长视频卡死，也不会为了完整转写浪费太多等待时间。
