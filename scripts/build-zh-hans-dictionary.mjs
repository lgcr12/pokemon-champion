import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(".");
const OUTPUT = resolve(ROOT, "data", "zh-hans-terms.json");
const BASE = "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv";
const CACHE_DIR = process.env.POKEAPI_CSV_DIR || "";
const ZH_HANS_LANGUAGE_ID = "12";

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
  const dictionary = {};
  for (const entry of names) {
    if (entry.local_language_id !== ZH_HANS_LANGUAGE_ID || !entry.name) continue;
    const identifier = byId.get(entry[idField]);
    if (!identifier) continue;
    dictionary[identifier.toLowerCase()] = entry.name;
    dictionary[compact(identifier)] = entry.name;
  }
  return dictionary;
}

const moves = await fetchCsv("moves");
const moveNames = await fetchCsv("move_names");
const abilities = await fetchCsv("abilities");
const abilityNames = await fetchCsv("ability_names");
const items = await fetchCsv("items");
const itemNames = await fetchCsv("item_names");
const species = await fetchCsv("pokemon_species");
const speciesNames = await fetchCsv("pokemon_species_names");

const output = {
  source: "PokeAPI CSV zh-Hans",
  generatedAt: new Date().toISOString(),
  moves: buildCategory(moves, moveNames, "move_id"),
  abilities: buildCategory(abilities, abilityNames, "ability_id"),
  items: buildCategory(items, itemNames, "item_id"),
  pokemon: buildCategory(species, speciesNames, "pokemon_species_id"),
};

await mkdir(resolve(ROOT, "data"), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: OUTPUT, moves: Object.keys(output.moves).length, abilities: Object.keys(output.abilities).length, items: Object.keys(output.items).length, pokemon: Object.keys(output.pokemon).length }, null, 2));
