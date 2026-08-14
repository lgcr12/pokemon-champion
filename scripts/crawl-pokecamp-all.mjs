import { appendFile, writeFile } from "node:fs/promises";

const api = process.env.POKE_FORGE_API || "http://127.0.0.1:4174";
const logPath = process.env.POKECAMP_CRAWL_LOG || "data/pokecamp-crawl-all.log";
const sources = [
  { sourcePageType: "vgc-teams", format: "double", url: "https://pokecamp.cc/zh/champions/vgc-teams" },
  { sourcePageType: "team-builds-single", format: "single", url: "https://pokecamp.cc/zh/champions/team-builds" },
  { sourcePageType: "team-builds-double", format: "double", url: "https://pokecamp.cc/zh/champions/team-builds" },
];

const post = async (path, body) => {
  const response = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `${path} failed (${response.status})`);
  return payload;
};

await writeFile(logPath, `${new Date().toISOString()} START\n`, "utf8");
const record = async (value) => appendFile(logPath, `${new Date().toISOString()} ${JSON.stringify(value)}\n`, "utf8");

try {
  for (const source of sources) {
    await record({ event: "source-start", ...source });
    const opened = await post("/api/pokecamp/browser/open", { url: source.url });
    await record({ event: "opened", source: source.sourcePageType, status: opened.status, challenge: opened.challenge });
    if (opened.challenge || opened.status === "WAITING_FOR_HUMAN_VERIFICATION") throw new Error("PokéCamp 需要人工完成验证后才能继续抓取。");
    const switched = await post("/api/pokecamp/browser/format", { format: source.format });
    await record({ event: "format", source: source.sourcePageType, preview: switched.preview || "" });
    const crawled = await post("/api/pokecamp/browser/crawl", { sourcePageType: source.sourcePageType, pages: 30 });
    await record({ event: "crawled", source: source.sourcePageType, preview: crawled.preview || {} });
    const imported = await post("/api/pokecamp/browser/crawl/import", { sourcePageType: source.sourcePageType, format: source.format, season: "M-B", regulation: "M-B" });
    await record({ event: "imported", source: source.sourcePageType, totalTeams: imported.totalTeams, imported: imported.imported });
  }
  await record({ event: "complete" });
} catch (error) {
  await record({ event: "failed", error: error.message || String(error) });
  process.exitCode = 1;
}
