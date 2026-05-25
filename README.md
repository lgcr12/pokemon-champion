# PokéForge Lab

**A competitive Pokémon team forge that turns live meta data into editable teams, matchup plans, PKHeX-friendly exports, and AI-assisted builds.**

![PokéForge Lab preview](docs/preview.svg)

PokéForge Lab is a browser-based team building dashboard for Pokémon Champions-style competitive research. It combines local cached usage data, public team examples, direct set editing, Showdown export, and optional AI team advice through OpenAI-compatible APIs or Cockpit local access.

## Highlights

- Build teams from current single/double usage rankings.
- Import public teams from `pokemon-teams.pages.dev`.
- Edit each Pokémon set directly: item, ability, nature, EVs, IVs, Tera Type, level, gender, ball, language, shiny, and moves.
- Export Showdown text for PKHeX-compatible workflows and many bot formats.
- Export/import local JSON drafts.
- Auto-save the current team in `localStorage`.
- Generate matchup plans from actual team structure instead of static templates.
- Detect practical rule issues: duplicate items, multiple Mega stones, EV overflow, missing abilities/items/moves, and incomplete export fields.
- Show speed threats, type spread, role tags, common sets, and opponent archetype risks.
- Optional AI advice for single and double teams with separate recommendations.
- Interactive side Pokémon: hover/click to preview and add Pokémon to the team.
- One-click cache refresh with progress bar.
- First launch auto-fetches missing data.

## Quick Start

Requires Node.js 18+.

```bash
npm install
npm run start:ai
```

Open:

```text
http://127.0.0.1:4174
```

On first launch, if `data/champion-data.json` or `data/team-data.json` is missing, the server starts a missing-data fetch automatically. The page displays a progress bar until usable data is ready.

## Data Refresh

Use the **补缺/队伍** button in the top bar.

It runs a fast refresh:

- fills only missing Pokémon details;
- reuses existing cached data;
- fetches public teams in fast mode;
- reloads local JSON after completion;
- shows progress in the top bar.

Manual commands:

```bash
npm run fetch:data
npm run fetch:teams
npm run fetch:missing-all
npm run fetch:all
```

Useful environment variables:

```bash
# PowerShell examples
$env:SEASON="M-2"
$env:FORMATS="single,double"
$env:LIMIT="120"
$env:MISSING_ONLY="1"
$env:TEAM_LIMIT="300"
$env:ENRICH_TEAMS="0"
npm run fetch:missing-all
```

## AI Setup

PokéForge Lab supports two AI routes:

1. Cockpit local access fallback, read from:

```text
~/.antigravity_cockpit/codex_local_access.json
```

2. OpenAI-compatible environment variables:

```bash
$env:OPENAI_API_KEY="your_api_key"
$env:OPENAI_MODEL="gpt-4.1-mini"
$env:OPENAI_BASE_URL="https://api.openai.com"
npm run start:ai
```

The app endpoint is:

```text
POST /api/team-advice
```

## Data Sources

- Usage data: [PokéCham DB](https://pokechamdb.com/zh-Hans)
- Public team library: [pokemon-teams.pages.dev](https://pokemon-teams.pages.dev/)
- Tweet/X expansion when full enrichment is enabled: `api.fxtwitter.com`

If X/Twitter-related data cannot be fetched, the app reports the likely cause in the refresh status. Common reason: your network cannot access X/Twitter or `fxtwitter` without a proxy. Fast team mode avoids heavy X enrichment and still imports the basic public team list.

## Tech Stack

- Frontend: vanilla HTML, CSS, and JavaScript modules
- Backend: Node.js HTTP server
- Data cache: local JSON files in `data/`
- Fetch scripts: Node.js `fetch`
- AI protocol: OpenAI-compatible `/v1/responses`
- No build step required

## Project Structure

```text
.
├─ app.js                    # Frontend app logic
├─ index.html                # App shell
├─ styles.css                # UI, layout, interaction styles
├─ server.mjs                # Static server, AI proxy, refresh API
├─ scripts/
│  ├─ fetch-data.mjs         # Usage/meta scraper
│  └─ fetch-teams.mjs        # Public team scraper
├─ data/
│  ├─ champion-data.json     # Local usage cache
│  └─ team-data.json         # Local public team cache
└─ docs/
   └─ preview.svg            # README preview image
```

## Deployment Notes

Run the Node server, not the static-only script, if you want automatic data fetch and AI support:

```bash
npm run start:ai
```

Static hosting can serve the UI and existing JSON files, but cannot:

- auto-fetch missing data;
- refresh cached data from the page;
- proxy AI requests.

## Legal and Safety Notes

PokéForge Lab exports editable team text and local drafts. It does not bypass game legality checks, create save files, or automate online trading. Use PKHeX or your target ruleset to verify legality before using exported teams anywhere else.
