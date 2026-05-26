import { mkdir, writeFile } from "node:fs/promises";

const OUT_FILE = "data/battle-knowledge.json";
const SMOGON_FORMATS = (process.env.SMOGON_FORMATS || "gen9ou,gen9doublesou,gen9vgc2026")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const POKEMON_LIMIT = Number(process.env.KNOWLEDGE_POKEMON_LIMIT || 120);
const ENTRY_LIMIT = Number(process.env.KNOWLEDGE_ENTRY_LIMIT || 10);

const SOURCES = {
  showdown: {
    pokedex: "https://play.pokemonshowdown.com/data/pokedex.json",
    moves: "https://play.pokemonshowdown.com/data/moves.json",
    items: "https://play.pokemonshowdown.com/data/items.js",
    abilities: "https://play.pokemonshowdown.com/data/abilities.js",
  },
  smogonIndex: "https://pkmn.github.io/smogon/data/stats/index.json",
  smogonFormat: (format) => `https://pkmn.github.io/smogon/data/stats/${format}.json`,
};

const headers = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
};

function toId(value = "") {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
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
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
  }
  throw lastError;
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function fetchShowdownExport(url, exportName) {
  const text = await fetchText(url);
  const exports = {};
  Function("exports", text)(exports);
  return exports[exportName] || {};
}

function topObjectEntries(object = {}, limit = ENTRY_LIMIT) {
  return Object.entries(object)
    .map(([name, value]) => ({ name, value: Number(value) || 0 }))
    .filter((item) => item.name && item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function topCounterEntries(object = {}, limit = ENTRY_LIMIT) {
  return Object.entries(object)
    .map(([name, value]) => {
      if (Array.isArray(value)) {
        return {
          name,
          score: Number(value[0]) || 0,
          koed: Number(value[1]) || 0,
          switched: Number(value[2]) || 0,
        };
      }
      if (typeof value === "object" && value) {
        return { name, ...value };
      }
      return { name, score: Number(value) || 0 };
    })
    .filter((item) => item.name)
    .slice(0, limit);
}

function summarizeSpread(spread = "") {
  const [nature = "", evs = ""] = spread.split(":");
  const [hp = 0, atk = 0, def = 0, spa = 0, spd = 0, spe = 0] = evs.split("/").map((item) => Number(item) || 0);
  return {
    name: spread,
    nature,
    evs: { hp, atk, def, spa, spd, spe },
  };
}

function summarizeSmogonPokemon(name, data = {}) {
  return {
    name,
    usage: Number(data.usage?.weighted || data.usage?.real || data.usage?.raw || 0),
    lead: Number(data.lead?.weighted || data.lead?.real || data.lead?.raw || 0),
    abilities: topObjectEntries(data.abilities),
    items: topObjectEntries(data.items),
    moves: topObjectEntries(data.moves),
    teammates: topObjectEntries(data.teammates),
    teraTypes: topObjectEntries(data.teraTypes),
    spreads: topObjectEntries(data.spreads, 6).map((item) => ({ ...summarizeSpread(item.name), value: item.value })),
    counters: topCounterEntries(data.counters, 8),
  };
}

function summarizeDexEntry(id, entry = {}) {
  return {
    id,
    name: entry.name || id,
    num: entry.num || 0,
    types: entry.types || [],
    baseStats: entry.baseStats || {},
    abilities: entry.abilities || {},
    tier: entry.tier || "",
    tags: entry.tags || [],
    isNonstandard: entry.isNonstandard || "",
  };
}

function summarizeMove(id, move = {}) {
  return {
    id,
    name: move.name || id,
    type: move.type || "",
    category: move.category || "",
    basePower: move.basePower || 0,
    accuracy: move.accuracy,
    priority: move.priority || 0,
    target: move.target || "",
    flags: move.flags || {},
    shortDesc: move.shortDesc || move.desc || "",
    isNonstandard: move.isNonstandard || "",
  };
}

function summarizeItem(id, item = {}) {
  return {
    id,
    name: item.name || id,
    shortDesc: item.shortDesc || item.desc || "",
    megaStone: item.megaStone || "",
    megaEvolves: item.megaEvolves || "",
    zMove: item.zMove || "",
    onPlate: item.onPlate || "",
    isNonstandard: item.isNonstandard || "",
  };
}

function summarizeAbility(id, ability = {}) {
  return {
    id,
    name: ability.name || id,
    rating: ability.rating ?? null,
    shortDesc: ability.shortDesc || ability.desc || "",
    isNonstandard: ability.isNonstandard || "",
  };
}

async function main() {
  await mkdir("data", { recursive: true });
  console.log("Fetching Pokemon Showdown dex data...");
  const [pokedex, moves, items, abilities] = await Promise.all([
    fetchJson(SOURCES.showdown.pokedex),
    fetchJson(SOURCES.showdown.moves),
    fetchShowdownExport(SOURCES.showdown.items, "BattleItems"),
    fetchShowdownExport(SOURCES.showdown.abilities, "BattleAbilities"),
  ]);

  console.log("Fetching Smogon stats index...");
  const smogonIndex = await fetchJson(SOURCES.smogonIndex);
  const availableFormats = new Set(Object.keys(smogonIndex).map((name) => name.replace(/\.json$/, "")));
  const selectedFormats = SMOGON_FORMATS.filter((format) => availableFormats.has(format));
  const missingFormats = SMOGON_FORMATS.filter((format) => !availableFormats.has(format));
  if (missingFormats.length) console.warn(`Skipped missing Smogon formats: ${missingFormats.join(", ")}`);

  const pokemon = {};
  for (const [id, entry] of Object.entries(pokedex)) {
    pokemon[id] = {
      showdown: summarizeDexEntry(id, entry),
      smogon: {},
    };
  }

  for (const format of selectedFormats) {
    console.log(`Fetching Smogon format ${format}...`);
    const data = await fetchJson(SOURCES.smogonFormat(format));
    const entries = Object.entries(data.pokemon || {})
      .map(([name, value]) => [name, summarizeSmogonPokemon(name, value)])
      .sort((a, b) => b[1].usage - a[1].usage)
      .slice(0, POKEMON_LIMIT);

    for (const [name, summary] of entries) {
      const id = toId(name);
      pokemon[id] ||= { showdown: { id, name }, smogon: {} };
      pokemon[id].smogon[format] = summary;
    }
  }

  const output = {
    source: {
      showdown: SOURCES.showdown,
      smogonIndex: SOURCES.smogonIndex,
      smogonFormats: selectedFormats.map((format) => SOURCES.smogonFormat(format)),
    },
    fetchedAt: new Date().toISOString(),
    notes: [
      "Pokemon Showdown data is used for rules, species, moves, abilities and items.",
      "pkmn Smogon stats is used for aggregated usage, moves, items, teammates, tera types and counters.",
      "This file is a compact AI knowledge cache, not a full legality engine.",
    ],
    formats: selectedFormats,
    limits: {
      pokemonPerFormat: POKEMON_LIMIT,
      entriesPerList: ENTRY_LIMIT,
    },
    pokemon,
    moves: Object.fromEntries(Object.entries(moves).map(([id, move]) => [id, summarizeMove(id, move)])),
    items: Object.fromEntries(Object.entries(items).map(([id, item]) => [id, summarizeItem(id, item)])),
    abilities: Object.fromEntries(Object.entries(abilities).map(([id, ability]) => [id, summarizeAbility(id, ability)])),
  };

  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote knowledge cache to ${OUT_FILE}`);
  console.log(`Formats: ${selectedFormats.join(", ")}`);
  console.log(`Pokemon entries: ${Object.keys(output.pokemon).length}`);
  console.log(`Moves: ${Object.keys(output.moves).length}, items: ${Object.keys(output.items).length}, abilities: ${Object.keys(output.abilities).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
