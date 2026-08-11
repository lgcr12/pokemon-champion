import { chromium } from "playwright";

const baseUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4174/";
const cases = [
  { name: "单打平衡", format: "single", goal: "单打平衡队" },
  { name: "双打晴天", format: "double", goal: "双打晴天九尾" },
  { name: "双打空间", format: "double", goal: "双打空间队" },
];
const failures = [];

function sharedMembers(first = [], second = []) {
  const names = new Set(first);
  return second.filter((name) => names.has(name)).length;
}

async function waitForBuild(page) {
  await page.waitForSelector("#ai-output.is-loading", { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("#ai-output")?.classList.contains("is-loading"), null, { timeout: 90000 });
}

async function renderedTeam(page) {
  return page.locator(".ai-mon-card h3").allTextContents().then((items) => items.map((item) => item.trim()).filter(Boolean));
}

const browser = await chromium.launch({ headless: true });
try {
  for (const testCase of cases) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(() => localStorage.removeItem("champion-lab-ai-variation-history-v1"));
    const requests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/team-build")) requests.push(request.postDataJSON());
    });
    await page.goto(`${baseUrl}?qaVariation=${encodeURIComponent(testCase.name)}-${Date.now()}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#data-meta", { timeout: 60000 });
    await page.click(testCase.format === "double" ? "#double-format" : "#single-format");
    await page.fill("#ai-user-goal", testCase.goal);

    const teams = [];
    await page.click("#ai-build-config");
    await waitForBuild(page);
    teams.push(await renderedTeam(page));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.locator("[data-ai-retry]").click();
      await waitForBuild(page);
      teams.push(await renderedTeam(page));
    }
    const output = await page.locator("#ai-output").evaluate((element) => ({ className: element.className, text: element.textContent || "" }));
    if (output.className.includes("is-error") || teams.some((team) => team.length !== 6)) {
      failures.push(`${testCase.name}: 连续构筑没有稳定返回三支完整队伍`);
    }
    if (sharedMembers(teams[0], teams[1]) > 4 || sharedMembers(teams[0], teams[2]) > 4 || sharedMembers(teams[1], teams[2]) > 4) {
      failures.push(`${testCase.name}: 连续构筑仍重复了五只或六只成员：${JSON.stringify(teams)}`);
    }
    if ((requests[1]?.avoidTeams || []).length < 1 || (requests[2]?.avoidTeams || []).length < 2) {
      failures.push(`${testCase.name}: 网页没有把前两次结果传为避重复历史`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
if (failures.length) process.exitCode = 1;
