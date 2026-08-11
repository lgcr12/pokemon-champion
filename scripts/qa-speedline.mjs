import { chromium } from "playwright";

const baseUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4174/";
const failures = [];

function unresolvedBuild() {
  return {
    ok: true,
    format: "single",
    season: "M-3",
    team: Array.from({ length: 6 }, (_, index) => ({
      id: `unknown-speed-${index + 1}`,
      slug: `unknown-speed-${index + 1}`,
      name: `未知速度成员 ${index + 1}`,
      item: "剩饭",
      ability: "压迫感",
      nature: "认真",
      evs: "H252 / B4 / D252",
      level: "50",
      moves: ["保护", "替身", "挑衅", "守住"],
      role: "回归测试成员",
      note: "无种族值来源，速度必须显示为待配置。",
    })),
    buildReport: {
      plan: "回归测试。",
      synergies: [],
      risks: [],
      mega: { reason: "回归测试。" },
    },
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${baseUrl}?qaSpeedline=empty-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#data-meta", { timeout: 60000 });
  const emptySummary = await page.locator("#speedline-summary").innerText();
  if (!emptySummary.includes("先选队伍")) failures.push(`空队提示不正确：${emptySummary}`);

  await page.click("#double-format");
  await page.click("#open-palette-btn");
  await page.locator(".pokemon-row:not([disabled])").first().click();
  await page.waitForTimeout(250);
  const resolved = await page.evaluate(() => ({
    summary: document.querySelector("#speedline-summary")?.textContent?.trim() || "",
    metric: document.querySelector("#speed-line")?.textContent?.trim() || "",
  }));
  if (/最高速度是 0|待配置/.test(resolved.summary) || !/^\d+$/.test(resolved.metric)) {
    failures.push(`有预设的成员没有解析出速度：${JSON.stringify(resolved)}`);
  }
  await page.close();

  const unknownPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await unknownPage.route("**/api/team-build", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(unresolvedBuild()),
  }));
  await unknownPage.goto(`${baseUrl}?qaSpeedline=unknown-${Date.now()}`, { waitUntil: "domcontentloaded" });
  await unknownPage.waitForSelector("#data-meta", { timeout: 60000 });
  await unknownPage.fill("#ai-user-goal", "速度线回归测试");
  await unknownPage.click("#ai-build-config");
  await unknownPage.waitForFunction(() => !document.querySelector("#ai-output")?.classList.contains("is-loading"), null, { timeout: 60000 });
  await unknownPage.locator('[data-ai-apply="single"]').first().click();
  await unknownPage.waitForTimeout(250);
  const unresolved = await unknownPage.evaluate(() => ({
    summary: document.querySelector("#speedline-summary")?.textContent?.trim() || "",
    metric: document.querySelector("#speed-line")?.textContent?.trim() || "",
    labels: [...document.querySelectorAll(".speedline-row .speedline-rank span")].slice(0, 4).map((item) => item.textContent?.trim()),
  }));
  if (!unresolved.summary.includes("还没有解析出来") || unresolved.metric !== "待配置" || unresolved.labels.some((label) => label !== "待配置")) {
    failures.push(`未知速度被误判为 0 或需控速：${JSON.stringify(unresolved)}`);
  }
  await unknownPage.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
if (failures.length) process.exitCode = 1;
