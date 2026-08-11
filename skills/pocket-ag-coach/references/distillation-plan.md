# Pocket AG Distillation Plan

## Source priorities
1. Pocket AG Bilibili videos from:
   - `https://space.bilibili.com/343348/lists`
   - `https://space.bilibili.com/343348/upload/video`
2. Pocket AG own posts, captions, and team reports
3. Reliable summaries and battle discussions
4. Fan inferences only as weak support

## Priority series
- 2026vgc比赛解说
- 宝可梦冠军对战
- 宝可梦冠军热门分析
- 宝可梦冠军mega
- 对战精灵用法分析

## Pagination rule
When a video list has multiple pages, log every page URL or page number that was checked.
Do not treat the first page as complete coverage.

## Sample record fields
- source_url
- page_number
- date
- format
- scene
- decision
- reason
- evidence_timestamp
- confidence
- tags

## Extraction questions
- What is the win condition?
- What is the backup route?
- Why is this Mega slot chosen?
- What creates safe turns?
- How is speed controlled?
- How is the endgame closed?
- What differs between singles and doubles?
- Why is this support option valued?

## Output shape
Write distilled rules as:
`when -> do -> why`
