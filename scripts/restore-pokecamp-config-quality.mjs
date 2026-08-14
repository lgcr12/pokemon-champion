import { readFile, writeFile } from "node:fs/promises";

const currentPath = process.env.CURRENT || "data/team-data.json";
const backupPath = process.env.BACKUP || "data/team-data.before-detail-fix.json";
const current = JSON.parse(await readFile(currentPath, "utf8"));
const backup = JSON.parse(await readFile(backupPath, "utf8"));
const quality = (team) => (team?.configurations || []).reduce((score, configuration) => score + [
  configuration.item,
  configuration.ability,
  configuration.nature,
  configuration.stats,
  configuration.moves?.length,
].filter(Boolean).length, 0);
const key = (team) => [
  team.sourcePageType === "team-builds-single" ? "team-builds" : team.sourcePageType,
  team.format,
  (team.members || []).map((member) => String(member.name || member.localizedName || member.slug || "").replace(/[^a-z0-9\u4e00-\u9fff]/gi, "").toLowerCase()).join("|"),
].join("::");
const byId = new Map((backup.teams || []).map((team) => [String(team.id), team]));
const bySignature = new Map();
for (const team of backup.teams || []) bySignature.set(key(team), team);
let restored = 0;
for (const team of current.teams || []) {
  const previous = byId.get(String(team.id)) || bySignature.get(key(team));
  if (!previous || quality(previous) <= quality(team)) continue;
  team.configurations = previous.configurations;
  if (previous.details && Object.keys(previous.details).length) team.details = previous.details;
  team.detailStatus = "COMPLETE";
  restored += 1;
}
current.fetchedAt = new Date().toISOString();
current.sourceVersion = "pokecamp-import-v5-quality-restore";
await writeFile(currentPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ restored, total: current.teams?.length || 0 }));
