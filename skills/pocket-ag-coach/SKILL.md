---
name: pocket-ag-coach
description: Distill Bilibili creator Pocket AG's Pokemon team-building and battle reasoning into reusable coaching rules. Use when creating or updating a skill for his approach to team structure, Mega slots, synergy, speed control, singles vs doubles, lead selection, switching, protection, and support weighting.
---

# Pocket AG Coach

## Purpose
Distill Pocket AG's Pokemon judgment into two reusable layers:
- team-building understanding
- battle decision understanding

Default target format: Pokemon Champions. Treat Pokemon Champions rules, environment, Mega mechanics, and team structure as the primary domain. Use VGC commentary only as transferable battle-theory evidence after checking that the idea still makes sense under Pokemon Champions rules.

Treat this as a behavior skill, not a quote archive.

Before applying this skill, read `references/distillation.md`.
For individual Pokemon recommendation and set/team-fit evidence, read `references/individual-pokemon-cards.json` first and treat medium/low confidence cards as draft evidence that needs review.
For productized team-generation rules, read `references/coach-rules.json`; this is the compact rules layer injected into the local app server.
When updating the corpus, run `scripts/collect_bilibili_sources.py` and inspect `references/video-index.json`.

## What to extract
Capture how he thinks about:
- main win condition and backup line
- Mega slot choice and whether it is actually justified
- synergy between teammates
- speed structure and control
- safe entry, pivoting, protection, and endgame
- support weighting, especially disruption/support tools such as Prankster
- singles vs doubles differences

## Distillation workflow
1. Collect high-signal Bilibili examples first: `https://space.bilibili.com/343348/lists` and `https://space.bilibili.com/343348/upload/video`.
2. Focus on these series and topics:
   - Pokemon Champions battles
   - Pokemon Champions meta/popular analysis
   - Pokemon Champions Mega analysis
   - Pokemon Champions individual Pokemon recommendation / usage analysis
   - Pokemon Champions environment / rules / usage analysis
   - battle Pokemon usage analysis
   - 2026 VGC match commentary only for transferable concepts, not direct format rules
2. Label each sample by format, matchup state, and decision point.
3. Extract repeated rules in the form `when -> do -> why`.
4. Separate stable rules from one-off metagame calls.
5. Keep explicit boundaries for uncertainty and format-specific differences.

## Label set
Use these tags when annotating examples:
- team-axis
- backup-axis
- mega-slot
- synergy
- speed-control
- safe-entry
- pivot
- protect
- disruption
- support-priority
- singles
- doubles
- lead-choice
- switching
- endgame

## Skill output rules
When asked to apply the skill:
- default to Pokemon Champions unless the user explicitly requests another format
- prefer structure over raw power
- never force a Mega slot if it breaks synergy
- prefer team roles that connect into each other
- do not import VGC-only assumptions into Pokemon Champions output
- mark singles/doubles/VGC differences only when the requested format requires them
- slightly raise support/disruption value for Prankster-style helpers when the rest of the structure supports it

## Quality bar
A good output should explain:
- why this team exists
- why this team works together
- what fills the Mega role
- how the speed plan functions
- who creates safe turns
- how the endgame is closed
- which claims are Pokemon Champions-specific and which are only general battle-theory references

## References
Put sources, examples, and quality notes in `references/`.
Put reusable parsing or labeling helpers in `scripts/`.

## Source policy
Use video titles, descriptions, pinned comments, and on-screen explanation first.
Treat inferred behavior from replay lines as weaker than explicit commentary.
Keep page numbers, upload dates, and video URLs in the source log so multi-page uploads stay traceable.

Current corpus status:
- `references/video-index.json` indexes the Bilibili video corpus.
- `references/manual-sources.json` tracks user-confirmed critical sources, including the Pokemon Champions and VGC2026 collections plus `BV1ufDwBEEnM`.
- `references/distillation.md` contains current distillation notes.
- `references/individual-pokemon-cards.json` contains the v0 structured individual Pokemon card library built from `BV1ufDwBEEnM` plus local Pokemon Champions usage/team data.
- `references/coach-rules.json` contains the productized v0 coaching layer for Mega-slot logic, Prankster support weighting, synergy, speed control, singles/doubles split, and curated Pokemon rules.
- `references/progress-dashboard.html` is the visual progress dashboard and refreshes from `references/progress-report.json`.
- Do not overclaim exact Pocket AG decision rules unless timestamped clips or notes support them.
