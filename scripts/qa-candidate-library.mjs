import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const port = Number(process.env.CANDIDATE_QA_PORT || 4187);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "ignore", "pipe"],
});

let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk; });

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/rules/active`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Candidate QA server did not start. ${stderr}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await waitForServer();
  const terms = JSON.parse(readFileSync("data/zh-hans-terms.json", "utf8"));
  const all = await request("/api/rules/candidates?format=double&limit=100");
  const space = await request("/api/rules/candidates?format=double&category=trickroom&limit=100");
  const matcha = await request(`/api/rules/candidates?format=double&query=${encodeURIComponent("刷刷茶炮")}&limit=24`);
  const ditto = await request(`/api/rules/candidates?format=double&query=${encodeURIComponent("百变怪")}&limit=24`);

  assert(all.rulesetId && all.showdownFormatId, "Candidate results must be bound to an active ruleset.");
  assert(terms.aliases?.moves?.["トリックルーム"] === "trick-room", "Japanese move aliases must normalize to Showdown identifiers.");
  assert(all.poolTotal >= 220, `Expected a near-complete Champions pool, received ${all.poolTotal}.`);
  assert(all.sourceTotal >= all.poolTotal && all.excludedTotal === all.sourceTotal - all.poolTotal, "Source and legal pool totals are inconsistent.");
  assert(all.configurationTotal >= 500, `Expected configuration-level candidates, received ${all.configurationTotal}.`);
  assert(space.total >= 5 && space.matchedConfigurationTotal >= 10, "Trick Room filter must return real configurations.");
  assert(space.items.every((item) => item.sets.every((set) => set.categories.includes("trickroom"))), "Category filtering leaked a non-Trick Room configuration.");
  assert(matcha.items.some((item) => item.sets.some((set) => set.moveLabels.includes("刷刷茶炮"))), "Move localization/search failed for Matcha Gotcha.");
  assert(ditto.items[0]?.role === "复制应变", `Ditto role was misclassified as ${ditto.items[0]?.role || "missing"}.`);
  assert(all.items.some((item) => item.sets.length > 1), "At least one Pokemon must expose multiple configurations.");
  assert(all.items.flatMap((item) => item.sets).every((set) => set.abilityLabel && set.itemLabel && set.moveLabels.length), "Localized configuration fields are incomplete.");
  console.log("Candidate library QA passed.");
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}
