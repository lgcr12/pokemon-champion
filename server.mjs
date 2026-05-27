import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(".");
const require = createRequire(import.meta.url);
const { TeamValidator, Teams } = require("pokemon-showdown");
const PORT = Number(process.env.PORT || 4174);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "";
const COCKPIT_LOCAL_ACCESS_CONFIG =
  process.env.COCKPIT_LOCAL_ACCESS_CONFIG ||
  join(process.env.USERPROFILE || "", ".antigravity_cockpit", "codex_local_access.json");
const COCKPIT_DEFAULT_MODEL = "gpt-5.4-mini";
const OPENAI_DEFAULT_MODEL = "gpt-4.1-mini";
let refreshTask = null;
const DEFAULT_ITEM_POOL = ["生命宝珠", "气势披带", "讲究围巾", "讲究眼镜", "突击背心", "剩饭"];
const ADVICE_POKEMON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "role", "item", "ability", "nature", "evs", "level", "moves", "note"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    item: { type: "string" },
    ability: { type: "string" },
    nature: { type: "string" },
    evs: { type: "string" },
    level: { type: "string" },
    moves: {
      type: "array",
      maxItems: 4,
      items: { type: "string" },
    },
    note: { type: "string" },
  },
};
const ADVICE_FORMAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["team", "plan", "watch"],
  properties: {
    team: {
      type: "array",
      maxItems: 6,
      items: ADVICE_POKEMON_SCHEMA,
    },
    plan: { type: "string" },
    watch: { type: "array", maxItems: 4, items: { type: "string" } },
  },
};
const ADVICE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "single", "double"],
  properties: {
    summary: { type: "string" },
    single: ADVICE_FORMAT_SCHEMA,
    double: ADVICE_FORMAT_SCHEMA,
  },
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function buildPrompt(payload) {
  const task = payload.mode === "complete-team" ? "补全队伍" : "给当前队伍配招";
  const promptMode =
    payload.promptMode === "compare"
      ? "多方案比较：先给 2 到 3 个方向，再选择最稳方向输出最终 JSON。"
      : payload.promptMode === "deep"
        ? "详细推理：重点分析速度控制、轮转、终盘、双打守住/站位，但最终仍只输出 JSON。"
        : "快速建议：优先给可直接应用的稳妥配置。";
  return `
你是 Pokemon Champions 队伍配置助手。只返回一个 JSON 对象。
第一个字符必须是 {，最后一个字符必须是 }。
不要 Markdown，不要标题，不要项目符号，不要解释性结尾，不写“如果你愿意...”之类收尾话。

任务：${task}
推理模式：${promptMode}
当前规则：${payload.formatLabel || payload.format}
用户目标：${payload.userGoal || "未填写"}

输出要求：
1. 简洁，最多 6 只宝可梦，每只 1 到 2 句说明。
2. 必须同时给出 single 和 double 两个分区，两个分区都要有各自的 team、plan、watch。
3. single.team 和 double.team 都必须是最终可应用队伍。优先保留 selectedPokemon，再从 metaCandidates 补到 6 只。
4. 必须以 Pokemon Champions 当前数据为主：selectedPokemon、metaCandidates、importedTeam、commonMoves、commonItems、commonAbilities 是主数据源。
5. Showdown / Smogon / externalKnowledge 只作为补充参考，用来理解环境趋势、英文规则和 matchup；不能覆盖 Champions 可用池，不能凭外部数据加入 metaCandidates 中不存在的宝可梦。
6. 招式、道具、特性优先使用 Champions 数据中的 commonMoves、commonItems、commonAbilities；外部知识只在 Champions 数据缺失或写“可替换”时辅助说明。
7. 单打与双打配置要明显按规则分化：单打重视钉子、强化、换血、清场；双打重视守住、控速、站场协作、击掌奇袭、威吓、广域防守或空间/顺风。
8. 每只配置包含 id、name、role、item、ability、nature、evs、moves。moves 最多 4 个。
9. 不写“如果你愿意...”之类收尾话。
10. 如果不确定，用“可替换”标注，不要编造数据来源。
11. 必须参考 battleKnowledge 中的 risks、strengths、stateTags 和成员 flags，不要只按使用率补队。
12. 必须优先处理 battleKnowledge.needs、roleCoverage、typeProfile、legality 中暴露的问题；如果 risks 包含缺少控速、缺少清场、守住位偏少、终盘路线不明确，输出方案必须明确补足对应问题。
13. 同一分区的 6 只宝可梦不能携带重复道具；如果热门配置重复，必须换成合理替代道具。
14. 每只宝可梦必须包含 level，默认写 "50"。
15. 选补位时要说明队伍职责：输出端、控速端、防守换入、终盘路线、单打撒钉/除钉或双打站场协作至少覆盖其中 3 类。
16. 如果 battleKnowledge.legality.violations 不为空，最终 JSON 中必须规避这些问题，不要重复输出同样违规配置。
17. 必须参考 compositionReport 的 style、cores、winConditions、gaps、buildPriorities。输出队伍不能只堆热门成员，必须围绕已识别核心补足阵容结构。
18. 如果 compositionReport.gaps 和 matchupReport.threats 指向同一问题，优先用补位或配置调整解决这个问题，并在 note 中说明该成员解决了什么缺口。

JSON 结构：
{
  "summary": "一句话总判断",
  "single": {
    "team": [
      {"id":"", "name":"", "role":"", "item":"", "ability":"", "nature":"", "evs":"", "level":"50", "moves":[""], "note":""}
    ],
    "plan":"",
    "watch":[""]
  },
  "double": {
    "team": [
      {"id":"", "name":"", "role":"", "item":"", "ability":"", "nature":"", "evs":"", "level":"50", "moves":[""], "note":""}
    ],
    "plan":"",
    "watch":[""]
  }
}

输入数据：
${JSON.stringify(payload)}
`;
}

function showdownFormatFor(format = "single") {
  const value = String(format || "").toLowerCase();
  if (value.includes("vgc")) return "gen9vgc2025regg";
  if (value.includes("double")) return "gen9nationaldexdoubles";
  return "gen9nationaldex";
}

function validateShowdownTeam(text = "", format = "single") {
  const formatId = showdownFormatFor(format);
  const team = Teams.import(text);
  if (!team?.length) {
    return {
      ok: false,
      format: formatId,
      problems: ["没有解析到有效的 Showdown 队伍文本。"],
      teamSize: 0,
    };
  }
  const validator = TeamValidator.get(formatId);
  const problems = (validator.validateTeam(team) || []).filter((problem) => !/is level 50, but this format allows level 100/i.test(problem));
  return {
    ok: problems.length === 0,
    format: formatId,
    problems,
    teamSize: team.length,
  };
}

function extractOutputText(data) {
  const chatText = data.choices?.[0]?.message?.content;
  if (typeof chatText === "string") return chatText;
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      if (content.type === "text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function parseAdviceJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function plainText(value = "") {
  return String(value)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~|[\]()]/g, " ")
    .replace(/^\s*[-+\d.、]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstName(entries = []) {
  const item = Array.isArray(entries) ? entries.find(Boolean) : null;
  if (!item) return "";
  return plainText(typeof item === "string" ? item : item.name || "");
}

function firstUsefulLine(text) {
  return (
    text
      .split(/\r?\n/)
      .map(plainText)
      .find((line) => line.length >= 12 && !/^总判断|建议配置|补队方案|队伍缺口|替换位/.test(line)) ||
    "围绕当前核心补齐抗性、速度控制和收尾位。"
  );
}

function watchItems(text) {
  const lines = text
    .split(/\r?\n/)
    .map(plainText)
    .filter((line) => line.length >= 4 && line.length <= 28);
  return [...new Set(lines)].slice(0, 4);
}

function advicePokemon(mon = {}, index, format = "single") {
  const role = mon.roles?.[0] || (index === 0 ? "核心输出" : "补位");
  const moves = (mon.commonMoves || mon.moves || []).map((move) => firstName([move])).filter(Boolean).slice(0, 4);
  if (format === "double" && moves.length < 4 && !moves.includes("守住")) moves.push("守住");
  return {
    id: String(mon.id || mon.slug || mon.name || ""),
    name: String(mon.name || mon.slug || `成员 ${index + 1}`),
    role: format === "double" && role === "补位" ? "双打协作位" : role,
    item: firstName(mon.commonItems || mon.items) || "可替换道具",
    ability: firstName(mon.commonAbilities || mon.abilities) || "可替换特性",
    nature: firstName(mon.commonNatures || mon.natures) || "按速度线调整",
    evs: role.includes("耐久") || role.includes("功能") ? "耐久为主" : "速度与主攻为主",
    level: "50",
    moves,
    note:
      format === "double"
        ? "按双打节奏补足守住、控速或站场协作。"
        : role.includes("功能")
          ? "负责转场、钉子、控速或状态压制。"
          : "承担主要输出、强化或收尾任务。",
  };
}

function normalizeAdviceItems(advice) {
  for (const format of ["single", "double"]) {
    const team = Array.isArray(advice?.[format]?.team) ? advice[format].team : [];
    const used = new Set();
    team.forEach((mon, index) => {
      mon.level = String(mon.level || "50");
      const key = normalizedItem(mon.item);
      if (!key || used.has(key)) {
        const replacement = DEFAULT_ITEM_POOL.find((item) => !used.has(normalizedItem(item))) || `可替换道具${index + 1}`;
        mon.item = replacement;
        used.add(normalizedItem(replacement));
      } else {
        used.add(key);
      }
    });
  }
  return advice;
}

function normalizedItem(value = "") {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function fallbackAdvice(payload, text) {
  const selected = Array.isArray(payload.selectedPokemon) ? payload.selectedPokemon : [];
  const candidates = Array.isArray(payload.metaCandidates) ? payload.metaCandidates : [];
  const seen = new Set();
  const baseTeam = [];

  for (const mon of [...selected, ...candidates]) {
    const key = String(mon?.id || mon?.slug || mon?.name || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    baseTeam.push(mon);
    if (baseTeam.length === 6) break;
  }

  const summary = firstUsefulLine(text);
  const watch = watchItems(text);
  const currentPlan = summary.length > 56 ? `${summary.slice(0, 56)}。` : summary;
  const singlePlan = payload.format === "single" ? currentPlan : "单打更重视一换一效率、钉子压力、强化机会和后期清场。";
  const doublePlan = payload.format === "double" ? currentPlan : "双打需要补守住、站场协作、威吓、顺风或空间等控速手段。";

  return normalizeAdviceItems({
    summary: currentPlan,
    single: {
      team: baseTeam.map((mon, index) => advicePokemon(mon, index, "single")),
      plan: singlePlan,
      watch,
    },
    double: {
      team: baseTeam.map((mon, index) => advicePokemon(mon, index, "double")),
      plan: doublePlan,
      watch,
    },
  });
}

function parseSseResponse(raw) {
  const deltas = [];
  let doneText = "";
  let completedResponse = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }

    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      doneText = event.text;
    } else if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltas.push(event.delta);
    } else if (event.type === "response.completed" && event.response) {
      completedResponse = event.response;
    }
  }

  return {
    output_text: doneText || deltas.join(""),
    response: completedResponse,
  };
}

async function readAIResponse(response) {
  const raw = await response.text();
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    return parseSseResponse(raw);
  }
  return JSON.parse(raw);
}

async function readCockpitLocalAccess() {
  try {
    const config = JSON.parse(await readFile(COCKPIT_LOCAL_ACCESS_CONFIG, "utf8"));
    if (!config.enabled || !config.port || !config.apiKey) return null;
    return {
      apiKey: config.apiKey,
      baseUrl: `http://127.0.0.1:${config.port}`,
      model: OPENAI_MODEL || COCKPIT_DEFAULT_MODEL,
      source: "cockpit",
    };
  } catch {
    return null;
  }
}

async function resolveAIConfig() {
  if (OPENAI_API_KEY) {
    return {
      apiKey: OPENAI_API_KEY,
      baseUrl: OPENAI_BASE_URL.replace(/\/+$/, ""),
      model: OPENAI_MODEL || OPENAI_DEFAULT_MODEL,
      source: "openai-env",
    };
  }

  return readCockpitLocalAccess();
}

function resolveRequestAIConfig(payload = {}) {
  const config = payload.aiConfig || {};
  const apiKey = String(config.apiKey || "").trim();
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(config.model || "").trim();
  if (!apiKey || !baseUrl || !model) return null;
  return {
    apiKey,
    baseUrl,
    model,
    endpoint: config.endpoint === "chat" ? "chat" : "responses",
    source: config.provider || "custom-ui",
  };
}

function aiEndpoint(baseUrl, path) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1")) return `${normalized}${path}`;
  return `${normalized}/v1${path}`;
}

async function requestAI(aiConfig, payload, useJsonSchema) {
  if (aiConfig.endpoint === "chat") {
    return fetch(aiEndpoint(aiConfig.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${aiConfig.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [{ role: "user", content: buildPrompt(payload) }],
        temperature: 0.3,
        response_format: useJsonSchema ? { type: "json_object" } : undefined,
      }),
    });
  }

  const body = {
    model: aiConfig.model,
    input: buildPrompt(payload),
    stream: false,
  };

  if (useJsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: "pokemon_team_advice",
        strict: true,
        schema: ADVICE_JSON_SCHEMA,
      },
    };
  }

  return fetch(aiEndpoint(aiConfig.baseUrl, "/responses"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${aiConfig.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function handleAI(req, res) {
  const payload = await readJson(req);
  const aiConfig = resolveRequestAIConfig(payload) || (await resolveAIConfig());
  if (!aiConfig) {
    sendJson(res, 501, {
      error: "缺少 AI 配置。请在页面里填写 API Key / Base URL / 模型，或设置 OPENAI_API_KEY，或启用 Cockpit Codex Local Access。",
    });
    return;
  }

  let response;
  let data;
  try {
    response = await requestAI(aiConfig, payload, true);
    data = await readAIResponse(response);

    if (!response.ok && [400, 422].includes(response.status)) {
      response = await requestAI(aiConfig, payload, false);
      data = await readAIResponse(response);
    }
  } catch (err) {
    sendJson(res, 502, {
      error: `AI 接口连接失败：${err.message || "请检查 Base URL、接口类型、网络或代理配置。"}`,
    });
    return;
  }

  if (!response.ok) {
    sendJson(res, response.status, {
      error: data.error?.message || "OpenAI API request failed.",
    });
    return;
  }

  const text = extractOutputText(data);
  const advice = normalizeAdviceItems(parseAdviceJson(text) || fallbackAdvice(payload, text));
  sendJson(res, 200, {
    model: aiConfig.model,
    provider: aiConfig.source,
    text,
    advice,
  });
}

async function handleAITest(req, res) {
  const payload = await readJson(req);
  const aiConfig = resolveRequestAIConfig(payload);
  if (!aiConfig) {
    sendJson(res, 400, { error: "请填写 API Key、Base URL 和模型。" });
    return;
  }
  try {
    const response = await requestAI(
      aiConfig,
      {
        mode: "config",
        format: "single",
        formatLabel: "单打",
        userGoal: "连接测试。请只返回 JSON。",
        selectedPokemon: [{ id: 25, name: "皮卡丘" }],
        metaCandidates: [],
      },
      false,
    );
    const data = await readAIResponse(response);
    if (!response.ok) {
      sendJson(res, response.status, {
        error: data.error?.message || "AI 测试失败。请检查 API Key、模型名称、余额或接口类型。",
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      provider: aiConfig.source,
      model: aiConfig.model,
    });
  } catch (err) {
    sendJson(res, 502, {
      error: `连接失败：${err.message || "请检查 Base URL、接口类型、网络或代理配置。"}`,
    });
  }
}

async function handleAIModels(req, res) {
  const payload = await readJson(req);
  const aiConfig = resolveRequestAIConfig(payload);
  if (!aiConfig) {
    sendJson(res, 400, { error: "请先填写 API Key 和 Base URL。" });
    return;
  }
  try {
    const response = await fetch(aiEndpoint(aiConfig.baseUrl, "/models"), {
      method: "GET",
      headers: {
        authorization: `Bearer ${aiConfig.apiKey}`,
        "content-type": "application/json",
      },
    });
    const data = await readAIResponse(response);
    if ([404, 405].includes(response.status)) {
      sendJson(res, 200, {
        provider: aiConfig.source,
        models: [],
        unsupported: true,
        message: "当前服务商不开放 /v1/models 模型列表接口，请使用预设模型或自定义模型。",
      });
      return;
    }
    if (!response.ok) {
      sendJson(res, response.status, {
        error: data.error?.message || "获取模型列表失败。该服务商可能不开放 /v1/models。",
      });
      return;
    }
    const models = (Array.isArray(data.data) ? data.data : [])
      .map((item) => item.id || item.name)
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b)));
    sendJson(res, 200, {
      provider: aiConfig.source,
      models,
    });
  } catch (err) {
    sendJson(res, 502, {
      error: `获取模型列表失败：${err.message || "请检查网络、Base URL 或服务商是否支持 /v1/models。"}`,
    });
  }
}

function runRefreshTask(mode = "data") {
  if (refreshTask?.running) return refreshTask;
  const args =
    mode === "missing-all"
      ? ["run", "fetch:missing-all"]
      : mode === "all"
      ? ["run", "fetch:all"]
      : mode === "knowledge"
        ? ["run", "fetch:knowledge"]
      : mode === "teams"
        ? ["run", "fetch:teams:fast"]
        : ["run", "fetch:data"];
  const missingOnly = mode === "data" || mode === "missing" || mode === "missing-all";
  refreshTask = {
    running: true,
    mode,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    exitCode: null,
    fetched: 0,
    checked: 0,
    teamsFetched: 0,
    stage: "starting",
    output: "",
    error: "",
  };
  const child = spawn("npm", args, {
    cwd: ROOT,
    shell: process.platform === "win32",
    env: {
      ...process.env,
      MISSING_ONLY: missingOnly ? "1" : process.env.MISSING_ONLY || "",
      ENRICH_TEAMS: missingOnly ? "0" : process.env.ENRICH_TEAMS || "",
      LIMIT: missingOnly ? process.env.REFRESH_LIMIT || "80" : process.env.LIMIT || "",
      REQUEST_DELAY_MS: missingOnly ? process.env.REQUEST_DELAY_MS || "80" : process.env.REQUEST_DELAY_MS || "250",
    },
  });
  const append = (key, chunk) => {
    const text = chunk.toString();
    refreshTask[key] = `${refreshTask[key]}${text}`.slice(-8000);
    if (key === "output") {
      if (/Filling missing|Fetching #/.test(text)) refreshTask.stage = "data";
      if (/Fetching team page|Wrote \d+ teams/.test(text)) refreshTask.stage = "teams";
      if (/Fetching Pokemon Showdown|Fetching Smogon|Wrote knowledge cache/.test(text)) refreshTask.stage = "knowledge";
      refreshTask.fetched += (text.match(/Filling missing|Fetching #/g) || []).length;
      for (const match of text.matchAll(/Wrote (\d+) teams/g)) {
        refreshTask.teamsFetched = Number(match[1] || 0);
      }
      for (const match of text.matchAll(/Missing-only refresh filled (\d+) entries/g)) {
        refreshTask.checked += Number(match[1] || 0);
      }
    }
  };
  child.stdout.on("data", (chunk) => append("output", chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => append("error", chunk.toString("utf8")));
  child.on("close", (code) => {
    refreshTask.running = false;
    refreshTask.exitCode = code;
    refreshTask.finishedAt = new Date().toISOString();
  });
  child.on("error", (err) => {
    refreshTask.running = false;
    refreshTask.exitCode = 1;
    refreshTask.finishedAt = new Date().toISOString();
    append("error", err.message || "Failed to start refresh task.");
  });
  return refreshTask;
}

async function handleRefresh(req, res) {
  const body = req.method === "POST" ? await readJson(req).catch(() => ({})) : {};
  const mode = ["data", "missing", "missing-all", "teams", "knowledge", "all"].includes(body.mode) ? body.mode : "data";
  const task = req.method === "POST" ? runRefreshTask(mode) : refreshTask;
  sendJson(res, 200, {
    running: Boolean(task?.running),
    mode: task?.mode || "",
    stage: task?.stage || "",
    startedAt: task?.startedAt || "",
    finishedAt: task?.finishedAt || "",
    exitCode: task?.exitCode ?? null,
    fetched: task?.fetched || 0,
    checked: task?.checked || 0,
    teamsFetched: task?.teamsFetched || 0,
    output: task?.output || "",
    error: task?.error || "",
    reason: explainRefreshFailure(task),
  });
}

function explainRefreshFailure(task) {
  const text = `${task?.error || ""}\n${task?.output || ""}`;
  if (!text || task?.running || task?.exitCode === 0) return "";
  if (/x\.com|twitter\.com|fxtwitter|ETIMEDOUT|ECONNRESET|ENETUNREACH|fetch failed/i.test(text)) {
    return "热门队伍来源包含 X/Twitter 链接，当前网络可能没有代理或无法访问 X 相关域名。可挂代理后重试，或使用快速模式仅导入基础队伍列表。";
  }
  if (/pokechamdb|No ranking|Fetch failed/i.test(text)) {
    return "环境数据源暂时无法访问或页面结构变化。请稍后重试，或降低 LIMIT 后再补缺。";
  }
  if (/pkmn\.github\.io|pokemonshowdown|play\.pokemonshowdown|Smogon/i.test(text)) {
    return "规则/知识数据源暂时无法访问。请检查服务器是否能访问 Pokemon Showdown、pkmn.github.io 和 Smogon 相关域名。";
  }
  return "抓取任务失败，请查看终端日志或 /api/refresh-data 返回的 error/output。";
}

async function ensureInitialData() {
  try {
    await stat(join(ROOT, "data", "champion-data.json"));
    await stat(join(ROOT, "data", "team-data.json"));
    await stat(join(ROOT, "data", "battle-knowledge.json"));
  } catch {
    console.log("Local data cache missing; starting initial missing-all fetch.");
    runRefreshTask("missing-all");
  }
}
async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = normalize(join(ROOT, requested));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    const fallback = await readFile(join(ROOT, "index.html"));
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(fallback);
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/team-advice") {
      await handleAI(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/ai-test") {
      await handleAITest(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/ai-models") {
      await handleAIModels(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/validate-team") {
      const body = await readJson(req).catch(() => ({}));
      sendJson(res, 200, validateShowdownTeam(body.text || "", body.format || "single"));
      return;
    }
    if ((req.method === "POST" || req.method === "GET") && req.url === "/api/refresh-data") {
      await handleRefresh(req, res);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (err) {
    sendJson(res, 500, { error: err.message || "Server error" });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Champion Lab AI server running at http://127.0.0.1:${PORT}`);
  console.log(`OpenAI model: ${OPENAI_MODEL || `${COCKPIT_DEFAULT_MODEL} via Cockpit fallback`}`);
  ensureInitialData();
});

