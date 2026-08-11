# Pocket AG Distillation v0.7

## Update v0.8 - Individual Card Layer
- `BV1ufDwBEEnM` has now been transcribed across 34/34 cached 600-second chunks.
- `individual-analysis-log.json` contains 518 tagged snippets from the critical individual Pokemon recommendation source.
- `individual-pokemon-cards.json` is the first structured v0 card library for product use:
  - 105 cards
  - 11 cards with direct matched AG evidence
  - 7 cards with curated AG summaries
  - 11 high-confidence cards
  - 39 cards with Mega forms
  - 62 unassigned evidence clusters that still need manual Pokemon assignment
- Current high-confidence examples include Charizard, Salamence, Garchomp, Dragonite, Heracross, Venusaur, Gengar, Manectric, Grimmsnarl, Amoonguss, and Dondozo.
- Treat Champion usage/rank/team data in these cards as environment context, not as direct AG claims.
- Treat medium/low cards as draft evidence until manually reviewed.

Data status: Bilibili metadata plus sampled subtitle evidence.
Collected from Pocket AG Bilibili space `343348`.

## Target Format Boundary
- Primary target format: Pokemon Champions.
- Team-building, scoring, Mega-slot judgment, speed plans, and matchup explanations must follow Pokemon Champions environment and rules.
- VGC evidence is retained as transferable battle theory only: speed control, Protect tempo, switching, support conversion, and lead/positioning concepts.
- Do not turn VGC-only assumptions into Pokemon Champions rules unless a Pokemon Champions source independently supports the same behavior.

## Indexed Corpus
- 2026 official events / VGC commentary: 87 indexed videos
- Pokemon Champions battles: 21 indexed videos
- Pokemon Champions meta analysis: 10 indexed videos
- Scarlet/Violet usage analysis: 90 indexed videos
- Total indexed videos: 208

## Critical Source Notes
- Critical primary collection: `宝可梦冠军` season, 21 videos. Use this as the main Pokemon Champions environment and battle corpus.
- Critical reference collection: `2026年官方比赛大全`, 87 videos. Use as battle-theory reference only, not as Pokemon Champions rules.
- Critical individual-analysis source: `BV1ufDwBEEnM` / `《宝可梦冠军》给大家推荐一些好用的宝可梦`, 2026-04-04, 5h36m. This is the main long-form source for individual Pokemon recommendation and usage logic.
- `BV1ufDwBEEnM` has no public subtitle; low-bitrate audio has been downloaded and should be transcribed in 10-minute chunks before v1.0.

## Subtitle Evidence Status
- Transcript fetch records: 33 videos
- Usable transcript samples: 21 videos
  - public subtitle transcripts: 20
  - audio-transcribed transcripts: 1
- Current fetch statuses:
  - ok: 21
  - error: 6
  - no public subtitle: 6
- Extracted evidence snippets: see `evidence-log.json`
- Evidence tags found:
  - speed-control: 452
  - support: 300
  - protect: 277
  - endgame: 169
  - switching: 121
  - team-axis: 83
  - lead-choice: 54
  - focus-fire: 55
  - mega-slot: 9

## Evidence-Backed Coaching Rules

### 1. Start from Pokemon Champions team axis, not isolated strength
Evidence: VGC commentary samples identify team structures first, then map enablers such as screens, Tailwind, support Volcarona, or offensive backline.

Rule:
- First name the Pokemon Champions structure: Mega-centered offense, weather, speed-control offense, bulky balance, disruption balance, setup route, or matchup-patch route.
- Then explain which Pokemon enables which teammate.
- Do not rate a Pokemon as strong without naming its job in the team chain.
- If the evidence is from VGC, re-check whether the same structure exists in Pokemon Champions before using it in scoring.

### 2. Opening plan follows enabling responsibility
Evidence: In `BV15x4DzQEEc` around 181.96s, Grimmsnarl is treated as a likely lead because it is the screen setter.

Rule:
- In Pokemon Champions, the opening plan should expose or preserve the key enabler for screens, speed control, weather, disruption, or Mega safe entry.
- If applying VGC lead logic, translate it into Pokemon Champions opening-route logic rather than assuming a VGC-style lead pair.
- If the opponent changes lead between games, evaluate whether they are adapting before repeating the same line.

### 3. Speed control is a board plan, not just a move
Evidence: Multiple subtitle snippets discuss Tailwind, Trick Room, speed, and support combinations such as Tailwind plus Rage Powder or screens.

Rule:
- Ask who sets speed control, who benefits, and what protects the setup turn.
- Tailwind/Trick Room must connect to damage or board control.
- If both active Pokemon are support, identify the damage conversion plan behind them.

### 4. Protect and defensive turns are part of damage conversion
Evidence: Extracted snippets repeatedly mention Protect, predicting focus fire, and double-targeting into likely Protect turns.

Rule:
- In doubles, treat Protect as tempo, information, and bait, not as a passive move.
- If the opponent is likely to focus-fire a key Pokemon, Protect or switching can convert that attack into a wasted turn.
- When attacking, judge whether double-targeting is worth the Protect risk.

### 5. Support value depends on what it enables
Evidence: Snippets identify support Volcarona, Grimmsnarl, Incineroar-style tools, and the risk of too many support pieces reducing output.

Rule:
- Value support by the concrete turn it creates: Fake Out, screens, Intimidate, redirection, Parting Shot, Tailwind, status, or disruption.
- Penalize teams where multiple support Pokemon occupy the board without damage conversion.
- Prankster-style support gets a small boost only when it directly enables the main line.

### 6. Move slots should answer real board problems
Evidence: In `BV15x4DzQEEc` around 114.57s, Vacuum Wave is discussed as priority and coverage for a concrete matchup.

Rule:
- Evaluate the fourth move by matchup utility, priority, coverage, endgame cleanup, or disruption.
- Reject cosmetic coverage that does not change an important matchup.

### 7. Switching is board reconstruction
Evidence: Snippets mention direct switches and double switches into backline pieces.

Rule:
- In doubles, switching resets positioning, ability pressure, board pairings, and endgame resources.
- Track backline assumptions before judging whether a switch is safe.

### 8. Mega slot is a win-condition resource
Evidence: Champions/Mega corpus contains many Mega-centered battles and usage analyses, but sampled subtitles still mention Mega directly less often than speed/protect/support topics.

Rule:
- Treat Mega as a main or secondary win condition slot.
- Require an explanation for safe entry, speed support, matchup coverage, and endgame use.
- Usually identify at least one Mega candidate when the format allows Mega.
- Two Mega candidates are acceptable only when they represent different matchup routes or one is a real backup plan.
- Do not add a Mega just to satisfy a checklist.

### 9. Trick Room should not be clicked blindly
Evidence: In `BV12YowBoEnk`, he says not to open Trick Room directly; deal damage first and open Trick Room when its turns are useful.

Rule:
- Count Trick Room turns as scarce.
- If immediate Trick Room does not win enough turns, use damage, Fake Out, Taunt pressure, or positioning first.

### 10. Simple teams are valuable when their sequence is clear
Evidence: In `BV16A5a6hE1v`, a simple Tailwind team is described by clear lead/backline sequencing.

Rule:
- A team can be good because its execution path is simple and repeatable.
- Prefer clear lead/backline sequencing when coaching newer players.
- Still check what happens if the opponent blocks the first speed-control turn.

### 11. Check opponent support answers before committing
Evidence: `BV12YowBoEnk` calls out Taunt, Fake Out, Wide Guard, Protect, and similar answers to Trick Room or offensive plans.

Rule:
- Before Tailwind, Trick Room, spread moves, or setup, scan for Taunt, Fake Out, Wide Guard, Protect, Intimidate, and redirection.
- If the opponent has a direct answer, use bait, switch, double target, or an alternate line first.

### 12. Define the Pokemon's job before choosing the set
Evidence: In `BV1Jv4y1y7wY` around 751s, Meowscarada is framed as a fast physical attacker. Around 758-775s, it is described as flexible rather than locked to rain, sun, or another fixed system.

Rule:
- Classify the job first: independent attacker, system attacker, speed-control setter, defensive pivot, support/disruptor, or matchup patch.
- If it is independent, do not force a weather/terrain/core label.
- If it is system-dependent, require the enabling teammate and turn sequence before calling it usable.

### 13. Team fit includes opportunity cost
Evidence: In `BV1Jv4y1y7wY` around 796-805s, Meowscarada is valued because it hits hard while not consuming an important team resource slot another teammate may need.

Rule:
- Evaluate fit by both synergy and opportunity cost.
- A Pokemon can be valuable because it contributes while leaving scarce resources for the real core.
- Avoid giving the flexible slot a resource the main win condition needs more.

### 14. Fast attackers should keep their speed identity
Evidence: In `BV1Jv4y1y7wY` around 553-592s and 684-688s, high speed plus physical attack is treated as Meowscarada's simple default identity.

Rule:
- Preserve speed tier on naturally fast attackers unless a concrete survival benchmark changes a matchup.
- Do not add bulk "because bulk is nice"; name the attack survived or the extra turn enabled.
- Speed benchmarks should say who is being outrun.

### 15. Fake Out and speed-control support are not equivalent
Evidence: In `BV1Jv4y1y7wY` around 296-321s, Fake Out is contrasted with Trick Room support and appears more directly useful for a very fast Pokemon.

Rule:
- Judge support moves by the turns they create for the Pokemon's role.
- Fast attackers often prefer immediate tempo tools like Fake Out, priority, or disruption over slower structural support.
- Do not count a support move as synergy unless it serves the actual speed and damage plan.

### 16. Move templates need a flexible patch slot
Evidence: In `BV1Jv4y1y7wY` around 1224-1238s, STAB moves plus Protect are stable while the final move is open to priority, Taunt, or Trick Room depending on need.

Rule:
- Build sets as core identity moves plus one patch slot.
- Core moves express identity; patch moves answer the environment.
- In a product UI, explain the patch slot as "why this fourth move exists".

### 17. Usage rate is evidence, not proof
Evidence: In `BV1FRdpBgEmq` and `BV1em9CBmEzr`, usage rate and type distribution introduce why a Pokemon matters, then the analysis moves into stats, speed, typing, protection, and role.

Rule:
- Use usage rate to decide what deserves attention, not what is automatically good.
- After popularity is noted, still evaluate typing, speed tier, defensive liabilities, required support, and matchup contribution.
- Product scoring should separate "meta presence" from "team fit".

### 18. Mega game plans still need normal tempo checks
Evidence: Audio transcription for `BV1GGoXB5ENF` adds a Mega-focused Champions battle. The extracted snippets repeatedly mention weather exchange, Tailwind, Encore, Protect, switching, speed comparison, and chip damage / HP-line pressure.

Rule:
- Do not evaluate a Mega plan as "big damage only".
- Even when the Mega attacker is the headline, still check speed control, weather control, Protect turns, Encore/disruption, and whether chip damage creates the KO line.
- Mega-centered teams should explain how the Mega wins tempo, not only how hard it hits.

## Format Split

### Pokemon Champions
- Treat this as the default format.
- Emphasize Mega-slot value, team-axis clarity, speed tier, weather/control interaction, safe entry, setup denial, switching routes, and endgame cleanup.
- Mega choice can be a central breaker, cleaner, defensive pivot, or matchup patch, but must not steal support from the actual win route.
- When using data from Scarlet/Violet or VGC videos, only import the reasoning pattern after translating it into Pokemon Champions mechanics and environment.

### VGC / Doubles Reference
- Emphasize lead pair, speed-control turn, Fake Out / Protect / redirection, board damage, and backline sequencing.
- Support and Prankster-style disruption are more valuable when they create a safe turn for the real attacker.
- Protect, switching, and double targets should be evaluated as tempo exchanges.
- Use this section as reference material, not as the default team-building rule set.

## Current Limitations
- Many decision snippets still come from VGC commentary; those are lower-priority evidence for Pokemon Champions unless corroborated by Champions videos.
- Pokemon Champions Mega-specific rules are improving through audio transcription, but one audio-transcribed battle is not enough for v1.0.
- Some usage-analysis videos include off-topic openings or analogies, so evidence extraction must be manually filtered before turning snippets into rules.
- Some Bilibili videos have no subtitle or temporary request errors; do not repeatedly hammer those endpoints.
- Local `faster-whisper small` transcription is usable but imperfect for Pokemon names; manually curate high-value snippets before treating them as strong evidence.

## Next Upgrade To v1.0
- Segment-transcribe `BV1ufDwBEEnM` and curate individual Pokemon recommendations by role, item/ability/move template, team fit, speed needs, and matchup warnings.
- Add audio transcription for at least 5 high-value Pokemon Champions / Mega videos with no public subtitle.
- Add at least 10 Champions battle clips with team-axis and win-route explanations.
- Add more usage-analysis clips focused on item, ability, teammate, and move-slot logic.
- Add a curated `examples.jsonl` with manually accepted snippets and rejected noisy snippets.
