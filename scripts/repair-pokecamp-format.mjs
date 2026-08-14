import { readFile, writeFile } from "node:fs/promises";

const path = "data/team-data.json";
const document = JSON.parse(await readFile(path, "utf8"));
let updated = 0;
for (const team of document.teams || []) {
  if (!String(team.source || "").toLowerCase().includes("pokecamp")) continue;
  const isSingleBuild = team.sourcePageType === "team-builds";
  if (isSingleBuild && team.format !== "single") { team.format = "single"; team.formatLabel = "Single / BSS"; team.sourceVersion = "pokecamp-import-v2-format"; updated += 1; }
}
document.fetchedAt = new Date().toISOString();
await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ updated, total: document.teams.length }));
