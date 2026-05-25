import { mkdir, readFile, writeFile } from "node:fs/promises";

const BASE_URL = "https://pokechamdb.com/zh-Hans";
const FORMATS = (process.env.FORMATS || process.env.FORMAT || "single,double")
  .split(",")
  .map((format) => format.trim())
  .filter(Boolean);
const SEASON = process.env.SEASON || "M-2";
const LIMIT = Number(process.env.LIMIT || 220);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 650);
const MISSING_ONLY = process.env.MISSING_ONLY === "1";
const OUT_FILE = "data/champion-data.json";

const headers = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, retries = 6) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return res.text();
      lastError = new Error(`Fetch failed ${res.status}: ${url}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await sleep(1500 * (attempt + 1));
  }
  throw lastError;
}

function decodeEntities(value = "") {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("<!-- -->", "");
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

function extractRanking(html, targetFormat) {
  const cards = [];
  const re =
    /<a class="group[\s\S]*?href="\/zh-Hans\/pokemon\/([^"?]+)\?season=[^"]*?format=([^"&]+)[\s\S]*?<span[^>]*>(\d+)<\/span><img src="([^"]+)" alt="([^"]+)"[\s\S]*?<span[^>]*>([^<]+)<\/span><\/a>/g;

  for (const match of html.matchAll(re)) {
    const [, slug, format, rank, sprite, alt, name] = match;
    if (format !== targetFormat) continue;
    cards.push({
      rank: Number(rank),
      slug,
      name: decodeEntities(name || alt),
      sprite: decodeEntities(sprite),
    });
  }

  const unique = new Map();
  for (const card of cards) unique.set(card.slug, card);
  return [...unique.values()].sort((a, b) => a.rank - b.rank);
}

function extractUpdatedAt(html) {
  const match = html.match(/最后更新（中国时间）:\s*<!-- -->\s*([^<]+北京时间)/);
  return decodeEntities(match?.[1]?.trim() || "");
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

function extractEntries(flight, title) {
  const titleIndex = flight.indexOf(`"title":"${title}"`);
  if (titleIndex < 0) return [];
  const raw = readJsonValue(flight, '"entries":', "[", "]", titleIndex);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function extractDisplayNames(flight, title) {
  const titleIndex = flight.indexOf(`"title":"${title}"`);
  if (titleIndex < 0) return {};
  const raw = readJsonValue(flight, '"displayNames":', "{", "}", titleIndex);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function localizeEntries(entries, displayNames = {}) {
  return entries.map((entry) => ({
    rank: Number(entry.rank || 0),
    name: displayNames[entry.name] || entry.name,
    rawName: entry.name,
    percentage: Number(entry.percentage || 0),
    type: entry.type || "",
    category: entry.category || "",
  }));
}

function extractTypes(html) {
  const h1 = html.indexOf("<h1");
  const typeBlockStart = html.indexOf('class="mt-1.5 flex flex-wrap gap-1.5"', h1);
  const typeBlockEnd = html.indexOf("</div>", typeBlockStart);
  const block = html.slice(typeBlockStart, typeBlockEnd);
  return [...block.matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map((m) => decodeEntities(m[1]));
}

function extractStats(html) {
  const stats = {};
  const re =
    /<span class="w-14[^"]*">([^<]+)<\/span><span class="font-display[^"]*">(\d+)<\/span>/g;
  for (const match of html.matchAll(re)) {
    const label = decodeEntities(match[1]);
    if (["HP", "攻击", "防御", "特攻", "特防", "速度"].includes(label)) {
      stats[label] = Number(match[2]);
    }
  }
  return stats;
}

function extractPokemonId(html) {
  return Number(html.match(/No\.<!-- -->(\d+)/)?.[1] || 0);
}

function extractDetail(html, base) {
  const flight = decodeFlight(html);
  const panels = {};
  for (const title of ["招式", "道具", "特性", "性格", "队友"]) {
    panels[title] = localizeEntries(extractEntries(flight, title), extractDisplayNames(flight, title));
  }

  return {
    ...base,
    id: extractPokemonId(html),
    types: extractTypes(html),
    stats: extractStats(html),
    moves: panels["招式"],
    items: panels["道具"],
    abilities: panels["特性"],
    natures: panels["性格"],
    partners: panels["队友"],
  };
}

async function fetchFormat(format, existingFormat = null) {
  const listUrl = `${BASE_URL}?format=${format}&season=${SEASON}&view=pokemon`;
  const listHtml = await fetchText(listUrl);
  const ranking = extractRanking(listHtml, format).slice(0, LIMIT);
  if (!ranking.length) throw new Error(`No ranking entries found for ${format}.`);

  const cached = new Map((existingFormat?.pokemon || []).map((mon) => [mon.slug, mon]));
  if (MISSING_ONLY) {
    const existingPokemon = existingFormat?.pokemon || [];
    const existingBySlug = new Map(existingPokemon.map((mon) => [mon.slug, mon]));
    let missingCount = 0;
    for (const base of ranking) {
      const old = existingBySlug.get(base.slug);
      if (old?.moves?.length || old?.items?.length || old?.abilities?.length) {
        existingBySlug.set(base.slug, { ...old, ...base });
        continue;
      }
      missingCount += 1;
      const url = `${BASE_URL}/pokemon/${base.slug}?season=${SEASON}&format=${format}`;
      console.log(`[${format}] Filling missing #${base.rank} ${base.name} (${base.slug})`);
      const html = await fetchText(url);
      existingBySlug.set(base.slug, extractDetail(html, base));
      await sleep(REQUEST_DELAY_MS);
    }
    console.log(`[${format}] Missing-only refresh filled ${missingCount} entries.`);
    return {
      ...(existingFormat || {}),
      source: `${BASE_URL}?format=${format}&season=${SEASON}&view=pokemon`,
      fetchedAt: existingFormat?.fetchedAt || new Date().toISOString(),
      refreshedAt: new Date().toISOString(),
      updatedAt: extractUpdatedAt(listHtml) || existingFormat?.updatedAt || "",
      season: SEASON,
      format,
      pokemon: [...existingBySlug.values()].sort((a, b) => Number(a.rank || 9999) - Number(b.rank || 9999)),
    };
  }

  const pokemon = [];
  for (const base of ranking) {
    const old = cached.get(base.slug);
    if (old?.moves?.length || old?.items?.length || old?.abilities?.length) {
      pokemon.push({ ...old, ...base });
      continue;
    }

    const url = `${BASE_URL}/pokemon/${base.slug}?season=${SEASON}&format=${format}`;
    console.log(`[${format}] Fetching #${base.rank} ${base.name} (${base.slug})`);
    const html = await fetchText(url);
    pokemon.push(extractDetail(html, base));
    await sleep(REQUEST_DELAY_MS);
  }

  return {
    source: `${BASE_URL}?format=${format}&season=${SEASON}&view=pokemon`,
    fetchedAt: new Date().toISOString(),
    updatedAt: extractUpdatedAt(listHtml),
    season: SEASON,
    format,
    pokemon,
  };
}

async function main() {
  await mkdir("data", { recursive: true });
  let existing = {};
  try {
    existing = JSON.parse(await readFile(OUT_FILE, "utf8"));
  } catch {
    existing = {};
  }

  const formats = { ...(existing.formats || {}) };
  if (!existing.formats && existing.format && Array.isArray(existing.pokemon)) {
    formats[existing.format] = existing;
  }
  for (const format of FORMATS) {
    formats[format] = await fetchFormat(format, formats[format]);
  }

  const data = {
    source: BASE_URL,
    fetchedAt: new Date().toISOString(),
    season: SEASON,
    defaultFormat: FORMATS[0] || existing.defaultFormat || "single",
    formats,
  };

  await writeFile(OUT_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${Object.keys(formats).join(", ")} data to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
