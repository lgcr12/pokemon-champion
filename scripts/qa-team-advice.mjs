import { chromium } from "playwright";
import { fallbackAdvice } from "../server.mjs";

const BASE_URL = process.env.QA_BASE_URL || "http://127.0.0.1:4175/";

const goals = [
  {
    name: "雨天顺风队",
    goal: "雨天顺风队",
    require: { rain: true, tailwind: true, rainAbuser: true },
    forbid: [/烈焰猴[\s\S]{0,40}雨天启动手/, /Infernape[\s\S]{0,40}rain/i],
  },
  {
    name: "喷火龙顺风队",
    goal: "喷火龙顺风队",
    require: { pokemon: /喷火龙|charizard/i, tailwind: true },
    forbid: [/大嘴鸥|pelipper|降雨|drizzle/],
  },
  {
    name: "雨天队",
    goal: "雨天队",
    require: { rain: true, rainAbuser: true },
    forbid: [/烈焰猴[\s\S]{0,40}雨天启动手/, /Infernape[\s\S]{0,40}rain/i],
  },
  {
    name: "晴天队",
    goal: "晴天队",
    require: { sun: true, sunAbuser: true },
  },
  {
    name: "空间队",
    goal: "空间队",
    require: { trickRoom: true, trickRoomAbuser: true },
    forbid: [/风妖精[\s\S]{0,40}戏法空间手/, /顺风控速手[\s\S]{0,40}空间/],
  },
  {
    name: "沙暴队",
    goal: "沙暴队",
    require: { sand: true, sandAbuser: true },
  },
  {
    name: "雪天队",
    goal: "雪天队",
    require: { snow: true, snowAbuser: true },
  },
];

const goalFilter = String(process.env.QA_GOAL || "").trim();
const selectedGoals = goalFilter ? goals.filter((item) => item.name.includes(goalFilter) || item.goal.includes(goalFilter)) : goals;
const diversityRuns = Number(process.env.QA_DIVERSITY_RUNS || 6);
const runRealBattle = process.env.QA_REAL_BATTLE !== "0";

function textOfMember(item = {}) {
  return [
    item.text,
    item.name,
    item.slug,
    item.role,
    item.item,
    item.ability,
    ...(Array.isArray(item.moves) ? item.moves : []),
    item.note,
  ].filter(Boolean).join(" ");
}

const teamText = (team = []) => team.map(textOfMember).join(" ");

function familyKey(item = {}) {
  const text = textOfMember(item).toLowerCase();
  if (/幽尾玄鱼|basculegion/.test(text)) return "basculegion";
  if (/鬃岩狼人|lycanroc/.test(text)) return "lycanroc";
  if (/洛托姆|rotom/.test(text)) return "rotom";
  return String(item.name || item.slug || item.id || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/（.*?）/g, "")
    .replace(/雌性|雄性|超级|阿罗拉|伽勒尔|洗翠|帕底亚/g, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "")
    .replace(/mega[xy]?$/i, "")
    .replace(/female|male|therian|incarnate|alola|galar|hisui|paldea|midday|midnight|dusk$/i, "");
}

function hasTailwind(team) {
  return team.some((item) => /顺风|tailwind|おいかぜ/i.test(textOfMember(item)));
}

function setsTheme(team, theme) {
  return team.some((item) => {
    const text = textOfMember(item);
    if (theme === "rain") return /(降雨|drizzle|求雨|rain[-\s]?dance|大嘴鸥|pelipper|蚊香蛙皇|politoed|盖欧卡|kyogre)/i.test(text);
    if (theme === "sun") return /(日照|drought|大晴天|sunny[-\s]?day|煤炭龟|torkoal|九尾|ninetales|固拉多|groudon)/i.test(text);
    if (theme === "trickRoom") return /(戏法空间|trick[-\s]?room)/i.test(text);
    if (theme === "sand") return /(扬沙|sand[-\s]?stream|沙暴|sandstorm|班基拉斯|tyranitar|河马兽|hippowdon|庞岩怪|gigalith)/i.test(text);
    if (theme === "snow") return /(降雪|snow[-\s]?warning|雪景|snowscape|冰雹|hail|阿罗拉[\s\S]*九尾|九尾[\s\S]*阿罗拉|alolan[\s\S]*ninetales|暴雪王|abomasnow)/i.test(text);
    return false;
  });
}

function hasAbuser(team, theme) {
  return team.some((item) => {
    const text = textOfMember(item);
    if (theme === "rain") return /(雨天收益打手|悠游自如|swift swim|电光束|electro[-\s]?shot|打雷|thunder|暴风|hurricane|水炮|hydro pump|波动冲|wave crash|刺龙王|kingdra|乐天河童|ludicolo|戽斗尖梭|barraskewda|铝钢桥龙|archaludon|海豚侠|palafin|巨沼怪|swampert|暴噬龟|drednaw)/i.test(text);
    if (theme === "sun") return /(晴天收益打手|叶绿素|chlorophyll|太阳之力|solar power|日光束|solar beam|热风|heat wave|喷火|eruption|妙蛙花|venusaur|裙儿小姐|lilligant|波荡水|walking wake|振翼发|flutter mane|古玉鱼|chi-yu|喷火龙|charizard)/i.test(text);
    if (theme === "trickRoom") return /(空间收益打手|低速|最慢|min speed|slow|煤炭龟|torkoal|月月熊|ursaluna|铁掌力士|hariyama|布莉姆温|hatterene)/i.test(text);
    if (theme === "sand") return /(沙暴收益打手|拨沙|sand rush|沙之力|sand force|龙头地鼠|excadrill|鬃岩狼人|lycanroc)/i.test(text);
    if (theme === "snow") return /(雪天收益打手|拨雪|slush rush|极光幕|aurora veil|暴风雪|blizzard|浩大鲸|cetitan|冻脊龙|baxcalibur|铁包袱|iron bundle|阿罗拉[\s\S]*穿山王|sandslash[\s\S]*alola)/i.test(text);
    return false;
  });
}

function assertTeam(goalCase, format, block, score, warningText = "") {
  const team = block?.team || [];
  const text = teamText(team);
  const failures = [];
  const families = new Map();
  if (team.length !== 6) failures.push(`${format} 不是 6 只`);
  for (const item of team) {
    const key = familyKey(item);
    if (!key) continue;
    if (families.has(key)) failures.push(`${format} 同族/形态重复：${families.get(key)}、${item.name || "未知成员"}`);
    else families.set(key, item.name || key);
  }
  if (goalCase.require?.pokemon && !goalCase.require.pokemon.test(text)) failures.push(`${format} 缺少指定核心`);
  if (goalCase.require?.tailwind && !hasTailwind(team)) failures.push(`${format} 缺少真实顺风手`);
  if (goalCase.require?.rain && !setsTheme(team, "rain")) failures.push(`${format} 缺少真实雨天来源`);
  if (goalCase.require?.sun && !setsTheme(team, "sun")) failures.push(`${format} 缺少真实晴天来源`);
  if (goalCase.require?.trickRoom && !setsTheme(team, "trickRoom")) failures.push(`${format} 缺少真实戏法空间手`);
  if (goalCase.require?.sand && !setsTheme(team, "sand")) failures.push(`${format} 缺少真实沙暴来源`);
  if (goalCase.require?.snow && !setsTheme(team, "snow")) failures.push(`${format} 缺少真实雪天来源`);
  if (goalCase.require?.rainAbuser && !hasAbuser(team, "rain")) failures.push(`${format} 缺少雨天收益打手`);
  if (goalCase.require?.sunAbuser && !hasAbuser(team, "sun")) failures.push(`${format} 缺少晴天收益打手`);
  if (goalCase.require?.trickRoomAbuser && !hasAbuser(team, "trickRoom")) failures.push(`${format} 缺少空间收益打手`);
  if (goalCase.require?.sandAbuser && !hasAbuser(team, "sand")) failures.push(`${format} 缺少沙暴收益打手`);
  if (goalCase.require?.snowAbuser && !hasAbuser(team, "snow")) failures.push(`${format} 缺少雪天收益打手`);
  for (const pattern of goalCase.forbid || []) {
    if (pattern.test(text)) failures.push(`${format} 命中禁用模式：${pattern}`);
  }
  if (/[\u3040-\u30ff]/.test(text)) failures.push(`${format} 含日文假名`);
  const leakedEnglish = text.match(/\b(?:aerodactylite|hawluchanite|electro-shot|flash-cannon|draco-meteor|weather-ball|rain abuser|sun abuser|tailwind setter|great tusk|gholdengo|incineroar|archaludon|hydreigon|gyarados|pelipper|whimsicott|talonflame|charizard|infernape)\b/i);
  if (leakedEnglish) failures.push(`${format} 含未中文化英文：${leakedEnglish[0]}`);
  for (const item of team) {
    const itemText = textOfMember(item);
    if (!/道具：/.test(itemText) || !/特性：/.test(itemText) || item.moveCount < 4) {
      failures.push(`${format} ${item.name || "未知成员"} 配置不完整`);
    }
  }
  if (/没有满足用户目标|缺少要求的招式|这是雨天队请求|这是晴天队请求|这是顺风队请求|这是空间队请求|这是沙暴队请求|这是雪天队请求|没有说明用户要求的职责|Mega 规划建议主 Mega 为|结果使用低速\/空间思路但没有戏法空间手|Mega 位过多|超级 位过多|有 2 个 (?:Mega|超级) 候选/.test(warningText)) {
    failures.push(`${format} 页面仍显示目标未满足警告`);
  }
  if (Number(score || 0) < 45) failures.push(`${format} 结构可信度过低：${score}`);
  return failures;
}

async function waitForApp(page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ai-user-goal", { timeout: 60000 });
  await page.waitForSelector("#data-meta", { timeout: 60000 });
}

async function setGoal(page, goal, format = "single") {
  await page.click(format === "double" ? "#double-format" : "#single-format");
  await page.selectOption("#ai-build-intent", "new-team");
  await page.selectOption("#ai-prompt-mode", "quick");
  await page.fill("#ai-user-goal", goal);
}

async function installAdviceRoute(page, records) {
  await page.route("**/api/team-advice", async (route) => {
    const body = route.request().postDataJSON();
    const startedAt = Date.now();
    console.error(`[qa] /api/team-advice start: ${body.userGoal || "无目标"}${body.correction ? " correction" : ""}`);
    const advice = fallbackAdvice(body, "local QA fallback");
    console.error(`[qa] /api/team-advice done: ${body.userGoal || "无目标"} ${Date.now() - startedAt}ms`);
    records.push({
      goal: body.userGoal,
      avoidPreviousTeams: body.avoidPreviousTeams || null,
      advice,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ model: "qa-local", provider: "qa", text: "{}", parsed: false, advice }),
    });
  });
}

async function installFakeBattleRoute(page) {
  await page.route("**/api/battle-eval", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        record: "2胜1负2平",
        winRate: 40,
        results: [
          {
            result: "loss",
            opponentName: "QA 靶队",
            turns: 7,
            actions: { moves: 12, switches: 2, teamPreview: 1 },
            trace: ["队伍预览：QA 靶队", "第 1 回合：雨天手启动天气", "第 2 回合：顺风手建立速度线", "第 7 回合：被靶队反打，记录失败分支"],
            errors: [],
            failureReasons: ["测试用非全胜结果"],
          },
        ],
      }),
    });
  });
}

async function extractRenderedAdvice(page) {
  return page.evaluate(() => {
    const scoreText = document.querySelector(".ai-structure-score")?.textContent || "";
    const score = Number(scoreText.match(/(\d+)\/100/)?.[1] || 0);
    const warningText = document.querySelector(".ai-tags.warning")?.textContent || "";
    const outputText = document.querySelector("#ai-output")?.innerText || "";
    const outputClass = document.querySelector("#ai-output")?.className || "";
    const extract = (format) => ({
      team: [...document.querySelectorAll(`[data-ai-mon-format="${format}"]`)].map((card) => ({
        name: card.querySelector("h3")?.textContent?.trim() || "",
        role: card.querySelector(".ai-mon-head p")?.textContent?.trim() || "",
        text: card.textContent || "",
        moveCount: card.querySelectorAll(".ai-moves span").length,
      })),
    });
    return {
      score,
      warningText,
      outputText,
      outputClass,
      single: extract("single"),
      double: extract("double"),
      reviewButtonCount: document.querySelectorAll("[data-battle-review-open], #battle-review-btn").length,
      battleText: document.querySelector(".battle-eval")?.innerText || "",
    };
  });
}

async function generateAdvice(page, goalCase) {
  await setGoal(page, goalCase.goal, "single");
  await page.click("#ai-build-config");
  await page.waitForSelector(".ai-mon-card", { timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector("#ai-output")?.classList.contains("is-loading"), null, { timeout: 90000 });
  await page.waitForTimeout(300);
  return extractRenderedAdvice(page);
}

async function runFunctionRegression(page) {
  const results = [];
  for (const goalCase of selectedGoals) {
    console.error(`[qa] goal start: ${goalCase.name}`);
    const rendered = await generateAdvice(page, goalCase);
    const failures = [
      ...assertTeam(goalCase, "single", rendered.single, rendered.score, rendered.warningText),
      ...assertTeam(goalCase, "double", rendered.double, rendered.score, rendered.warningText),
    ];
    results.push({
      name: goalCase.name,
      score: rendered.score,
      single: rendered.single.team.map((item) => item.name),
      double: rendered.double.team.map((item) => item.name),
      warningText: rendered.warningText,
      failures,
    });
    console.error(`[qa] goal done: ${goalCase.name} score=${rendered.score} failures=${failures.length}`);
  }
  return results;
}

async function runDiversityRegression(page) {
  const signatures = [];
  const failures = [];
  for (let index = 0; index < diversityRuns; index += 1) {
    console.error(`[qa] diversity run ${index + 1}/${diversityRuns}`);
    const rendered = await generateAdvice(page, goals[0]);
    const signature = rendered.single.team.map((item) => item.name).join("/");
    if (signatures.includes(signature)) failures.push(`第 ${index + 1} 次完全重复：${signature}`);
    signatures.push(signature);
  }
  const uniqueCount = new Set(signatures).size;
  if (diversityRuns >= 6 && uniqueCount < 4) failures.push(`${diversityRuns} 次雨天顺风仅 ${uniqueCount} 套不同队伍`);
  if (diversityRuns < 6 && uniqueCount < Math.min(2, diversityRuns)) failures.push(`${diversityRuns} 次雨天顺风没有产生变化`);
  return { signatures, uniqueCount, failures };
}

async function newPage(browser, { fakeBattle = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.addInitScript(() => {
    localStorage.setItem("champion-lab-ai-config-v1", JSON.stringify({
      provider: "custom",
      endpoint: "chat",
      baseUrl: "https://qa.invalid/v1",
      apiKey: "qa-key",
      model: "qa-model",
    }));
    localStorage.removeItem("champion-lab-ai-failure-memory-v1");
    localStorage.removeItem("champion-lab-ai-battle-history-v1");
  });
  const records = [];
  await installAdviceRoute(page, records);
  if (fakeBattle) await installFakeBattleRoute(page);
  await waitForApp(page);
  return { page, records };
}

async function runPageRegression(browser) {
  console.error("[qa] page regression start");
  const { page, records } = await newPage(browser, { fakeBattle: false });
  const rendered = await generateAdvice(page, goals[0]);
  await page.waitForTimeout(8000);
  const afterBattle = await extractRenderedAdvice(page);
  await page.click("[data-battle-review-open]");
  await page.waitForSelector("#battle-review-root:not([hidden])", { timeout: 15000 });
  await page.waitForTimeout(500);
  const review = await page.evaluate(() => ({
    open: !document.querySelector("#battle-review-root")?.hidden,
    traceCount: document.querySelectorAll(".battle-review-trace li").length,
    text: document.querySelector("#battle-review-root")?.innerText || "",
  }));
  await page.close();
  console.error(`[qa] page regression done trace=${review.traceCount}`);
  const failures = [
    ...assertTeam(goals[0], "single", afterBattle.single, afterBattle.score, afterBattle.warningText),
    ...assertTeam(goals[0], "double", afterBattle.double, afterBattle.score, afterBattle.warningText),
  ];
  if (!afterBattle.reviewButtonCount) failures.push("页面没有对局回顾按钮");
  if (!review.open) failures.push("对局回顾面板没有打开");
  if (review.traceCount <= 0) failures.push("对局回顾没有战斗过程日志");
  if (/100%|全胜|10胜0负0平|5胜0负0平/.test(`${afterBattle.battleText} ${review.text}`)) failures.push("本地模拟仍呈现全胜/100% 倾向");
  if (/is-loading/.test(afterBattle.outputClass)) failures.push("AI 输出仍卡在 loading 状态");
  if (!records.length) failures.push("页面没有发出 /api/team-advice 请求");
  return { rendered, afterBattle, review, records, failures };
}

const browser = await chromium.launch({ headless: true });
try {
  const { page, records } = await newPage(browser, { fakeBattle: true });
  const functionResults = await runFunctionRegression(page);
  const diversity = await runDiversityRegression(page);
  await page.close();
  const pageResult = runRealBattle
    ? await runPageRegression(browser)
    : { failures: [], review: { open: false, traceCount: 0 }, afterBattle: { outputClass: "", battleText: "" }, records: [] };
  const failures = [
    ...functionResults.flatMap((item) => item.failures.map((failure) => `${item.name}: ${failure}`)),
    ...diversity.failures.map((failure) => `连续生成: ${failure}`),
    ...pageResult.failures.map((failure) => `页面回归: ${failure}`),
  ];
  const report = {
    ok: failures.length === 0,
    failures,
    functionResults: functionResults.map((item) => ({
      name: item.name,
      score: item.score,
      single: item.single,
      double: item.double,
      warningText: item.warningText,
    })),
    diversity,
    page: {
      reviewOpen: pageResult.review.open,
      traceCount: pageResult.review.traceCount,
      outputClass: pageResult.afterBattle.outputClass,
      battleText: pageResult.afterBattle.battleText,
      requestCount: records.length + pageResult.records.length,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await browser.close();
}
