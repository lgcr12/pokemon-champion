import { chromium } from "playwright";

const baseUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4174/";
const goal = "\u53cc\u6253\u96e8\u5929\u94dd\u94a2\u6865\u9f99";
const expectedCore = "archaludon";
const shortNameGoal = "\u53cc\u6253\u6674\u5929\u4e5d\u5c3e";
const expectedShortNameCore = "ninetales";
const trickRoomGoal = "\u53cc\u6253\u7a7a\u95f4\u961f";
const formGoal = "\u53cc\u6253\u6e05\u6d17\u6d1b\u6258\u59c6";
const failures = [];

async function runCase(browser, { fallback, coach = false, design = false, partialDesign = false, forceBuildFailure = false, userGoal = goal }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const requests = [];
  let coachRequestCount = 0;
  if (coach || design) {
    await page.addInitScript(() => {
      localStorage.setItem("champion-lab-ai-config-v1", JSON.stringify({
        provider: "qa",
        endpoint: "chat",
        baseUrl: "https://qa.invalid/v1",
        model: "qa-model",
        apiKey: "qa-key",
      }));
    });
    await page.route("**/api/team-coach", async (route) => {
      coachRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          provider: "qa",
          model: "qa-model",
          coach: {
            plan: "QA verified battle plan.",
            leads: ["Lead with a verified member."],
            synergies: ["Use the validated weather core."],
            risks: ["Keep the speed-control member healthy."],
          },
        }),
      });
    });
  }
  let designRequestCount = 0;
  if (design) {
    await page.route("**/api/team-design", async (route) => {
      designRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          provider: "qa",
          model: "qa-model",
          draft: {
            pokemon: [
              { name: "\u5de8\u94b3\u87b3\u8782", slug: "scizor" },
              { name: "\u5e7d\u5c3e\u7384\u9c7c", slug: "basculegion" },
              { name: "\u94dd\u94a2\u6865\u9f99", slug: "archaludon" },
              { name: "\u52fe\u9b42\u773c", slug: "sableye" },
              { name: "\u5927\u5634\u9e25", slug: "pelipper" },
              { name: "\u5feb\u9f99", slug: "dragonite" },
            ].slice(0, partialDesign ? 2 : 6),
            rationale: "QA AI-created draft.",
            completionNote: partialDesign ? "AI \u53ea\u8fd4\u56de\u4e86 2 \u4e2a\u53ef\u8bc6\u522b\u5019\u9009\uff1b\u4e25\u683c\u5f15\u64ce\u5df2\u8865\u5168\u5176\u4f59\u4f4d\u7f6e\u3002" : "",
          },
        }),
      });
    });
  }
  page.on("request", (request) => {
    if (request.url().includes("/api/team-build")) requests.push(request.postDataJSON());
  });
  if (fallback || forceBuildFailure) {
    await page.route("**/api/team-build", async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, diagnostics: [forceBuildFailure ? "forced AI design strict failure" : "forced QA fallback"] }),
      });
    });
  }

  await page.goto(`${baseUrl}?qaStrictUi=${fallback ? "fallback" : "live"}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ai-user-goal", { timeout: 60000 });
  await page.waitForSelector("#data-meta", { timeout: 60000 });
  await page.click("#double-format");
  if (design) await page.selectOption("#ai-build-method", "ai-designed");
  await page.fill("#ai-user-goal", userGoal);
  await page.click("#ai-build-config");
  await page.waitForFunction(() => !document.querySelector("#ai-output")?.classList.contains("is-loading"), null, { timeout: 90000 });

  const rendered = await page.evaluate(() => ({
    className: document.querySelector("#ai-output")?.className || "",
    cards: [...document.querySelectorAll(".ai-mon-card")].map((card) => card.querySelector("h3")?.textContent?.trim() || ""),
    text: document.querySelector("#ai-output")?.innerText || "",
  }));
  await page.close();
  return { requests, rendered, coachRequestCount, designRequestCount };
}

const browser = await chromium.launch({ headless: true });
try {
  const live = await runCase(browser, { fallback: false });
  const fallback = await runCase(browser, { fallback: true });
  const coached = await runCase(browser, { fallback: false, coach: true });
  const designed = await runCase(browser, { fallback: false, design: true });
  const partialDesigned = await runCase(browser, { fallback: false, design: true, partialDesign: true });
  const failedDesign = await runCase(browser, { fallback: false, design: true, forceBuildFailure: true });
  const shortName = await runCase(browser, { fallback: false, userGoal: shortNameGoal });
  const trickRoom = await runCase(browser, { fallback: false, userGoal: trickRoomGoal });
  const formSpecific = await runCase(browser, { fallback: false, userGoal: formGoal });
  for (const [name, result] of [["live", live]]) {
    const cores = result.requests[0]?.goalConstraints?.requiredPokemon || [];
    const slugs = cores.map((core) => core.slug);
    if (slugs.length !== 1 || slugs[0] !== expectedCore) {
      failures.push(`${name}: explicit core extraction sent ${JSON.stringify(slugs)} instead of only ${expectedCore}`);
    }
    if (result.rendered.className.includes("is-error")) failures.push(`${name}: rendered an error state`);
    if (result.rendered.cards.length !== 6) failures.push(`${name}: expected six rendered team cards, got ${result.rendered.cards.length}`);
    if (!result.rendered.cards.some((nameText) => /\u94dd\u94a2\u6865\u9f99/.test(nameText))) failures.push(`${name}: generated team is missing Archaludon`);
  }
  if (!fallback.rendered.className.includes("is-error") || fallback.rendered.cards.length) {
    failures.push("strict-service failure: rendered an unverified fallback team instead of the diagnostic state");
  }
  if (!live.rendered.text.includes("热门完整样本：整队配置原样复用")) failures.push("sample mode: rendered result is missing the complete-sample source label");
  const shortNameCores = shortName.requests[0]?.goalConstraints?.requiredPokemon || [];
  const shortNameSlugs = shortNameCores.map((core) => core.slug);
  if (shortNameSlugs.length !== 1 || shortNameSlugs[0] !== expectedShortNameCore) {
    failures.push(`short-name: explicit core extraction sent ${JSON.stringify(shortNameSlugs)} instead of only ${expectedShortNameCore}`);
  }
  if (shortName.rendered.className.includes("is-error") || shortName.rendered.cards.length !== 6) {
    failures.push("short-name: failed to build a six-member team for Ninetales");
  }
  if (/拨沙|沙之力|拨雪|悠游自如/.test(shortName.rendered.text)) {
    failures.push("short-name: sun team leaked an unsupported rain, sand, or snow payoff configuration");
  }
  if (trickRoom.rendered.className.includes("is-error") || trickRoom.rendered.cards.length !== 6 || !trickRoom.rendered.text.includes("戏法空间")) {
    failures.push("trick-room: failed to render a six-member team with an actual Trick Room plan");
  }
  if (/顺风|降雨|求雨|日照|大晴天|扬沙|降雪/.test(trickRoom.rendered.text)) {
    failures.push("trick-room: UI result leaked a conflicting speed or weather system");
  }
  const formSlugs = formSpecific.requests[0]?.goalConstraints?.requiredPokemon?.map((core) => core.slug) || [];
  if (formSlugs.length !== 1 || formSlugs[0] !== "rotom-wash" || !formSpecific.rendered.cards.some((name) => /清洗洛托姆/.test(name))) {
    failures.push(`form-hard-constraint: UI did not preserve Rotom-Wash, got ${JSON.stringify(formSlugs)}`);
  }
  if (coached.coachRequestCount !== 1) failures.push(`AI coach: expected one request, got ${coached.coachRequestCount}`);
  if (!coached.rendered.text.includes("AI 对局方案")) failures.push("AI coach: rendered result is missing the AI coaching section");
  if (designed.designRequestCount !== 1) failures.push(`AI design: expected one request, got ${designed.designRequestCount}`);
  if (designed.requests[0]?.buildMethod !== "ai-designed") failures.push("AI design: strict build payload lost the selected build method");
  if (!designed.requests[0]?.aiDraft?.pokemon?.length) failures.push("AI design: strict build payload is missing the AI draft");
  if (!designed.rendered.text.includes("AI 原创草案")) failures.push("AI design: rendered result is missing the AI design report");
  if (!designed.rendered.text.includes("AI 原创设计：逐只配置经严格验证")) failures.push("AI design: rendered result is missing the AI-design source label");
  if (partialDesigned.rendered.className.includes("is-error") || partialDesigned.rendered.cards.length !== 6) failures.push("AI partial design: incomplete model output should still produce a six-member verified team");
  if (!partialDesigned.rendered.text.includes("AI \u53ea\u8fd4\u56de\u4e86 2 \u4e2a")) failures.push("AI partial design: result did not disclose strict completion of the incomplete draft");
  if (!failedDesign.rendered.className.includes("is-error")) failures.push("AI design failure: strict failure should remain visible instead of silently substituting a sample team");
  if (failedDesign.rendered.text.includes("热门完整样本")) failures.push("AI design failure: substituted a complete popular sample after an AI-design failure");
  console.log(JSON.stringify({ ok: failures.length === 0, failures, live, fallback, coached, designed, shortName, trickRoom, formSpecific }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}
