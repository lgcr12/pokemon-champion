import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const BASE_URL = "https://pokechamdb.com/zh-Hans";
const FORMATS = (process.env.FORMATS || process.env.FORMAT || "single,double")
  .split(",")
  .map((format) => format.trim())
  .filter(Boolean);
const SEASON = process.env.SEASON || "M-2";
const LIMIT = Number(process.env.LIMIT || 300);
const SUPPLEMENT_TARGET = Number(process.env.SUPPLEMENT_TARGET || 227);
const POKECAMP_REGULATION = process.env.POKECAMP_REGULATION || "M-A";
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 650);
const MISSING_ONLY = process.env.MISSING_ONLY === "1";
const SKIP_DETAILS = process.env.SKIP_DETAILS === "1";
const OUT_FILE = "data/champion-data.json";
const TEMP_OUT_FILE = `${OUT_FILE}.tmp`;
const POKECAMP_URL = "https://pokecamp.cc/zh/champions/pokemon";

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

const TYPE_EN_TO_CN = {
  normal: "一般",
  fire: "火",
  water: "水",
  electric: "电",
  grass: "草",
  ice: "冰",
  fighting: "格斗",
  poison: "毒",
  ground: "地面",
  flying: "飞行",
  psychic: "超能力",
  bug: "虫",
  rock: "岩石",
  ghost: "幽灵",
  dragon: "龙",
  dark: "恶",
  steel: "钢",
  fairy: "妖精",
};

function statBlock(stats = {}) {
  return {
    HP: Number(stats.hp || 0),
    攻击: Number(stats.attack || 0),
    防御: Number(stats.defense || 0),
    特攻: Number(stats.specialAttack || 0),
    特防: Number(stats.specialDefense || 0),
    速度: Number(stats.speed || 0),
  };
}

function absolutePokeCampSprite(sprite = "") {
  if (!sprite) return "";
  if (/^https?:\/\//i.test(sprite)) return sprite;
  return `https://pokecamp.cc${sprite.startsWith("/") ? "" : "/"}${sprite}`;
}

function idFromSprite(sprite = "") {
  return Number(String(sprite).match(/\/pokemon\/(\d+)\.png/)?.[1] || 0);
}

async function fetchPokeCampPokemon() {
  const html = await fetchText(POKECAMP_URL);
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return { regulation: "", pokemonList: [] };

  const pageProps = JSON.parse(match[1]).props?.pageProps || {};
  const dataByRegulation = pageProps.dataByRegulation || {};
  const preferred = dataByRegulation[POKECAMP_REGULATION] ? POKECAMP_REGULATION : Object.keys(dataByRegulation)[0] || "";
  const pokemonList = dataByRegulation[preferred]?.limitless?.pokemonList || [];
  return {
    regulation: preferred,
    meta: dataByRegulation[preferred]?.limitless?.meta || {},
    pokemonList,
  };
}

function pokeCampEntryForBase(base, pokeCampData) {
  if (!pokeCampData?.pokemonList?.length) return null;
  const id = idFromSprite(base.sprite);
  const keys = new Set([base.slug, base.name].map((value) => String(value || "").toLowerCase()).filter(Boolean));
  return (
    pokeCampData.pokemonList.find((entry) => Number(entry.id) === id && id) ||
    pokeCampData.pokemonList.find((entry) =>
      [entry.identifier, entry.speciesIdentifier, entry.nameZh, entry.displayName, entry.nameEn]
        .map((value) => String(value || "").toLowerCase())
        .some((key) => keys.has(key)),
    ) ||
    null
  );
}

function baseFromPokeCamp(entry, rank) {
  const usage = entry.usage || {};
  const slug = entry.identifier || entry.speciesIdentifier || "";
  return {
    rank,
    slug,
    name: entry.nameZh || entry.displayName || entry.nameEn || slug,
    sprite: absolutePokeCampSprite(entry.sprite),
    id: Number(entry.id || 0),
    types: (entry.types || []).map((type) => TYPE_EN_TO_CN[type] || type).filter(Boolean),
    stats: statBlock(entry.stats),
    moves: [],
    items: [],
    abilities: [],
    natures: [],
    partners: [],
    supplemental: true,
    supplementalSource: "PokeCamp Champions / Limitless",
    usage: {
      rank: Number(usage.rank || 0),
      singlesRank: Number(usage.singlesRank || 0),
      doublesRank: Number(usage.doublesRank || 0),
      usagePercent: Number(usage.usagePercent || 0),
      teamCount: Number(usage.teamCount || 0),
    },
  };
}

function enrichBaseFromPokeCamp(base, pokeCampData) {
  const entry = pokeCampEntryForBase(base, pokeCampData);
  if (!entry) {
    return {
      ...base,
      id: idFromSprite(base.sprite),
      types: [],
      stats: {},
      moves: [],
      items: [],
      abilities: [],
      natures: [],
      partners: [],
    };
  }
  return {
    ...baseFromPokeCamp(entry, base.rank),
    slug: base.slug || entry.identifier || entry.speciesIdentifier || "",
    name: base.name || entry.nameZh || entry.displayName || entry.nameEn || "",
    sprite: base.sprite || absolutePokeCampSprite(entry.sprite),
    supplemental: false,
    supplementalSource: "",
  };
}

function supplementFromPokeCamp(pokemon, pokeCampData, format) {
  if (!SUPPLEMENT_TARGET || pokemon.length >= SUPPLEMENT_TARGET || !pokeCampData?.pokemonList?.length) {
    return { pokemon, added: 0, source: null };
  }

  const seenIds = new Set(pokemon.map((mon) => Number(mon.id)).filter(Boolean));
  const seenKeys = new Set(
    pokemon
      .flatMap((mon) => [mon.slug, mon.name])
      .map((value) => String(value || "").toLowerCase())
      .filter(Boolean),
  );
  const next = [...pokemon];

  const scoreForFormat = (entry) => {
    const usage = entry.usage || {};
    if (format === "single") return Number(usage.singlesRank || usage.rank || 9999);
    if (format === "double") return Number(usage.doublesRank || usage.rank || 9999);
    return Number(usage.rank || 9999);
  };

  const candidates = [...pokeCampData.pokemonList].sort((a, b) => scoreForFormat(a) - scoreForFormat(b));
  for (const entry of candidates) {
    if (next.length >= SUPPLEMENT_TARGET) break;
    const usage = entry.usage || {};
    const id = Number(entry.id || 0);
    const slug = entry.identifier || entry.speciesIdentifier || "";
    const name = entry.nameZh || entry.displayName || entry.nameEn || slug;
    const keys = [slug, name, entry.nameEn].map((value) => String(value || "").toLowerCase()).filter(Boolean);
    if ((id && seenIds.has(id)) || keys.some((key) => seenKeys.has(key))) continue;

    next.push(baseFromPokeCamp(entry, next.length + 1));
    if (id) seenIds.add(id);
    keys.forEach((key) => seenKeys.add(key));
  }

  return {
    pokemon: next,
    added: next.length - pokemon.length,
    source: next.length > pokemon.length ? "PokeCamp Champions / Limitless" : null,
  };
}

async function fetchFormat(format, existingFormat = null) {
  const listUrl = `${BASE_URL}?format=${format}&season=${SEASON}&view=pokemon`;
  const listHtml = await fetchText(listUrl);
  let ranking = extractRanking(listHtml, format).slice(0, LIMIT);
  if (!ranking.length && existingFormat?.pokemon?.length) {
    console.warn(`[${format}] Ranking list unavailable; reusing ${existingFormat.pokemon.length} cached entries.`);
    ranking = existingFormat.pokemon
      .map((mon, index) => ({
        rank: Number(mon.rank || index + 1),
        slug: mon.slug,
        name: mon.name,
        sprite: mon.sprite,
      }))
      .filter((mon) => mon.slug);
  }
  if (!ranking.length) throw new Error(`No ranking entries found for ${format}.`);

  const cached = new Map((existingFormat?.pokemon || []).map((mon) => [mon.slug, mon]));
  const pokeCampData = ranking.length < SUPPLEMENT_TARGET ? await fetchPokeCampPokemon().catch((err) => {
    console.warn(`[${format}] PokeCamp supplement unavailable: ${err.message}`);
    return null;
  }) : null;

  if (SKIP_DETAILS) {
    const pokemon = ranking.map((base) => enrichBaseFromPokeCamp(base, pokeCampData));
    const supplemented = supplementFromPokeCamp(pokemon, pokeCampData, format);
    if (supplemented.added) console.log(`[${format}] Added ${supplemented.added} supplemental entries from PokeCamp.`);
    return {
      source: `${BASE_URL}?format=${format}&season=${SEASON}&view=pokemon`,
      fetchedAt: new Date().toISOString(),
      updatedAt: extractUpdatedAt(listHtml),
      season: SEASON,
      format,
      supplementalSource: supplemented.source || "",
      pokemon: supplemented.pokemon,
    };
  }

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
    const supplemented = supplementFromPokeCamp(
      [...existingBySlug.values()].sort((a, b) => Number(a.rank || 9999) - Number(b.rank || 9999)),
      pokeCampData,
      format,
    );
    if (supplemented.added) console.log(`[${format}] Added ${supplemented.added} supplemental entries from PokeCamp.`);
    return {
      ...(existingFormat || {}),
      source: `${BASE_URL}?format=${format}&season=${SEASON}&view=pokemon`,
      fetchedAt: existingFormat?.fetchedAt || new Date().toISOString(),
      refreshedAt: new Date().toISOString(),
      updatedAt: extractUpdatedAt(listHtml) || existingFormat?.updatedAt || "",
      season: SEASON,
      format,
      supplementalSource: supplemented.source || existingFormat?.supplementalSource || "",
      pokemon: supplemented.pokemon,
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
    try {
      const html = await fetchText(url);
      pokemon.push(extractDetail(html, base));
    } catch (err) {
      const fallback = old || base;
      console.warn(`[${format}] Skipped ${base.slug}: ${err.message}`);
      pokemon.push({ ...fallback, ...base });
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const supplemented = supplementFromPokeCamp(pokemon, pokeCampData, format);
  if (supplemented.added) console.log(`[${format}] Added ${supplemented.added} supplemental entries from PokeCamp.`);

  return {
    source: `${BASE_URL}?format=${format}&season=${SEASON}&view=pokemon`,
    fetchedAt: new Date().toISOString(),
    updatedAt: extractUpdatedAt(listHtml),
    season: SEASON,
    format,
    supplementalSource: supplemented.source || "",
    pokemon: supplemented.pokemon,
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

  await writeFile(TEMP_OUT_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(TEMP_OUT_FILE, OUT_FILE);
  console.log(`Wrote ${Object.keys(formats).join(", ")} data to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
