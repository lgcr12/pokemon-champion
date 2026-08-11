import { chromium } from "playwright";

const baseUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4174/";
const leakedTerms = ["recover", "bug-bite", "lumina-crash", "electroweb", "eerie-impulse", "starminite", "bitter-blade"];
const expectedTerms = ["自我再生", "虫咬", "琉光冲击", "电网", "怪异电波", "宝石海星进化石"];

const fixture = {
  ok: true,
  format: "double",
  season: "M-3",
  team: [
    { name: "宝石海星", slug: "starmie", item: "starminite", ability: "natural-cure", nature: "timid", evs: "H32/A17/B2/S15", moves: ["ice-beam", "rapid-spin", "recover", "protect"], evidence: { season: "M-3", format: "double", source: "OP.GG Replica Teams" } },
    { name: "巨钳螳螂", slug: "scizor", item: "metal-coat", ability: "technician", nature: "adamant", evs: "H32/A32/S2", moves: ["bullet-punch", "bug-bite", "swords-dance", "protect"] },
    { name: "超能艳鸵", slug: "espathra", item: "choice-scarf", ability: "speed-boost", nature: "timid", evs: "H1/B1/C32/S32", moves: ["lumina-crash", "calm-mind", "baton-pass", "protect"] },
    { name: "清洗洛托姆", slug: "rotom-wash", item: "wise-glasses", ability: "levitate", nature: "timid", evs: "H23/C11/S32", moves: ["electroweb", "volt-switch", "hydro-pump", "will-o-wisp"] },
    { name: "红莲铠骑", slug: "armarouge", item: "life-orb", ability: "flash-fire", nature: "quiet", evs: "H32/B1/C32/D1", moves: ["expanding-force", "heat-wave", "trick-room", "protect"] },
    { name: "加热洛托姆", slug: "rotom-heat", item: "leftovers", ability: "levitate", nature: "modest", evs: "H32/C32/D2", moves: ["bitter-blade", "volt-switch", "eerie-impulse", "protect"] },
  ],
  buildReport: {
    plan: "用于核验简中术语渲染。",
    synergies: ["宝石海星通过高速旋转为巨钳螳螂清除场地压力。", "清洗洛托姆用电网服务超能艳鸵的收割。"],
    risks: [],
    mega: { reason: "本测试不安排 Mega。" },
  },
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route("**/api/team-build", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(fixture),
  }));
  await page.goto(`${baseUrl}?qaZhHans=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#data-meta", { timeout: 60000 });
  await page.click("#double-format");
  await page.fill("#ai-user-goal", "双打测试队");
  await page.click("#ai-build-config");
  await page.waitForFunction(() => !document.querySelector("#ai-output")?.classList.contains("is-loading"), null, { timeout: 60000 });

  const text = await page.locator("#ai-output").innerText();
  const leaks = leakedTerms.filter((term) => new RegExp(term, "i").test(text));
  const missing = expectedTerms.filter((term) => !text.includes(term));
  const untranslatedSource = text.includes("OP.GG Replica Teams");
  const result = { ok: leaks.length === 0 && missing.length === 0 && !untranslatedSource, leaks, missing, untranslatedSource };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  await page.close();
} finally {
  await browser.close();
}
