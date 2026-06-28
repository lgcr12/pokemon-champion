import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const SEARCH_URL = "https://pokemon-teams.pages.dev/search";
const GAMEWITH_BASE_URL = "https://gamewith-tool.s3.ap-northeast-1.amazonaws.com/pokemon-champions";
const GAMEWITH_ARTICLE_URL = "https://gamewith.jp/pokemon-champions/560474";
const OPGG_REPLICA_URL = "https://op.gg/zh-cn/pokemon-champions/replica-teams";
const CHAMPION_DATA_FILE = "data/champion-data.json";
const OUT_FILE = "data/team-data.json";
const TEAM_LIMIT = Number(process.env.TEAM_LIMIT || 900);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 350);
const DETAIL_LIMIT = Number(process.env.DETAIL_LIMIT || TEAM_LIMIT);
const ENRICH_TEAMS = process.env.ENRICH_TEAMS !== "0";
const GAMEWITH_SEASONS = (process.env.GAMEWITH_SEASONS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const OPGG_FORMATS = (process.env.OPGG_FORMATS || "DOUBLE,SINGLE")
  .split(",")
  .map((item) => item.trim().toUpperCase())
  .filter(Boolean);
const OPGG_PAGE_LIMIT = Number(process.env.OPGG_PAGE_LIMIT || 20);

const headers = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveSeason() {
  if (process.env.TEAM_SEASON) return process.env.TEAM_SEASON;
  try {
    const data = JSON.parse(await readFile(CHAMPION_DATA_FILE, "utf8"));
    return data.season || data.formats?.single?.season || data.formats?.double?.season || "";
  } catch {
    return "";
  }
}

function buildBaseUrl(season = "") {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("format", process.env.TEAM_FORMAT || "all");
  if (season) url.searchParams.set("season", season);
  return url.toString();
}

function decodeEntities(value = "") {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("<!-- -->", "")
    .trim();
}

async function fetchText(url, retries = 4) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res.text();
      lastError = new Error(`Fetch failed ${res.status}: ${url}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await sleep(900 * (attempt + 1));
  }
  throw lastError;
}

async function fetchJson(url, retries = 4) {
  return JSON.parse(await fetchText(url, retries));
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function knownValue(value = "") {
  const text = String(value || "").trim();
  return text && !["不明", "なし", "None", "-1"].includes(text) ? text : "";
}

function decodeFlight(html) {
  const chunks = [];
  const re = /<script>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
  for (const match of html.matchAll(re)) {
    try {
      chunks.push(JSON.parse(`"${match[1]}"`));
    } catch {
      chunks.push(match[1]);
    }
  }
  return chunks.join("");
}

function readJsonValue(text, key, opener, closer, startAt = 0) {
  const keyIndex = text.indexOf(key, startAt);
  if (keyIndex < 0) return "";
  let cursor = text.indexOf(opener, keyIndex);
  if (cursor < 0) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let end = cursor; end < text.length; end += 1) {
    const ch = text[end];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === opener) depth += 1;
    if (ch === closer) depth -= 1;
    if (depth === 0) return text.slice(cursor, end + 1);
  }
  return "";
}

function pageUrl(baseUrl, page) {
  const url = new URL(baseUrl);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

function extractPageCount(html) {
  const pages = [...html.matchAll(/page=(\d+)/g)].map((match) => Number(match[1]));
  return Math.max(1, ...pages.filter(Number.isFinite));
}

function pokemonIdFromSprite(sprite = "") {
  const match = sprite.match(/\/pokemon\/(\d+)\.png/);
  return Number(match?.[1] || 0);
}

function normalizeFormat(formatLabel = "") {
  const lower = formatLabel.toLowerCase();
  if (lower.includes("double")) return "double";
  return "single";
}

function stableId(team) {
  return createHash("sha1")
    .update(`${team.href}|${team.title}|${team.rentalCode || ""}|${team.members.map((member) => member.slug || member.id || member.name).join(",")}`)
    .digest("hex")
    .slice(0, 12);
}

function opggSlug(slug = "") {
  const text = String(slug || "").trim();
  const aliases = {
    "ninetales-alolan": "ninetales-alola",
    "mega-clefable": "clefable",
    "mega-victreebel": "victreebel",
    "mega-starmie": "starmie",
    "floette-eternal-flower": "floette",
    "maushold-family-of-four": "maushold",
    "maushold-family-of-three": "maushold",
    "basculegion-male": "basculegion",
    "mega-garchomp": "garchomp",
    "mega-venusaur": "venusaur-mega",
    "mega-raichu-y": "raichu",
    "mega-raichu-x": "raichu",
  };
  if (aliases[text]) return aliases[text];
  const mega = text.match(/^mega-(.+)$/);
  return mega ? `${mega[1]}-mega` : text;
}

function statSpread(stats = {}) {
  const labels = [
    ["hp", "H"],
    ["attack", "A"],
    ["defense", "B"],
    ["spAtk", "C"],
    ["spDef", "D"],
    ["speed", "S"],
  ];
  return labels
    .map(([key, label]) => (Number(stats[key]) > 0 ? `${label}${stats[key]}` : ""))
    .filter(Boolean)
    .join("/");
}

function tweetApiUrl(href = "") {
  const match = href.match(/x\.com\/([^/]+)\/status\/(\d+)/) || href.match(/twitter\.com\/([^/]+)\/status\/(\d+)/);
  if (!match) return "";
  return `https://api.fxtwitter.com/${match[1]}/status/${match[2]}`;
}

function absoluteUrl(url = "") {
  return url.replaceAll("&amp;", "&");
}

function dexNumberFromIcon(icon = "") {
  const match = String(icon).match(/\d+/);
  return Number(match?.[0] || 0);
}

function pokemonSprite(icon = "") {
  const dex = dexNumberFromIcon(icon);
  return dex ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${dex}.png` : "";
}

function statText(evs = []) {
  const labels = ["H", "A", "B", "C", "D", "S"];
  if (!Array.isArray(evs)) return "";
  return evs.map((value, index) => (Number(value) > 0 ? `${labels[index]}${value}` : "")).filter(Boolean).join("/");
}

function articleTextFromHtml(html = "") {
  const match =
    html.match(/<div class="entry-content[\s\S]*?<div class="social-buttons/) ||
    html.match(/<article[\s\S]*?<\/article>/) ||
    html.match(/<main[\s\S]*?<\/main>/);
  const source = match?.[0] || html;
  return decodeEntities(
    source
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<\/p>|<\/h\d>|<\/li>|<\/div>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " "),
  );
}

function extractArticleImages(html = "") {
  return [...html.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/g)]
    .map((match) => absoluteUrl(match[1]))
    .filter((url) => /pbs\.twimg\.com|cdn-ak\.f\.st-hatena\.com|blog-imgs|livedoor|ameba/.test(url));
}

function extractRentalCode(text = "") {
  const normalized = String(text).replace(/\s+/g, " ");
  const match =
    normalized.match(/(?:レンタル|チームID|公開ID|構築ID|コード)[^A-Z0-9]{0,24}([A-Z0-9]{6,8})/) ||
    normalized.match(/(?:rental code|team code|rental id|team id)[^A-Z0-9]{0,16}([A-Z0-9]{6,8})/i) ||
    normalized.match(/([A-Z0-9]{6,8})[^A-Z0-9]{0,16}(?:レンタル|チームID|公開ID|コード|rental code|team code)/i);
  return match?.[1] || "";
}

function splitMoves(value = "") {
  return value
    .split(/[　\s]+/)
    .map((move) => move.trim())
    .filter(Boolean);
}

function extractConfigsFromText(text = "", members = []) {
  const configs = [];
  for (const member of members) {
    const escaped = member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const startRe = new RegExp(`[・･]\\s*${escaped}\\s*@\\s*([^\\n　 ]+)(?:[　 ]+([^\\n]+))?`);
    const start = text.search(startRe);
    if (start < 0) continue;

    const rest = text.slice(start);
    const next = rest.slice(1).search(/\n[・･]\s*[^@\n]{2,24}\s*@/);
    const section = next > 0 ? rest.slice(0, next + 1) : rest.slice(0, 1800);
    const header = section.match(startRe);
    const moves = section.match(/技構成[：:]\s*([^\n]+)/)?.[1] || "";
    const stats = section.match(/\n(\d{2,3}\([^)]+\)[^\n]*|\d{2,3}-\d{2,3}[^\n]*)/)?.[1] || "";
    const notes = [...section.matchAll(/調整意図\s*\n([\s\S]*?)(?=\n[^・\n].{0,40}\n|$)/g)][0]?.[1] || "";

    configs.push({
      id: member.id,
      name: member.name,
      item: header?.[1] || "",
      ability: header?.[2]?.trim() || "",
      stats,
      moves: splitMoves(moves),
      notes: notes
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("・"))
        .slice(0, 4),
    });
  }
  return configs;
}

function extractPokePasteConfigs(html = "") {
  const articles = [...html.matchAll(/<article>([\s\S]*?)<\/article>/g)].map((match) => match[1]);
  return articles
    .map((article) => {
      const id = Number(article.match(/\/img\/pokemon\/(\d+)-/)?.[1] || 0);
      const pre = article
        .replace(/<br\s*\/?>/g, "\n")
        .replace(/<\/span>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/\r/g, "")
        .trim();
      const lines = pre.split("\n").map((line) => line.trim()).filter(Boolean);
      const header = lines[0]?.match(/^(.+?)\s*@\s*(.+)$/);
      const ability = lines.find((line) => line.startsWith("Ability:"))?.replace("Ability:", "").trim() || "";
      const evs = lines.find((line) => line.startsWith("EVs:"))?.replace("EVs:", "").trim() || "";
      const nature = lines.find((line) => / Nature$/.test(line)) || "";
      const moves = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
      if (!id && !header) return null;
      return {
        id,
        name: header?.[1] || "",
        item: header?.[2] || "",
        ability,
        stats: [evs, nature].filter(Boolean).join(" / "),
        moves,
        notes: [],
      };
    })
    .filter(Boolean);
}

async function fetchGameWithStructureData(season, format) {
  const fileName = `structure-data-${String(season).normalize("NFKC").trim().replace(/\s+/g, "_").replace(/[\\/:*?"<>|]/g, "_")}-${format}.json`;
  const updateUrl = `${GAMEWITH_BASE_URL}/${encodeURIComponent(fileName.replace(/\.json$/, "-update.json"))}`;
  const update = await fetchJson(updateUrl, 2).catch(() => null);
  const dataUrl = `${GAMEWITH_BASE_URL}/${encodeURIComponent(fileName)}${update?.lastUpdate ? `?v=${update.lastUpdate}` : ""}`;
  return fetchJson(dataUrl, 2);
}

async function fetchGameWithTeams(seasons) {
  const seasonList = Array.isArray(seasons) ? seasons.filter(Boolean) : [seasons].filter(Boolean);
  if (!seasonList.length) return [];
  const [pokemonMaster, itemMaster, abilityMaster, moveMaster, singleData, doubleData] = await Promise.all([
    fetchJson(`${GAMEWITH_BASE_URL}/master-pokemon.json`, 2),
    fetchJson(`${GAMEWITH_BASE_URL}/master-item.json`, 2),
    fetchJson(`${GAMEWITH_BASE_URL}/master-ability.json`, 2),
    fetchJson(`${GAMEWITH_BASE_URL}/master-move.json`, 2),
    Promise.all(seasonList.map((season) => fetchGameWithStructureData(season, "single").catch(() => []))).then((items) => items.flat()),
    Promise.all(seasonList.map((season) => fetchGameWithStructureData(season, "double").catch(() => []))).then((items) => items.flat()),
  ]);
  const pokemonById = new Map(pokemonMaster.map((item) => [String(item.id), item]));
  const itemById = new Map(itemMaster.map((item) => [String(item.id), item.n]));
  const abilityById = new Map(abilityMaster.map((item) => [String(item.id), item.n]));
  const moveById = new Map(moveMaster.map((item) => [String(item.id), item.n]));
  return [
    ...convertGameWithEntries(singleData, "single", seasonList, pokemonById, itemById, abilityById, moveById),
    ...convertGameWithEntries(doubleData, "double", seasonList, pokemonById, itemById, abilityById, moveById),
  ];
}

async function fetchOpggReplicaTeams(formats = OPGG_FORMATS) {
  const teams = [];
  for (const rawFormat of formats) {
    const first = await fetchOpggReplicaPage(rawFormat, 1);
    teams.push(...first.teams);
    const pageCount = Math.min(OPGG_PAGE_LIMIT, Math.max(1, Math.ceil(first.total / first.pageSize)));
    for (let page = 2; page <= pageCount; page += 1) {
      console.log(`Fetching OP.GG ${rawFormat} page ${page}/${pageCount}`);
      const next = await fetchOpggReplicaPage(rawFormat, page);
      teams.push(...next.teams);
      await sleep(REQUEST_DELAY_MS);
    }
  }
  return teams;
}

async function fetchOpggReplicaPage(rawFormat, page = 1) {
  const url = new URL(OPGG_REPLICA_URL);
  url.searchParams.set("battleFormat", rawFormat);
  if (page > 1) url.searchParams.set("page", String(page));
  const html = await fetchText(url.toString(), 3);
  const flight = decodeFlight(html);
  const rawTeams = readJsonValue(flight, '"teamCodes":', "[", "]");
  const total = Number(flight.match(/"initialTotalCount":(\d+)/)?.[1] || 0);
  const pageSize = Number(flight.match(/"pageSize":(\d+)/)?.[1] || 50);
  return {
    total,
    pageSize,
    teams: rawTeams ? convertOpggReplicaTeams(JSON.parse(rawTeams), rawFormat, url.toString()) : [],
  };
}

function convertOpggReplicaTeams(entries, rawFormat, sourceUrl) {
  const format = rawFormat === "DOUBLE" ? "double" : "single";
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => Array.isArray(entry.slots) && entry.slots.length >= 3)
    .map((entry) => {
      const members = entry.slots
        .map((slot) => {
          const slug = opggSlug(slot.pokemon);
          return {
            id: 0,
            slug,
            name: slug,
            sprite: `https://img.pokemondb.net/sprites/scarlet-violet/normal/${slug}.png`,
          };
        })
        .filter((member) => member.slug);
      const team = {
        href: sourceUrl,
        title: entry.title || `${entry.author?.nickname || "OP.GG"} #${entry.id}`,
        season: "M-2",
        format,
        formatLabel: rawFormat === "DOUBLE" ? "Double" : "Single",
        rate: 0,
        rank: Number(entry.id || 9999),
        source: "OP.GG Replica Teams",
        sourceLinks: [sourceUrl],
        social: {},
        rentalCode: knownValue(entry.teamId),
        author: entry.author?.nickname || "",
        members,
        configurations: entry.slots.map((slot) => ({
          id: 0,
          slug: opggSlug(slot.pokemon),
          name: opggSlug(slot.pokemon),
          item: knownValue(slot.item),
          ability: knownValue(slot.ability),
          nature: knownValue(slot.nature),
          stats: statSpread(slot.customStats),
          moves: (Array.isArray(slot.moves) ? slot.moves : []).map(knownValue).filter(Boolean).slice(0, 4),
        })),
        articleUrl: sourceUrl,
        createdAt: entry.createdAt || "",
        updatedAt: entry.updatedAt || "",
      };
      return { id: stableId(team), ...team };
    })
    .filter(Boolean);
}

function convertGameWithEntries(entries, format, season, pokemonById, itemById, abilityById, moveById) {
  const seasonSet = new Set(Array.isArray(season) ? season : [season].filter(Boolean));
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => (!seasonSet.size || seasonSet.has(entry.s)) && Array.isArray(entry.po) && entry.po.length >= 3)
    .map((entry) => {
      const members = entry.po
        .map((mon) => {
          const master = pokemonById.get(String(mon.id));
          const id = dexNumberFromIcon(master?.i);
          if (!master || !id) return null;
          return {
            id,
            name: master.n || String(mon.id),
            sprite: pokemonSprite(master.i),
          };
        })
        .filter(Boolean);
      if (members.length < 3) return null;
      const team = {
        href: entry.url || (entry.tw ? `https://x.com/${entry.tw}` : GAMEWITH_ARTICLE_URL),
        title: `${entry.un || "GameWith"} ${entry.r ? `#${entry.r}` : "Top"} Build`,
        season: entry.s || [...seasonSet][0] || "",
        format,
        formatLabel: format === "double" ? "Double" : "Single",
        rate: Number(entry.p || 0),
        rank: Number(entry.r || 0),
        source: "GameWith",
        sourceLinks: uniqueValues([entry.url, entry.tw ? `https://x.com/${entry.tw}` : "", entry.yt, entry.tc ? `https://www.twitch.tv/${entry.tc}` : ""]),
        social: {
          x: entry.tw ? `https://x.com/${entry.tw}` : "",
          youtube: entry.yt || "",
          twitch: entry.tc ? `https://www.twitch.tv/${entry.tc}` : "",
          twitcasting: entry.cs ? `https://twitcasting.tv/${entry.cs}` : "",
        },
        rentalCode: "",
        members,
        configurations: entry.po
          .map((mon) => {
            const master = pokemonById.get(String(mon.id));
            const id = dexNumberFromIcon(master?.i);
            if (!master || !id) return null;
            return {
              id,
              name: master.n || "",
              item: knownValue(itemById.get(String(mon.i))),
              ability: knownValue(abilityById.get(String(mon.a))),
              stats: statText(mon.e),
              moves: (Array.isArray(mon.mo) ? mon.mo : [])
                .map((moveId) => knownValue(moveById.get(String(moveId))))
                .filter(Boolean)
                .slice(0, 4),
            };
          })
          .filter(Boolean),
        articleUrl: entry.url || "",
      };
      return { id: stableId(team), ...team };
    })
    .filter(Boolean);
}

async function enrichTeam(team) {
  const apiUrl = tweetApiUrl(team.href);
  const existingArticleUrl = team.articleUrl || (team.href && !apiUrl ? team.href : "");
  if (!apiUrl && existingArticleUrl) {
    try {
      const html = await fetchText(existingArticleUrl, 1);
      const text = articleTextFromHtml(html);
      return {
        ...team,
        rentalCode: team.rentalCode || extractRentalCode(text),
        articleImages: team.articleImages || extractArticleImages(html).slice(0, 6),
      };
    } catch (err) {
      return { ...team, enrichError: err.message };
    }
  }
  if (!apiUrl) return team;

  try {
    const tweetRes = await fetchText(apiUrl, 2);
    const tweet = JSON.parse(tweetRes).tweet;
    const articleUrl =
      tweet?.raw_text?.facets?.find((facet) => facet.type === "url")?.replacement ||
      tweet?.text?.match(/https?:\/\/\S+/)?.[0] ||
      "";
    const media = tweet?.media?.all || [];
    const enriched = {
      ...team,
      tweetText: tweet?.text || "",
      media,
      articleUrl,
      rentalCode: team.rentalCode || "",
      configurations: team.configurations || [],
      articleImages: [],
    };

    if (articleUrl) {
      const html = await fetchText(articleUrl, 2);
      const text = articleTextFromHtml(html);
      enriched.rentalCode = extractRentalCode(text);
      const parsedConfigurations = articleUrl.includes("pokepast.es") ? extractPokePasteConfigs(html) : extractConfigsFromText(text, team.members);
      if (parsedConfigurations.length) enriched.configurations = parsedConfigurations;
      enriched.articleImages = extractArticleImages(html).slice(0, 6);
    }

    return enriched;
  } catch (err) {
    return {
      ...team,
      enrichError: err.message,
    };
  }
}

function parseCards(html) {
  const chunks = html.split('<div class="card-frame card-hover">').slice(1);
  return chunks
    .map((chunk) => {
      const start = html.indexOf(chunk);
      const before = html.slice(Math.max(0, start - 260), start);
      const href = decodeEntities(before.match(/<a href="([^"]+)"/)?.[1] || "");
      const title = decodeEntities(chunk.match(/<h3[^>]*>(.*?)<\/h3>/)?.[1] || "未命名队伍");
      const season = decodeEntities(chunk.match(/bg-sky-500 text-white"><span class="truncate">([^<]+)<\/span>/)?.[1] || "");
      const formatLabel = decodeEntities(chunk.match(/ring-1 ring-slate-200">([^<]+)<\/span>/)?.[1] || "");
      const rate = Number(chunk.match(/<span class="font-display text-base font-black[^>]*>([^<]+)<\/span>/)?.[1] || 0);
      const members = [...chunk.matchAll(/<div class="relative aspect-square rounded-lg bg-white" title="([^"]+)"><img alt="([^"]+)"[\s\S]*?src="([^"]+)"/g)]
        .map((match) => ({
          id: pokemonIdFromSprite(decodeEntities(match[3])),
          name: decodeEntities(match[1] || match[2]),
          sprite: decodeEntities(match[3]),
        }))
        .filter((member) => member.id);

      if (members.length < 3) return null;
      const team = {
        href,
        title,
        season,
        format: normalizeFormat(formatLabel),
        formatLabel: formatLabel || "Single",
        rate: rate || 0,
        members,
      };
      return { id: stableId(team), ...team };
    })
    .filter(Boolean);
}

async function main() {
  await mkdir("data", { recursive: true });
  const season = await resolveSeason();
  const baseUrl = buildBaseUrl(season);
  console.log(`Fetching teams from ${baseUrl}`);
  const firstHtml = await fetchText(pageUrl(baseUrl, 1));
  const pageCount = extractPageCount(firstHtml);
  const teams = parseCards(firstHtml);

  for (let page = 2; page <= pageCount && teams.length < TEAM_LIMIT; page += 1) {
    console.log(`Fetching team page ${page}/${pageCount}`);
    const html = await fetchText(pageUrl(baseUrl, page));
    teams.push(...parseCards(html));
    await sleep(REQUEST_DELAY_MS);
  }

  const unique = new Map();
  for (const team of teams) {
    if (!unique.has(team.id)) unique.set(team.id, team);
  }
  const seasonsToFetch = uniqueValues([season, ...GAMEWITH_SEASONS]);
  if (seasonsToFetch.length) {
    console.log(`Fetching GameWith top builds for ${seasonsToFetch.join(", ")}.`);
    const gameWithTeams = await fetchGameWithTeams(seasonsToFetch);
    for (const team of gameWithTeams) {
      if (!unique.has(team.id)) unique.set(team.id, team);
    }
  }
  console.log(`Fetching OP.GG replica teams for ${OPGG_FORMATS.join(", ")}.`);
  const opggTeams = await fetchOpggReplicaTeams();
  for (const team of opggTeams) {
    if (!unique.has(team.id)) unique.set(team.id, team);
  }

  let selected = [...unique.values()]
    .sort(
      (a, b) =>
        String(b.season || "").localeCompare(String(a.season || "")) ||
        Number(Boolean(b.rentalCode)) - Number(Boolean(a.rentalCode)) ||
        Number(a.rank || 9999) - Number(b.rank || 9999) ||
        Number(b.rate || 0) - Number(a.rate || 0),
    )
    .slice(0, TEAM_LIMIT);
  const source = uniqueValues([baseUrl, GAMEWITH_ARTICLE_URL, GAMEWITH_BASE_URL, OPGG_REPLICA_URL]).join(" / ");

  if (ENRICH_TEAMS) {
    for (let index = 0; index < Math.min(selected.length, DETAIL_LIMIT); index += 1) {
      console.log(`Enriching team ${index + 1}/${Math.min(selected.length, DETAIL_LIMIT)} ${selected[index].title}`);
      selected[index] = await enrichTeam(selected[index]);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const data = {
    source,
    fetchedAt: new Date().toISOString(),
    season,
    availableSeasons: uniqueValues([...unique.values()].map((team) => team.season)).sort().reverse(),
    total: unique.size,
    teams: selected,
  };

  await writeFile(OUT_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${data.teams.length} teams to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
