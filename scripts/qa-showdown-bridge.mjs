import { chromium } from "playwright";

const baseUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4174/";
const failures = [];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${baseUrl}?qaShowdownBridge=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#data-meta", { timeout: 60000 });
  await page.click("#double-format");
  await page.fill("#ai-user-goal", "双打空间队");
  await page.click("#ai-build-config");
  await page.waitForFunction(() => !document.querySelector("#ai-output")?.classList.contains("is-loading"), null, { timeout: 90000 });
  await page.locator('[data-ai-apply="double"]').first().click();
  await page.waitForTimeout(200);
  const result = await page.evaluate(async () => {
    const teamText = document.querySelector("#showdown-export")?.value || "";
    const response = await fetch("/api/showdown-bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamText, format: "double", name: "QA bridge" }),
    });
    const created = await response.json();
    const pending = created.token
      ? await fetch(`/api/showdown-bridge?token=${encodeURIComponent(created.token)}`).then((item) => item.json())
      : null;
    return { status: response.status, created, pending, teamText };
  });
  const moveCount = (result.teamText.match(/^-/gm) || []).length;
  if (result.status !== 200 || !result.created?.token || !result.pending?.payload?.packedTeam || /[\u3040-\u30ff\u3400-\u9fff]/.test(result.teamText) || moveCount < 24) {
    failures.push(`严格构筑没有生成可桥接的英文六人队：${JSON.stringify({ status: result.status, moveCount, created: result.created })}`);
  }
  if (process.env.QA_DESKTOP_BRIDGE === "1" && result.created?.token) {
    const desktop = await page.evaluate(async (token) => {
      const launch = await fetch("/api/showdown-bridge/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const pending = await fetch(`/api/showdown-bridge?token=${encodeURIComponent(token)}`);
      return { launch: launch.status, pending: pending.status };
    }, result.created.token);
    if (desktop.launch !== 200 || desktop.pending !== 404) failures.push(`桌面 Showdown 桥接未完成导入：${JSON.stringify(desktop)}`);
  }
  const invalid = await page.evaluate(async () => {
    const response = await fetch("/api/showdown-bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamText: "Pikachu\n- Thunderbolt", format: "single", name: "invalid" }),
    });
    return { status: response.status, body: await response.json() };
  });
  if (invalid.status !== 422 || !Array.isArray(invalid.body?.problems) || !invalid.body.problems.length) {
    failures.push("非法队伍没有返回可读的 Showdown 导入诊断");
  }
  await page.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
if (failures.length) process.exitCode = 1;
