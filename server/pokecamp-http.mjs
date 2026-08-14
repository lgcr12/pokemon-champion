// PokéCamp HTTP direct-fetch pipeline.
//
// The site serves its whole dataset as static JSON files behind Cloudflare CDN
// (cf-cache-status: HIT). This module downloads those files with a browser-like
// HTTP client and reuses the existing normalize/merge pipeline
// (pokecamp-teams.mjs) so the result is identical in shape to what the
// Playwright crawler imports — without opening a browser or requiring a human
// Cloudflare verification. The switch that selects this path over the browser
// is `pokecampMonitorState.bypassCf` in server.mjs.
//
// Data sources (verified 2026-08, regulation M-B):
//   /data/zh/champions/regulations/{reg}/vgc-teams.json        VGC team list
//   /data/zh/champions/regulations/{reg}/vgc-team-details.json full per-pokemon configs keyed by team id
//   /data/zh/champions/regulations/{reg}/team-builds.json      team-build list (members + items + team moves)
//   /data/zh/champions/team-build-details/{id}.json            per-build full configs (no regulation segment)
//   /data/zh/champions/regulations/{reg}/vgc-teams-page.json   pagination / stats (not imported)

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { normalizePokecampPayload, mergePokecampTeams } from "./pokecamp-teams.mjs";

const TEAM_DATA_PATH = fileURLToPath(new URL("../data/team-data.json", import.meta.url));
const POKECAMP_ORIGIN = "https://pokecamp.cc";
const POKECAMP_TEAM_URL = "https://pokecamp.cc/zh/champions/vgc-teams";
const POKECAMP_BUILD_URL = "https://pokecamp.cc/zh/champions/team-builds";

// Same-origin static assets: browser-like headers are enough today, and keep
// the requests looking like the site's own XHR traffic.
const HTTP_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  Referer: "https://pokecamp.cc/zh/champions/vgc-teams",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(path, { retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${POKECAMP_ORIGIN}${path}`, {
        headers: HTTP_HEADERS,
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} (${path})`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastError;
}

const STAT_NAMES = { HP: "HP", Atk: "攻击", Def: "防御", SpA: "特攻", SpD: "特防", Spe: "速度" };

// "20 HP / 32 Def / 10 SpA / 4 Spe" or "HP:16 / 攻击:25 / 速度:25"
// -> repo convention "HP 20 / 防御 32 / 特攻 10 / 速度 4"
function statPointsToStats(value = "") {
  const pairs = [...String(value || "").matchAll(/(HP|Atk|Def|SpA|SpD|Spe|攻击|防御|特攻|特防|速度)\s*[:：]?\s*(\d+)/g)];
  return pairs.map((match) => `${STAT_NAMES[match[1]] || match[1]} ${match[2]}`).join(" / ");
}

function spriteUrl(path = "") {
  const value = String(path || "").trim();
  if (!value) return "";
  return value.startsWith("http") ? value : `${POKECAMP_ORIGIN}${value}`;
}

function mapVgcTeam(team = {}, detailsByTeam = {}) {
  const source = team.source || {};
  const configs = Array.isArray(detailsByTeam[team.id]) ? detailsByTeam[team.id] : [];
  return {
    title: team.playerName || source.replicaCode || team.tournament?.name || team.id || "PokéCamp VGC 队伍",
    href: source.pasteUrl || source.url || POKECAMP_TEAM_URL,
    sourceUrl: source.pasteUrl || source.url || POKECAMP_TEAM_URL,
    rentalCode: source.replicaCode || "",
    author: team.playerName || "",
    pokemon: (team.pokemon || []).map((pokemon) => ({
      slug: pokemon.identifier,
      name: pokemon.displayName,
      localizedName: pokemon.displayName,
      sprite: spriteUrl(pokemon.sprite),
      item: pokemon.item,
    })),
    configurations: configs.map((config, index) => {
      const member = team.pokemon?.[index] || {};
      const preMegaAbility = config.preMegaAbility || "";
      const finalAbility = config.ability || "";
      const abilities = [preMegaAbility, finalAbility].filter((value, abilityIndex, list) => value && list.indexOf(value) === abilityIndex);
      return {
        slug: member.identifier || "",
        name: member.displayName || member.identifier || "",
        localizedName: member.displayName || "",
        item: config.item || member.item || "",
        ability: abilities.join(" → "),
        preMegaAbility,
        finalAbility,
        nature: config.nature || "",
        stats: statPointsToStats(config.statPoints),
        moves: Array.isArray(config.moves) ? config.moves : [],
        teraType: config.teraType || undefined,
      };
    }),
    detailStatus: configs.length ? "COMPLETE" : "PENDING",
  };
}

function mapBuildMember(pokemon = {}) {
  return {
    slug: pokemon.identifier,
    name: pokemon.displayName,
    localizedName: pokemon.displayName,
    sprite: spriteUrl(pokemon.sprite),
    item: pokemon.itemName || pokemon.item?.displayName || pokemon.itemIdentifier || "",
  };
}

function mapBuildDetailConfigurations(pokemonList = []) {
  return pokemonList.map((pokemon) => ({
    slug: pokemon.identifier || "",
    name: pokemon.displayName || pokemon.identifier || "",
    localizedName: pokemon.displayName || "",
    item: pokemon.item?.displayName || pokemon.itemName || "",
    ability: pokemon.ability?.displayName || pokemon.abilityName || "",
    nature: pokemon.nature?.displayName || pokemon.natureName || "",
    stats: statPointsToStats(pokemon.statPoints),
    moves: (pokemon.moves || []).map((move) => move.displayName || move.identifier).filter(Boolean),
    notes: pokemon.description ? [pokemon.description] : [],
  }));
}

function readTeamDataDocument() {
  try {
    return JSON.parse(readFileSync(TEAM_DATA_PATH, "utf8"));
  } catch {
    return { season: "", availableSeasons: [], teams: [] };
  }
}

// Fetch one source type over plain HTTP, normalize through the same pipeline
// the browser crawler uses, merge into data/team-data.json, and report the
// same counters the monitor UI displays (scanned / added / updated / details).
// `dryRun: true` performs the fetch and merge in memory without writing.
export async function syncPokecampHttp(options = {}) {
  const sourcePageType = String(options.sourcePageType || "vgc-teams").trim();
  const season = String(options.season || "M-B").trim();
  const regulation = String(options.regulation || season || "M-B").trim();
  const format =
    options.format === "single" || options.format === "double"
      ? options.format
      : sourcePageType.includes("single")
        ? "single"
        : "double";
  const withBuildDetails = options.withBuildDetails ?? sourcePageType.startsWith("team-builds");
  const segment = String(regulation).toLowerCase();

  try {
    let teams = [];
    let detailsCount = 0;

    if (sourcePageType === "vgc-teams") {
      const [list, detailsByTeam] = await Promise.all([
        fetchJson(`/data/zh/champions/regulations/${segment}/vgc-teams.json`),
        fetchJson(`/data/zh/champions/regulations/${segment}/vgc-team-details.json`),
      ]);
      teams = (Array.isArray(list) ? list : []).map((team) => mapVgcTeam(team, detailsByTeam || {}));
      detailsCount = teams.filter((team) => team.detailStatus === "COMPLETE").length;
    } else if (sourcePageType.startsWith("team-builds")) {
      const doc = await fetchJson(`/data/zh/champions/regulations/${segment}/team-builds.json`);
      const wantSingle = sourcePageType === "team-builds-single";
      const list = (Array.isArray(doc?.builds) ? doc.builds : []).filter((build) => {
        const raw = String(build.battleFormat || "").toLowerCase();
        return wantSingle ? /single|bss/.test(raw) : /double|vgc/.test(raw);
      });
      for (const build of list) {
        const entry = {
          title: build.title || String(build.id || ""),
          href: build.sourceUrl || POKECAMP_BUILD_URL,
          sourceUrl: build.sourceUrl || POKECAMP_BUILD_URL,
          author: build.author || "",
          pokemon: (build.pokemon || []).map(mapBuildMember),
          detailStatus: "PENDING",
        };
        if (withBuildDetails) {
          // Per-build details live outside the regulations folder.
          const detail = await fetchJson(
            `/data/zh/champions/team-build-details/${encodeURIComponent(String(build.id))}.json`,
            { retries: 1 },
          ).catch(() => null);
          if (detail && Array.isArray(detail.pokemon) && detail.pokemon.length) {
            entry.configurations = mapBuildDetailConfigurations(detail.pokemon);
            entry.strategy = detail.strategy || "";
            entry.description = detail.introduction || "";
            entry.detailStatus = "COMPLETE";
            detailsCount += 1;
          }
          await sleep(120); // gentle pacing; the list has ~360 builds
        }
        teams.push(entry);
      }
    } else {
      return { ok: false, sourcePageType, error: `未知来源类型：${sourcePageType}` };
    }

    const imported = normalizePokecampPayload({ teams }, { sourcePageType, format, season, regulation });
    imported.teams = imported.teams.map((team) => ({ ...team, sourceVersion: "pokecamp-http-v1" }));
    const document = readTeamDataDocument();
    const merged = mergePokecampTeams(document, imported);
    if (!options.dryRun) {
      await writeFile(TEAM_DATA_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    }

    return {
      ok: true,
      source: "Pokecamp",
      sourcePageType,
      format,
      season,
      regulation,
      dryRun: Boolean(options.dryRun),
      imported: merged.imported,
      totalTeams: merged.teams.length,
      formats: {
        single: merged.teams.filter((team) => team.format === "single").length,
        double: merged.teams.filter((team) => team.format === "double").length,
      },
      crawl: { teams: imported.teams.length, details: detailsCount },
      preview: { teams: imported.teams.length, details: detailsCount, sourcePageType, regulation },
    };
  } catch (error) {
    return { ok: false, sourcePageType, error: error.message || "HTTP 同步失败" };
  }
}
