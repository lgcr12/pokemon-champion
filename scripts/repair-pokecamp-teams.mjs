import { readFile, writeFile } from "node:fs/promises";
import { repairPokecampTeam } from "../server/pokecamp-teams.mjs";

const path = process.env.INPUT || "data/team-data.json";
const document = JSON.parse(await readFile(path, "utf8"));
const repaired = document.teams.map(repairPokecampTeam);
const quality = (team) => (team.configurations || []).reduce((score, configuration) => score + [configuration.item, configuration.ability, configuration.nature, configuration.stats, configuration.moves?.length].filter(Boolean).length, 0);
const mergeSameArticle = (left, right) => {
  const byName = new Map((left.configurations || []).map((configuration) => [String(configuration.name || configuration.slug), configuration]));
  for (const configuration of right.configurations || []) {
    const key = String(configuration.name || configuration.slug);
    const previous = byName.get(key);
    const score = (value) => [value?.item, value?.ability, value?.nature, value?.stats, value?.moves?.length].filter(Boolean).length;
    if (!previous || score(configuration) > score(previous)) byName.set(key, configuration);
  }
  const configurations = (left.members || []).map((member) => byName.get(String(member.name || member.slug))).filter(Boolean);
  return { ...left, ...right, sourcePageType: "team-builds", configurations, sourceVersion: "pokecamp-import-v4-merged" };
};
const compact = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
const identity = (value) => { const raw = compact(value); return raw.replace(/[^a-z0-9]+/g, "") || raw; };
const memberSignature = (team) => (team.members || []).map((member) => identity(member.name || member.localizedName || member.slug)).join("|");
const generatedTitle = (value) => /^PokéCamp\s+.+\s+p\d+-\d+$/i.test(String(value || ""));
const articleTitleKey = (value) => compact(value).replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "");
const byArticle = new Map();
for (const team of repaired) {
  if (!String(team.source || "").toLowerCase().includes("pokecamp")) { byArticle.set(`other:${team.id}`, team); continue; }
  const normalizedPage = team.sourcePageType === "team-builds-single" ? "team-builds" : team.sourcePageType;
  const key = [normalizedPage, team.format, team.season || team.regulation || "", articleTitleKey(team.title), memberSignature(team)].join("::");
  const previous = byArticle.get(key);
  byArticle.set(key, previous ? (quality(team) > quality(previous) ? mergeSameArticle(team, previous) : mergeSameArticle(previous, team)) : team);
}
let deduplicated = [...byArticle.values()];
// Older imports used generated page titles. Merge those records with a later
// crawl that recovered the article title and detail dialog.
const generatedBySignature = new Map(deduplicated.filter((team) => generatedTitle(team.title)).map((team) => [
  [team.sourcePageType === "team-builds-single" ? "team-builds" : team.sourcePageType, team.format, team.season || team.regulation || "", memberSignature(team)].join("::"),
  team,
]));
const obsolete = new Set();
for (const team of deduplicated) {
  if (generatedTitle(team.title)) continue;
  const key = [team.sourcePageType === "team-builds-single" ? "team-builds" : team.sourcePageType, team.format, team.season || team.regulation || "", memberSignature(team)].join("::");
  const generated = generatedBySignature.get(key);
  if (!generated || generated.id === team.id) continue;
  const merged = mergeSameArticle(generated, team);
  const index = deduplicated.indexOf(generated);
  if (index >= 0) deduplicated[index] = merged;
  obsolete.add(team.id);
  generatedBySignature.set(key, merged);
}
deduplicated = deduplicated.filter((team) => !obsolete.has(team.id));
for (const team of deduplicated) {
  const completeConfigurations = (team.configurations || []).filter((configuration) => configuration.ability && (configuration.moves || []).length >= 4).length;
  if (completeConfigurations >= Math.min(4, (team.members || []).length)) team.detailStatus = "COMPLETE";
}
// A team can share all six members with another article while using a
// different set, lead plan, or playstyle. Repair in place and never dedupe by
// members; source id/title is the identity boundary for imported records.
const output = { ...document, teams: deduplicated, total: deduplicated.length, fetchedAt: new Date().toISOString(), sourceVersion: "pokecamp-import-v4-merged" };
await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ before: document.teams.length, after: deduplicated.length, removed: document.teams.length - deduplicated.length, pokecamp: deduplicated.filter((team) => String(team.source || "").toLowerCase().includes("pokecamp")).length }));
