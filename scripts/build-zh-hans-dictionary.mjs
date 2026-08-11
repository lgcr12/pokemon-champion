import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(".");
const OUTPUT = resolve(ROOT, "data", "zh-hans-terms.json");
const BASE = "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv";
const CACHE_DIR = process.env.POKEAPI_CSV_DIR || "";
const ZH_HANS_LANGUAGE_ID = "12";
const ALIAS_LANGUAGE_IDS = new Set(["1", "11"]);

function parseCsvLine(line = "") {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      value += char;
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function parseCsv(text = "") {
  const lines = text.trim().split(/\r?\n/);
  const header = parseCsvLine(lines.shift());
  return lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""]));
  });
}

async function fetchCsv(name) {
  if (CACHE_DIR) {
    const cached = await readFile(resolve(CACHE_DIR, `${name}.csv`), "utf8");
    return parseCsv(cached);
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`${BASE}/${name}.csv`, { signal: controller.signal });
      if (!response.ok) throw new Error(`${name}.csv: HTTP ${response.status}`);
      return parseCsv(await response.text());
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function compact(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildCategory(identifiers, names, idField) {
  const byId = new Map(identifiers.map((entry) => [entry.id, entry.identifier]));
  const chineseById = new Map(names.filter((entry) => entry.local_language_id === ZH_HANS_LANGUAGE_ID && entry.name).map((entry) => [entry[idField], entry.name]));
  const dictionary = {};
  const aliases = {};
  for (const [entityId, identifier] of byId) {
    const chinese = chineseById.get(entityId);
    if (!chinese) continue;
    dictionary[identifier.toLowerCase()] = chinese;
    dictionary[compact(identifier)] = chinese;
  }
  for (const entry of names) {
    const identifier = byId.get(entry[idField]);
    const chinese = chineseById.get(entry[idField]);
    if (!identifier || !entry.name || !ALIAS_LANGUAGE_IDS.has(entry.local_language_id)) continue;
    aliases[entry.name.toLowerCase()] = identifier;
    if (!chinese) continue;
    dictionary[entry.name.toLowerCase()] = chinese;
  }
  return { dictionary, aliases };
}

const moveOverrides = {
  "dire-claw": "克命爪", "wave-crash": "波动冲", "last-respects": "扫墓", "matcha-gotcha": "刷刷茶炮",
  "ceaseless-edge": "秘剑·千重涛", "torch-song": "闪焰高歌", "kowtow-cleave": "仆刀", "lumina-crash": "琉光冲激",
  "bitter-blade": "悔念剑", "twin-beam": "双光束", "gigaton-hammer": "巨力锤", "chilly-reception": "冷笑话",
  "ice-spinner": "冰旋", "aqua-cutter": "水波刀", "shed-tail": "断尾", "triple-arrows": "三连箭",
  "flower-trick": "千变万花", "stone-axe": "岩斧", shelter: "闭关", "jet-punch": "喷射拳",
  "bitter-malice": "冤冤相报", "make-it-rain": "淘金潮", trailblaze: "起草", "population-bomb": "鼠数儿",
  "rage-fist": "愤怒之拳", "headlong-rush": "突飞猛扑", "raging-bull": "怒牛", "infernal-parade": "群魔乱舞",
  "aqua-step": "流水旋舞", "armor-cannon": "铠农炮", "salt-cure": "盐腌", "tidy-up": "大扫除",
};

const itemOverrides = {
  "fairy-feather": "妖精之羽",
  dragoninite: "快龙进化石",
  glimmoranite: "晶光花进化石",
};

const moves = await fetchCsv("moves");
const moveNames = await fetchCsv("move_names");
const abilities = await fetchCsv("abilities");
const abilityNames = await fetchCsv("ability_names");
const items = await fetchCsv("items");
const itemNames = await fetchCsv("item_names");
const species = await fetchCsv("pokemon_species");
const speciesNames = await fetchCsv("pokemon_species_names");

const moveCategory = buildCategory(moves, moveNames, "move_id");
const abilityCategory = buildCategory(abilities, abilityNames, "ability_id");
const itemCategory = buildCategory(items, itemNames, "item_id");
const pokemonCategory = buildCategory(species, speciesNames, "pokemon_species_id");
Object.assign(moveCategory.dictionary, moveOverrides, Object.fromEntries(Object.entries(moveOverrides).map(([key, value]) => [compact(key), value])));
Object.assign(itemCategory.dictionary, itemOverrides, Object.fromEntries(Object.entries(itemOverrides).map(([key, value]) => [compact(key), value])));

const output = {
  source: "PokeAPI CSV zh-Hans",
  generatedAt: new Date().toISOString(),
  moves: moveCategory.dictionary,
  abilities: abilityCategory.dictionary,
  items: itemCategory.dictionary,
  pokemon: pokemonCategory.dictionary,
  aliases: {
    moves: moveCategory.aliases,
    abilities: abilityCategory.aliases,
    items: itemCategory.aliases,
    pokemon: pokemonCategory.aliases,
  },
};

await mkdir(resolve(ROOT, "data"), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: OUTPUT, moves: Object.keys(output.moves).length, abilities: Object.keys(output.abilities).length, items: Object.keys(output.items).length, pokemon: Object.keys(output.pokemon).length }, null, 2));
