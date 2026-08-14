import { readFile, writeFile } from "node:fs/promises";
import { mergePokecampTeams, normalizePokecampPayload } from "../server/pokecamp-teams.mjs";

const inputPath = process.argv[2] || process.env.POKECAMP_INPUT;
if (!inputPath) {
  console.error("Usage: node scripts/import-pokecamp-teams.mjs <pokecamp-export.json>");
  process.exit(2);
}

const payload = JSON.parse(await readFile(inputPath, "utf8"));
const imported = normalizePokecampPayload(payload, {
  format: process.env.FORMAT === "double" ? "double" : process.env.FORMAT === "single" ? "single" : "",
  season: process.env.SEASON || "",
  regulation: process.env.REGULATION || "",
  rulesetId: process.env.RULESET_ID || "",
});
const outputPath = process.env.OUTPUT || "data/team-data.json";
let document = { season: process.env.SEASON || "", availableSeasons: [], teams: [] };
try { document = JSON.parse(await readFile(outputPath, "utf8")); } catch {}
const merged = mergePokecampTeams(document, imported);
await writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, imported: merged.imported, totalTeams: merged.teams.length, formats: { single: merged.teams.filter((team) => team.format === "single").length, double: merged.teams.filter((team) => team.format === "double").length }, seasons: merged.availableSeasons }, null, 2));
