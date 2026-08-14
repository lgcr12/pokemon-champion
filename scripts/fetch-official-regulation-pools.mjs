import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Dex } = require("pokemon-showdown");

const sources = {
  "M-A": {
    announcementUrl: "https://news.pokemon-home.com/sc/page/751.html",
    sourceUrl: "https://web-view.app.pokemonchampions.jp/battle/pages/events/rs177501629259kmzbny/sc/pokemon.html",
  },
  "M-B": {
    announcementUrl: "https://news.pokemon-home.com/sc/page/776.html",
    sourceUrl: "https://web-view.app.pokemonchampions.jp/battle/pages/events/rs178066986988lmoqpm/sc/pokemon.html",
  },
};

const terms = JSON.parse(readFileSync("data/zh-hans-terms.json", "utf8"));
const reverseNames = new Map();
for (const [id, name] of Object.entries(terms.pokemon || {})) {
  const normalized = normalizeName(name);
  if (!reverseNames.has(normalized)) reverseNames.set(normalized, id);
}

const byNum = new Map();
for (const species of Dex.species.all()) {
  if (!Number.isFinite(Number(species.num)) || species.num <= 0 || species.isCosmeticForme) continue;
  const list = byNum.get(Number(species.num)) || [];
  list.push(species);
  byNum.set(Number(species.num), list);
}

function normalizeName(value = "") {
  return String(value || "")
    .replace(/[\uFF10-\uFF19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF21-\uFF3A]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF41-\uFF5A]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\uFF31/g, "Q")
    .replace(/[\u30FB\u00B7]/g, "-")
    .trim();
}

function formMatches(species, formLabel) {
  const label = String(formLabel || "");
  if (!label) return !species.forme;
  const aliases = [
    [/\u963f\u7f57\u62c9/, "alola"],
    [/\u4f3d\u52d2\u5c14/, "galar"],
    [/\u6d17\u7fe0/, "hisui"],
    [/\u5e15\u5e95\u4e9a.*\u6597\u6218/, "paldeacombat"],
    [/\u5e15\u5e95\u4e9a.*\u706b\u7098/, "paldeablaze"],
    [/\u5e15\u5e95\u4e9a.*\u6c34\u6f9c/, "paldeaaqua"],
    [/\u8d85\u7ea7\u8fdb\u5316|\u8d85\u7ea7/, "mega"],
    [/\u6781\u5de8\u5316/, "gmax"],
    [/\u539f\u59cb/, "primal"],
    [/\u9ec4\u660f/, "dusk"],
    [/\u6b63\u5348|\u65e5\u95f4/, "midday"],
    [/\u6df1\u591c|\u591c\u95f4/, "midnight"],
    [/\u706b\u7098/, "blaze"],
    [/\u6c34\u6f9c/, "aqua"],
  ];
  const hit = aliases.find(([pattern]) => pattern.test(label));
  if (!hit) return species.forme.toLowerCase().replace(/[^a-z0-9]/g, "").includes(label.toLowerCase().replace(/[^a-z0-9]/g, ""));
  return species.id.includes(hit[1]) || species.forme.toLowerCase().replace(/[^a-z0-9]/g, "").includes(hit[1]);
}

function showdownIdsFor(name, dex, homeId = "") {
  const normalized = normalizeName(name);
  const baseName = normalized.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const formLabel = normalized.match(/\(([^)]*)\)\s*$/)?.[1] || "";
  const baseId = reverseNames.get(baseName);
  const candidates = byNum.get(Number(dex)) || [];
  const baseCandidates = baseId
    ? candidates.filter((species) => species.baseSpecies.toLowerCase() === baseId || species.id === baseId || normalizeName(species.baseSpecies).replace(/[^a-z0-9]/gi, "").toLowerCase() === baseId.replace(/[^a-z0-9]/gi, "").toLowerCase())
    : candidates;
  const formSuffix = String(homeId).match(/-(\d{3})$/)?.[1] || "000";
  const suffixHints = {
    "000": (species) => !species.forme,
    "001": (species) => /combat/i.test(species.id),
    "002": (species) => /blaze/i.test(species.id),
    "003": (species) => /aqua/i.test(species.id),
  };
  const byHomeForm = suffixHints[formSuffix] ? baseCandidates.filter(suffixHints[formSuffix]) : [];
  return (byHomeForm.length ? byHomeForm : baseCandidates.filter((species) => formMatches(species, formLabel))).map((species) => species.id);
}

const regulations = {};
for (const [regulation, source] of Object.entries(sources)) {
  const html = await (await fetch(source.sourceUrl)).text();
  const match = html.match(/const pokemons\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error(`Official Pokemon list not found for ${regulation}`);
  const rows = JSON.parse(match[1]);
  const entries = rows.map(([homeId, _category, name]) => {
    const dex = Number(String(homeId).slice(0, 4));
    return {
    homeId,
    dex,
    name,
    showdownIds: showdownIdsFor(name, dex, homeId),
    sprite: Number(dex),
    };
  });
  regulations[regulation] = { ...source, count: entries.length, entries };
  const unmapped = entries.filter((entry) => !entry.showdownIds.length);
  if (unmapped.length) console.warn(`${regulation}: ${unmapped.length} entries have no exact Showdown mapping`);
}

writeFileSync(
  "data/official-regulation-pools.json",
  `${JSON.stringify({ schemaVersion: 1, source: "Pokemon HOME official regulation pages", fetchedAt: new Date().toISOString(), regulations }, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(Object.fromEntries(Object.entries(regulations).map(([key, value]) => [key, { count: value.count, unmapped: value.entries.filter((entry) => !entry.showdownIds.length).length }])), null, 2));
