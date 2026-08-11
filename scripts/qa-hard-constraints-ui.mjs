import { chromium } from "playwright";

const baseUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4174/";
const goal = "\u53cc\u6253\u706b\u7130\u9e21\u63a5\u68d2\u961f\uff0c\u5fc5\u987b\u6709\u6c14\u52bf\u62ab\u5e26\uff0c\u5fc5\u987b\u6709\u52a0\u901f\uff0c\u5fc5\u987b\u6709\u63a5\u68d2\uff0c\u4e0d\u8981\u70bd\u7130\u5486\u54ee\u864e";
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const payloads = [];
  let designRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/team-build")) payloads.push(request.postDataJSON());
  });
  await page.route("**/api/team-design", async (route) => {
    designRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, draft: { pokemon: ["espathra", "scizor", "armarouge", "rotom-wash", "talonflame", "rotom-heat"] } }),
    });
  });
  await page.addInitScript(() => localStorage.setItem("champion-lab-ai-config-v1", JSON.stringify({ provider: "qa", endpoint: "chat", baseUrl: "https://qa.invalid/v1", model: "qa-model", apiKey: "qa-key" })));
  await page.goto(`${baseUrl}?qaHardConstraints=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#data-meta", { timeout: 60000 });
  await page.click("#double-format");
  await page.selectOption("#ai-build-method", "ai-designed");
  await page.fill("#ai-user-goal", goal);
  await page.click("#ai-build-config");
  await page.waitForFunction(() => !document.querySelector("#ai-output")?.classList.contains("is-loading"), null, { timeout: 60000 });

  const rendered = await page.locator("#ai-output").innerText();
  const cardNames = await page.locator(".ai-mon-card h3").allTextContents();
  const payload = payloads[0] || {};
  const constraints = payload.goalConstraints || {};
  const hasRequiredCore = (constraints.requiredPokemon || []).some((item) => item.slug === "blaziken");
  const hasUnavailableCore = (constraints.unavailablePokemon || []).some((item) => item.slug === "blaziken");
  const hasRequiredMove = (constraints.requiredMoves || []).includes("baton-pass");
  const hasRequiredItem = (constraints.requiredItems || []).includes("focus-sash");
  const hasRequiredAbility = (constraints.requiredAbilities || []).includes("speed-boost");
  const forbidsIncineroar = (constraints.forbiddenPokemon || []).some((item) => item.slug === "incineroar");
  const result = {
    ok: hasRequiredCore && !hasUnavailableCore && hasRequiredMove && hasRequiredItem && hasRequiredAbility && forbidsIncineroar && designRequests === 1 && cardNames[0] === "\u706b\u7130\u9e21" && !cardNames.includes("\u70bd\u7130\u5486\u54ee\u864e") && rendered.includes("\u63a5\u68d2") && rendered.includes("\u6c14\u52bf\u62ab\u5e26") && !rendered.includes("\u70bd\u7130\u5486\u54ee\u864e") && !rendered.includes("\u65e0\u6cd5\u6309\u786c\u6027\u8981\u6c42\u6784\u7b51"),
    hasRequiredCore,
    hasUnavailableCore,
    hasRequiredMove,
    hasRequiredItem,
    hasRequiredAbility,
    forbidsIncineroar,
    userGoal: payload.userGoal,
    forbiddenPokemon: constraints.forbiddenPokemon || [],
    designRequests,
    cardNames,
    rendered,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  await page.close();
} finally {
  await browser.close();
}
