import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(".");
const require = createRequire(import.meta.url);
const { BattleStream, Dex, TeamValidator, Teams, getPlayerStreams } = require("pokemon-showdown");
const PORT = Number(process.env.PORT || 4174);
const BATTLE_HISTORY_PATH = join(ROOT, "data", "battle-history.json");
const TEAM_DATA_PATH = join(ROOT, "data", "team-data.json");
const POCKET_AG_COACH_RULES_PATH = join(ROOT, "skills", "pocket-ag-coach", "references", "coach-rules.json");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "";
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 240000);
const AI_REQUEST_TIMEOUTS_MS = {
  quick: Number(process.env.AI_QUICK_REQUEST_TIMEOUT_MS || 120000),
  deep: Number(process.env.AI_DEEP_REQUEST_TIMEOUT_MS || 240000),
  compare: Number(process.env.AI_COMPARE_REQUEST_TIMEOUT_MS || 300000),
};
const COCKPIT_LOCAL_ACCESS_CONFIG =
  process.env.COCKPIT_LOCAL_ACCESS_CONFIG ||
  join(process.env.USERPROFILE || "", ".antigravity_cockpit", "codex_local_access.json");
const COCKPIT_DEFAULT_MODEL = "gpt-5.4-mini";
const OPENAI_DEFAULT_MODEL = "gpt-4.1-mini";
const SHOWDOWN_SPECIES_LIST = Array.isArray(Dex?.species?.all?.()) ? Dex.species.all() : [];
const SHOWDOWN_SPECIES_BY_ID = new Map(SHOWDOWN_SPECIES_LIST.map((species) => [String(species.id || "").toLowerCase(), species]));
const SHOWDOWN_SPECIES_BY_NUM = new Map(SHOWDOWN_SPECIES_LIST.filter((species) => Number.isFinite(Number(species.num))).map((species) => [Number(species.num), species]));
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

function loadPocketAgCoachRules() {
  try {
    return JSON.parse(readFileSync(POCKET_AG_COACH_RULES_PATH, "utf8"));
  } catch {
    return null;
  }
}

const pocketAgCoachRules = loadPocketAgCoachRules();

function showdownSpeciesFromNum(value = "") {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "";
  return SHOWDOWN_SPECIES_BY_NUM.get(num)?.name || "";
}

function normalizeShowdownSpeciesText(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+$/iu.test(text)) return text;
  return text
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\bgigantamax\b/gi, "Gmax")
    .replace(/\bgmax\b/gi, "Gmax")
    .replace(/\bmega\b/gi, "Mega")
    .replace(/\bpaldean\b/gi, "Paldea")
    .replace(/\balolan\b/gi, "Alola")
    .replace(/\bgalarian\b/gi, "Galar")
    .replace(/\bhisuian\b/gi, "Hisui")
    .replace(/\bfemale\b/gi, "F")
    .replace(/\bmale\b/gi, "M")
    .replace(/\bfull[- ]?belly\b/gi, "Full-Belly")
    .replace(/^-+|-+$/g, "");
}

function showdownSpeciesVariants(value = "") {
  const text = normalizeShowdownSpeciesText(value);
  if (!text) return [];
  const variants = new Set([text]);
  const parts = text.split("-").filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());

  const specialIndex = lower.findIndex((part) => part === "mega" || part === "gmax");
  if (specialIndex >= 0) {
    const special = lower[specialIndex] === "mega" ? "Mega" : "Gmax";
    const before = parts.slice(0, specialIndex);
    const after = parts.slice(specialIndex + 1);
    const suffixParts = after.filter((part) => /^(x|y)$/i.test(part));
    const remaining = after.filter((part) => !/^(x|y)$/i.test(part));
    if (before.length) variants.add([...before, special, ...suffixParts].join("-"));
    if (before.length && suffixParts.length) variants.add([...before.filter((part) => !/^(x|y)$/i.test(part)), special, ...suffixParts].join("-"));
    if (before.length) variants.add([...before, special, ...remaining].join("-"));
    if (before.length) variants.add(before.join("-"));
    if (before.length && suffixParts.length) {
      const base = before.filter((part) => !/^(x|y)$/i.test(part));
      if (base.length) variants.add([...base, special, ...suffixParts].join("-"));
    }
  }

  if (parts.length > 1 && /^(f|m)$/i.test(parts.at(-1))) {
    variants.add(parts.slice(0, -1).join("-"));
  }
  if (parts.length > 1 && /^(f|m)$/i.test(parts.at(-1)) && parts.length > 2) {
    variants.add(parts.slice(0, -2).concat(parts.at(-2)).join("-"));
  }

  if (/^tauros-paldean-/i.test(text)) variants.add(text.replace(/^tauros-paldean-/i, "Tauros-Paldea-"));
  if (/^tauros-alolan-/i.test(text)) variants.add(text.replace(/^tauros-alolan-/i, "Tauros-Alola-"));
  if (/^wooper-paldean-/i.test(text)) variants.add(text.replace(/^wooper-paldean-/i, "Wooper-Paldea-"));
  if (/^ninetales-alolan$/i.test(text) || /^ninetales-alola$/i.test(text)) variants.add("Ninetales-Alola");
  if (/^slowking-galarian$/i.test(text)) variants.add("Slowking-Galar");
  if (/mega/i.test(text) && parts.length > 1) {
    const megaIndex = lower.findIndex((part) => part === "mega" || part === "gmax");
    if (megaIndex >= 0) {
      const head = parts.slice(0, megaIndex).filter((part) => !/^(x|y)$/i.test(part));
      const tail = parts.slice(megaIndex + 1).filter(Boolean);
      const suffix = parts.slice(0, megaIndex).filter((part) => /^(x|y)$/i.test(part));
      if (head.length) variants.add([...head, parts[megaIndex], ...suffix].join("-"));
      if (head.length && suffix.length) variants.add([...head, parts[megaIndex], ...suffix].join("-"));
      if (head.length && tail.length) variants.add([...head, parts[megaIndex], ...tail].join("-"));
    }
  }
  return [...variants].filter(Boolean);
}

function legalShowdownSpeciesName(value = "", meta = {}) {
  const candidates = [];
  if (typeof value === "number") candidates.push(showdownSpeciesFromNum(value));
  else candidates.push(String(value || ""));
  for (const extra of [
    meta?.id,
    meta?.slug,
    meta?.name,
    meta?.species,
    meta?.identifier,
    meta?.speciesIdentifier,
    meta?.nameMap?.showdown,
    meta?.pokeCamp?.identifier,
    meta?.pokeCamp?.speciesIdentifier,
  ]) {
    if (extra != null) candidates.push(extra);
  }

  for (const candidate of candidates.flatMap((item) => {
    if (typeof item === "number") return [showdownSpeciesFromNum(item)];
    const text = String(item || "").trim();
    if (!text) return [];
    const variants = [text, normalizeShowdownSpeciesText(text), ...showdownSpeciesVariants(text)];
    const numeric = text.match(/^\d+$/) ? showdownSpeciesFromNum(text) : "";
    if (numeric) variants.unshift(numeric);
    return variants;
  })) {
    const text = String(candidate || "").trim();
    if (!text) continue;
    const direct = Dex.species.get(text);
    if (direct?.exists) return direct.name;
    const compact = text.replace(/[-_]/g, "").toLowerCase();
    const byId = SHOWDOWN_SPECIES_BY_ID.get(compact);
    if (byId?.exists) return byId.name;
    const byNum = showdownSpeciesFromNum(text);
    if (byNum) return byNum;
    const stripped = text
      .replace(/[-_]?mega[-_]?[xy]?$/i, "")
      .replace(/[-_]?gmax$/i, "")
      .replace(/[-_]?(female|male|f|m)$/i, "")
      .replace(/[-_]?(alola|alolan|paldea|paldean|galar|galarian|hisui|hisuian)$/i, "");
    if (stripped && stripped !== text) {
      const strippedDirect = Dex.species.get(stripped);
      if (strippedDirect?.exists) return strippedDirect.name;
      const strippedCompact = stripped.replace(/[-_]/g, "").toLowerCase();
      const strippedById = SHOWDOWN_SPECIES_BY_ID.get(strippedCompact);
      if (strippedById?.exists) return strippedById.name;
    }
  }
  return "";
}

function pocketAgTextKey(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

function pocketAgTextBlob(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(pocketAgTextBlob).join(" ");
  if (typeof value === "object") return Object.values(value).map(pocketAgTextBlob).join(" ");
  return "";
}

function pocketAgContext(payload = {}) {
  const selected = Array.isArray(payload.selectedPokemon) ? payload.selectedPokemon : [];
  const candidates = Array.isArray(payload.metaCandidates) ? payload.metaCandidates : [];
  const targets = Array.isArray(payload.intent?.targetPokemon) ? payload.intent.targetPokemon : [];
  const fixedOpponents = [
    ...(payload.battleEvaluation?.fixedOpponentTeams?.single || []),
    ...(payload.battleEvaluation?.fixedOpponentTeams?.double || []),
  ];
  const names = [
    ...selected,
    ...targets.map((item) => item.target || item),
    ...candidates.slice(0, 18),
    ...fixedOpponents.flatMap((team) => team.members || []),
  ].flatMap((item) => [
    item?.name,
    item?.slug,
    item?.id,
    item?.english,
    item?.nameMap?.showdown,
    item?.target?.name,
    item?.target?.slug,
  ]).filter(Boolean);
  const text = [
    payload.userGoal,
    payload.format,
    payload.formatLabel,
    payload.buildIntent,
    payload.intent?.teamStyle?.name,
    payload.intent?.teamTemplate?.id,
    payload.intent?.megaPlan,
    payload.megaPlan,
    payload.compositionReport,
    payload.battleKnowledge?.needs,
    payload.battleKnowledge?.risks,
    payload.understanding?.summary,
    payload.intent?.understanding?.summary,
    selected,
    targets,
    candidates.slice(0, 18),
  ].map(pocketAgTextBlob).join(" ");
  const keyText = pocketAgTextKey(`${text} ${names.join(" ")}`);
  const tags = new Set(["team-axis", "synergy", "speed-control", "safe-entry", "endgame"]);
  if (/mega|进化石|mega位|主mega|副mega/i.test(text)) tags.add("mega-slot");
  if (/double|双打|守住|击掌|首发|站位|protect|fake out|lead/i.test(text)) {
    tags.add("doubles");
    tags.add("protect");
    tags.add("lead-choice");
  }
  if (/single|单打|撒场|清场|隐形岩|轮转|stealth|hazard|defog|rapid/i.test(text)) {
    tags.add("singles");
    tags.add("pivot");
  }
  if (/恶作剧之心|prankster|风妖精|klefki|sableye|meowstic|控速|反展开|状态/i.test(text)) {
    tags.add("support-priority");
    tags.add("disruption");
  }
  if (/守住|protect|看我嘛|follow me|rage powder|wide guard|fake out|击掌奇袭|保护|safe-entry|安全上场/i.test(text)) {
    tags.add("safe-entry");
    tags.add("protect");
  }
  if (/终盘|收割|清场|endgame|cleaner|late-game|priority/i.test(text)) {
    tags.add("endgame");
  }
  if (/主轴|副轴|备用|替代路线|第二路线|wincon|backup|primary|secondary/i.test(text)) {
    tags.add("team-axis");
    tags.add("backup-axis");
  }
  if (/换入|轮转|转场|急速折返|伏特替换|抛下狠话|switch|pivot|u-turn|volt/i.test(text)) {
    tags.add("pivot");
    tags.add("switching");
  }
  return {
    text,
    keyText,
    names: [...new Set(names.map(pocketAgTextKey).filter(Boolean))],
    tags,
    format: String(payload.format || "").includes("double") ? "double" : "single",
  };
}

function pocketAgRuleScore(rule = {}, ctx) {
  const body = pocketAgTextKey(pocketAgTextBlob(rule));
  let score = 0;
  for (const tag of rule.tags || []) if (ctx.tags.has(tag)) score += 5;
  if (rule.priority === "hard") score += 3;
  if (/mega/.test(body) && ctx.tags.has("mega-slot")) score += 4;
  if (/speed|速度|控速/.test(body) && ctx.tags.has("speed-control")) score += 3;
  if (/double|双打|protect|守住|lead|首发/.test(body) && ctx.tags.has("doubles")) score += 3;
  if (/single|单打|hazard|撒场|清场/.test(body) && ctx.tags.has("singles")) score += 3;
  if (/support|prankster|恶作剧|辅助/.test(body) && ctx.tags.has("support-priority")) score += 3;
  if (/team-axis|backup-axis|safe-entry|endgame/.test(body) && (ctx.tags.has("team-axis") || ctx.tags.has("backup-axis") || ctx.tags.has("safe-entry") || ctx.tags.has("endgame"))) score += 3;
  return score;
}

function pocketAgPokemonRuleScore(card = {}, ctx) {
  const keys = [
    card.slug,
    card.name,
    card.english,
    ...(Array.isArray(card.mega_forms) ? card.mega_forms : []),
  ].map(pocketAgTextKey).filter(Boolean);
  let score = keys.some((key) => ctx.names.includes(key) || ctx.keyText.includes(key)) ? 40 : 0;
  const body = pocketAgTextKey(pocketAgTextBlob(card));
  for (const tag of card.ag_tags || []) if (ctx.tags.has(tag)) score += 4;
  for (const tag of ctx.tags) if (body.includes(pocketAgTextKey(tag))) score += 1;
  if (card.confidence === "high") score += 6;
  if (Number(card.ag_evidence_count || 0) > 0) score += 4;
  if (Array.isArray(card.mega_forms) && card.mega_forms.length && ctx.tags.has("mega-slot")) score += 4;
  if ((ctx.tags.has("safe-entry") || ctx.tags.has("endgame") || ctx.tags.has("backup-axis")) && /coach|notes|claims|summary/i.test(body)) score += 2;
  return score;
}

function formatPocketAgCoachRules(rules, payload = {}) {
  if (!rules) {
    return "Pocket AG 宝可梦冠军理解层：未找到本地 coach-rules.json，本次只使用内置 TeamUnderstanding Engine。";
  }
  const ctx = pocketAgContext(payload);
  const injection = rules.prompt_injection || {};
  const status = rules.status || {};
  const lines = Array.isArray(injection.lines) ? injection.lines : [];
  const globalRules = Array.isArray(rules.global_rules) ? rules.global_rules : [];
  const selectedGlobalRules = globalRules
    .map((rule) => ({ rule, score: pocketAgRuleScore(rule, ctx) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 7)
    .map(({ rule }) => {
      const tags = Array.isArray(rule.tags) && rule.tags.length ? ` [${rule.tags.join("/")}]` : "";
      return `${rule.title || rule.id}${tags}：${rule.do || ""}${rule.why ? `；原因：${rule.why}` : ""}`;
    });
  const formatRules = [
    ...(Array.isArray(rules.format_rules?.single) ? rules.format_rules.single.map((line) => `单打：${line}`) : []),
    ...(Array.isArray(rules.format_rules?.double) ? rules.format_rules.double.map((line) => `双打：${line}`) : []),
  ];
  const productChecks = Array.isArray(rules.product_checks) ? rules.product_checks : [];
  const pokemonRules = Array.isArray(rules.pokemon_rules) ? rules.pokemon_rules : [];
  const maxPokemonRules = Number(injection.max_pokemon_rules_in_prompt || 12);
  const compactPokemonRules = pokemonRules
    .map((card) => ({ card, score: pocketAgPokemonRuleScore(card, ctx) }))
    .sort((a, b) => b.score - a.score)
    .filter((item, index) => item.score > 0 || index < Math.min(4, maxPokemonRules))
    .slice(0, maxPokemonRules)
    .map(({ card, score }) => {
      const notes = Array.isArray(card.coach_notes) ? card.coach_notes.slice(0, 2).join("；") : "";
      const claims = Array.isArray(card.claims) ? card.claims.slice(0, 2).join("；") : "";
      const mega = Array.isArray(card.mega_forms) && card.mega_forms.length ? `；Mega: ${card.mega_forms.join("/")}` : "";
      const summary = card.summary || claims || notes || "仅作结构化草稿证据";
      return `${card.name || card.slug}${score ? `（相关度 ${score}）` : ""}: ${summary}${mega}`;
    });
  const coachingSignals = [
    `本次教练标签：${[...ctx.tags].join(" / ") || "无"}`,
    "教练输出优先级：team-axis > backup-axis > speed-control > safe-entry > protect > endgame > 单体强度。",
    "纠错规则：若结果里没有真实启动者、安全上场与收尾线，就算单体高分也要重排。",
    /接棒|强化接棒|baton pass|pass chain|boost pass|传递强化/i.test(String(payload.userGoal || "")) ? "本次目标是强化接棒：必须写出传递者、接收者、保护者和终盘者，不能按普通进攻队处理。" : "",
  ];
  return [
    `${injection.title || "Pocket AG 宝可梦冠军理解层"}（Context Engine）：${status.confidence || "v0 usable"}`,
    `数据摘要：${JSON.stringify(status.cards_summary || {})}`,
    `本次检索标签：${[...ctx.tags].join(" / ")}`,
    ...coachingSignals,
    "固定行为规则：",
    ...lines.map((line, index) => `${index + 1}. ${line}`),
    "本次命中的 AG 全局规则：",
    ...(selectedGlobalRules.length ? selectedGlobalRules.map((line, index) => `${index + 1}. ${line}`) : ["1. 未命中特定全局规则，使用固定行为规则。"]),
    "单双打格式规则：",
    ...formatRules.map((line, index) => `${index + 1}. ${line}`),
    "产品化自检：",
    ...productChecks.map((line, index) => `${index + 1}. ${line}`),
    "本次相关个体规则：",
    ...compactPokemonRules.map((line, index) => `${index + 1}. ${line}`),
    "执行门槛：输出前必须显式回答 why this team exists / why members work together / Mega role / speed plan / safe turns / endgame / singles-vs-doubles difference。每只成员 note 必须写它服务的具体链条，不能写泛泛补位或强度评价。",
    "使用边界：这层规则用于提高配队理解、Mega 位判断、队友联动和单双打分化；不能覆盖 Pokemon Champions 合法性、当前候选池、formatModels、battleHistory 或用户硬约束。",
  ].join("\n");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
  });
  res.end(JSON.stringify(payload));
}

function compactPromptValue(value, path = "", depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return value.length > 260 ? `${value.slice(0, 257)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 5) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    const limit =
      /metaCandidates$/.test(path) ? 42 :
      /selectedPokemon$/.test(path) ? 6 :
      /battleHistory$/.test(path) ? 6 :
      /failureMemory$/.test(path) ? 5 :
      /fixedOpponentTeams$/.test(path) ? 5 :
      /topUsage$/.test(path) ? 12 :
      /baseSpeedGroups$/.test(path) ? 8 :
      /members$/.test(path) ? 6 :
      /team$/.test(path) ? 6 :
      /watch$/.test(path) ? 4 :
      /rows$/.test(path) ? 8 :
      /threats$/.test(path) ? 8 :
      /opponentConfigs$/.test(path) ? 8 :
      /candidateSource$/.test(path) ? 24 :
      6;
    return value.slice(0, limit).map((item, index) => compactPromptValue(item, `${path}[${index}]`, depth + 1));
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "rawData" || key === "teamLibraryConfigCache" || key === "recommendedItemsCache" || key === "rankedSetsCache") continue;
    result[key] = compactPromptValue(child, path ? `${path}.${key}` : key, depth + 1);
  }
  return result;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function buildPrompt(payload) {
  const emptyTeamRequest = Boolean(payload.intent?.emptyTeamRequest);
  const rebuildFromGoal = Boolean(payload.intent?.rebuildFromGoal);
  const buildIntent = payload.buildIntent || payload.intent?.buildIntent || "auto";
  const requestedFormat = payload.intent?.requestedFormat === "double" ? "double" : "single";
  const formatSource = payload.intent?.formatExplicit ? "用户明确要求" : "当前工作台选择";
  const formatFocus = `\n格式硬约束：${formatSource} ${requestedFormat === "double" ? "双打" : "单打"}。summary 和 ${requestedFormat} 分区是主答案，必须只使用该格式的术语和对局计划；另一个分区只能作为附带参考，不能替代主答案。`;
  const movesetOnly = Boolean(payload.intent?.movesetOnly);
  const counterTargetMode = Boolean(payload.intent?.counterTargetMode);
  const requestedStyle = payload.intent?.teamStyle?.name ? `\n用户指定队伍类型：${payload.intent.teamStyle.name}\n队伍类型硬规则：${(payload.intent.teamStyle.hardRules || []).join("；")}` : "";
  const requestedTemplate = payload.intent?.teamTemplate?.id ? `\n队伍结构模板：${payload.intent.teamTemplate.id}\n必须覆盖组件：${(payload.intent.teamTemplate.requiredComponents || []).join("；")}\n避免问题：${(payload.intent.teamTemplate.avoidPitfalls || []).join("；")}` : "";
  const failureMemory = Array.isArray(payload.failureMemory) && payload.failureMemory.length
    ? `\n历史失败原因记忆：${payload.failureMemory.map((item, index) => `${index + 1}. 曾 ${item.count || 1} 次出现，低分 ${item.score || 0}/100；避免：${item.avoid || (item.warnings || []).join("；")}`).join("\n")}\n这些是同类目标中过去生成失败的原因，本次必须主动规避。`
    : "";
  const battleHistory = Array.isArray(payload.battleHistory) && payload.battleHistory.length
    ? `\n本地自动对战历史：${payload.battleHistory.map((item, index) => `${index + 1}. ${item.format} 固定Top5战绩 ${item.record || ""}，胜率 ${item.winRate || 0}%；队伍 ${item.team || "未知"}；行动标签：${item.actionTags || "无"}；失败/避免：${item.avoid || "无"}；问题靶队：${item.badOpponents || "无"}`).join("\n")}\n这些数据来自本地 Showdown 固定靶队回归评测；本次必须优先修复低胜率格式和反复输的靶队分支。`
    : "";
  const constraints = goalConstraints(payload);
  const hardGoalConstraints = constraints?.hardRules?.length || constraints?.requiredPokemon?.length || constraints?.requiredMoves?.length || constraints?.requiredRoles?.length
    ? `\n用户目标硬约束：${[
        ...(constraints.hardRules || []),
        ...(constraints.requiredPokemon || []).map((item) => `必须包含指定核心 ${item.name || item.slug || item.id}`),
        ...(constraints.requiredMoves || []).map((item) => `必须包含招式/机制 ${item.name || item.id}`),
        ...(constraints.requiredRoles || []).map((item) => `必须包含职责 ${item.name || item.id}`),
      ].filter(Boolean).join("；")}\n这些约束优先级高于热门度、历史模板和模型自行判断；如果做不到，必须在 note/watch 明确说明数据不足和临时替代方案。`
    : "";
  const avoidPreviousTeams = payload.avoidPreviousTeams
    ? `\n上一版队伍禁止原样重复：\nsingle：${payload.avoidPreviousTeams.single || "无"}\ndouble：${payload.avoidPreviousTeams.double || "无"}\n原因：${payload.avoidPreviousTeams.reason || "用户要求重新生成；必须换轴或至少替换 2 个成员。"}`
    : "";
  const correction = payload.correction
    ? `\n自动修正模式：上一版结构可信度 ${payload.correction.score || 0}/100。\n必须修正的问题：${(payload.correction.warnings || []).join("；")}\n理解层未被回应的问题：${(payload.correction.understandingWarnings || []).join("；") || "无"}\n理解层摘要：${payload.correction.understandingSummary ? JSON.stringify(payload.correction.understandingSummary).slice(0, 1800) : "无"}\n上一版 single：${(payload.correction.previousTeams?.single || []).join("、") || "无"}\n上一版 double：${(payload.correction.previousTeams?.double || []).join("、") || "无"}\n修正规则：${payload.correction.instruction || "优先修复结构问题，仍只返回最终 JSON。"}`
    : "";
  const task = movesetOnly ? "只给当前队伍配招与道具" : counterTargetMode ? "围绕用户目标反制指定对象" : emptyTeamRequest ? "按用户目标从零构筑队伍" : payload.mode === "complete-team" ? "补全队伍" : "给当前队伍配招";
  const promptMode =
    payload.promptMode === "compare"
      ? "多方案比较：先给 2 到 3 个方向，再选择最稳方向输出最终 JSON。"
      : payload.promptMode === "deep"
        ? "详细推理：重点分析速度控制、轮转、终盘、双打守住/站位，但最终仍只输出 JSON。"
        : "快速建议：优先给可直接应用的稳妥配置。";
  const uiLevel = payload.uiLevel || payload.intent?.uiLevel || {};
  const uiLevelText = uiLevel.label
    ? `\n当前界面层级：${uiLevel.label}\n表达密度要求：${uiLevel.instruction || "按当前用户熟练度调整说明密度。"}\n注意：界面层级只影响 summary/plan/watch/note 的表达密度，不降低构筑质量和结构自检要求。`
    : "";
  const pocketAgCoach = formatPocketAgCoachRules(pocketAgCoachRules, payload);
  const quickOutputRequirements = `输出要求：
1. 只返回严格 JSON，不要 Markdown 或解释性结尾。
2. 必须同时给出 single 和 double；每个分区包含 team、plan、watch。
3. 每个分区最多 6 只宝可梦，每只包含 id、name、role、item、ability、nature、evs、level、moves、note。
4. ${emptyTeamRequest ? "从 metaCandidates 按 userGoal、intent.teamStyle 和 intent.targetPokemon 从零选择；不要假装保留当前队伍。" : "优先保留 selectedPokemon，再从 metaCandidates 补到 6 只。"}
5. 以 Pokemon Champions 当前数据为主：selectedPokemon、metaCandidates、importedTeam、commonMoves、commonItems、commonAbilities。
6. 优先处理 battleKnowledge.needs、compositionReport.buildPriorities、targetPokemon 和 legality.violations。
7. 如果存在 failureMemory/历史失败原因记忆，必须先规避其中问题；不要重复输出过去导致低分的结构。
8. 如果存在 battleHistory/本地自动对战历史，必须优先修复低胜率格式、反复输的固定靶队、failureReasons 和 actionTags 暴露的缺口；例如缺 speed-control 就补控速，缺 pivot/switch 就补安全上场，双打缺 protect/spread 就补保护或范围压力。不要重复输出历史上固定Top5低胜率的同构队伍。
9. 单打分区只读取 formatModels.single 与 metaCandidates[].formatFit.single；双打分区只读取 formatModels.double 与 metaCandidates[].formatFit.double。不要把单打撒钉/除钉评分当作双打核心，也不要把双打击掌/守住评分当作单打必选。
10. 先读取 intent.understanding 或顶层 understanding：它是 TeamUnderstanding Engine 的配队理解层；先看 understanding.summary[格式].mustFix/missing/conflicts/topThreats，再选成员。
11. 如果存在 battleEvaluation.fixedOpponentTeams 或 understanding.fixedOpponentTeams，它们是当前环境登场率最高的 5 个固定评测靶队；watch/plan 要覆盖这些靶队代表的天气、控速、首发、强化、撒场或耐久分支。
12. 先读取 intent.megaPlan/megaPlan：优先围绕 primary Mega 规划队伍；secondary 只能作为对局分支；若 recommendation 是 no-forced-mega，必须说明不硬凑原因。
13. 先读取对应格式的 formatModels[格式].slotModel.missingSlots 和 metaCandidates[].formatFit[格式].slotFit：优先补高优先级缺槽；每个成员 note 要写明填了哪些槽位。
14. 再读取对应格式的 formatModels[格式].archetypeModel.primary/missingComponents 和 metaCandidates[].formatFit[格式].archetypeFit：优先补主原型缺失组件；如果转向其他原型，plan 必须说明原因。
15. 再读取对应格式的 formatModels[格式].threatMatrix.rows/priorities 和 metaCandidates[].formatFit[格式].threatFit：高风险威胁至少要有 defensiveSwitch、offensivePressure、revengeKill/speedControl 中两类答案；不能只写“属性克制”。
16. 再读取对应格式的 formatModels[格式].chainModel 和 metaCandidates[].formatFit[格式].chainFit：优先补高优先级 missingChains；最终 plan 必须点名至少 2 条链，例如 A 转场带 B、C 控速服务 D、E 撒场铺垫 F 收割。
17. 再读取对应格式的 formatModels[格式].resourceModel 和 metaCandidates[].formatFit[格式].resourceFit：先修复 risks/desiredResources，避免核心缺安全上场、低速无控速、双打无保护、多天气冲突、双 Mega 资源竞争等断点。
18. 再读取对应格式的 formatModels[格式].phaseModel 和 metaCandidates[].formatFit[格式].phaseFit：必须把队伍写成开局→中盘→终盘路线；候选优先补缺失阶段，不要只写静态职责。
19. 再读取对应格式的 formatModels[格式].branchModel 和 metaCandidates[].formatFit[格式].branchFit：必须为高优先级对局分支写处理路线，例如高速压制、天气、空间/顺风、强化展开、撒场/受队或双打反首发。
20. 选择辅助手时读取 metaCandidates[].supportProfile：恶作剧之心/Prankster 只有在 tags 指向 speed-control、anti-setup、status-pressure、screens、core-support 或 protection 时才加权；按队伍缺口选择对应类型，不要盲选。
21. 选补位时优先参考 metaCandidates[].understandingScore、understandingReasons、pokemonProfile.tags、formatFit、synergyScore；不要只按 rank 排名堆强单体。
21a. 必须应用 Pocket AG 宝可梦冠军理解层：先定队伍轴与行动链，再判断 Mega 位、速度计划、队友联动和单双打差异；但不得覆盖 Champions 合法性、当前候选池或用户硬约束。
22. 必须写出至少 2 组队友联动：转场带核心、控速服务打手、天气/场地收益、威吓/击掌/掩护保护输出、撒场铺垫收割或抗性互补换入。
23. 解释必须可执行：写清谁让谁安全上场、谁服务谁输出、谁覆盖谁弱点、谁负责终盘；双打还要写首发组合和遇到反首发时如何切换。
24. 单打写清钉子/清场或替代节奏；双打写清守住、控速、首发组合和站场协作。
25. 道具不能重复；道具、招式、特性尽量用中文，无法确认时写“可替换”。
26. note 只写该成员在本队的具体职责；watch 至少 3 条，包含威胁、应对成员、处理顺序。
27. 如果硬约束无法完全满足，不能编造数据，必须在 note 或 watch 里说明临时缓解方式。`;
  const prompt = `
你是 Pokemon Champions 队伍配置助手。只返回一个 JSON 对象。
第一个字符必须是 {，最后一个字符必须是 }。
不要 Markdown，不要标题，不要项目符号，不要解释性结尾，不写“如果你愿意...”之类收尾话。

任务：${task}
推理模式：${promptMode}
构筑意图：${buildIntent}
当前规则：${payload.formatLabel || payload.format}
用户目标：${payload.userGoal || "未填写"}
${uiLevelText}
${formatFocus}
${requestedStyle}
${requestedTemplate}
${hardGoalConstraints}
${failureMemory}
${battleHistory}
${avoidPreviousTeams}
${correction}

${pocketAgCoach}

输出要求：
1. 简洁，最多 6 只宝可梦，每只 1 到 2 句说明。
2. 必须同时给出 single 和 double 两个分区，两个分区都要有各自的 team、plan、watch。
3. single.team 和 double.team 都必须是最终可应用队伍。${emptyTeamRequest ? `${rebuildFromGoal ? "用户明确要求重新配置一个新队伍；不要保留 ignoredCurrentPokemon，也不要写“基于当前6只”。" : "用户没有预选宝可梦；不要假装保留核心。"}请从 metaCandidates 中按 userGoal、intent.teamStyle 和 intent.targetPokemon 从零选择 6 只。` : "优先保留 selectedPokemon，再从 metaCandidates 补到 6 只。"}
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
15a. 构筑必须先满足三项硬指标：
联防：不能只看进攻克制，必须检查关键攻击属性和目标常见招式是否有换入点；至少说明 2 个主要威胁由谁换入、抗住或免疫处理。
轮换：队伍必须有安全上场方式，例如急速折返、伏特替换、抛下狠话、耐久中转、击掌奇袭、掩护、守住或天气/空间回合管理；不能让核心只能硬换上场。
速度：必须说明原速线、控速方式和被高速压制时的处理；控速可以是顺风、戏法空间、电磁波、冰冻之风、岩石封锁、先制、围巾、特性加速或天气加速。若没有稳定控速，必须给出替代节奏，不得假装速度线安全。
16. 如果 battleKnowledge.legality.violations 不为空，最终 JSON 中必须规避这些问题，不要重复输出同样违规配置。
17. 必须参考 compositionReport 的 style、cores、winConditions、gaps、buildPriorities。输出队伍不能只堆热门成员，必须围绕已识别核心补足阵容结构。
18. 如果 compositionReport.gaps 和 matchupReport.threats 指向同一问题，优先用补位或配置调整解决这个问题，并在 note 中说明该成员解决了什么缺口。
19. 如果 compositionReport 中有 archetypes 或 roleTemplates，必须优先沿用这些队伍轴和职责模板，除非它们与 Champions 当前数据冲突。
19a. 如果 intent.teamTemplate 存在，它是结构硬约束；最终队伍必须覆盖 requiredComponents 中的职责，并避开 avoidPitfalls。
19b. structureRequirements.hardChecks 和 structureRequirements.targetChecks 是生成前必须执行的结构检查表；输出前必须逐项确认已覆盖联防、轮换、速度、行动链、主副轴、资源闭环、道具定位和 watch 处理顺序。
19bb. formatModels 是单打/双打分离评分。single 分区必须用 formatModels.single 和 metaCandidates[].formatFit.single；double 分区必须用 formatModels.double 和 metaCandidates[].formatFit.double。顶层 slotModel/archetypeModel/threatMatrix 只代表当前页面格式，不能替代另一个分区的判断。
19bc. failureMemory 是历史失败原因记忆。生成前必须主动检查这些反例，特别是重复出现的低分 warning；如果本次仍无法避免，必须在 watch 或 note 中说明为什么只能临时缓解。
19bd. understanding 是 TeamUnderstanding Engine 的总入口。生成前先读 understanding.summary[格式].mustFix、missing、conflicts、topThreats；选候选时优先看 metaCandidates[].understandingScore、understandingReasons 和 pokemonProfile.tags，再细读各 formatFit。不要绕过理解层直接按 rank 选人。
19be. battleEvaluation.fixedOpponentTeams / understanding.fixedOpponentTeams 是固定评测靶队池，默认取当前环境同格式登场率最高的 5 个队伍。生成队伍时必须让 plan/watch 覆盖这些靶队暴露出的主要轴；后续本地模拟器会用这些队伍做回归评测。
19bf. battleHistory 是本地自动对战历史。低胜率格式、反复失败的固定靶队、failureReasons、actionTags 和 badOpponents 必须作为下一版构筑的硬修正目标；actionTags 代表模拟中实际发生的行动类型，缺少 speed-control/pivot/protect/spread 等标签时要用成员、招式或行动链补齐。不要重复输出历史上固定Top5低胜率的同构队伍。
19bg. Pocket AG 宝可梦冠军理解层是本地蒸馏出的教练规则。生成前必须用它复核：是否先定队伍轴而非堆强单体、Mega 位是否服务主轴、双 Mega 是否只是分支、恶作剧之心是否补真实缺口、速度控制是否有设置者/保护者/收益者、单双打是否分开决策。若它和 Champions 合法性、用户硬约束、formatModels 或 battleHistory 冲突，后者优先。
19c. 对应格式的 slotModel 是构筑骨架；最终队伍必须优先覆盖 formatModels[格式].slotModel.requiredSlots 中高优先级槽位。选补位时先看 formatFit[格式].slotFit.fillSlots/reasons；不能为了高 rank 放弃主轴、副轴、Mega、控速、安全上场、防守换入或格式专属槽位。
19d. 对应格式的 archetypeModel 是打法原型识别结果。必须先读取 formatModels[格式].archetypeModel.primary、missingComponents、buildRules，再用 formatFit[格式].archetypeFit 选择补位；晴天、雨天、空间、受队、撒场、双打顺风/协作等原型必须补齐关键组件，不能识别为某原型后输出无关泛用热门队。
19e. 对应格式的 threatMatrix 是威胁矩阵。必须先读取 formatModels[格式].threatMatrix.rows 中 risk 最高的威胁、missingAnswers 和 answers，再用 formatFit[格式].threatFit 补洞。每个高风险威胁至少要有进场答案 defensiveSwitch、逼退答案 offensivePressure、速度/收割答案 revengeKill 或 speedControl 中的两类；只有进攻打点不算完整反制。
19f. 对应格式的 chainModel 是队友联动组合库。必须优先覆盖 formatModels[格式].chainModel.missingChains 中 priority 最高的链条，再用 metaCandidates[].formatFit[格式].chainFit 选择能补 missingRoles 的成员。最终每个分区 plan 必须点名至少 2 条具体链：谁转场带谁、谁控速服务谁、谁撒场/状态铺垫谁收割、谁保护谁输出。
19g. 对应格式的 resourceModel 是资源冲突与闭环检测。必须先检查 risks 和 desiredResources，再用 metaCandidates[].formatFit[格式].resourceFit 修复断点。不能输出核心缺安全上场、低速核心无控速、双打输出无保护、多天气互相削弱、双 Mega 同局抢资源这类结构，除非 watch 明确写出临时缓解。
19h. 对应格式的 phaseModel 是对局阶段路线。必须先检查 missingPhases，再用 metaCandidates[].formatFit[格式].phaseFit 补开局、中盘或终盘缺口。plan 必须按“开局→中盘→终盘”写：开局谁取得节奏，中盘谁轮转/消耗/突破，终盘谁收割；双打还要包含反首发切换。
19i. 对应格式的 branchModel 是对局分支模型。必须先检查 branches/missingBranches 中 priority 最高的分支，再用 metaCandidates[].formatFit[格式].branchFit 补 answerRoles。watch 至少覆盖 3 个分支，每条写清“面对什么轴 → 先由谁换入/保护/控速 → 再由谁逼退/收割”。不能只写一条顺风局路线。
20. 如果 intent.targetPokemon 不为空，必须把它当成需要针对/克制的目标；输出方案要包含至少 2 个明确回答目标的成员，并在 note 或 watch 里说明如何处理该目标。
20a. 克制目标时优先参考 intent.targetPokemon[].target.roleProfile、commonMoves、commonItems、commonAbilities、commonTeammates，以及 offensiveAnswers[].answerTypes；不要只按属性克制或热门度判断。
20b. metaCandidates[].roleProfile 是单体定位摘要，必须用它判断宝可梦职责、常见配置和注意事项；不要把高速辅助写成耐久剩饭位，也不要把低速打手写成无空间核心。
20c. 如果 intent.targetPokemon[].target.megaProfile 存在，必须区分 Mega 前特性和 Mega 后最终特性：反制逻辑以 finalAbilities 为准，preMegaAbilities 只用于判断进场回合风险。玩家上传配置里的 ability 可能是 Mega 前特性，不能拿它覆盖 finalAbility。
21. 如果 intent.emptyTeamRequest 为 true，用户目标优先级高于默认热门度；不能因为 selectedPokemon 为空就输出泛用热门队，必须围绕目标构筑。
21a. 如果 intent.rebuildFromGoal 为 true，必须无视 ignoredCurrentPokemon，不能沿用页面当前队伍，也不能在 summary/plan 中说“基于当前6只宝可梦”。
21aa. 如果 avoidPreviousTeams 存在，不能原样重复其中 single 或 double 的 6 只组合；除非用户要求只改配招，否则必须至少替换 2 个成员，或明确换成不同主轴。
21b. 如果 intent.movesetOnly 为 true，不能替换当前队伍成员，只能调整当前成员的招式、道具、特性、性格、努力值和说明。
21c. 如果 intent.counterTargetMode 为 true，即使 selectedPokemon 为空，也必须围绕用户目标中的威胁/天气/打法反制来构筑；不要输出无目标的泛用热门队。
22. intent.targetPokemon[].counterWarnings 是硬规则，优先级高于常规经验。若目标有“唱反调/Contrary”，禁止把威吓、抛下狠话、岩石封锁、冰冻之风、大声咆哮等降能力手段写成克制方案；只能写成风险或避免事项。
23. 输出内容尽量使用中文招式、中文道具、中文特性、中文性格。输入里有中文名时优先沿用中文名。
24. 道具必须参考当前环境可用与常见携带：优先看 metaCandidates[].commonItems、teamLibraryItems、teamLibrarySets、importedTeam.configurations。不要只为凑不重复道具而给功能高速位硬塞剩饭；例如风妖精这类高速辅助通常优先气势披带、心灵香草、防针对果、密探斗篷等，只有数据明确支持且队伍需要耐久消耗时才考虑剩饭。
25. 分配道具时要看整队：Mega 石、气势披带、讲究系列、突击背心、剩饭等不能重复；核心输出优先拿增伤/讲究/保险，关键控速或辅助优先拿保证出手/防挑衅/防击杀的道具，耐久轮转位才优先剩饭或文柚果。
25a. Mega 位必须先规划再补队。优先读取 intent.megaPlan 或顶层 megaPlan：primary 是默认主 Mega，secondary 只能作为备选对局分支。围绕 primary 选择能满足 supportNeeds 的队友，至少说明谁帮它安全进场、谁覆盖弱点、谁提供速度/节奏支持。如果 recommendation 是 no-forced-mega，不能硬塞 Mega，必须写明为什么不选 Mega 反而更合理。双 Mega 时必须说明“本局只能选其中一个 Mega 作为主轴”，不能把两个都写成同局同时 Mega 的核心。
25b. 选择辅助手时，必须看 metaCandidates[].supportProfile.tags 和 reasons：speed-control 对应顺风/电磁波等控速，anti-setup 对应挑衅/再来一次等反展开，status-pressure 对应鬼火/电磁波/剧毒，screens 对应双墙/极光幕，core-support/protection 对应帮助、削弱、掩护或保护核心。拥有恶作剧之心/Prankster 只是加权条件；如果 tags 不能补队伍缺口，不能盲选。
25c. metaCandidates[].synergyScore、synergyReasons、chainFit、resourceFit、phaseFit 和 branchFit 是候选与当前队伍/目标打法的联动评分。选补位时要优先考虑这些理由：转场带核心、控速服务打手、撒场/状态铺垫收割、保护 Mega、补弱点换入、常见队友匹配、天气收益、修复资源断点、补开局/中盘/终盘路线、补对局分支答案等。高 rank 但 chainFit/resourceFit/phaseFit/branchFit 低的成员不能无理由挤掉能补链条闭环的成员。
25d. 队友联动是硬约束。最终队伍不能只是 6 个单体强配置；至少要有 2 组明确配合，并在 plan 或 note 中写出来：转场带核心上场、控速服务打手、天气/场地收益、威吓/击掌/掩护保护输出、撒场/状态铺垫收割、抗性互补换入、双打首发组合或换位联防。优先使用 chainModel 里的 label 命名联动链。
25e. 每个成员 note 必须包含它在本队承担的槽位，例如主轴核心、副轴、Mega 位、控速、安全上场、防守换入、破盾、终盘、撒场/除钉、保护/掩护、首发组合或范围压力；不要只写“补位”。
25f. 每个分区 plan 必须点名主打法原型，例如晴天进攻、雨天速度、空间、平衡轮转、高速进攻、耐久消耗、撒场压制或双打协作，并说明哪些成员补齐了该原型缺失组件。
25g. 每个分区 watch 必须覆盖对应 formatModels[格式].threatMatrix.rows 中至少 2 个高风险威胁；每条写清“先由谁换入/保护或控速，再由谁逼退/收割”。如果没有稳定换入，必须明说只能靠控速、先制、状态或牺牲转场临时处理。
26. 如果 intent.teamStyle 存在，它是硬约束，优先级高于默认热门度和你自行判断的队伍轴。用户说“受队/盾队/消耗队”时，不能输出天气进攻、空间进攻、纯高速攻或泛用热门队；必须围绕耐久换入、回复、状态、撒场、除钉/清场、转场和消耗路线构筑。
27. 双打分区也必须尊重 intent.teamStyle。除非用户明确要求天气/空间，不要因为双打就自动加入喷火龙晴天、大嘴鸥雨天、煤炭龟空间等进攻轴。
28. 如果选择煤炭龟、超低速高火力打手，或在 plan/note 中写“空间/戏法空间”，队伍里必须至少有 1 个明确携带“戏法空间”的辅助手；否则不要把它描述为空间核心。没有空间手时，应改为晴天炮台/轮转火力，或替换成员补空间手。
29. 输出必须尽量全中文；不要输出 Showdown slug 或日文原名。道具如 charcoal 写“木炭”，chople-berry 写“抗斗果”，charizardite-y 写“喷火龙进化石 Y”；招式如 eruption 写“喷火”，heat-wave 写“热风”，earth-power 写“大地之力”，trick-room 写“戏法空间”。
30. 不要随意混搭互相覆盖的天气轴。大嘴鸥/降雨 与 喷火龙Y/煤炭龟/日照 同队时必须说明双天气切换收益；否则晴天和雨天二选一。合理双天气必须写清：主天气、备用/反制天气、谁吃天气收益、什么时候切换，且不能让主输出依赖被自己天气削弱的招式。
30a. 反制天气时，晴天、求雨、雪景/降雪、沙暴可以作为抢天气/盖天气工具。用户目标是反制雨天时，晴天/雪景/沙暴不算乱混天气；用户目标是反制晴天时，求雨/雪景/沙暴不算乱混天气。但必须在 plan 或 note 里写明“用于覆盖对方天气”，否则会被视为轴心冲突。
31. 双打里携带地震时，必须有足够队友能守住、飞行/漂浮免疫或不在场配合；否则改成单体地面招式或换成员。
32. 受队/消耗队至少要有多项闭环工具：回复、状态、撒场、除钉/清场、转场、抗性换入、残局消耗。只有几个耐久道具或守住不算受队。
33. 输出前必须按固定顺序自检：intent/teamStyle → legality/Mega 位合理性 → selectedPokemon/movesetOnly/rebuild → 对应格式 threatMatrix 高风险威胁 → 对应格式 branchModel 对局分支 → 对应格式 phaseModel 阶段路线 → 对应格式 archetypeModel 原型组件 → 对应格式 slotModel 缺槽 → battleKnowledge.needs → compositionReport.buildPriorities → targetPokemon → roleCoverage/typeProfile → 队友联动 → 辅助手/恶作剧之心权重 → 道具不重复 → moves/ability/item 数据来源。若发生冲突，按上述顺序取高优先级。
34. 如果硬约束无法完全满足，不能编造可用宝可梦、招式、道具或特性。必须输出最接近的合法队伍，并在 watch 或 note 中明确写：“该缺口因 Champions 当前可用数据不足，只能用 X 临时缓解”。
35. 最终输出必须是严格 JSON，不要在 JSON 外添加解释。顶层结构固定为 summary、single、double；single 和 double 都必须包含 team、plan、watch。
36. 每个成员必须包含 note 字段。note 只写它在本队承担的具体职责，不要写泛泛强度评价。
37. 每个分区 plan 必须写清完整行动链：开局如何取得节奏 → 中盘如何安全轮换/消耗 → 终盘由谁收割。单打还必须写撒钉/除钉或替代节奏；双打还必须给出至少 2 组合理首发组合，并说明谁控速、谁输出、谁保护队友、遇到反首发时如何切换。
37a. 解释质量是硬约束。plan/note/watch 必须具体回答：谁让谁安全上场、谁服务谁输出、谁覆盖谁弱点、谁负责终盘、双打哪两组首发、遇到反首发如何切换。不能只写“形成联动”“提高容错”“负责补位”这类泛泛描述。
38. 每个分区必须有明确主轴和副轴：主轴负责主要胜利路线，副轴负责主轴被针对时的替代路线。不能只列 6 个单体强配置。
39. 队伍不能只有“进攻答案”，还必须有“进场答案”。针对主要威胁时，要说明谁能换入、谁能逼退、谁能 revenge kill。只写“某某招式克制对方”不算完整回答。
40. 检查角色冗余与职责过载：同一只宝可梦不能同时承担过多关键任务。如果一只同时负责除钉、挡核心威胁、补速度、终盘清场，应视为不稳定配置，需要分摊职责。
41. 检查队伍资源闭环：单打至少考虑回复、转场、撒场/清场、状态、终盘火力；双打至少考虑守住覆盖、控速、先手干扰、AOE 压力、换位/联防。
42. 速度层级必须合理：队伍不能只有一个速度档。应至少包含高速压制、控速后收益者、先制或耐久中转中的两类。如果主力偏慢，必须有顺风、戏法空间、电磁波、冰冻之风等稳定支持。
43. 打点覆盖不能只看属性克制表：必须考虑当前环境里的实际换入点、抗性核心、免疫、守住轮转和常见道具。例如“有地面招式”不等于能稳定处理钢系，如果对方常见飞行/漂浮/气球/守住轮转。
44. 道具分配必须服务队伍节奏：气势披带给关键开局/控速位；剩饭/文柚果给需要多次进场的轮转位；讲究/命玉/强化道具给承担突破或收割职责的输出位。不允许为了不重复道具而破坏宝可梦定位。
45. 如果同一只宝可梦存在 Mega、普通形态、地区形态或不同形态，必须使用 Champions 数据中的 id/name/form 判断，不能混用招式、特性、道具或定位。
46. 如果 commonMoves/commonItems/commonAbilities 与 importedTeam 配置冲突：importedTeam 只在合法且符合当前意图时保留；否则优先使用 Champions 常见数据，并在 note 中说明“调整为当前环境常见配置”。
47. 努力值必须服务于角色：输出手优先速度/火力，耐久轮转优先关键耐久，辅助优先生存和出手。不要所有成员机械套 252/252；如果数据不足，可写合理模板并标注“可替换”。
48. watch 至少包含 3 条：每条必须包含主要威胁或 branchModel 分支、应对成员、具体处理顺序。不能只写“怕某某”。如果 intent.targetPokemon 不为空，watch 里必须至少有 1 条专门回答目标宝可梦/目标打法。

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
  ${JSON.stringify(compactPromptValue(payload))}
`;
  return payload.promptMode === "quick" ? prompt.replace(/输出要求：[\s\S]*?\nJSON 结构：/, `${quickOutputRequirements}\n\nJSON 结构：`) : prompt;
}

function showdownFormatFor(format = "single") {
  const value = String(format || "").toLowerCase();
  if (value.includes("vgc")) return "gen9vgc2025regg";
  if (value.includes("double")) return "gen9nationaldexdoubles";
  return "gen9nationaldex";
}

function showdownLegalValue(value = "", fallback = "", category = "") {
  const text = String(value || "").trim();
  const safeFallback = String(fallback || "").trim();
  if (!text) return safeFallback;
  const dex = category && Dex?.[category];
  if (dex?.get) {
    const data = dex.get(text);
    if (!data?.exists) return safeFallback;
  }
  return text;
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

function readTeamDataFile() {
  try {
    const data = JSON.parse(readFileSync(TEAM_DATA_PATH, "utf8"));
    return Array.isArray(data?.teams) ? data.teams : [];
  } catch {
    return [];
  }
}

async function readBattleHistoryFile() {
  try {
    const data = JSON.parse(await readFile(BATTLE_HISTORY_PATH, "utf8"));
    return Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeBattleHistoryFile(items = []) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    items,
  };
  await writeFile(BATTLE_HISTORY_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload.items;
}

function battleHistoryEntryKey(item = {}) {
  return [item.key || "", item.format || "", item.teamSignature || "", item.updatedAt || ""].join("|");
}

async function handleBattleHistory(req, res) {
  if (req.method === "GET") {
    const items = await readBattleHistoryFile();
    sendJson(res, 200, { ok: true, items });
    return;
  }
  const body = await readJson(req).catch(() => ({}));
  const incoming = Array.isArray(body.items) ? body.items : body.entry ? [body.entry] : [];
  const existing = await readBattleHistoryFile();
  const merged = [];
  const seen = new Set();
  for (const item of [...incoming, ...existing].filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
    const stableKey = [item.key || "", item.format || "", item.teamSignature || ""].join("|");
    const key = stableKey.trim() ? stableKey : battleHistoryEntryKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  const items = await writeBattleHistoryFile(merged);
  sendJson(res, 200, { ok: true, items });
}

function battleFormatFor(format = "single", custom = false) {
  const value = String(format || "").toLowerCase();
  if (!custom) return showdownFormatFor(format);
  return value.includes("double") || value.includes("vgc") ? "gen9doublescustomgame" : "gen9customgame";
}

function prepareBattleTeam(text = "", format = "single", label = "队伍") {
  const team = Teams.import(text);
  if (!team?.length) {
    return {
      ok: false,
      label,
      problems: [`${label} 没有解析到有效 Showdown 队伍文本。`],
      teamSize: 0,
    };
  }
  const repaired = [];
  const skipped = [];
  for (const [index, mon] of team.slice(0, 6).entries()) {
    const species = legalShowdownSpeciesName(mon?.species || mon?.name || mon?.id || mon?.template?.species || "", mon);
    if (!species) {
      skipped.push(`${label} 第 ${index + 1} 只宝可梦无法解析为合法 Showdown 物种。`);
      continue;
    }
    const item = showdownLegalValue(mon?.item, "", "items");
    const ability = showdownLegalValue(mon?.ability, "", "abilities");
    const nature = showdownLegalValue(mon?.nature, "", "natures");
    const moves = (Array.isArray(mon?.moves) ? mon.moves : []).map((move) => showdownLegalValue(move, "", "moves")).filter(Boolean).slice(0, 4);
    repaired.push({
      ...mon,
      species,
      item,
      ability,
      nature,
      moves,
      level: mon?.level || 50,
      evs: mon?.evs || {},
      ivs: mon?.ivs || {},
    });
  }
  if (!repaired.length) {
    return {
      ok: false,
      label,
      problems: [`${label} 解析后没有可识别的宝可梦物种。请确认导出的队伍文本是英文 Showdown 格式。`],
      teamSize: 0,
    };
  }
  const packedText = Teams.pack(repaired.slice(0, 6));
  const validation = validateShowdownTeam(packedText, format);
  return {
    ok: true,
    label,
    strictLegal: validation.ok,
    problems: [...skipped, ...(validation.problems || [])],
    teamSize: repaired.length,
    packedTeam: packedText,
  };
}

function availableSwitchIndexes(request = {}, activeIndex = 0) {
  const side = request.side?.pokemon || [];
  const activeCount = Array.isArray(request.forceSwitch) ? request.forceSwitch.length : Array.isArray(request.active) ? request.active.length : 1;
  return side
    .map((pokemon, index) => ({ pokemon, index: index + 1 }))
    .filter(({ pokemon, index }) => {
      if (pokemon.active) return false;
      if (String(pokemon.condition || "").includes("0 fnt")) return false;
      if (index <= activeCount && side.length > activeCount) return false;
      return true;
    })
    .map((item) => item.index);
}

const BATTLE_MOVE_PATTERNS = {
  speedControl: /tailwind|trick room|icy wind|icywind|electroweb|thunder wave|thunderwave|glare|rock tomb|rocktomb|bulldoze|scary face|scaryface|string shot|stringshot|cotton spore/i,
  pivot: /u-turn|uturn|volt switch|voltswitch|flip turn|flipturn|parting shot|partingshot|chilly reception|baton pass|batonpass/i,
  recovery: /recover|roost|slack off|slackoff|wish|soft-boiled|softboiled|moonlight|synthesis|rest|shore up|shoreup/i,
  disrupt: /fake out|taunt|encore|spore|sleep powder|sleeppowder|will-o-wisp|willowisp|toxic|nuzzle|parting shot|partingshot|snarl|charm|fake tears/i,
  protect: /protect|detect|spiky shield|spikyshield|king's shield|kingsshield|baneful bunker|banefulbunker|silk trap|silktrap/i,
  setup: /swords dance|swordsdance|nasty plot|nastyplot|dragon dance|dragondance|quiver dance|quiverdance|calm mind|calmmind|bulk up|bulkup|shell smash|shellsmash|growth/i,
  priority: /quick attack|extreme speed|extremespeed|aqua jet|bullet punch|ice shard|shadow sneak|sucker punch|mach punch|first impression/i,
};

function hpRatio(condition = "") {
  const text = String(condition || "");
  if (text.includes("0 fnt")) return 0;
  const match = text.match(/(\d+)\/(\d+)/);
  if (!match) return 1;
  const current = Number(match[1] || 0);
  const max = Number(match[2] || 1);
  return max > 0 ? current / max : 0;
}

function activeHpRatio(request = {}, activeIndex = 0) {
  const activePokemon = (request.side?.pokemon || []).filter((pokemon) => pokemon.active)[activeIndex] || request.side?.pokemon?.[activeIndex];
  return hpRatio(activePokemon?.condition || "");
}

function createBattleAgentState(playerId = "p1") {
  return {
    playerId,
    foeId: playerId === "p1" ? "p2" : "p1",
    foes: new Map(),
  };
}

function battleSlotIndex(ident = "") {
  const match = String(ident).match(/^p[12]([a-d])/);
  return match ? match[1].charCodeAt(0) - 97 : 0;
}

function parseBattleIdent(value = "") {
  const [ident, name = ""] = String(value || "").split(": ");
  return { side: ident.slice(0, 2), slot: battleSlotIndex(ident), name: name.trim() };
}

function observeBattleLine(agent, line = "") {
  if (!agent || !line.startsWith("|")) return;
  const parts = line.split("|");
  const cmd = parts[1];
  if (cmd === "switch" || cmd === "drag" || cmd === "replace") {
    const ident = parseBattleIdent(parts[2]);
    if (ident.side === agent.foeId) {
      agent.foes.set(ident.slot, {
        name: ident.name,
        hp: hpRatio(parts[4] || ""),
        active: true,
      });
    }
  } else if (cmd === "-damage" || cmd === "-heal" || cmd === "faint") {
    const ident = parseBattleIdent(parts[2]);
    if (ident.side === agent.foeId) {
      const previous = agent.foes.get(ident.slot) || { name: ident.name, hp: 1, active: true };
      agent.foes.set(ident.slot, {
        ...previous,
        hp: cmd === "faint" ? 0 : hpRatio(parts[3] || ""),
        active: cmd !== "faint",
      });
    }
  }
}

function opponentHpRatios(agent = null, format = "single") {
  const count = format === "double" ? 2 : 1;
  return Array.from({ length: count }, (_, index) => agent?.foes?.get(index)?.hp ?? 1);
}

function moveDataFor(move = {}) {
  const id = String(move.id || move.move || "").toLowerCase();
  const data = Dex.moves.get(id);
  return {
    id,
    basePower: Number(data.basePower || 0),
    accuracy: data.accuracy === true ? 100 : Number(data.accuracy || 90),
    category: data.category || "",
    priority: Number(data.priority || 0),
    target: move.target || data.target || "",
    flags: data.flags || {},
    status: data.status || "",
    volatileStatus: data.volatileStatus || "",
    boosts: data.boosts || null,
    sideCondition: data.sideCondition || "",
    weather: data.weather || "",
    terrain: data.terrain || "",
  };
}

function battleMoveTags(move = {}) {
  const data = moveDataFor(move);
  const tags = [];
  if (data.basePower > 0) tags.push("damage");
  if (data.priority > 0) tags.push("priority");
  if (/protect|detect|spikyshield|kingsshield|banefulbunker|silktrap/.test(data.id)) tags.push("protect");
  if (/wideguard|quickguard/.test(data.id)) tags.push("team-protect");
  if (/tailwind|trickroom|icywind|electroweb|thunderwave|glare|rocktomb|bulldoze|scaryface|stringshot|cottonspore/.test(data.id)) tags.push("speed-control");
  if (/fakeout|taunt|encore|spore|sleeppowder|willowisp|toxic|nuzzle|partingshot|snarl|charm|fake tears/i.test(data.id)) tags.push("disrupt");
  if (/stealthrock|spikes|toxicspikes|stickyweb/.test(data.id)) tags.push("hazard");
  if (/rapidspin|defog|mortalspin|tidyup/.test(data.id)) tags.push("removal");
  if (/uturn|voltswitch|flipturn|partingshot|chillyreception|batonpass/.test(data.id)) tags.push("pivot");
  if (/swordsdance|nastyplot|dragondance|quiverdance|calmmind|bulkup|shellsmash|growth/.test(data.id)) tags.push("setup");
  if (/recover|roost|slackoff|wish|softboiled|moonlight|synthesis|rest|shoreup/.test(data.id)) tags.push("recovery");
  if (data.target === "allAdjacentFoes" || data.target === "allAdjacent") tags.push("spread");
  if (data.weather || /sunnyday|raindance|sandstorm|snowscape/.test(data.id)) tags.push("weather");
  return tags;
}

function pokemonBattleSnapshot(request = {}, activeIndex = 0) {
  const sidePokemon = request.side?.pokemon || [];
  const activePokemon = sidePokemon.filter((pokemon) => pokemon.active)[activeIndex] || sidePokemon[activeIndex] || {};
  const allies = sidePokemon.filter((pokemon) => !pokemon.active && String(pokemon.condition || "").indexOf("fnt") < 0);
  const hp = hpRatio(activePokemon.condition || "");
  const faintedCount = sidePokemon.filter((pokemon) => String(pokemon.condition || "").includes("0 fnt")).length;
  return {
    active: activePokemon,
    hp,
    faintedCount,
    reserveCount: allies.length,
    trapped: Boolean(activePokemon.trapped || activePokemon.maybeTrapped || activePokemon.isTrapped || activePokemon.forceSwitchFlag),
    canMegaEvo: Boolean(activePokemon.canMegaEvo),
    canTerastallize: Boolean(activePokemon.canTerastallize),
    canUltraBurst: Boolean(activePokemon.canUltraBurst),
    canDynamax: Boolean(activePokemon.canDynamax),
  };
}

function moveBattleValue(move = {}, format = "single", turn = 1, activeIndex = 0, request = {}, agent = null) {
  const data = moveDataFor(move);
  const tags = battleMoveTags(move);
  const hp = activeHpRatio(request, activeIndex);
  const foeHp = opponentHpRatios(agent, format);
  const foeAvgHp = foeHp.length ? foeHp.reduce((sum, ratio) => sum + ratio, 0) / foeHp.length : 1;
  let score = 10;

  if (tags.includes("damage")) {
    score += Math.min(32, data.basePower / 4) + Math.max(0, data.accuracy - 80) / 5 + data.priority * 4;
    if (data.category === "Status") score -= 5;
  }
  if (tags.includes("priority") && foeHp.some((ratio) => ratio <= 0.35)) score += 12;
  if (tags.includes("protect")) score += format === "double" ? (hp <= 0.45 ? 16 : turn <= 3 ? 6 : 1) : hp <= 0.3 ? 4 : -12;
  if (tags.includes("team-protect")) score += format === "double" ? 12 : -8;
  if (tags.includes("speed-control")) score += turn <= 4 ? (format === "double" ? 18 : 11) : 6;
  if (tags.includes("disrupt")) score += turn <= 4 ? (format === "double" ? 12 : 8) : 4;
  if (tags.includes("hazard")) score += format === "single" && turn <= 4 ? 15 : -9;
  if (tags.includes("removal")) score += format === "single" ? 7 : -5;
  if (tags.includes("pivot")) score += format === "single" ? (hp <= 0.5 ? 14 : 8) : 5;
  if (tags.includes("setup")) score += hp >= 0.6 && turn <= 6 ? (format === "single" ? 10 : 4) : -8;
  if (tags.includes("recovery")) score += hp <= 0.5 ? 14 : turn <= 3 ? -10 : -3;
  if (tags.includes("spread")) score += format === "double" ? 11 : 0;
  if (tags.includes("weather")) score += turn <= 3 ? 6 : 1;
  if (/explosion|selfdestruct|memento|finalgambit/.test(data.id)) score -= 12;

  if (data.category === "Status") {
    if (turn <= 2 && (tags.includes("speed-control") || tags.includes("disrupt") || tags.includes("hazard"))) score += 6;
    if (hp <= 0.35 && !tags.includes("protect") && !tags.includes("recovery")) score -= 8;
  }
  if (foeAvgHp <= 0.35 && tags.includes("damage")) score += 10;
  return score;
}

function switchBattleValue(pokemon = {}, request = {}, format = "single", activeIndex = 0, agent = null) {
  const name = String(pokemon.name || pokemon.ident || "").toLowerCase();
  const moveText = (pokemon.moves || []).join(" ").toLowerCase();
  let score = 20;
  const hp = hpRatio(pokemon.condition || "");
  const foeHp = opponentHpRatios(agent, format);
  const foeAvgHp = foeHp.length ? foeHp.reduce((sum, ratio) => sum + ratio, 0) / foeHp.length : 1;

  if (String(pokemon.condition || "").includes("0 fnt")) return -999;
  if (pokemon.active) return -999;
  if (pokemon.trapped || pokemon.maybeTrapped || pokemon.forceSwitchFlag) return -999;

  if (hp >= 0.8) score += 8;
  if (hp <= 0.35) score -= 8;
  if (BATTLE_MOVE_PATTERNS.speedControl.test(moveText)) score += 10;
  if (BATTLE_MOVE_PATTERNS.pivot.test(moveText)) score += 10;
  if (BATTLE_MOVE_PATTERNS.recovery.test(moveText)) score += 6;
  if (BATTLE_MOVE_PATTERNS.disrupt.test(moveText)) score += 6;
  if (BATTLE_MOVE_PATTERNS.protect.test(moveText)) score += format === "double" ? 5 : 1;
  if (/威吓|intimidate/.test(name)) score += format === "double" ? 6 : 2;
  if (/再来一次|follow me|rage powder|看我嘛|击掌|fake out/.test(moveText)) score += format === "double" ? 12 : 0;
  if (/顺风|tailwind|戏法空间|trick room|冰冻之风|electroweb|电磁波/.test(moveText)) score += 8;
  if (format === "double" && hp >= 0.4 && !BATTLE_MOVE_PATTERNS.protect.test(moveText)) score += 2;
  if (format === "single" && BATTLE_MOVE_PATTERNS.setup.test(moveText) && hp <= 0.5) score -= 4;
  if (foeAvgHp <= 0.4 && BATTLE_MOVE_PATTERNS.priority.test(moveText)) score += 10;
  if (request.forceSwitch) score += 4;
  if (activeIndex === 0) score += 1;
  return score;
}

function battleScoreNoise(format = "single") {
  return (Math.random() - 0.5) * (format === "double" ? 6 : 4);
}

function chooseBattleSwitch(request = {}, format = "single", activeIndex = 0, agent = null) {
  const switches = availableSwitchIndexes(request, activeIndex);
  if (!switches.length) return "default";
  const sidePokemon = request.side?.pokemon || [];
  const options = switches
    .map((index) => sidePokemon[index - 1])
    .filter(Boolean)
    .map((pokemon, optionIndex) => ({
      pokemon,
      index: switches[optionIndex],
      score: switchBattleValue(pokemon, request, format, activeIndex, agent) + battleScoreNoise(format),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return options[0]?.index ? `switch ${options[0].index}` : "default";
}

function scoreBattleMove(move = {}, format = "single", turn = 1, activeIndex = 0, request = {}, agent = null) {
  if (!move || move.disabled) return -999;
  return moveBattleValue(move, format, turn, activeIndex, request, agent) + battleScoreNoise(format);
}

function targetSuffixForMove(move = {}, format = "single", activeIndex = 0, agent = null) {
  const target = move?.target || moveDataFor(move).target;
  if (format !== "double") return "";
  if (["normal", "any", "adjacentFoe"].includes(target)) {
    const foes = opponentHpRatios(agent, "double");
    return ` ${foes[1] < foes[0] ? 2 : 1}`;
  }
  if (target === "adjacentAlly") return ` -${(activeIndex ^ 1) + 1}`;
  if (target === "adjacentAllyOrSelf") return ` -${(activeIndex ^ 1) + 1}`;
  return "";
}

function chooseBattleMove(request = {}, format = "single", turn = 1, agent = null) {
  if (request.wait) return "";
  if (request.teamPreview) return "default";
  if (Array.isArray(request.forceSwitch)) {
    return request.forceSwitch
      .map((required, index) => {
        if (!required) return "pass";
        const choice = chooseBattleSwitch(request, format, index, agent);
        const switchIndex = String(choice).match(/^switch\s+(\d+)$/)?.[1];
        return `switch ${switchIndex || index + 2}`;
      })
      .join(", ");
  }
  if (!Array.isArray(request.active)) return "default";
  const chosenSwitches = new Set();
  return request.active
    .map((active, activeIndex) => {
      const sidePokemon = request.side?.pokemon || [];
      const ownActive = sidePokemon.filter((pokemon) => pokemon.active)[activeIndex] || sidePokemon[activeIndex];
      if (String(ownActive?.condition || "").endsWith(" fnt") || ownActive?.commanding) return "pass";
      const moves = Array.isArray(active.moves) ? active.moves : [];
      const snapshot = pokemonBattleSnapshot(request, activeIndex);
      const shouldSwitch =
        !snapshot.trapped &&
        snapshot.hp <= (format === "double" ? 0.22 : 0.28) &&
        snapshot.reserveCount > 0 &&
        !moves.some((move) => move && !move.disabled && moveBattleValue(move, format, turn, activeIndex, request, agent) >= 28);
      if (shouldSwitch) {
        const switchIndex = chooseBattleSwitch(request, format, activeIndex, agent).match(/^switch\s+(\d+)/)?.[1];
        if (switchIndex && !chosenSwitches.has(Number(switchIndex))) {
          chosenSwitches.add(Number(switchIndex));
          return `switch ${switchIndex}`;
        }
      }
      const bestMove = moves
        .map((move, index) => ({ move, index: index + 1, score: scoreBattleMove(move, format, turn, activeIndex, request, agent), tags: battleMoveTags(move) }))
        .filter((item) => !item.move.disabled)
        .sort((a, b) => b.score - a.score || a.index - b.index)[0];
      if (bestMove && bestMove.score > -999) {
        let choice = `move ${bestMove.index}${targetSuffixForMove(bestMove.move, format, activeIndex, agent)}`;
        if (agent) {
          agent.lastTags = agent.lastTags || [];
          agent.lastTags.push(...bestMove.tags);
        }
        return choice;
      }
      const switchIndex = availableSwitchIndexes(request, activeIndex).find((index) => !chosenSwitches.has(index));
      if (switchIndex) {
        chosenSwitches.add(switchIndex);
        return `switch ${switchIndex}`;
      }
      return "default";
    })
    .join(", ");
}

function recordActionTags(actionLog, tags = []) {
  actionLog.tags ||= {};
  for (const tag of tags.filter(Boolean)) {
    actionLog.tags[tag] = (actionLog.tags[tag] || 0) + 1;
  }
}

function pushBattleTrace(actionLog, line) {
  if (!line) return;
  actionLog.trace ||= [];
  actionLog.trace.push(String(line));
  if (actionLog.trace.length > 180) actionLog.trace.shift();
}

function stripBattleSide(value = "") {
  return String(value || "").replace(/^p\d[a-z]?:\s*/i, "").trim();
}

function shouldRecordBattleLine(line = "") {
  return /^(\|turn\||\|switch\||\|move\||\|-damage\||\|-heal\||\|-status\||\|-curestatus\||\|-boost\||\|-unboost\||\|-activate\||\|-ability\||\|-item\||\|-enditem\||\|-weather\||\|-fieldstart\||\|-fieldend\||\|-terrain\||\|faint\||\|win\||\|tie\||\|error\||\|cant\||\|-crit\||\|-supereffective\||\|-resisted\||\|-immune\||\|-miss\||\|-fail\||\|-sidestart\||\|-sideend\||\|-message\||\|-hint\||\|-prepare\||\|-mustrecharge\||\|-start\||\|-end\||\|-sethp\||\|-drag\||\|-zpower\||\|-ability\||\|-terastallize\||\|-heal\|)/.test(
    String(line || ""),
  );
}

function describeBattleLine(line = "", turn = 0) {
  const raw = String(line || "");
  const parts = raw.split("|").slice(1);
  const [cmd = "", a = "", b = "", c = ""] = parts;
  const sideA = stripBattleSide(a);
  const sideB = stripBattleSide(b);
  const sideC = stripBattleSide(c);
  if (cmd === "turn") return `回合 ${a || turn}`;
  if (cmd === "switch") return `${sideA || "宝可梦"} 换入${sideB ? `：${sideB}` : ""}`;
  if (cmd === "move") return `${sideA || "宝可梦"} 使用 ${b || "招式"}${c ? ` · ${c}` : ""}`;
  if (cmd === "-damage") return `${sideA || "宝可梦"} 受到伤害${b ? ` · ${b}` : ""}`;
  if (cmd === "-heal") return `${sideA || "宝可梦"} 回复${b ? ` · ${b}` : ""}`;
  if (cmd === "faint") return `${sideA || "宝可梦"} 倒下`;
  if (cmd === "win") return `获胜：${a || "未知"}`;
  if (cmd === "tie") return "平局";
  if (cmd === "error") return `错误：${a || ""}`.trim();
  if (cmd === "cant") return `${sideA || "宝可梦"} 无法行动${b ? ` · ${b}` : ""}`;
  if (cmd === "-status" || cmd === "-curestatus") return `${sideA || "宝可梦"} ${cmd === "-status" ? "获得状态" : "解除状态"}${b ? ` · ${b}` : ""}`;
  if (cmd === "-boost" || cmd === "-unboost") return `${sideA || "宝可梦"} ${cmd === "-boost" ? "能力提升" : "能力下降"}${b ? ` · ${b}` : ""}`;
  if (cmd === "-activate") return `${sideA || "宝可梦"} 触发：${b || ""}${c ? ` · ${c}` : ""}`.trim();
  if (cmd === "-ability") return `${sideA || "宝可梦"} 特性：${b || ""}${c ? ` · ${c}` : ""}`.trim();
  if (cmd === "-item") return `${sideA || "宝可梦"} 道具：${b || ""}${c ? ` · ${c}` : ""}`.trim();
  if (cmd === "-enditem") return `${sideA || "宝可梦"} 道具结束：${b || ""}`.trim();
  if (cmd === "-weather") return `天气：${b || ""}`;
  if (cmd === "-terrain") return `场地：${b || ""}`;
  if (cmd === "-fieldstart") return `场地开始：${b || ""}`;
  if (cmd === "-fieldend") return `场地结束：${b || ""}`;
  if (cmd === "-sidestart") return `己方效果：${b || ""}`;
  if (cmd === "-sideend") return `己方效果结束：${b || ""}`;
  if (cmd === "-crit") return `${sideA || "宝可梦"} 暴击`;
  if (cmd === "-supereffective") return `${sideA || "宝可梦"} 效果拔群`;
  if (cmd === "-resisted") return `${sideA || "宝可梦"} 效果不理想`;
  if (cmd === "-immune") return `${sideA || "宝可梦"} 无效`;
  if (cmd === "-miss") return `${sideA || "宝可梦"} 未命中`;
  if (cmd === "-fail") return `${sideA || "宝可梦"} 行动失败`;
  if (cmd === "-message" || cmd === "-hint") return a || raw.replace(/^\|/, "");
  if (cmd === "-prepare") return `${sideA || "宝可梦"} 蓄力：${b || ""}`;
  if (cmd === "-mustrecharge") return `${sideA || "宝可梦"} 需要蓄力`;
  if (cmd === "-start" || cmd === "-end") return `${sideA || "宝可梦"} ${cmd === "-start" ? "开始" : "结束"}：${b || ""}`.trim();
  if (cmd === "-sethp") return `${sideA || "宝可梦"} HP 变更：${b || ""}${c ? ` · ${c}` : ""}`.trim();
  if (cmd === "-drag") return `${sideA || "宝可梦"} 被拖出${b ? ` · ${b}` : ""}`;
  if (cmd === "-zpower") return `${sideA || "宝可梦"} Z 招式`;
  if (cmd === "-terastallize") return `${sideA || "宝可梦"} 太晶化${b ? ` · ${b}` : ""}`;
  return raw.replace(/^\|/, "").replace(/\|/g, " · ");
}

async function runBattlePlayer(stream, format, actionLog, playerId, agent, candidatePlayerId = "p1") {
  let turn = 1;
  for await (const chunk of stream) {
    for (const line of chunk.split("\n")) {
      observeBattleLine(agent, line);
      if (line.startsWith("|turn|")) turn = Number(line.split("|")[2] || turn) || turn;
      if (line.startsWith("|error|")) {
        actionLog.errors.push(`${playerId}: ${line.slice(7)}`);
        stream.write("default");
        continue;
      }
      if (!line.startsWith("|request|")) continue;
      const request = JSON.parse(line.slice(9));
      agent.lastTags = [];
      const choice = chooseBattleMove(request, format, turn, agent);
      if (!choice) continue;
      if (request.teamPreview) actionLog.teamPreview += 1;
      else if (request.forceSwitch) actionLog.switches += String(choice).split("switch").length - 1;
      else actionLog.moves += String(choice).split("move").length - 1;
      pushBattleTrace(actionLog, `[${playerId.toUpperCase()} 回合 ${turn}] ${String(choice)}`);
      if (playerId === candidatePlayerId) {
        if (String(choice).includes("switch")) recordActionTags(actionLog, ["switch"]);
        recordActionTags(actionLog, agent.lastTags || []);
      }
      stream.write(choice);
    }
  }
}

async function runLocalBattle({ format = "single", formatId, p1Team, p2Team, maxTurns = 80, seed = null, p1Name = "Candidate", p2Name = "Meta", candidateName = "Candidate" }) {
  const battleStream = new BattleStream();
  const streams = getPlayerStreams(battleStream);
  const actionLog = { moves: 0, switches: 0, teamPreview: 0, errors: [], tags: {}, trace: [] };
  const p1Agent = createBattleAgentState("p1");
  const p2Agent = createBattleAgentState("p2");
  const candidatePlayerId = p1Name === candidateName ? "p1" : p2Name === candidateName ? "p2" : "p1";
  const p1 = runBattlePlayer(streams.p1, format, actionLog, "p1", p1Agent, candidatePlayerId);
  const p2 = runBattlePlayer(streams.p2, format, actionLog, "p2", p2Agent, candidatePlayerId);
  let turns = 0;
  let winner = "";
  let tied = false;
  let forcedTie = false;
  let p1Faints = 0;
  let p2Faints = 0;

  const watch = (async () => {
    for await (const chunk of streams.omniscient) {
      for (const line of chunk.split("\n")) {
        if (line.startsWith("|turn|")) {
          turns = Number(line.split("|")[2] || turns) || turns;
          pushBattleTrace(actionLog, describeBattleLine(line, turns));
          if (turns > maxTurns && !forcedTie) {
            forcedTie = true;
            streams.omniscient.write(">forcetie");
          }
        } else if (line.startsWith("|faint|p1")) {
          p1Faints += 1;
          if (shouldRecordBattleLine(line)) pushBattleTrace(actionLog, describeBattleLine(line, turns));
        } else if (line.startsWith("|faint|p2")) {
          p2Faints += 1;
          if (shouldRecordBattleLine(line)) pushBattleTrace(actionLog, describeBattleLine(line, turns));
        } else if (line.startsWith("|win|")) {
          winner = line.slice(5).trim();
          pushBattleTrace(actionLog, describeBattleLine(line, turns));
        } else if (line.startsWith("|tie|")) {
          tied = true;
          pushBattleTrace(actionLog, describeBattleLine(line, turns));
        } else if (line.startsWith("|error|")) {
          actionLog.errors.push(line.slice(7));
          pushBattleTrace(actionLog, describeBattleLine(line, turns));
        } else if (shouldRecordBattleLine(line)) {
          pushBattleTrace(actionLog, describeBattleLine(line, turns));
        }
      }
      if (winner || tied) break;
    }
  })();

  const startOptions = { formatid: formatId };
  if (seed) startOptions.seed = seed;
  streams.omniscient.write(`>start ${JSON.stringify(startOptions)}`);
  streams.omniscient.write(`>player p1 ${JSON.stringify({ name: p1Name, team: p1Team })}`);
  streams.omniscient.write(`>player p2 ${JSON.stringify({ name: p2Name, team: p2Team })}`);

  await Promise.race([
    watch,
    new Promise((resolve) => setTimeout(resolve, 15000)),
  ]);
  if (!winner && !tied) {
    forcedTie = true;
    streams.omniscient.write(">forcetie");
  }
  streams.omniscient.writeEnd();
  await Promise.allSettled([p1, p2]);
  if (!actionLog.trace.length) {
    pushBattleTrace(actionLog, `模拟摘要：${winner ? `${winner} 获胜` : tied ? "平局" : "未分出胜负"}，${turns || 0} 回合。`);
    pushBattleTrace(actionLog, `行动统计：招式 ${actionLog.moves || 0} 次，换人 ${actionLog.switches || 0} 次，队伍预览 ${actionLog.teamPreview || 0} 次。`);
    if (forcedTie) pushBattleTrace(actionLog, "模拟达到回合或时间上限，已强制判平。");
    for (const error of actionLog.errors.slice(0, 3)) pushBattleTrace(actionLog, `模拟错误：${error}`);
  }

  const candidateFaints = candidatePlayerId === "p1" ? p1Faints : p2Faints;
  const opponentFaints = candidatePlayerId === "p1" ? p2Faints : p1Faints;
  return {
    result: winner === candidateName ? "win" : winner ? "loss" : "tie",
    winner: winner || (tied ? "tie" : ""),
    turns,
    forcedTie,
    p1Faints,
    p2Faints,
    candidateFaints,
    opponentFaints,
    actions: actionLog,
  };
}

function uniqueByKey(items = [], keyFn = (item) => item?.id || item?.title || "") {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(keyFn(item) || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sampleWeighted(items = [], limit = 5) {
  const pool = items
    .map((item) => ({
      ...item,
      sampleWeight: Math.max(1, Number(item.rate || 0) + (Number(item.rank || 9999) ? Math.max(0, 1400 - Number(item.rank || 9999)) / 50 : 0) + (item.source === "OP.GG Replica Teams" ? 12 : 0)),
    }))
    .filter((item) => item.sampleWeight > 0);
  const picks = [];
  const working = [...pool];
  while (working.length && picks.length < limit) {
    const total = working.reduce((sum, item) => sum + item.sampleWeight, 0);
    let roll = Math.random() * total;
    let index = 0;
    for (; index < working.length; index += 1) {
      roll -= working[index].sampleWeight;
      if (roll <= 0) break;
    }
    picks.push(working.splice(Math.min(index, working.length - 1), 1)[0]);
  }
  return picks;
}

function hotOpponentPool(format = "single", season = "") {
  const currentSeason = String(season || "").trim();
  return readTeamDataFile()
    .filter((team) => team.format === format && (!currentSeason || !team.season || team.season === currentSeason))
    .filter((team) => Array.isArray(team.members) && team.members.length >= 6)
    .sort((a, b) => Number(b.rate || 0) - Number(a.rate || 0) || Number(a.rank || 9999) - Number(b.rank || 9999))
    .slice(0, 120)
    .map((team) => ({
      id: team.id,
      title: team.title,
      source: team.source,
      season: team.season,
      format: team.format,
      rate: Number(team.rate || 0),
      rank: Number(team.rank || 9999),
      rentalCode: team.rentalCode || "",
      members: (team.members || []).map((member) => String(member?.name || member?.slug || "").trim()).filter(Boolean).slice(0, 6),
      configurations: (team.configurations || []).slice(0, 6).map((config) => ({
        slug: config.slug,
        item: config.item,
        ability: config.ability,
        nature: config.nature,
        stats: config.stats,
        moves: config.moves || [],
      })),
      showdownText: showdownTextForHotTeam(team),
    }));
}

function randomHotOpponentTeams(format = "single", limit = 5, season = "") {
  const pool = hotOpponentPool(format, season);
  return sampleWeighted(pool, limit)
    .map((team, index) => ({
      id: team.id,
      rank: index + 1,
      title: team.title,
      source: team.source,
      season: team.season,
      format: team.format,
      rate: Number(team.rate || 0),
      rentalCode: team.rentalCode || "",
      members: team.members,
      configurations: team.configurations,
      showdownText: team.showdownText,
      evaluationRole: "hot-random-opponent",
    }));
}

function showdownTextForHotTeam(team = {}) {
  const configsBySlug = new Map((team.configurations || []).map((config) => [String(config.slug || config.name || "").toLowerCase(), config]));
  return (team.members || [])
    .slice(0, 6)
    .map((member, index) => {
      const memberSlug = String(member?.slug || member?.name || member || "").toLowerCase();
      const memberName = String(member?.name || member?.slug || member || "").toLowerCase();
      const species = legalShowdownSpeciesName(member?.id || member?.slug || member?.name || member || "", member);
      if (!species) return "";
      const config =
        configsBySlug.get(species.toLowerCase()) ||
        configsBySlug.get(memberSlug) ||
        configsBySlug.get(memberName) ||
        (team.configurations || [])[index] ||
        {};
      const item = showdownLegalValue(config.item, "", "items");
      const ability = showdownLegalValue(config.ability, "", "abilities");
      const nature = showdownLegalValue(config.nature, "", "natures");
      const moves = (Array.isArray(config.moves) ? config.moves : []).map((move) => showdownLegalValue(move, "", "moves")).filter(Boolean);
      const lines = [`${species}${item ? ` @ ${item}` : ""}`];
      if (ability) lines.push(`Ability: ${ability}`);
      lines.push(`Level: ${config.level || 50}`);
      if (config.stats) lines.push(`EVs: ${config.stats}`);
      if (nature) lines.push(`${nature} Nature`);
      for (const move of moves.slice(0, 4)) lines.push(`- ${move}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function battleFailureReasons(result, format = "single") {
  const reasons = [];
  const tags = result.actions?.tags || {};
  const candidateFaints = Number.isFinite(Number(result.candidateFaints)) ? Number(result.candidateFaints) : Number(result.p1Faints || 0);
  const opponentFaints = Number.isFinite(Number(result.opponentFaints)) ? Number(result.opponentFaints) : Number(result.p2Faints || 0);
  if (result.result === "loss") {
    if (candidateFaints >= 4) reasons.push("候选队伍被击倒速度偏快，优先复盘防守换入与控速。");
    if (opponentFaints <= 2) reasons.push("对固定靶队压制不足，可能缺破盾、范围压力或终盘收割。");
    if (!tags["speed-control"]) reasons.push(`${format === "double" ? "双打" : "单打"}实战代理几乎没有使用控速，下一版优先补稳定速度控制或先制收割。`);
    if (format === "single" && !tags.pivot && !tags.switch) reasons.push("单打缺少安全轮转记录，核心可能只能硬换上场。");
    if (format === "double" && !tags.protect && !tags["team-protect"]) reasons.push("双打缺少保护/广防记录，站场核心容易被集火。");
    if (format === "double" && !tags.spread && opponentFaints <= 2) reasons.push("双打缺少范围压力记录，容易被对方双站场拖住。");
    if (!reasons.length) reasons.push("候选队伍落败，需要检查首发选择、换人节奏和核心输出窗口。");
  }
  if (result.result === "tie" && result.forcedTie) {
    reasons.push("超过回合上限未结束，可能缺稳定终盘或模拟代理进入消耗循环。");
    if (!tags.setup && !tags.hazard) reasons.push("平局记录里缺少强化/撒场推进，下一版需要更明确的破局路线。");
  }
  if (result.actions?.errors?.length) reasons.push("模拟中出现非法选择回退，建议检查招式/换人代理。");
  return reasons;
}

function calibrateBattleResults(results = []) {
  const played = results.filter((item) => ["win", "loss", "tie"].includes(item.result));
  if (played.length < 4 || !played.every((item) => item.result === "win")) return results;
  const uncertainCount = Math.max(2, Math.ceil(played.length * 0.4));
  const closestWins = [...played]
    .sort((a, b) => {
      const marginA = Number(a.opponentFaints || a.p2Faints || 0) - Number(a.candidateFaints || a.p1Faints || 0);
      const marginB = Number(b.opponentFaints || b.p2Faints || 0) - Number(b.candidateFaints || b.p1Faints || 0);
      return marginA - marginB || Number(b.turns || 0) - Number(a.turns || 0);
    })
    .slice(0, uncertainCount);
  const uncertain = new Set(closestWins);
  for (const item of results) {
    if (!uncertain.has(item)) continue;
    item.result = "tie";
    item.winner = "uncertain";
    item.calibrated = true;
    item.failureReasons = [
      "基础代理给出全胜，已按最接近的对局标记为平局风险；需要人工复盘而不是按 100% 胜率理解。",
      ...(item.failureReasons || []),
    ];
    if (item.actions?.trace) {
      item.actions.trace.push("校准提示：本地基础代理全胜时不会输出 100% 确定胜率，本局按平局风险纳入回顾。");
    }
  }
  return results;
}

async function handleBattleEval(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const format = String(body.format || "single").includes("double") ? "double" : "single";
  const own = prepareBattleTeam(body.teamText || "", format, "候选队伍");
  if (!own.ok) {
    sendJson(res, 400, { ok: false, error: own.problems[0], problems: own.problems });
    return;
  }
  const gamesPerOpponent = Math.max(1, Math.min(3, Number(body.gamesPerOpponent || 1) || 1));
  const maxTurns = Math.max(20, Math.min(160, Number(body.maxTurns || 80) || 80));
  const opponentSource = String(body.opponentSource || body.opponentPool || "hot").toLowerCase();
  const results = [];
  const warnings = own.problems.map((problem) => `候选队伍：${problem}`);

  const providedOpponents = Array.isArray(body.opponents) ? body.opponents.filter(Boolean).slice(0, 5) : [];
  const opponents = providedOpponents.length
    ? providedOpponents
    : opponentSource === "hot"
      ? randomHotOpponentTeams(format, 5, body.season)
      : [];
  if (!opponents.length) {
    sendJson(res, 400, { ok: false, error: "缺少可用靶队。请先刷新热门队伍缓存。" });
    return;
  }

  for (const opponent of opponents) {
    const opponentTeam = prepareBattleTeam(opponent.showdownText || "", format, opponent.title || opponent.id || "固定靶队");
    if (!opponentTeam.ok) {
      results.push({
        opponentId: opponent.id || "",
        opponentTitle: opponent.title || "固定靶队",
        result: "skipped",
        failureReasons: opponentTeam.problems,
        actions: {
          moves: 0,
          switches: 0,
          teamPreview: 0,
          errors: opponentTeam.problems,
          tags: {},
          trace: [
            `跳过对局：${opponent.title || opponent.id || "固定靶队"} 无法解析为有效 Showdown 队伍。`,
            ...opponentTeam.problems.slice(0, 4).map((problem) => `原因：${problem}`),
          ],
        },
      });
      continue;
    }
    warnings.push(...opponentTeam.problems.map((problem) => `${opponentTeam.label}：${problem}`));
    const useCustom = !own.strictLegal || !opponentTeam.strictLegal;
    const formatId = battleFormatFor(format, useCustom);
    for (let game = 0; game < gamesPerOpponent; game += 1) {
      const pairings = [
        {
          p1Team: own.packedTeam,
          p2Team: opponentTeam.packedTeam,
          p1Name: "Candidate",
          p2Name: "Meta",
          sideLabel: "候选先手",
        },
        {
          p1Team: opponentTeam.packedTeam,
          p2Team: own.packedTeam,
          p1Name: "Meta",
          p2Name: "Candidate",
          sideLabel: "靶队先手",
        },
      ];
      for (const pairing of pairings) {
        const battle = await runLocalBattle({
          format,
          formatId,
          p1Team: pairing.p1Team,
          p2Team: pairing.p2Team,
          p1Name: pairing.p1Name,
          p2Name: pairing.p2Name,
          candidateName: "Candidate",
          maxTurns,
        });
        results.push({
          opponentId: opponent.id || "",
          opponentTitle: opponent.title || "固定靶队",
          rate: Number(opponent.rate || 0),
          game: game * 2 + (pairing.sideLabel === "候选先手" ? 1 : 2),
          sideLabel: pairing.sideLabel,
          formatId,
          strictLegal: own.strictLegal && opponentTeam.strictLegal,
          ...battle,
          failureReasons: battleFailureReasons(battle, format),
        });
      }
    }
  }

  calibrateBattleResults(results);
  const played = results.filter((item) => ["win", "loss", "tie"].includes(item.result));
  const wins = played.filter((item) => item.result === "win").length;
  const losses = played.filter((item) => item.result === "loss").length;
  const ties = played.filter((item) => item.result === "tie").length;
  sendJson(res, 200, {
    ok: played.length > 0,
    mode: opponentSource === "hot" ? "local-showdown-hot-meta" : "local-showdown-fixed-meta",
    agentVersion: "tactical-single-double-v2",
    format,
    games: played.length,
    wins,
    losses,
    ties,
    winRate: played.length ? Math.round((wins / played.length) * 100) : 0,
    warnings: [...new Set(warnings)].slice(0, 12),
    results,
    note: opponentSource === "hot" ? "本地模拟使用热门队池随机抽样和基础合法动作代理；结果用于发现结构压力点，不等同于公开天梯胜率。" : "本地模拟使用固定 Top5 靶队和基础合法动作代理；结果用于发现结构压力点，不等同于公开天梯胜率。",
  });
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

function firstNonEmptyArray(...arrays) {
  return arrays.find((items) => Array.isArray(items) && items.filter(Boolean).length) || [];
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

function firstTeamLibrarySet(mon = {}) {
  const sets = Array.isArray(mon.teamLibrarySets) ? mon.teamLibrarySets : [];
  return sets.find((item) => item && (item.item || item.ability || item.nature || Array.isArray(item.moves))) || {};
}

let teamLibraryConfigCache = null;
const generatedTeamMemory = new Map();
const THEME_IDS = ["sun", "rain", "trick-room", "sand", "snow"];
function normalizedTeamLibraryConfigs(team = {}) {
  const memberByKey = new Map();
  for (const member of team.members || []) {
    for (const value of [member?.slug, member?.name, member?.id].filter(Boolean)) {
      memberByKey.set(pocketAgTextKey(value), member);
    }
  }
  return (team.configurations || []).map((config) => {
    const key = [config?.slug, config?.name, config?.id].map(pocketAgTextKey).find((value) => memberByKey.has(value));
    const member = key ? memberByKey.get(key) : {};
    return {
      ...member,
      ...config,
      slug: config.slug || member?.slug,
      name: config.name || member?.name,
      id: config.id || member?.id,
    };
  });
}

function pocketAgConfigRawValues(mon = {}) {
  const knownSlugByZh = {
    喷火龙: "charizard",
    风妖精: "whimsicott",
    烈箭鹰: "talonflame",
    大嘴鸥: "pelipper",
    烈咬陆鲨: "garchomp",
    仆斩将军: "kingambit",
    炽焰咆哮虎: "incineroar",
    轰擂金刚猩: "rillaboom",
    克雷色利亚: "cresselia",
    多边兽2: "porygon2",
    煤炭龟: "torkoal",
    超级长耳兔: "lopunny-mega",
  };
  return [
    mon.slug,
    mon.nameMap?.showdown,
    mon.pokeCamp?.identifier,
    mon.pokeCamp?.speciesIdentifier,
    knownSlugByZh[mon.name],
  ].filter(Boolean);
}

function pocketAgExactConfigLookupKeys(mon = {}) {
  return [...new Set(pocketAgConfigRawValues(mon).map(pocketAgTextKey).filter(Boolean))];
}

function pocketAgConfigLookupKeys(mon = {}) {
  const rawValues = pocketAgConfigRawValues(mon);
  const keys = new Set(pocketAgExactConfigLookupKeys(mon));
  for (const value of rawValues) {
    const text = String(value || "");
    const base = text
      .replace(/[-_]?mega[-_]?[xy]?$/i, "")
      .replace(/[-_]?gmax$/i, "")
      .replace(/[-_]?gigantamax$/i, "")
      .replace(/[-_]?(female|male|f|m)$/i, "")
      .replace(/[-_]?(heat|wash|mow|fan|frost)$/i, "")
      .replace(/[-_]?(alola|galar|hisui|paldea)$/i, "");
    const baseKey = pocketAgTextKey(base);
    if (baseKey && baseKey !== pocketAgTextKey(text)) keys.add(baseKey);
  }
  return [...keys];
}

function teamLibraryConfigsFor(mon = {}) {
  const keys = pocketAgConfigLookupKeys(mon);
  if (!keys.length) return [];
  const exactKeys = pocketAgExactConfigLookupKeys(mon);
  if (!teamLibraryConfigCache) {
    const map = new Map();
    for (const team of readTeamDataFile()) {
      for (const config of normalizedTeamLibraryConfigs(team)) {
        const configKeys = [config.slug, config.name].map(pocketAgTextKey).filter(Boolean);
        for (const key of configKeys) {
          if (!map.has(key)) map.set(key, []);
          map.get(key).push({ ...config, sourceRate: Number(team.rate || 0), sourceRank: Number(team.rank || 9999) });
        }
      }
    }
    teamLibraryConfigCache = map;
  }
  const exactConfigs = exactKeys
    .flatMap((key) => teamLibraryConfigCache.get(key) || [])
    .filter((config) => config && (config.item || config.ability || config.nature || (config.moves || []).length));
  const sourceKeys = exactConfigs.length ? exactKeys : keys;
  return sourceKeys
    .flatMap((key) => teamLibraryConfigCache.get(key) || [])
    .filter((config) => config && (config.item || config.ability || config.nature || (config.moves || []).length))
    .sort((a, b) => Number(b.sourceRate || 0) - Number(a.sourceRate || 0) || Number(a.sourceRank || 9999) - Number(b.sourceRank || 9999));
}

let teamLibrarySpeciesKeyCache = null;
function teamLibrarySpeciesKeys() {
  if (!teamLibrarySpeciesKeyCache) {
    const keys = new Set();
    for (const team of readTeamDataFile()) {
      for (const entry of [...(team.members || []), ...(team.configurations || [])]) {
        for (const value of [entry?.slug, entry?.name, entry?.id].filter(Boolean)) {
          keys.add(pocketAgTextKey(value));
        }
      }
    }
    teamLibrarySpeciesKeyCache = keys;
  }
  return teamLibrarySpeciesKeyCache;
}

function pocketAgConfigPoolsFor(mon = {}) {
  const configs = teamLibraryConfigsFor(mon);
  const librarySet = firstTeamLibrarySet(mon);
  const pools = {
    items: new Set(),
    abilities: new Set(),
    natures: new Set(),
    moves: new Set(),
  };
  const add = (pool, value) => {
    const key = pocketAgTextKey(plainText(value || ""));
    if (key) pool.add(key);
  };
  for (const config of [librarySet, ...configs]) {
    add(pools.items, config.item);
    add(pools.abilities, config.ability);
    add(pools.natures, config.nature);
    for (const move of config.moves || []) add(pools.moves, move);
  }
  for (const item of firstNonEmptyArray(mon.commonItems, mon.items)) add(pools.items, firstName([item]));
  for (const ability of firstNonEmptyArray(mon.commonAbilities, mon.abilities)) add(pools.abilities, firstName([ability]));
  for (const nature of firstNonEmptyArray(mon.commonNatures, mon.natures)) add(pools.natures, firstName([nature]));
  for (const move of firstNonEmptyArray(mon.commonMoves, mon.moves)) add(pools.moves, firstName([move]));
  return pools;
}

function requestedTeamStyle(goal = "") {
  const text = String(goal || "");
  const cn = text.normalize("NFKC");
  if (/接棒|强化接棒|baton pass|pass chain|boost pass|传递强化/i.test(text) || /接棒|强化接棒|传递强化/.test(cn)) {
    return {
      id: "pass-chain",
      name: "强化接棒",
      hardRules: [
        "必须围绕强化接棒链构筑。",
        "至少包含 1 个接棒/强化传递成员、1 个接收强化的终盘成员、1 个安全上场或保护成员。",
        "不能输出纯泛用攻队或把接棒写成普通输出套路。",
      ],
      preferRoles: ["转场位", "保护/掩护", "终盘收割", "控速位", "主轴核心"],
      preferMoves: ["baton-pass", "接棒", "protect", "守住", "speed-control", "顺风", "戏法空间"],
      avoidThemes: ["weather", "sun", "rain", "trick-room"],
    };
  }
  if (/stall|受队|盾队|消耗|耐久/.test(text) || /受队|盾队|消耗|耐久/.test(cn)) {
    return { id: "stall", name: "受队", hardRules: ["围绕攻防转换构筑，避免只堆高速输出。"], preferRoles: ["耐久位", "功能位", "物理输出", "特殊输出"], preferMoves: ["u-turn", "volt-switch", "recover", "stealth-rock", "急速折返", "伏特替换", "自我再生", "隐形岩"], avoidThemes: [] };
  }
  if (/offense|进攻|高速|爆发/.test(text) || /进攻|高速|爆发/.test(cn)) return { id: "offense", name: "进攻队", hardRules: ["优先明确破盾、清场和速度线，少放纯消耗位。"], preferRoles: ["物理输出", "特殊输出", "高速位"], preferMoves: ["swords-dance", "nasty-plot", "dragon-dance", "tailwind", "剑舞", "诡计", "龙之舞", "顺风"], avoidThemes: [] };
  if (/sun|晴/.test(text) || /晴天/.test(cn)) return { id: "sun", name: "晴天队", hardRules: ["必须围绕晴天收益构筑。"], preferRoles: ["特殊输出", "高速位", "功能位"], preferMoves: ["sunny-day", "大晴天"], avoidThemes: [] };
  if (/rain|雨/.test(text) || /雨天/.test(cn)) return { id: "rain", name: "雨天队", hardRules: ["必须围绕雨天收益构筑。"], preferRoles: ["物理输出", "特殊输出", "高速位"], preferMoves: ["rain-dance", "求雨"], avoidThemes: [] };
  if (/trick.?room|space/i.test(text) || /空间|戏法空间/.test(cn)) return { id: "trick-room", name: "空间队", hardRules: ["必须围绕戏法空间回合构筑，优先低速高压输出。"], preferRoles: ["耐久位", "物理输出", "特殊输出"], preferMoves: ["trick-room", "戏法空间"], avoidThemes: [] };
  if (/sand|沙暴|沙队|扬沙/i.test(text) || /沙暴|沙队|扬沙/.test(cn)) return { id: "sand", name: "沙暴队", hardRules: ["必须围绕沙暴收益构筑。"], preferRoles: ["物理输出", "耐久位", "高速位"], preferMoves: ["sandstorm", "沙暴"], avoidThemes: [] };
  if (/snow|hail|雪天|雪景|雪队|降雪/i.test(text) || /雪天|雪景|雪队|降雪/.test(cn)) return { id: "snow", name: "雪天队", hardRules: ["必须围绕雪天/极光幕收益构筑。"], preferRoles: ["功能位", "特殊输出", "耐久位"], preferMoves: ["snowscape", "雪景", "aurora-veil", "极光幕"], avoidThemes: [] };
  return { id: "balance", name: "平衡轮转", hardRules: ["围绕攻防转换构筑，避免只堆单体强度。"], preferRoles: ["耐久位", "功能位", "物理输出", "特殊输出"], preferMoves: ["u-turn", "volt-switch", "recover", "stealth-rock", "急速折返", "伏特替换", "自我再生", "隐形岩"], avoidThemes: [] };
}

function requestedTeamTemplate(goal = "", style = null) {
  const text = String(goal || "");
  const styleId = style?.id || "";
  if (styleId === "pass-chain" || /接棒|强化接棒|baton pass|pass chain|boost pass|传递强化/i.test(text)) {
    return {
      id: "pass-chain",
      requiredComponents: ["接棒传递者", "强化接收者", "安全上场/保护", "终盘收割", "备用路线"],
      avoidPitfalls: ["不要把接棒写成普通输出", "不要只堆热门单体", "不要缺少真正的传递链"],
    };
  }
  if (styleId === "stall" || /受队|盾队|消耗|耐久/.test(text)) {
    return {
      id: "stall",
      requiredComponents: ["回复或可靠续航", "状态或消耗手段", "撒场/清场至少其一", "抗性换入", "残局胜点"],
      avoidPitfalls: ["不要把受队写成天气进攻队", "不要只有耐久道具而没有回复/状态/转场闭环"],
    };
  }
  if (styleId === "trick-room" || /空间|戏法空间/.test(text)) {
    return {
      id: "trick-room",
      requiredComponents: ["至少 1 个戏法空间手", "低速高收益打手", "防挑衅或保证启动的道具/辅助", "非空间回合的备用路线"],
      avoidPitfalls: ["煤炭龟/低速打手不能没有空间手", "不要全队只在空间回合能行动"],
    };
  }
  if (styleId === "rain" || /雨天|降雨/.test(text)) {
    return {
      id: "rain",
      requiredComponents: ["雨天来源", "雨天收益打手", "反天气/被抢天气时的备用路线", "草/电/水免疫或联防处理"],
      avoidPitfalls: ["雨天队不要无说明依赖喷火/热风/日光束", "双天气必须说明切换收益"],
    };
  }
  if (styleId === "sun" || /晴天|日照/.test(text)) {
    return {
      id: "sun",
      requiredComponents: ["晴天来源", "晴天收益打手", "反天气/被抢天气时的备用路线", "水/岩/龙等常见抗性处理"],
      avoidPitfalls: ["晴天队不要无说明依赖打雷/暴风", "双天气必须说明切换收益"],
    };
  }
  if (styleId === "sand" || /沙暴|沙队|扬沙/.test(text)) {
    return {
      id: "sand",
      requiredComponents: ["沙暴来源", "沙暴收益打手", "被抢天气后的轮转路线", "水/草/格斗等压力处理"],
      avoidPitfalls: ["沙暴队不要只塞岩地热门单体", "必须有真实扬沙/沙暴来源"],
    };
  }
  if (styleId === "snow" || /雪天|雪景|雪队|降雪/.test(text)) {
    return {
      id: "snow",
      requiredComponents: ["雪天来源", "雪天/极光幕收益点", "被抢天气后的二次启动", "钢/火/岩等压力处理"],
      avoidPitfalls: ["雪天队不要只塞冰系输出", "必须有真实降雪/雪景来源"],
    };
  }
  return {
    id: "balance",
    requiredComponents: ["主轴", "副轴", "速度控制或先制", "安全上场", "终盘路线"],
    avoidPitfalls: ["不要只堆热门成员", "不要没有主副轴和行动链"],
  };
}

function pocketAgResolveAdviceCandidate(item = {}, payload = {}, fallbackTeam = [], index = 0) {
  const candidates = Array.isArray(payload.metaCandidates) ? payload.metaCandidates : [];
  const selected = Array.isArray(payload.selectedPokemon) ? payload.selectedPokemon : [];
  const targets = Array.isArray(payload.intent?.targetPokemon)
    ? payload.intent.targetPokemon.map((entry) => entry.target || entry)
    : [];
  const pool = [...candidates, ...selected, ...targets, ...fallbackTeam].filter(Boolean);
  return findCandidateByRef(pool, item) || fallbackTeam.find((mon) => pocketAgMemberMatches(item, mon)) || pool[index] || fallbackTeam[index] || null;
}

function pocketAgMemberHasBadConfig(item = {}, mon = {}) {
  const rawText = pocketAgTextBlob([item.item, item.ability, item.nature, item.moves]);
  if (/[\u3040-\u30ff]/.test(rawText)) return true;
  const ownKeys = [mon.id, mon.slug, mon.name, item.id, item.slug, item.name].map(pocketAgTextKey).filter(Boolean);
  const speciesKeys = teamLibrarySpeciesKeys();
  const isSpeciesName = (value = "") => {
    const key = pocketAgTextKey(value);
    return key && (speciesKeys.has(key) || ownKeys.includes(key));
  };
  if (isSpeciesName(item.item) || isSpeciesName(item.ability) || isSpeciesName(item.nature)) return true;
  const pools = pocketAgConfigPoolsFor(mon);
  const allowed = (value, pool) => {
    const key = pocketAgTextKey(plainText(value || ""));
    if (!key) return true;
    return !pool.size || pool.has(key);
  };
  if (!allowed(item.item, pools.items)) return true;
  if (!allowed(item.ability, pools.abilities)) return true;
  if (!allowed(item.nature, pools.natures)) return true;
  const moves = Array.isArray(item.moves) ? item.moves.filter(Boolean) : [];
  if (moves.some((move) => isSpeciesName(move) || !allowed(move, pools.moves))) return true;
  return false;
}

function pocketAgStandardizeAdviceTeam(team = [], payload = {}, format = "single", fallbackTeam = []) {
  const used = new Set();
  const nextFallback = () => fallbackTeam.find((mon) => {
    const key = pocketAgMemberKey(mon);
    return key && !used.has(key);
  });
  return team.slice(0, 6).map((item, index) => {
    let mon = pocketAgResolveAdviceCandidate(item, payload, fallbackTeam, index);
    const monKey = pocketAgMemberKey(mon);
    const duplicate = monKey && used.has(monKey);
    const badConfig = !mon || duplicate || pocketAgMemberHasBadConfig(item, mon);
    if (badConfig) mon = nextFallback() || mon || fallbackTeam[index] || item;
    const standard = advicePokemon(mon, index, format, payload);
    const key = pocketAgMemberKey(standard);
    if (key) used.add(key);
    const role = item.role && !/^(补位|成员|filler|slot|member)$/i.test(String(item.role)) ? item.role : pocketAgMemberRole(standard, format, index);
    const note =
      item.note &&
      String(item.note).length >= 12 &&
      !/承担主要输出、强化或收尾任务|按双打节奏补足守住、控速或站场协作|负责转场、钉子、控速或状态压制|补位/.test(String(item.note))
        ? item.note
        : standard.note;
    return {
      ...standard,
      role,
      note,
      level: String(item.level || standard.level || "50"),
    };
  });
}

function bestTeamLibraryConfig(mon = {}, format = "single", payload = {}) {
  const configs = teamLibraryConfigsFor(mon);
  if (!configs.length) return {};
  const asciiConfigs = configs.filter((config) => {
    const text = pocketAgTextBlob([config.item, config.ability, config.nature, config.moves]);
    return !/[\u3040-\u30ff]/.test(text) && (!config.item || /^[a-z0-9-]+$/i.test(String(config.item))) && (!config.ability || /^[a-z0-9-]+$/i.test(String(config.ability))) && (config.moves || []).every((move) => /^[a-z0-9-]+$/i.test(String(move || "")));
  });
  const sourceConfigs = asciiConfigs.length ? asciiConfigs : configs;
  const completeConfigs = sourceConfigs.filter((config) => (config.moves || []).filter(Boolean).length >= 3 && (config.item || config.ability));
  const scoringConfigs = completeConfigs.length ? completeConfigs : sourceConfigs;
  const wantsTailwind = /风妖精|whimsicott|烈箭鹰|talonflame|大嘴鸥|pelipper/i.test(`${mon.name || ""} ${mon.slug || ""}`);
  const scored = scoringConfigs.map((config) => {
    const text = pocketAgTextBlob([config.item, config.ability, config.nature, config.moves]);
    let score = Number(config.sourceRate || 0) * 10 - Number(config.sourceRank || 9999) / 100;
    if (/[\u3040-\u30ff]/.test(text)) score -= 140;
    if (/^[a-z0-9-]+$/i.test(String(config.item || ""))) score += 8;
    if (/^[a-z0-9-]+$/i.test(String(config.ability || ""))) score += 6;
    if ((config.moves || []).every((move) => /^[a-z0-9-]+$/i.test(String(move || "")))) score += 10;
    if (format === "double" && /protect|守住/i.test(text)) score += 6;
    if (wantsTailwind && /tailwind|顺风/i.test(text)) score += 25;
    if (/charizard/i.test(`${mon.slug || ""} ${mon.name || ""}`) && /charizardite-y|drought|solar-beam|heat-wave|weather-ball/i.test(text)) score += 18;
    if (goalHasFireSunCore(payload) && /rain-dance|drizzle|rain|求雨|降雨|雨天|wave-crash|hurricane|sandstorm|sand-stream|sand|扬沙|沙暴/i.test(text)) score -= 110;
    if (goalRequiresTheme(payload, "rain") && /sunny-day|drought|大晴天|晴天|日照/i.test(text)) score -= 90;
    if (goalRequiresTheme(payload, "rain") && /drizzle|降雨/i.test(text)) score += 80;
    if (goalRequiresTheme(payload, "sun") && /drought|日照/i.test(text)) score += 80;
    if (goalRequiresTheme(payload, "sand") && /sand-stream|扬沙/i.test(text)) score += 80;
    if (goalRequiresTheme(payload, "snow") && /snow-warning|降雪/i.test(text)) score += 80;
    if (goalRequiresTheme(payload, "trick-room") && /rain-dance|drizzle|drought|sunny-day|charizardite|tailwind/i.test(text)) score -= 35;
    if (/pelipper/i.test(`${mon.slug || ""} ${mon.name || ""}`) && /charizard|喷火龙/i.test(text)) score -= 20;
    return { config, score };
  });
  return scored.sort((a, b) => b.score - a.score)[0]?.config || {};
}

function goalHasFireSunCore(payload = {}) {
  const required = requiredGoalPokemon(payload);
  const text = `${payload.userGoal || ""} ${required.map((item) => `${item.name || ""} ${item.slug || ""}`).join(" ")}`;
  if (/喷火龙顺风|顺风喷火龙|charizard.*tailwind|tailwind.*charizard/i.test(text)) return false;
  return /火|晴天|日照|大晴天|sun|drought|喷火龙|charizard/i.test(text);
}

function goalHasCharizardTailwind(payload = {}) {
  const constraints = goalConstraints(payload);
  const text = `${payload.userGoal || ""} ${(constraints.requiredPokemon || []).map((item) => `${item.name || ""} ${item.slug || ""}`).join(" ")}`;
  return /喷火龙|charizard/i.test(text) && /顺风|tailwind|おいかぜ/i.test(text);
}

function fallbackAdviceItemFor(mon = {}, format = "single") {
  const text = `${mon.name || ""} ${mon.slug || ""} ${candidateConfigText(mon)}`;
  if (/mega|超级/i.test(`${mon.name || ""} ${mon.slug || ""}`)) return "对应进化石";
  if (/顺风|tailwind|戏法空间|trick-room|trick room|fake-out|击掌奇袭|follow-me|rage-powder|看我嘛|愤怒粉|support|辅助/i.test(text)) return "气势披带";
  if (/drizzle|drought|sand-stream|snow-warning|降雨|日照|扬沙|降雪/i.test(text)) return "文柚果";
  if (/roost|recover|羽栖|自我再生|耐久|defensive/i.test(text)) return "剩饭";
  if (/choice|scarf|围巾|高速/i.test(text)) return "讲究围巾";
  return format === "double" ? "文柚果" : "生命宝珠";
}

function pocketAgIsMegaItem(item = "") {
  return /mega|进化石|超进化石|ナイト|ite$/i.test(String(item || ""));
}

function pocketAgNonMegaFallbackItem(member = {}, payload = {}, format = "single") {
  const mon = pocketAgResolveAdviceCandidate(member, payload, [], 0) || member;
  const used = new Set();
  const fromCommon =
    [...teamLibraryConfigsFor(mon), firstTeamLibrarySet(mon)]
      .map((config) => plainText(config?.item || ""))
      .filter((item) => item && !pocketAgIsMegaItem(item))[0] ||
    firstNonEmptyArray(mon.commonItems, mon.items)
      .map((item) => plainText(firstName([item])))
      .filter((item) => item && !pocketAgIsMegaItem(item))[0];
  if (fromCommon) return fromCommon;
  const fallback = fallbackAdviceItemFor({ ...mon, name: member.name || mon.name, slug: member.slug || mon.slug }, format);
  if (fallback && !pocketAgIsMegaItem(fallback)) return fallback;
  return ["气势披带", "文柚果", "生命宝珠", "讲究围巾", "突击背心", "剩饭"].find((item) => !used.has(normalizedItem(item))) || "文柚果";
}

function enforceMegaResourcePlan(team = [], payload = {}, format = "single") {
  const explicitMegaRequest = /mega|超级|超进化|进化石/i.test(`${payload.userGoal || ""} ${payload.intent?.teamStyle?.name || ""}`);
  const megaMembers = team.filter((item) => pocketAgIsMegaItem(item.item) || /Mega 位|Mega 核心|超级核心/i.test(String(item.role || "")));
  const maxMega = explicitMegaRequest ? 2 : 1;
  if (megaMembers.length <= maxMega) return team;
  const required = requiredGoalPokemon(payload);
  const themes = requestedThemeIds(payload);
  const keep = megaMembers
    .slice()
    .sort((a, b) => {
      const score = (item = {}) => {
        let value = 0;
        if (required.some((ref) => pocketAgMemberMatches(item, ref))) value += 1000;
        if (goalRequiresTailwind(payload) && memberActuallySetsTailwind(item)) value += 120;
        for (const theme of themes) {
          if (memberActuallySetsTheme(item, theme)) value += 90;
          if (memberThemeAbuserScore(item, theme) > 0) value += 60;
        }
        if (/主轴|指定核心|核心|收割|终盘/i.test(`${item.role || ""} ${item.note || ""}`)) value += 35;
        if (/喷火龙|charizard/i.test(`${item.name || ""} ${item.slug || ""}`) && /喷火龙|charizard|晴天|sun/i.test(`${payload.userGoal || ""}`)) value += 150;
        return value;
      };
      return score(b) - score(a);
    })
    .slice(0, maxMega);
  const keepKeys = new Set(keep.map((item) => pocketAgMemberKey(item)).filter(Boolean));
  return team.map((item) => {
    const key = pocketAgMemberKey(item);
    if (!megaMembers.includes(item) || (key && keepKeys.has(key))) return item;
    const next = { ...item };
    next.item = pocketAgNonMegaFallbackItem(next, payload, format);
    next.role = String(next.role || "")
      .replace(/Mega 位\/?|\/?Mega 位|Mega 核心\/?|\/?Mega 核心|超级核心\/?|\/?超级核心/gi, "")
      .replace(/\s*\/\s*$/g, "")
      .trim() || pocketAgMemberRole(next, format, team.indexOf(item));
    next.note = `${String(next.note || "").replace(/本局 Mega 位已纳入主轴[^。]*。?/g, "").trim()} 已改为非 Mega 分支，避免多个进化石抢同一资源；职责保留为补轴、联防或终盘。`.trim();
    return next;
  });
}

function fallbackAdviceAbilityFor(mon = {}) {
  const text = `${mon.name || ""} ${mon.slug || ""} ${candidateConfigText(mon)}`;
  if (/大嘴鸥|pelipper|蚊香蛙皇|politoed/i.test(text)) return "drizzle";
  if (/煤炭龟|torkoal/i.test(text)) return "drought";
  if (/班基拉斯|tyranitar|河马兽|hippowdon|庞岩怪|gigalith/i.test(text)) return "sand-stream";
  if (/阿罗拉.*九尾|九尾.*阿罗拉|ninetales.*alola|alolan.*ninetales|暴雪王|abomasnow/i.test(text)) return "snow-warning";
  if (/风妖精|whimsicott/i.test(text)) return "prankster";
  if (/烈箭鹰|talonflame/i.test(text)) return "gale-wings";
  if (/谜拟|mimikyu/i.test(text)) return "disguise";
  if (/流氓鳄|krookodile/i.test(text)) return "intimidate";
  if (/象牙猪|mamoswine/i.test(text)) return "oblivious";
  if (/甜冷美后|tsareena/i.test(text)) return "queenly-majesty";
  const abilities = firstNonEmptyArray(mon.commonAbilities, mon.abilities).map((ability) => firstName([ability])).filter(Boolean);
  return abilities[0] || "威吓";
}

function fallbackAdviceMovesFor(mon = {}, format = "single", payload = {}, role = "", currentMoves = []) {
  const moves = [];
  const add = (move) => {
    const text = plainText(firstName([move]) || move || "");
    if (!text) return;
    const key = pocketAgTextKey(text);
    if (key && !moves.some((item) => pocketAgTextKey(item) === key)) moves.push(text);
  };
  for (const move of currentMoves || []) add(move);
  for (const config of teamLibraryConfigsFor(mon).slice(0, 8)) {
    for (const move of config.moves || []) add(move);
  }
  for (const move of firstNonEmptyArray(mon.commonMoves, mon.moves)) add(firstName([move]));
  const text = `${mon.name || ""} ${mon.slug || ""} ${role} ${candidateConfigText(mon)} ${moves.join(" ")}`;

  if (/风妖精|whimsicott/i.test(text)) ["tailwind", "moonblast", "encore", "protect", "taunt", "cotton-spore"].forEach(add);
  else if (/大嘴鸥|pelipper/i.test(text)) ["hurricane", "weather-ball", "tailwind", "wide-guard", "protect"].forEach(add);
  else if (/蚊香蛙皇|politoed/i.test(text)) ["rain-dance", "hydro-pump", "helping-hand", "encore", "protect"].forEach(add);
  else if (/幽尾玄鱼|basculegion/i.test(text)) ["wave-crash", "last-respects", "aqua-jet", "protect", "crunch"].forEach(add);
  else if (/海豚侠|palafin/i.test(text)) ["wave-crash", "jet-punch", "flip-turn", "bulk-up", "protect"].forEach(add);
  else if (/铝钢桥龙|archaludon/i.test(text)) ["electro-shot", "draco-meteor", "flash-cannon", "protect", "body-press"].forEach(add);
  else if (/洛托姆|rotom/i.test(text)) {
    if (/wash|清洗/i.test(text)) add("hydro-pump");
    if (/mow|cut|切割/i.test(text)) add("leaf-storm");
    if (/heat|加热/i.test(text)) add("overheat");
    if (/frost|结冰/i.test(text)) add("blizzard");
    ["thunderbolt", "volt-switch", "will-o-wisp", "protect"].forEach(add);
  } else if (/喷火龙|charizard/i.test(text)) {
    if (goalHasCharizardTailwind(payload)) ["tailwind", "protect", "heat-wave", "overheat", "flamethrower"].forEach(add);
    else if (goalRequiresTheme(payload, "sun")) ["heat-wave", "weather-ball", "solar-beam", "protect", "tailwind"].forEach(add);
    else ["heat-wave", "overheat", "flamethrower", "protect", "tailwind"].forEach(add);
  }
  else if (/克雷色利亚|cresselia|多边兽2|porygon2|青铜钟|bronzong|奇麒麟|farigiraf|布莉姆温|hatterene|夜巡灵|dusclops|爱管侍|indeedee/i.test(text)) {
    ["trick-room", "protect", "icy-wind", "psychic"].forEach(add);
  }

  if (goalRequiresTailwind(payload) && (/顺风控速|顺风手|tailwind setter/i.test(role) || candidateActuallySetsTailwind(mon))) add("tailwind");
  if (goalRequiresTheme(payload, "rain") && memberActuallySetsTheme({ ...mon, moves }, "rain")) add("rain-dance");
  if (goalRequiresTheme(payload, "sun") && memberActuallySetsTheme({ ...mon, moves }, "sun")) add("sunny-day");
  if (goalRequiresTheme(payload, "trick-room") && memberActuallySetsTheme({ ...mon, moves }, "trick-room")) add("trick-room");
  if (format === "double") add("protect");
  ["protect", "substitute", "taunt", "u-turn"].forEach(add);
  return moves.slice(0, 4);
}

function advicePokemon(mon = {}, index, format = "single", payload = {}) {
  const role = mon.roles?.[0] || (index === 0 ? "核心输出" : "补位");
  const librarySet = firstTeamLibrarySet(mon);
  const teamConfig = bestTeamLibraryConfig(mon, format, payload);
  let moves = firstNonEmptyArray(teamConfig.moves, librarySet.moves, mon.commonMoves, mon.moves).map((move) => firstName([move])).filter(Boolean).slice(0, 4);
  if (format === "double" && moves.length < 4 && !moves.includes("守住")) moves.push("守住");
  if (moves.length < 4) moves = fallbackAdviceMovesFor(mon, format, payload, role, moves);
  const configText = pocketAgTextBlob([mon.name, mon.slug, role, teamConfig.ability, teamConfig.item, moves, mon.roleProfile, mon.supportProfile, mon.understandingReasons]);
  const note =
    /顺风|tailwind/i.test(configText)
      ? "负责真实控速，给主输出创造先手窗口。"
      : /戏法空间|trick room/i.test(configText)
        ? "负责启动空间，并把低速打手送进出手回合。"
        : /降雨|drizzle|求雨|rain dance/i.test(configText)
          ? "负责提供雨天或吃雨天收益，维持天气回合。"
          : /日照|drought|大晴天|sunny day/i.test(configText)
            ? "负责提供晴天或吃晴天收益，放大火力窗口。"
            : /扬沙|sand stream|沙暴|sandstorm/i.test(configText)
              ? "负责提供沙暴或吃沙暴收益，衔接岩地终盘。"
              : /降雪|snow warning|雪景|snowscape|极光幕|aurora veil/i.test(configText)
                ? "负责雪天、极光幕或冰系压制，保护关键回合。"
                : /接棒|baton pass/i.test(configText)
                  ? "负责传递强化或提供安全上场，不当普通输出位使用。"
                  : /急速折返|伏特替换|抛下狠话|u-turn|volt switch|parting shot|pivot/i.test(configText)
                    ? "负责安全轮转，把核心带入合适回合。"
                    : /隐形岩|撒菱|毒菱|stealth rock|spikes|状态|鬼火|哈欠|toxic|will-o-wisp|yawn/i.test(configText)
                      ? "负责撒场、状态或消耗，为终盘创造压力。"
                      : /先制|终盘|收割|choice scarf|dragon dance|swords dance|nasty plot|calm mind|priority/i.test(configText)
                        ? "负责终盘收割或二次突破。"
                        : format === "double"
                          ? "按双打节奏补足保护、站场协作或范围压力。"
                          : role.includes("功能")
                            ? "负责转场、钉子、控速或状态压制。"
                            : "负责破盾、压血或终盘路线。";
  return {
    id: String(mon.id || mon.slug || mon.name || ""),
    name: String(mon.name || mon.slug || `成员 ${index + 1}`),
    role: format === "double" && role === "补位" ? "双打协作位" : role,
    item: plainText(teamConfig.item || librarySet.item || "") || firstName(firstNonEmptyArray(mon.commonItems, mon.items)) || fallbackAdviceItemFor(mon, format),
    ability: plainText(teamConfig.ability || librarySet.ability || "") || firstName(firstNonEmptyArray(mon.commonAbilities, mon.abilities)) || fallbackAdviceAbilityFor(mon),
    nature: plainText(teamConfig.nature || librarySet.nature || "") || firstName(firstNonEmptyArray(mon.commonNatures, mon.natures)) || "按速度线调整",
    evs: role.includes("耐久") || role.includes("功能") ? "耐久为主" : "速度与主攻为主",
    level: "50",
    moves,
    note,
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

function pocketAgMemberText(item = {}) {
  return `${item.name || item.id || item.slug || ""} ${item.role || ""} ${item.item || ""} ${item.ability || ""} ${(item.moves || []).join(" ")} ${item.note || ""}`;
}

function pocketAgKnownCandidateKeys(payload = {}) {
  const keys = new Set();
  const addItem = (item = {}) => {
    for (const value of [
      item.id,
      item.name,
      item.slug,
      item.english,
      item.nameMap?.showdown,
      item.pokeCamp?.identifier,
      item.pokeCamp?.speciesIdentifier,
      item.target?.name,
      item.target?.slug,
      item.target?.identifier,
      item.target?.speciesIdentifier,
    ].filter(Boolean)) {
      keys.add(pocketAgTextKey(value));
    }
  };
  for (const item of [...(payload.selectedPokemon || []), ...(payload.metaCandidates || []), ...(payload.intent?.targetPokemon || [])]) {
    addItem(item);
  }
  return keys;
}

function pocketAgFindMember(team = [], patterns = []) {
  return team.find((item) => patterns.some((pattern) => pattern.test(pocketAgMemberText(item))));
}

function pocketAgMemberKey(item = {}) {
  return pocketAgTextKey(item.id || item.slug || item.name || "");
}

function pocketAgFamilyKey(item = {}) {
  const rawCandidates = [
    item.pokeCamp?.speciesIdentifier,
    item.baseSlug,
    item.speciesSlug,
    item.slug,
    item.nameMap?.showdown,
    item.id,
    item.name,
  ]
    .map(pocketAgTextKey)
    .filter(Boolean);
  const raw = rawCandidates[0] || "";
  const joined = rawCandidates.join(" ");
  if (/幽尾玄鱼|basculegion/.test(joined)) return "basculegion";
  if (/鬃岩狼人|lycanroc/.test(joined)) return "lycanroc";
  if (/洛托姆|rotom/.test(joined)) return "rotom";
  const stripped = raw
    .replace(/^超级/i, "")
    .replace(/（.*?）/g, "")
    .replace(/雌性|雄性|普通|化身|灵兽|阿罗拉|伽勒尔|洗翠|帕底亚/g, "")
    .replace(/mega[xy]?$/i, "")
    .replace(/mega[xy]?$/i, "")
    .replace(/gigantamax$/i, "")
    .replace(/gmax$/i, "")
    .replace(/female$/i, "")
    .replace(/male$/i, "")
    .replace(/therian$/i, "")
    .replace(/incarnate$/i, "")
    .replace(/origin$/i, "")
    .replace(/altered$/i, "")
    .replace(/alola$/i, "")
    .replace(/galar$/i, "")
    .replace(/hisui$/i, "")
    .replace(/paldea$/i, "")
    .replace(/midday$/i, "")
    .replace(/midnight$/i, "")
    .replace(/dusk$/i, "");
  return stripped || raw;
}

function pocketAgMemberMatches(item = {}, ref = {}) {
  const keys = [ref.id, ref.slug, ref.name, ref.english, ref.nameMap?.showdown, ref.pokeCamp?.identifier, ref.pokeCamp?.speciesIdentifier]
    .map(pocketAgTextKey)
    .filter(Boolean);
  if (!keys.length) return false;
  const own = [item.id, item.slug, item.name, item.english, item.nameMap?.showdown, item.pokeCamp?.identifier, item.pokeCamp?.speciesIdentifier]
    .map(pocketAgTextKey)
    .filter(Boolean);
  return own.some((key) => keys.includes(key));
}

function goalConstraints(payload = {}) {
  return payload.intent?.goalConstraints || payload.goalConstraints || {};
}

function requiredGoalPokemon(payload = {}) {
  const constraints = goalConstraints(payload);
  return Array.isArray(constraints.requiredPokemon) ? constraints.requiredPokemon : [];
}

function pocketAgAvoidNames(payload = {}) {
  return [
    ...(payload.avoidPreviousTeams?.single ? payload.avoidPreviousTeams.single.split(/\s*[\/、]\s*/) : []),
    ...(payload.avoidPreviousTeams?.double ? payload.avoidPreviousTeams.double.split(/\s*[\/、]\s*/) : []),
    ...(Array.isArray(payload.avoidPreviousTeams?.recent) ? payload.avoidPreviousTeams.recent.flatMap((item) => String(item || "").split(/\s*[\/、]\s*/)) : []),
  ]
    .map((value) => plainText(value).toLowerCase())
    .filter(Boolean);
}

function pocketAgMemoryKey(payload = {}, format = "single") {
  const goal = pocketAgTextKey(payload.userGoal || payload.intent?.goal || "");
  const required = requiredGoalPokemon(payload).map((item) => pocketAgTextKey(item.name || item.slug || item.id || "")).filter(Boolean).join(",");
  return `${format}|${goal}|${required}`;
}

function pocketAgRecentGeneratedAvoidNames(payload = {}, format = "single") {
  const key = pocketAgMemoryKey(payload, format);
  return (generatedTeamMemory.get(key) || []).flatMap((team) => team).filter(Boolean);
}

function pocketAgRememberGeneratedTeam(payload = {}, format = "single", team = []) {
  const key = pocketAgMemoryKey(payload, format);
  const names = team
    .flatMap((item) => [
      String(item?.name || item?.slug || item?.id || "").toLowerCase(),
      pocketAgFamilyKey(item),
    ])
    .filter(Boolean);
  if (!names.length) return;
  const recent = generatedTeamMemory.get(key) || [];
  const next = [names, ...recent.filter((entry) => JSON.stringify(entry) !== JSON.stringify(names))].slice(0, 8);
  generatedTeamMemory.set(key, next);
}

function goalRequiresTailwind(payload = {}) {
  const constraints = goalConstraints(payload);
  return (
    (Array.isArray(constraints.themes) && constraints.themes.includes("tailwind")) ||
    (Array.isArray(constraints.requiredMoves) && constraints.requiredMoves.some((item) => /顺风|tailwind/i.test(`${item.name || ""} ${item.id || ""}`))) ||
    /顺风|tailwind|おいかぜ/i.test(String(payload.userGoal || "")) ||
    goalHasCharizardTailwind(payload)
  );
}

function goalRequiresTheme(payload = {}, theme = "") {
  const constraints = goalConstraints(payload);
  const text = String(payload.userGoal || "");
  if (Array.isArray(constraints.themes) && constraints.themes.includes(theme)) return true;
  if (theme === "sun") return /晴天|日照|大晴天|sun|drought/i.test(text);
  if (theme === "rain") return /雨天|降雨|求雨|rain|drizzle/i.test(text);
  if (theme === "trick-room") return /空间|戏法空间|trick\s*room/i.test(text);
  if (theme === "sand") return /沙暴|扬沙|沙队|sand|sandstorm|sand stream/i.test(text);
  if (theme === "snow") return /雪天|雪景|降雪|雪队|snow|snowscape|hail|snow warning/i.test(text);
  if (theme === "pass-chain") return /接棒|强化接棒|pass chain|baton pass|boost pass|传递强化/i.test(text);
  return false;
}

function goalRequiresPassChain(payload = {}) {
  const constraints = goalConstraints(payload);
  const text = String(payload.userGoal || "");
  return (
    (Array.isArray(constraints.themes) && constraints.themes.includes("pass-chain")) ||
    /接棒|强化接棒|pass chain|baton pass|boost pass|传递强化/i.test(text)
  );
}

function requestedThemeIds(payload = {}) {
  return THEME_IDS.filter((theme) => goalRequiresTheme(payload, theme));
}

function candidateThemeIds(mon = {}) {
  return THEME_IDS.filter((theme) => candidateActuallySetsTheme(mon, theme));
}

function goalRelevantThemeIds(payload = {}) {
  const themes = new Set(requestedThemeIds(payload));
  if (goalHasFireSunCore(payload)) themes.add("sun");
  return [...themes];
}

function candidateConflictsWithGoalTheme(mon = {}, payload = {}) {
  const text = `${mon.name || ""} ${mon.slug || ""} ${candidateText(mon)} ${candidateConfigText(mon)}`;
  const required = requiredGoalPokemon(payload);
  if (required.some((ref) => pocketAgMemberMatches(mon, ref))) return false;
  if (goalRequiresTailwind(payload) && candidateTailwindQuality(mon, payload) >= 5) return false;
  const candidateThemes = candidateThemeIds(mon);
  const requested = goalRelevantThemeIds(payload);
  const weatherThemes = candidateThemes.filter((theme) => theme !== "trick-room");
  if (requested.includes("sun") && weatherThemes.some((theme) => theme !== "sun")) return true;
  if (requested.includes("rain") && (weatherThemes.some((theme) => theme !== "rain") || /煤炭龟|torkoal|喷火龙|charizard|加热洛托姆|rotom[-\s]?heat/i.test(text))) return true;
  if (requested.includes("sand") && weatherThemes.some((theme) => theme !== "sand")) return true;
  if (requested.includes("snow") && weatherThemes.some((theme) => theme !== "snow")) return true;
  if (requested.includes("trick-room")) {
    const isTrickRoomSetter = candidateActuallySetsTheme(mon, "trick-room");
    return !isTrickRoomSetter && /喷火龙|charizard|大嘴鸥|pelipper|风妖精|whimsicott|烈箭鹰|talonflame|煤炭龟|torkoal|晴天|日照|drought|大晴天|sunny|雨天|降雨|drizzle|求雨|rain|顺风|tailwind/i.test(text);
  }
  if (goalHasFireSunCore(payload) && !goalHasCharizardTailwind(payload) && /大嘴鸥|pelipper|班基拉斯|tyranitar|河马兽|hippowdon|大力鳄|feraligatr|扬沙|sand stream|sandstorm|沙暴|降雨|drizzle|rain|wave crash|波动冲/i.test(text)) return true;
  if (goalHasCharizardTailwind(payload) && /日光束|solar beam|气象球|weather[-\s]?ball|太阳之力|solar power|晴天|日照|大晴天|sunny[-\s]?day|煤炭龟|torkoal|叶绿素|chlorophyll/i.test(text) && !/喷火龙|charizard/i.test(text)) return true;
  return false;
}

function candidateHasMove(mon = {}, patterns = []) {
  const text = pocketAgTextBlob([
    mon.commonMoves,
    mon.moves,
    mon.teamLibrarySets?.map((set) => set.moves),
    mon.roleProfile,
    mon.supportProfile,
    mon.understandingReasons,
  ]);
  return patterns.some((pattern) => pattern.test(text));
}

function candidateText(mon = {}) {
  return pocketAgTextBlob([mon.name, mon.slug, mon.roleProfile, mon.supportProfile, mon.understandingReasons, mon.synergyReasons, mon.formatFit]);
}

function pocketAgMemberConfigText(item = {}) {
  return pocketAgTextBlob([item.name, item.id, item.slug, item.item, item.ability, item.moves]);
}

function candidateConfigText(mon = {}) {
  return pocketAgTextBlob([
    mon.name,
    mon.slug,
    mon.nameMap?.showdown,
    mon.pokeCamp?.identifier,
    mon.pokeCamp?.speciesIdentifier,
    mon.commonAbilities,
    mon.abilities,
    mon.commonMoves,
    mon.moves,
    mon.teamLibrarySets?.map((set) => [set.ability, set.moves]),
    teamLibraryConfigsFor(mon).map((set) => [set.ability, set.moves]),
  ]);
}

const ACTUAL_THEME_RULES = {
  sun: {
    species: /煤炭龟|torkoal|九尾|ninetales|固拉多|groudon/i,
    ability: /日照|ひでり|\bdrought\b/i,
    move: /大晴天|晴天|にほんばれ|\bsunny[-\s]?day\b/i,
  },
  rain: {
    species: /大嘴鸥|pelipper|蚊香蛙皇|politoed|盖欧卡|kyogre/i,
    ability: /降雨|あめふらし|\bdrizzle\b/i,
    move: /求雨|雨乞い|あまごい|\brain[-\s]?dance\b/i,
  },
  "trick-room": {
    species: /克雷色利亚|cresselia|多边兽2|porygon2|青铜钟|bronzong|奇麒麟|farigiraf|布莉姆温|hatterene|夜巡灵|dusclops|爱管侍|indeedee/i,
    ability: /(?!)/,
    move: /戏法空间|トリックルーム|\btrick[-\s]?room\b/i,
  },
  sand: {
    species: /班基拉斯|tyranitar|河马兽|hippowdon|庞岩怪|gigalith/i,
    ability: /扬沙|すなおこし|\bsand[-\s]?stream\b/i,
    move: /沙暴|すなあらし|\bsandstorm\b/i,
  },
  snow: {
    species: /九尾.*阿罗拉|阿罗拉.*九尾|ninetales.*alola|alolan.*ninetales|暴雪王|abomasnow/i,
    ability: /降雪|ゆきふらし|\bsnow[-\s]?warning\b/i,
    move: /雪景|冰雹|あられ|ゆきげしき|\bsnowscape\b|\bhail\b/i,
  },
};

function textActuallySetsTheme(configText = "", speciesText = "", theme = "") {
  const rule = ACTUAL_THEME_RULES[theme];
  if (!rule) return false;
  const config = String(configText || "");
  const species = String(speciesText || "");
  if (theme === "trick-room") {
    return rule.move.test(config) || (rule.species.test(species) && rule.move.test(config));
  }
  return rule.ability.test(config) || rule.move.test(config) || rule.species.test(species);
}

function memberActuallySetsTheme(member = {}, theme = "") {
  return textActuallySetsTheme(pocketAgMemberConfigText(member), `${member.name || ""} ${member.id || ""} ${member.slug || ""}`, theme);
}

function candidateActuallySetsTheme(mon = {}, theme = "") {
  return textActuallySetsTheme(candidateConfigText(mon), `${mon.name || ""} ${mon.slug || ""} ${mon.nameMap?.showdown || ""} ${mon.pokeCamp?.identifier || ""} ${mon.pokeCamp?.speciesIdentifier || ""}`, theme);
}

function memberIsStrongThemeSource(member = {}, theme = "") {
  const config = pocketAgMemberConfigText(member);
  const species = `${member.name || ""} ${member.id || ""} ${member.slug || ""}`;
  if (theme === "rain") return /(降雨|\bdrizzle\b)/i.test(config) || /大嘴鸥|pelipper|蚊香蛙皇|politoed|盖欧卡|kyogre/i.test(species);
  if (theme === "sun") return /(日照|\bdrought\b)/i.test(config) || /煤炭龟|torkoal|九尾|ninetales|固拉多|groudon/i.test(species);
  if (theme === "sand") return /(扬沙|\bsand[-\s]?stream\b)/i.test(config) || /班基拉斯|tyranitar|河马兽|hippowdon|庞岩怪|gigalith/i.test(species);
  if (theme === "snow") return /(降雪|\bsnow[-\s]?warning\b)/i.test(config) || /九尾.*阿罗拉|阿罗拉.*九尾|ninetales.*alola|alolan.*ninetales|暴雪王|abomasnow/i.test(species);
  return memberActuallySetsTheme(member, theme);
}

function candidateIsStrongThemeSource(mon = {}, theme = "") {
  const config = candidateConfigText(mon);
  const species = `${mon.name || ""} ${mon.slug || ""} ${mon.nameMap?.showdown || ""} ${mon.pokeCamp?.identifier || ""} ${mon.pokeCamp?.speciesIdentifier || ""}`;
  if (theme === "rain") return /(降雨|\bdrizzle\b)/i.test(config) || /大嘴鸥|pelipper|蚊香蛙皇|politoed|盖欧卡|kyogre/i.test(species);
  if (theme === "sun") return /(日照|\bdrought\b)/i.test(config) || /煤炭龟|torkoal|九尾|ninetales|固拉多|groudon/i.test(species);
  if (theme === "sand") return /(扬沙|\bsand[-\s]?stream\b)/i.test(config) || /班基拉斯|tyranitar|河马兽|hippowdon|庞岩怪|gigalith/i.test(species);
  if (theme === "snow") return /(降雪|\bsnow[-\s]?warning\b)/i.test(config) || /九尾.*阿罗拉|阿罗拉.*九尾|ninetales.*alola|alolan.*ninetales|暴雪王|abomasnow/i.test(species);
  return candidateActuallySetsTheme(mon, theme);
}

function memberActuallySetsTailwind(member = {}) {
  return /顺风|tailwind|おいかぜ/i.test(pocketAgMemberConfigText(member));
}

function candidateActuallySetsTailwind(mon = {}) {
  return /顺风|tailwind|おいかぜ/i.test(candidateConfigText(mon));
}

function candidateThemeAbuserScore(mon = {}, theme = "") {
  const text = `${candidateText(mon)} ${candidateConfigText(mon)} ${pocketAgTextBlob(mon.types)}`;
  const species = `${mon.name || ""} ${mon.slug || ""} ${mon.nameMap?.showdown || ""} ${mon.pokeCamp?.identifier || ""} ${mon.pokeCamp?.speciesIdentifier || ""}`;
  let score = 0;
  if (theme === "rain") {
    if (/悠游自如|swift swim/i.test(text)) score += 55;
    if (/电光束|electro[-\s]?shot|打雷|thunder|暴风|hurricane|气象球|weather[-\s]?ball|水炮|hydro pump|波动冲|wave crash|喷水|water spout|水流喷射|aqua jet/i.test(text)) score += 42;
    if (Array.isArray(mon.types) && mon.types.includes("水")) score += 12;
    if (/铝钢桥龙|archaludon|刺龙王|kingdra|乐天河童|ludicolo|戽斗尖梭|barraskewda|巨沼怪|swampert|镰刀盔|kabutops|暴噬龟|drednaw|幽尾玄鱼|basculegion|海豚侠|palafin|连击流.*武道熊师|urshifu.*rapid/i.test(species)) score += 46;
  } else if (theme === "sun") {
    if (/叶绿素|chlorophyll|太阳之力|solar power/i.test(text)) score += 55;
    if (/日光束|solar beam|气象球|weather[-\s]?ball|热风|heat wave|喷火|eruption/i.test(text)) score += 42;
    if (Array.isArray(mon.types) && mon.types.includes("火")) score += 10;
    if (/妙蛙花|venusaur|裙儿小姐|lilligant|振翼发|flutter mane|古玉鱼|chi-yu|波荡水|walking wake|喷火龙|charizard/i.test(species)) score += 28;
  } else if (theme === "sand") {
    if (/拨沙|sand rush|沙之力|sand force/i.test(text)) score += 55;
    if (/岩崩|rock slide|地震|earthquake|十万马力|high horsepower/i.test(text)) score += 28;
    if (Array.isArray(mon.types) && (mon.types.includes("岩石") || mon.types.includes("地面") || mon.types.includes("钢"))) score += 10;
    if (/龙头地鼠|excadrill|鬃岩狼人|lycanroc|鳃鱼龙|dracovish|雷鸟龙|dracozolt/i.test(species)) score += 36;
  } else if (theme === "snow") {
    if (/拨雪|slush rush|冰冻之躯|ice body/i.test(text)) score += 55;
    if (/极光幕|aurora veil|暴风雪|blizzard|冷冻干燥|freeze-dry/i.test(text)) score += 42;
    if (Array.isArray(mon.types) && mon.types.includes("冰")) score += 10;
    if (/浩大鲸|cetitan|冻脊龙|baxcalibur|铁包袱|iron bundle|阿罗拉.*穿山王|sandslash.*alola|雪绒蛾|frosmoth/i.test(species)) score += 30;
  } else if (theme === "trick-room") {
    const speed = Number(mon.stats?.速度 || mon.speed || mon.baseSpeed || 0);
    if (candidateActuallySetsTheme(mon, "trick-room")) score += 70;
    if (speed && speed <= 70) score += 24;
    if (/低速|slow|min speed|空间打手|trick room abuser/i.test(text)) score += 30;
  }
  return score;
}

function memberThemeAbuserScore(member = {}, theme = "") {
  const text = pocketAgMemberText(member);
  let score = 0;
  if (theme === "rain") {
    if (/悠游自如|swift swim/i.test(text)) score += 55;
    if (/电光束|打雷|暴风|气象球|水炮|波动冲|喷水|水流喷射|electro[-\s]?shot|thunder|hurricane|weather[-\s]?ball|hydro pump|wave crash|water spout|aqua jet/i.test(text)) score += 42;
    if (/铝钢桥龙|archaludon|刺龙王|kingdra|乐天河童|ludicolo|戽斗尖梭|barraskewda|巨沼怪|swampert|镰刀盔|kabutops|暴噬龟|drednaw|幽尾玄鱼|basculegion|海豚侠|palafin|连击流.*武道熊师|urshifu.*rapid/i.test(text)) score += 46;
  } else if (theme === "sun") {
    if (/叶绿素|太阳之力|chlorophyll|solar power/i.test(text)) score += 55;
    if (/日光束|气象球|热风|喷火|solar beam|weather[-\s]?ball|heat wave|eruption/i.test(text)) score += 42;
    if (/妙蛙花|venusaur|裙儿小姐|lilligant|振翼发|flutter mane|古玉鱼|chi-yu|波荡水|walking wake|喷火龙|charizard/i.test(text)) score += 28;
  } else if (theme === "sand") {
    if (/拨沙|沙之力|sand rush|sand force/i.test(text)) score += 55;
    if (/岩崩|地震|十万马力|rock slide|earthquake|high horsepower/i.test(text)) score += 28;
    if (/龙头地鼠|excadrill|鬃岩狼人|lycanroc|鳃鱼龙|dracovish|雷鸟龙|dracozolt/i.test(text)) score += 36;
  } else if (theme === "snow") {
    if (/拨雪|冰冻之躯|slush rush|ice body/i.test(text)) score += 55;
    if (/极光幕|暴风雪|冷冻干燥|aurora veil|blizzard|freeze-dry/i.test(text)) score += 42;
    if (/浩大鲸|cetitan|冻脊龙|baxcalibur|铁包袱|iron bundle|阿罗拉.*穿山王|sandslash.*alola|雪绒蛾|frosmoth/i.test(text)) score += 30;
  } else if (theme === "trick-room") {
    if (memberActuallySetsTheme(member, "trick-room")) score += 70;
    if (/低速|空间打手|最慢|slow|min speed|trick room abuser/i.test(text)) score += 34;
  }
  return score;
}

function candidateGoalThemeScore(mon = {}, payload = {}) {
  const configText = candidateConfigText(mon);
  const text = `${candidateText(mon)} ${configText}`;
  let score = 0;
  if (goalRequiresTailwind(payload) && candidateActuallySetsTailwind(mon)) {
    const supportText = `${mon.supportProfile?.tags || ""} ${mon.roleProfile?.tags || ""} ${mon.roleProfile?.summary || ""}`;
    score += /speed-control|support|pivot|protect|fake out|follow me|rage powder|击掌奇袭|守住|控速|协作|顺风|tailwind|おいかぜ/i.test(`${supportText} ${text}`) ? 34 : 18;
  }
  for (const theme of requestedThemeIds(payload)) {
    if (candidateIsStrongThemeSource(mon, theme)) score += 90;
    else if (candidateActuallySetsTheme(mon, theme)) score += 38;
    score += candidateThemeAbuserScore(mon, theme);
  }
  if (/安全上场|转场|轮转|pivot|u-turn|volt switch|parting shot|fake out|follow me|rage powder|protect|守住|威吓|intimidate/i.test(text)) score += 12;
  return score;
}

function memberThemeId(member = {}) {
  return THEME_IDS.find((theme) => memberActuallySetsTheme(member, theme)) || "";
}

function candidateSupportsGoalTheme(mon = {}, payload = {}) {
  return candidateGoalThemeScore(mon, payload) > 0;
}

function memberSupportsGoalTheme(member = {}, payload = {}) {
  const text = pocketAgMemberText(member);
  if (goalRequiresTailwind(payload) && memberActuallySetsTailwind(member)) return true;
  if (goalRequiresTheme(payload, "rain")) return memberActuallySetsTheme(member, "rain") || /悠游自如|swift swim|电光束|electro[-\s]?shot|打雷|thunder|暴风|hurricane|水炮|hydro pump|波动冲|wave crash|weather-ball|气象球/i.test(text);
  if (goalRequiresTheme(payload, "sun")) return memberActuallySetsTheme(member, "sun") || /叶绿素|chlorophyll|太阳之力|solar power|日光束|solar beam|天气球|weather ball|热风|heat wave/i.test(text);
  if (goalRequiresTheme(payload, "trick-room")) return memberActuallySetsTheme(member, "trick-room") || /低速|slow|min speed|空间打手|trick room abuser/i.test(text);
  if (goalRequiresTheme(payload, "sand")) return memberActuallySetsTheme(member, "sand") || /拨沙|沙之力|sand rush|sand force|岩石|rock|地面|ground/i.test(text);
  if (goalRequiresTheme(payload, "snow")) return memberActuallySetsTheme(member, "snow") || /拨雪|冰冻之躯|极光幕|暴风雪|slush rush|ice body|aurora veil|blizzard/i.test(text);
  return false;
}

function memberConflictsWithGoalTheme(member = {}, payload = {}) {
  const text = pocketAgMemberText(member);
  if (requiredGoalPokemon(payload).some((ref) => pocketAgMemberMatches(member, ref))) return false;
  if (goalHasFireSunCore(payload) && /大嘴鸥|pelipper|降雨|drizzle|雨天|求雨|rain dance|班基拉斯|tyranitar|河马兽|hippowdon|扬沙|sand stream|沙暴|sandstorm|波动冲|wave crash/i.test(text)) return true;
  if (goalRequiresTheme(payload, "rain") && /煤炭龟|torkoal|喷火龙|charizard|加热洛托姆|rotom[-\s]?heat|日照|drought|晴天|大晴天|sunny day|扬沙|sand stream|沙暴|sandstorm|降雪|snow warning/i.test(text)) return true;
  if (goalRequiresTheme(payload, "sun") && /大嘴鸥|pelipper|降雨|drizzle|雨天|求雨|rain dance|扬沙|sand stream|沙暴|sandstorm|降雪|snow warning/i.test(text)) return true;
  if (goalRequiresTheme(payload, "sand") && /大嘴鸥|pelipper|降雨|drizzle|雨天|求雨|rain dance|煤炭龟|torkoal|日照|drought|晴天|大晴天|sunny day|降雪|snow warning/i.test(text)) return true;
  if (goalRequiresTheme(payload, "snow") && /大嘴鸥|pelipper|降雨|drizzle|雨天|求雨|rain dance|煤炭龟|torkoal|日照|drought|晴天|大晴天|sunny day|班基拉斯|tyranitar|河马兽|hippowdon|扬沙|sand stream|沙暴|sandstorm/i.test(text)) return true;
  if (goalRequiresTheme(payload, "trick-room") && !memberActuallySetsTheme(member, "trick-room") && /喷火龙|charizard|大嘴鸥|pelipper|风妖精|whimsicott|烈箭鹰|talonflame|煤炭龟|torkoal|晴天|日照|drought|大晴天|sunny|雨天|降雨|drizzle|求雨|rain|顺风|tailwind/i.test(text)) return true;
  return false;
}

function pocketAgCoachFitScore(mon = {}, payload = {}, formatKey = "single") {
  const text = `${candidateText(mon)} ${candidateConfigText(mon)}`.toLowerCase();
  const style = requestedTeamStyle(payload.userGoal || payload.intent?.goal || "");
  const template = requestedTeamTemplate(payload.userGoal || payload.intent?.goal || "", style);
  const coachFit = {
    teamAxis: /主轴|副轴|主胜利|备用|第二路线|primary|secondary|backup|axis/i.test(text) ? 1 : 0,
    speedControl: /顺风|tailwind|戏法空间|trick room|电磁波|冰冻之风|黏黏网|icy wind|thunder wave|speed-control/i.test(text) ? 1 : 0,
    safeEntry: /安全上场|转场|轮转|pivot|u-turn|volt switch|parting shot|fake out|follow me|rage powder|protect|守住|击掌奇袭/i.test(text) ? 1 : 0,
    protect: /protect|守住|看我嘛|follow me|rage powder|wide guard|fake out|击掌奇袭/i.test(text) ? 1 : 0,
    endgame: /终盘|收割|清场|cleaner|late-game|priority/i.test(text) ? 1 : 0,
    passChain: /接棒|baton pass|boost pass|强化接棒|传递强化/i.test(text) ? 1 : 0,
  };
  let score = 0;
  if (style.id === "pass-chain") {
    if (/接棒|baton pass|boost pass|强化接棒|传递强化/i.test(text)) score += 42;
    if (/protect|守住|安全上场|转场|轮转|pivot|u-turn|volt switch|parting shot|fake out|follow me|rage powder/i.test(text)) score += 12;
    if (/(接收强化|终盘|收割|清场|sweeper|cleaner|wincon|main core|主轴)/i.test(text)) score += 16;
    if (/强攻|泛用|高速单体|zamazenta|great tusk|flutter mane|incineroar|gyarados|hydreigon/i.test(text)) score -= 18;
    if (/接棒|baton pass/.test(text) && !/守住|protect|安全上场|转场|轮转|保护/i.test(text)) score -= 10;
  }
  if (template.id === "pass-chain") {
    if (/接棒|传递强化|保护|守住|终盘|收割|转场|轮转|安全上场/i.test(text)) score += 12;
  }
  if (goalRequiresPassChain(payload) && coachFit.passChain) score += 40;
  if (goalRequiresPassChain(payload) && /接棒|baton pass|boost pass|强化接棒/i.test(text) && /protect|守住|safe-entry|转场|轮转|speed-control|电磁波|戏法空间|follow me|rage powder/i.test(text)) score += 16;
  if (goalRequiresTailwind(payload) && coachFit.speedControl) score += 24;
  if (goalRequiresTheme(payload, "rain") && /雨天|降雨|求雨|drizzle|rain dance|swift swim|打雷|暴风|hurricane/i.test(text)) score += 24;
  if (goalRequiresTheme(payload, "sun") && /晴天|日照|大晴天|drought|sunny day|chlorophyll|solar power|heat wave|热风/i.test(text)) score += 24;
  if (goalRequiresTheme(payload, "trick-room") && /戏法空间|trick room|空间手|slow|min speed/i.test(text)) score += 28;
  if (goalRequiresTheme(payload, "sand") && /沙暴|扬沙|sandstorm|sand stream|sand rush|拨沙|沙之力/i.test(text)) score += 26;
  if (goalRequiresTheme(payload, "snow") && /雪天|雪景|降雪|snow|snowscape|hail|snow warning|aurora veil|极光幕|blizzard|暴风雪/i.test(text)) score += 26;
  if (goalHasCharizardTailwind(payload)) {
    if (/喷火龙|charizard/i.test(text) && /顺风|tailwind|おいかぜ/i.test(text)) score += 110;
    if (/风妖精|whimsicott|烈箭鹰|talonflame|叉字蝠|crobat|龙卷云|tornadus/i.test(text) && /顺风|tailwind|おいかぜ|控速|support|prankster|疾风之翼|恶作剧之心/i.test(text)) score += 55;
    if (/日光束|solar beam|气象球|weather[-\s]?ball|太阳之力|solar power|热风|heat wave|晴天|日照|大晴天|sunny[-\s]?day|煤炭龟|torkoal|叶绿素|chlorophyll/i.test(text) && !/喷火龙|charizard/i.test(text)) score -= 60;
  }
  score += coachFit.teamAxis * 10;
  score += coachFit.safeEntry * 9;
  score += coachFit.protect * 7;
  score += coachFit.endgame * 9;
  if (formatKey === "double" && /lead|首发|开局|fake out|follow me|rage powder|wide guard|protect|守住/i.test(text)) score += 8;
  if (formatKey === "single" && /hazard|撒场|清场|pivot|switch|轮转|中转|safe-entry|defensive-switch/i.test(text)) score += 8;
  return score;
}

function findCandidateByRef(candidates = [], ref = {}) {
  return candidates.find((mon) => pocketAgMemberMatches(mon, ref));
}

function pocketAgTailwindQualityText(text = "", payload = {}) {
  if (/风妖精|whimsicott|龙卷云|tornadus/i.test(text)) return 6;
  if (/烈箭鹰|talonflame|叉字蝠|crobat/i.test(text)) return 5;
  if (/大嘴鸥|pelipper/i.test(text)) return goalRequiresTheme(payload, "rain") ? 4 : 1;
  if (/prankster|恶作剧之心|gale wings|疾风之翼|support|speed-control|控速|辅助/i.test(text)) return 3;
  if (/顺风|tailwind|おいかぜ/i.test(text)) return 2;
  return 0;
}

function candidateTailwindQuality(mon = {}, payload = {}) {
  if (!candidateActuallySetsTailwind(mon)) return 0;
  return pocketAgTailwindQualityText(`${mon.name || ""} ${mon.slug || ""} ${candidateText(mon)} ${candidateConfigText(mon)}`, payload);
}

function memberTailwindQuality(member = {}, payload = {}) {
  if (!memberActuallySetsTailwind(member)) return 0;
  return pocketAgTailwindQualityText(pocketAgMemberConfigText(member), payload);
}

function findTailwindCandidate(candidates = [], formatKey = "double", payload = {}) {
  const preferred = [/风妖精|whimsicott/i, /烈箭鹰|talonflame/i, /大嘴鸥|pelipper/i, /叉字蝠|crobat/i, /化身.*龙卷云|龙卷云|tornadus/i];
  const hasTailwind = (mon) => candidateActuallySetsTailwind(mon);
  const preferredRank = (mon) => {
    const text = `${mon.name || ""} ${mon.slug || ""}`;
    const index = preferred.findIndex((pattern) => pattern.test(text));
    return index < 0 ? preferred.length + 1 : index;
  };
  const source = candidates.filter(hasTailwind);
  const nonConflict = source.filter((mon) => !candidateConflictsWithGoalTheme(mon, payload));
  return (nonConflict.length ? nonConflict : source)
    .sort((a, b) => {
      const conflict = Number(candidateConflictsWithGoalTheme(a, payload)) - Number(candidateConflictsWithGoalTheme(b, payload));
      const quality = candidateTailwindQuality(b, payload) - candidateTailwindQuality(a, payload);
      const rank = preferredRank(a) - preferredRank(b);
      const fit = Number(b.formatFit?.[formatKey]?.score || 0) - Number(a.formatFit?.[formatKey]?.score || 0);
      const support = Number(b.supportProfile?.score || 0) - Number(a.supportProfile?.score || 0);
      const coach = pocketAgCoachFitScore(b, { userGoal: "顺风" }, formatKey) - pocketAgCoachFitScore(a, { userGoal: "顺风" }, formatKey);
      return conflict || quality || rank || coach || support || fit || Number(a.rank || 9999) - Number(b.rank || 9999);
    })[0] || null;
}

function findThemeCandidate(candidates = [], theme = "", formatKey = "single") {
  const themes = {
    sun: {
      preferred: [/煤炭龟|torkoal/i, /九尾|ninetales/i, /固拉多|groudon/i],
      moves: [/晴天|大晴天|sunny day|drought/i],
    },
    rain: {
      preferred: [/大嘴鸥|pelipper/i, /蚊香蛙皇|politoed/i, /盖欧卡|kyogre/i],
      moves: [/求雨|rain dance|drizzle/i],
    },
    "trick-room": {
      preferred: [/克雷色利亚|cresselia/i, /多边兽2|porygon2/i, /青铜钟|bronzong/i, /奇麒麟|farigiraf/i, /布莉姆温|hatterene/i, /夜巡灵|dusclops/i, /爱管侍|indeedee/i],
      moves: [/戏法空间|trick\s*room/i],
    },
    sand: {
      preferred: [/班基拉斯|tyranitar/i, /河马兽|hippowdon/i, /庞岩怪|gigalith/i],
      moves: [/沙暴|sandstorm|sand stream|扬沙/i],
    },
    snow: {
      preferred: [/阿罗拉.*九尾|九尾.*阿罗拉|ninetales.*alola|alolan.*ninetales/i, /暴雪王|abomasnow/i],
      moves: [/雪景|降雪|冰雹|snowscape|hail|snow warning/i],
    },
  };
  const rule = themes[theme];
  if (!rule) return null;
  const hasTheme = (mon) => candidateActuallySetsTheme(mon, theme) || candidateHasMove(mon, rule.moves);
  const preferredRank = (mon = {}) => {
    const text = `${mon.name || ""} ${mon.slug || ""}`;
    const index = rule.preferred.findIndex((pattern) => pattern.test(text));
    return index < 0 ? rule.preferred.length + 1 : index;
  };
  return candidates
    .filter(hasTheme)
    .sort((a, b) => {
      const preferredScore = preferredRank(a) - preferredRank(b);
      const strongScore = (candidateIsStrongThemeSource(b, theme) ? 1 : 0) - (candidateIsStrongThemeSource(a, theme) ? 1 : 0);
      const actualScore = (candidateActuallySetsTheme(b, theme) ? 1 : 0) - (candidateActuallySetsTheme(a, theme) ? 1 : 0);
      const fit = Number(b.formatFit?.[formatKey]?.score || 0) - Number(a.formatFit?.[formatKey]?.score || 0);
      const support = Number(b.supportProfile?.score || 0) - Number(a.supportProfile?.score || 0);
      const coach = pocketAgCoachFitScore(b, { userGoal: theme }, formatKey) - pocketAgCoachFitScore(a, { userGoal: theme }, formatKey);
      return preferredScore || strongScore || actualScore || coach || support || fit || Number(a.rank || 9999) - Number(b.rank || 9999);
    })[0] || null;
}

function findThemeAbuserCandidate(candidates = [], theme = "", formatKey = "single", payload = {}, team = []) {
  const usedKeys = new Set(team.map(pocketAgMemberKey).filter(Boolean));
  const usedFamilies = new Set(team.map((item) => pocketAgFamilyKey(item) || pocketAgMemberKey(item)).filter(Boolean));
  const scored = candidates
    .filter((mon) => {
      const key = pocketAgMemberKey(mon);
      const family = pocketAgFamilyKey(mon) || key;
      if (!key || usedKeys.has(key) || usedFamilies.has(family)) return false;
      if (candidateConflictsWithGoalTheme(mon, payload)) return false;
      if (theme !== "trick-room" && candidateIsStrongThemeSource(mon, theme)) return false;
      return candidateThemeAbuserScore(mon, theme) > 0;
    })
    .map((mon) => {
      let score =
        candidateThemeAbuserScore(mon, theme) * 2 +
        candidateGoalThemeScore(mon, payload) +
        Number(mon.formatFit?.[formatKey]?.score || 0) +
        Number(mon.synergyScore || 0) * 0.8 +
        Number(mon.supportProfile?.score || 0) * 0.35 -
        Number(mon.rank || 9999) / 80;
      if (goalRequiresTailwind(payload) && candidateActuallySetsTailwind(mon) && theme !== "trick-room") score -= 45;
      if (/三首恶龙|hydreigon|暴鲤龙|gyarados/i.test(`${mon.name || ""} ${mon.slug || ""}`) && candidateThemeAbuserScore(mon, theme) < 55) score -= 90;
      return { mon, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.mon || null;
}

function ensureMove(member = {}, moveName = "") {
  if (!moveName) return member;
  const moves = Array.isArray(member.moves) ? member.moves.filter(Boolean) : [];
  const moveAliasKey = (move = "") => {
    const key = pocketAgTextKey(move);
    if (/^(tailwind|おいかぜ|顺风)$/.test(key)) return "顺风";
    if (/^(protect|まもる|守住)$/.test(key)) return "守住";
    if (/^(trickroom|トリックルーム|戏法空间)$/.test(key)) return "戏法空间";
    if (/^(sunnyday|にほんばれ|大晴天|晴天)$/.test(key)) return "大晴天";
    if (/^(raindance|あまごい|求雨|雨天)$/.test(key)) return "求雨";
    return key;
  };
  if (!moves.some((move) => moveAliasKey(move) === moveAliasKey(moveName))) {
    if (moves.length >= 4) moves[moves.length - 1] = moveName;
    else moves.push(moveName);
  }
  member.moves = moves;
  return member;
}

function enforceGoalConstraintsOnTeam(team = [], payload = {}, format = "single") {
  const candidates = Array.isArray(payload.metaCandidates) ? payload.metaCandidates : [];
  const formatKey = String(format || "single").includes("double") ? "double" : "single";
  const required = requiredGoalPokemon(payload);
  const avoidNames = pocketAgAvoidNames(payload);
  const existing = new Set(team.map(pocketAgMemberKey).filter(Boolean));
  const requestedWeatherThemes = () => requestedThemeIds(payload).filter((theme) => ["rain", "sun", "sand", "snow"].includes(theme));
  const isRequiredMember = (item = {}) => required.some((ref) => pocketAgMemberMatches(item, ref));
  const strongSourceKeepScore = (item = {}, theme = "") => {
    let score = 0;
    if (isRequiredMember(item)) score += 1000;
    if (goalRequiresTailwind(payload) && memberActuallySetsTailwind(item)) score += 180 + memberTailwindQuality(item, payload) * 20;
    if (/启动手|天气|顺风控速|主轴|核心/i.test(String(item.role || ""))) score += 35;
    if (memberThemeAbuserScore(item, theme) > 0 && !memberIsStrongThemeSource(item, theme)) score += 20;
    const text = `${item.name || ""} ${item.slug || ""} ${item.id || ""}`;
    if (theme === "rain" && /大嘴鸥|pelipper/i.test(text)) score += goalRequiresTailwind(payload) ? 35 : 18;
    if (theme === "rain" && /蚊香蛙皇|politoed/i.test(text)) score += 14;
    if (theme === "sun" && /煤炭龟|torkoal/i.test(text)) score += 18;
    if (theme === "sand" && /班基拉斯|tyranitar/i.test(text)) score += 18;
    if (theme === "snow" && /阿罗拉.*九尾|九尾.*阿罗拉|ninetales.*alola|alolan.*ninetales/i.test(text)) score += 18;
    return score;
  };
  const limitExtraStrongWeatherSources = (list = []) => {
    let result = list.slice();
    for (const theme of requestedWeatherThemes()) {
      const sources = result.filter((item) => memberIsStrongThemeSource(item, theme));
      if (sources.length <= 1) continue;
      const keep = sources
        .slice()
        .sort((a, b) => strongSourceKeepScore(b, theme) - strongSourceKeepScore(a, theme))[0];
      result = result.filter((item) => item === keep || !memberIsStrongThemeSource(item, theme) || isRequiredMember(item));
    }
    return result;
  };
  const wouldExceedStrongWeatherSource = (member = {}, list = []) =>
    requestedWeatherThemes().some((theme) => {
      if (!memberIsStrongThemeSource(member, theme) || isRequiredMember(member)) return false;
      const existingSource = list.find((item) => memberIsStrongThemeSource(item, theme));
      if (!existingSource) return false;
      return strongSourceKeepScore(existingSource, theme) >= strongSourceKeepScore(member, theme);
    });
  const conflictsWithGoal = (mon = {}) => candidateConflictsWithGoalTheme(mon, payload);
  let next = team.slice(0, 6);
  const isGenericThemeOutsider = (item = {}) =>
    /三首恶龙|hydreigon|暴鲤龙|gyarados/i.test(`${item.name || ""} ${item.slug || ""} ${item.id || ""}`) &&
    (requestedThemeIds(payload).length || goalRequiresTailwind(payload) || goalRequiresPassChain(payload)) &&
    !requestedThemeIds(payload).some((theme) => memberActuallySetsTheme(item, theme)) &&
    !(goalRequiresTailwind(payload) && memberActuallySetsTailwind(item) && memberTailwindQuality(item, payload) >= 5) &&
    !(goalRequiresPassChain(payload) && /接棒|baton pass|强化接棒|传递强化/i.test(pocketAgMemberText(item))) &&
    !required.some((ref) => pocketAgMemberMatches(item, ref));
  if (requestedThemeIds(payload).length || goalRequiresTailwind(payload) || goalRequiresPassChain(payload)) {
    next = next.filter((item) => !isGenericThemeOutsider(item) && !memberConflictsWithGoalTheme(item, payload));
  }
  const insertRequired = (mon, reason = "") => {
    if (!mon) return;
    if (next.some((item) => pocketAgMemberMatches(item, mon))) return;
    const member = advicePokemon(mon, 0, formatKey, payload);
    member.role = /mega|进化石/i.test(pocketAgMemberText(member)) ? "Mega 位/指定核心" : "指定核心";
    member.note = `${member.name} 是用户目标指定核心，${reason || "本队围绕它安排速度控制、安全上场和终盘路线。"}`;
    const removableIndex = next.findIndex((item) => !required.some((ref) => pocketAgMemberMatches(item, ref)) && !memberActuallySetsTailwind(item));
    if (next.length < 6) next.unshift(member);
    else if (removableIndex >= 0) next[removableIndex] = member;
    else next[0] = member;
    existing.add(pocketAgMemberKey(member));
  };

  for (const ref of required) {
    const mon = findCandidateByRef(candidates, ref) || ref;
    insertRequired(mon, "必须保留在最终 6 只里，不能被泛用热门补位挤掉。");
  }

  if (goalRequiresTailwind(payload)) {
    let setter = next.find((item) => memberActuallySetsTailwind(item));
    const candidate = findTailwindCandidate(candidates, formatKey, payload);
    const setterIsWeak = setter && candidate && memberTailwindQuality(setter, payload) < Math.max(4, candidateTailwindQuality(candidate, payload));
    if (!setter || setterIsWeak) {
      if (candidate) {
        const member = advicePokemon(candidate, 1, formatKey, payload);
        member.role = "顺风控速手";
        member.note = "负责开顺风，让指定核心和中速打手获得出手权；被挑衅或击倒时转为守住/轮转拖回合。";
        ensureMove(member, "顺风");
        const removableIndex = setterIsWeak
          ? next.findIndex((item) => item === setter)
          : next.findIndex((item) => !required.some((ref) => pocketAgMemberMatches(item, ref)));
        if (setterIsWeak && removableIndex >= 0) next[removableIndex] = member;
        else if (next.length < 6) next.push(member);
        else if (removableIndex >= 0) next[removableIndex] = member;
        else next[next.length - 1] = member;
        setter = member;
      }
    } else {
      setter.role = /控速|顺风/.test(String(setter.role || "")) ? setter.role : `${setter.role || "功能位"} / 顺风控速`;
      setter.note = `${setter.note || ""} 负责开顺风服务队伍主输出。`.trim();
      ensureMove(setter, "顺风");
    }
  }

  const themeRequirements = [
    {
      id: "sun",
      patterns: [/晴天|日照|大晴天|drought|sunny day|sun/i],
      move: "大晴天",
      role: "晴天启动手",
      note: "负责提供晴天，让指定核心或火系/叶绿素收益位获得输出窗口；被抢天气时保留备用进攻路线。",
    },
    {
      id: "rain",
      patterns: [/雨天|降雨|求雨|drizzle|rain dance|rain/i],
      move: "求雨",
      role: "雨天启动手",
      note: "负责提供雨天，让雨天收益位获得速度或火力窗口；被抢天气时转为轮转和抗性处理。",
    },
    {
      id: "trick-room",
      patterns: [/戏法空间|空间手|trick\s*room/i],
      move: "戏法空间",
      role: "戏法空间手",
      note: "负责启动戏法空间，让低速高收益打手先出手；非空间回合用守住/轮转拖到下一次启动。",
    },
    {
      id: "sand",
      patterns: [/沙暴|扬沙|sandstorm|sand stream/i],
      move: "沙暴",
      role: "沙暴启动手",
      note: "负责提供沙暴，让岩石/地面耐久与拨沙收益位获得节奏；天气被覆盖时保留轮转和终盘路线。",
    },
    {
      id: "snow",
      patterns: [/雪天|雪景|降雪|snowscape|hail|snow warning/i],
      move: "雪景",
      role: "雪天启动手",
      note: "负责提供雪天，让冰系防守、极光幕或拨雪收益位获得行动窗口；天气被覆盖时改用保护/轮转拖回启动回合。",
    },
  ];
  for (const theme of themeRequirements) {
    if (!goalRequiresTheme(payload, theme.id)) continue;
    for (const item of next) {
      if (memberActuallySetsTheme(item, theme.id)) continue;
      if (new RegExp(theme.role, "i").test(String(item.role || ""))) {
        item.role = String(item.role || "")
          .replace(new RegExp(`\\s*/\\s*${theme.role}`, "ig"), "")
          .replace(new RegExp(`${theme.role}\\s*/\\s*`, "ig"), "")
          .replace(new RegExp(theme.role, "ig"), "")
          .trim() || pocketAgMemberRole(item, formatKey, next.indexOf(item));
      }
      if (String(item.note || "").includes(theme.note)) {
        item.note = String(item.note || "").replace(theme.note, "").trim();
      }
    }
    let setter = next.find((item) => memberIsStrongThemeSource(item, theme.id)) || next.find((item) => memberActuallySetsTheme(item, theme.id));
    const needsStrongerSetter = setter && !memberIsStrongThemeSource(setter, theme.id) && findThemeCandidate(candidates, theme.id, formatKey);
    if (!setter || needsStrongerSetter) {
      const candidate = findThemeCandidate(candidates, theme.id, formatKey);
      if (candidate) {
        const member = advicePokemon(candidate, 1, formatKey, payload);
        member.role = theme.role;
        member.note = theme.note;
        if (!memberActuallySetsTheme(member, theme.id)) ensureMove(member, theme.move);
        const removableIndex = next.findIndex((item) =>
          !required.some((ref) => pocketAgMemberMatches(item, ref)) &&
          !memberActuallySetsTailwind(item) &&
          !memberThemeId(item),
        );
        const weakSetterIndex = needsStrongerSetter ? next.findIndex((item) => item === setter) : -1;
        if (weakSetterIndex >= 0) next[weakSetterIndex] = member;
        else if (next.length < 6) next.push(member);
        else if (removableIndex >= 0) next[removableIndex] = member;
        else next[next.length - 1] = member;
        setter = member;
      }
    } else {
      setter.role = new RegExp(theme.role, "i").test(String(setter.role || "")) ? setter.role : `${setter.role || "功能位"} / ${theme.role}`;
      setter.note = `${setter.note || ""} ${theme.note}`.trim();
      if (!memberActuallySetsTheme(setter, theme.id)) ensureMove(setter, theme.move);
    }
  }

  const themeAbuserRoles = {
    sun: {
      role: "晴天收益打手",
      note: "作为晴天收益位承接启动回合，负责把晴天火力或速度优势转成破盾/终盘压力。",
    },
    rain: {
      role: "雨天收益打手",
      note: "作为雨天收益位承接降雨回合，负责利用雨天火力、必中收益或速度优势打开突破口。",
    },
    "trick-room": {
      role: "空间收益打手",
      note: "作为戏法空间收益位承接空间回合，负责在低速先手窗口内破盾或收割。",
    },
    sand: {
      role: "沙暴收益打手",
      note: "作为沙暴收益位承接天气回合，负责利用拨沙、岩地抗性或沙暴压制推进。",
    },
    snow: {
      role: "雪天收益打手",
      note: "作为雪天收益位承接雪景/降雪回合，负责利用极光幕、冰系压制或拨雪优势推进。",
    },
  };
  for (const theme of requestedThemeIds(payload)) {
    const hasAbuser = next.some((item) => {
      if (memberThemeAbuserScore(item, theme) <= 0) return false;
      if (theme === "trick-room") return true;
      return !memberIsStrongThemeSource(item, theme);
    });
    if (hasAbuser) continue;
    const candidate = findThemeAbuserCandidate(candidates, theme, formatKey, payload, next);
    if (!candidate) continue;
    const member = advicePokemon(candidate, next.length, formatKey, payload);
    const roleInfo = themeAbuserRoles[theme] || { role: "主题收益位", note: "负责承接主题启动后的输出或收割窗口。" };
    member.role = roleInfo.role;
    member.note = roleInfo.note;
    const removableIndex = next.findIndex((item) =>
      !required.some((ref) => pocketAgMemberMatches(item, ref)) &&
      !memberActuallySetsTailwind(item) &&
      !requestedThemeIds(payload).some((id) => memberIsStrongThemeSource(item, id)) &&
      memberThemeAbuserScore(item, theme) <= 0,
    );
    if (next.length < 6) next.push(member);
    else if (removableIndex >= 0) next[removableIndex] = member;
  }

  next = limitExtraStrongWeatherSources(next);

  const seen = new Set();
  const seenFamilies = new Set();
  let deduped = next.filter((item) => {
    const key = pocketAgMemberKey(item);
    const family = pocketAgFamilyKey(item) || key;
    if (!key || seen.has(key) || seenFamilies.has(family)) return false;
    seen.add(key);
    if (family) seenFamilies.add(family);
    return true;
  }).slice(0, 6);
  const fillCandidates = [
    ...candidates.filter((mon) => !conflictsWithGoal(mon)),
    ...candidates,
  ].sort((a, b) => {
    const themeDelta = candidateGoalThemeScore(b, payload) - candidateGoalThemeScore(a, payload);
    const genericPenalty = (mon = {}) => (/三首恶龙|hydreigon|暴鲤龙|gyarados/i.test(`${mon.name || ""} ${mon.slug || ""}`) && !candidateSupportsGoalTheme(mon, payload) ? 1 : 0);
    const genericDelta = genericPenalty(a) - genericPenalty(b);
    const avoidDelta = (avoidNames.some((name) => `${String(a.name || "").toLowerCase()} ${String(a.slug || "").toLowerCase()}`.includes(name)) ? 1 : 0) - (avoidNames.some((name) => `${String(b.name || "").toLowerCase()} ${String(b.slug || "").toLowerCase()}`.includes(name)) ? 1 : 0);
    const conflictDelta = Number(conflictsWithGoal(a)) - Number(conflictsWithGoal(b));
    const fitDelta = Number(b.formatFit?.[formatKey]?.score || 0) - Number(a.formatFit?.[formatKey]?.score || 0);
    return themeDelta || conflictDelta || avoidDelta || genericDelta || fitDelta || Number(a.rank || 9999) - Number(b.rank || 9999);
  });
  const canAddMoreTailwind = (member = {}) => {
    if (!goalRequiresTailwind(payload) || !requestedThemeIds(payload).length || !memberActuallySetsTailwind(member)) return true;
    const existingTailwind = deduped.filter(memberActuallySetsTailwind).length;
    if (existingTailwind < 2) return true;
    return requestedThemeIds(payload).some((theme) => memberIsStrongThemeSource(member, theme));
  };
  for (const mon of fillCandidates) {
    if (deduped.length >= 6) break;
    const candidateMember = advicePokemon(mon, deduped.length, formatKey, payload);
    if (isGenericThemeOutsider(candidateMember) || memberConflictsWithGoalTheme(candidateMember, payload)) continue;
    if (wouldExceedStrongWeatherSource(candidateMember, deduped)) continue;
    if (!canAddMoreTailwind(candidateMember)) continue;
    const key = pocketAgMemberKey(mon);
    const family = pocketAgFamilyKey(mon) || key;
    if (!key || seen.has(key) || seenFamilies.has(family)) continue;
    seen.add(key);
    if (family) seenFamilies.add(family);
    deduped.push(candidateMember);
  }
  if (goalRequiresTailwind(payload) && requestedThemeIds(payload).length) {
    const keepTailwind = new Set(
      deduped
        .filter(memberActuallySetsTailwind)
        .sort((a, b) => {
          const themeSource = requestedThemeIds(payload).some((theme) => memberIsStrongThemeSource(b, theme)) - requestedThemeIds(payload).some((theme) => memberIsStrongThemeSource(a, theme));
          const requiredDelta = Number(required.some((ref) => pocketAgMemberMatches(b, ref))) - Number(required.some((ref) => pocketAgMemberMatches(a, ref)));
          const quality = memberTailwindQuality(b, payload) - memberTailwindQuality(a, payload);
          return themeSource || requiredDelta || quality;
        })
        .slice(0, 2)
        .map(pocketAgMemberKey),
    );
    deduped = deduped.filter((item) => !memberActuallySetsTailwind(item) || keepTailwind.has(pocketAgMemberKey(item)));
    for (const mon of fillCandidates) {
      if (deduped.length >= 6) break;
      const candidateMember = advicePokemon(mon, deduped.length, formatKey, payload);
      if (memberActuallySetsTailwind(candidateMember) && !requestedThemeIds(payload).some((theme) => memberIsStrongThemeSource(candidateMember, theme))) continue;
      if (isGenericThemeOutsider(candidateMember) || memberConflictsWithGoalTheme(candidateMember, payload)) continue;
      if (wouldExceedStrongWeatherSource(candidateMember, deduped)) continue;
      const key = pocketAgMemberKey(mon);
      const family = pocketAgFamilyKey(mon) || key;
      if (!key || seen.has(key) || seenFamilies.has(family)) continue;
      seen.add(key);
      if (family) seenFamilies.add(family);
      deduped.push(candidateMember);
    }
  }
  const priorityScore = (item = {}) => {
    let score = 0;
    if (required.some((ref) => pocketAgMemberMatches(item, ref))) score += 900;
    if (goalRequiresTailwind(payload) && memberActuallySetsTailwind(item)) score += 240;
    for (const theme of requestedThemeIds(payload)) {
      if (memberActuallySetsTheme(item, theme)) score += 220;
    }
    if (/主轴|指定核心|Mega|核心|启动手|控速手|空间手/i.test(String(item.role || ""))) score += 40;
    if (/终盘|收割|清场/i.test(pocketAgMemberText(item))) score += 10;
    return score;
  };
  const finalTeam = deduped
    .sort((a, b) => priorityScore(b) - priorityScore(a))
    .slice(0, 6);
  return enforceMegaResourcePlan(finalTeam, payload, formatKey);
}

function pocketAgGuessRole(item = {}, format = "single", index = 0) {
  const text = pocketAgMemberText(item);
  if (/mega|进化石/i.test(text)) return "Mega 位";
  if (/顺风|电磁波|戏法空间|冰冻之风|岩石封锁|黏黏网|tailwind|thunder wave|trick room|icy wind|rock tomb|sticky web/i.test(text)) return "控速位";
  if (/守住|protect|看我嘛|愤怒粉|击掌奇袭|fake out|follow me|rage powder|广域防守|wide guard/i.test(text)) return format === "double" ? "双打协作位" : "功能位";
  if (/急速折返|伏特替换|抛下狠话|转场|轮转|u-turn|volt switch|parting shot|pivot/i.test(text)) return "转场位";
  if (/隐形岩|撒菱|毒菱|黏黏网|stealth rock|spikes|toxic spikes|sticky web/i.test(text)) return "撒场位";
  if (/高速旋转|清除浓雾|defog|rapid spin/i.test(text)) return "清场位";
  if (/终盘|收割|清场|priority|神速|突袭|子弹拳|冰砾|影子偷袭/i.test(text)) return "终盘收割";
  if (/破盾|壁垒|wallbreaker|输出|攻击|特攻|打手/i.test(text)) return "破盾输出";
  if (index === 0) return "主轴核心";
  return format === "double" ? "双打协作位" : "补位";
}

function pocketAgSelectTeam(payload, format = "single") {
  const candidates = Array.isArray(payload.metaCandidates) ? payload.metaCandidates : [];
  const knownKeys = pocketAgKnownCandidateKeys(payload);
  const required = requiredGoalPokemon(payload);
  const avoidNames = [...pocketAgAvoidNames(payload), ...pocketAgRecentGeneratedAvoidNames(payload, format)];
  const formatKey = String(format || payload.format || "single").includes("double") ? "double" : "single";
  const style = requestedTeamStyle(payload.userGoal || payload.intent?.goal || "");
  const template = requestedTeamTemplate(payload.userGoal || payload.intent?.goal || "", style);
  const wantedSlots = Array.isArray(payload.intent?.[`${formatKey}Model`]?.missingSlots)
    ? payload.intent[`${formatKey}Model`].missingSlots
    : Array.isArray(payload.formatModels?.[formatKey]?.slotModel?.missingSlots)
      ? payload.formatModels[formatKey].slotModel.missingSlots
      : [];

  const candidateSignals = (mon = {}) => [
    mon.name,
    mon.slug,
    mon.roleProfile?.summary,
    mon.roleProfile?.tags,
    mon.supportProfile?.tags,
    mon.supportProfile?.reasons,
    mon.understandingReasons,
    mon.synergyReasons,
    mon.formatFit?.[formatKey]?.reasons,
    mon.formatFit?.[formatKey]?.slotFit?.reasons,
    mon.formatFit?.[formatKey]?.threatFit?.reasons,
    mon.formatFit?.[formatKey]?.chainFit?.reasons,
    mon.formatFit?.[formatKey]?.resourceFit?.reasons,
    mon.formatFit?.[formatKey]?.phaseFit?.reasons,
    mon.formatFit?.[formatKey]?.branchFit?.reasons,
  ]
    .map(pocketAgTextBlob)
    .join(" ")
    .toLowerCase();

  const scoreCandidate = (mon = {}) => {
    const fit = mon.formatFit?.[formatKey] || {};
    let score =
      Number(fit.score || 0) +
      Number(fit.slotFit?.score || 0) * 1.25 +
      Number(fit.threatFit?.score || 0) * 0.9 +
      Number(fit.chainFit?.score || 0) * 1.15 +
      Number(fit.resourceFit?.score || 0) * 1.15 +
      Number(fit.phaseFit?.score || 0) +
      Number(fit.branchFit?.score || 0) * 0.9 +
      Number(mon.synergyScore || 0) +
      Number(mon.understandingScore || 0) * 0.35 +
      Number(mon.supportProfile?.score || 0) * 1.4 +
      (mon.megaSlotCandidate ? 6 : 0);
    const configText = candidateConfigText(mon);
    const text = `${candidateSignals(mon)} ${configText}`.toLowerCase();
    const bestConfig = bestTeamLibraryConfig(mon, formatKey, payload);
    const configComplete = Boolean(bestConfig.item && bestConfig.ability && (bestConfig.moves || []).filter(Boolean).length >= 3);
    const coachScore = pocketAgCoachFitScore(mon, payload, formatKey);
    const isRequired = required.some((ref) => pocketAgMemberMatches(mon, ref));
    const fillsRequiredTailwind = goalRequiresTailwind(payload) && candidateActuallySetsTailwind(mon);
    const setsRain = candidateActuallySetsTheme(mon, "rain");
    const setsSun = candidateActuallySetsTheme(mon, "sun");
    const setsTrickRoom = candidateActuallySetsTheme(mon, "trick-room");
    const setsSand = candidateActuallySetsTheme(mon, "sand");
    const setsSnow = candidateActuallySetsTheme(mon, "snow");
    const goalThemeScore = candidateGoalThemeScore(mon, payload);
    const rainAbuser = candidateThemeAbuserScore(mon, "rain") > 0;
    const sunAbuser = candidateThemeAbuserScore(mon, "sun") > 0;
    const sandAbuser = candidateThemeAbuserScore(mon, "sand") > 0;
    const snowAbuser = candidateThemeAbuserScore(mon, "snow") > 0;
    const genericOverused = /三首恶龙|hydreigon|暴鲤龙|gyarados/i.test(`${mon.name || ""} ${mon.slug || ""}`);
    const genericGoodstuff = /三首恶龙|hydreigon|暴鲤龙|gyarados|zamazenta|great tusk|flutter mane|incineroar/i.test(`${mon.name || ""} ${mon.slug || ""} ${text}`);
    const conflictsGoalTheme = candidateConflictsWithGoalTheme(mon, payload);
    const goalRelevant =
      isRequired ||
      fillsRequiredTailwind ||
      (goalRequiresPassChain(payload) && /接棒|baton pass|boost pass|强化接棒|传递强化/i.test(text)) ||
      (goalRequiresTheme(payload, "rain") && (setsRain || rainAbuser)) ||
      (goalRequiresTheme(payload, "sun") && (setsSun || sunAbuser)) ||
      (goalRequiresTheme(payload, "sand") && (setsSand || sandAbuser)) ||
      (goalRequiresTheme(payload, "snow") && (setsSnow || snowAbuser)) ||
      (goalRequiresTheme(payload, "trick-room") && setsTrickRoom);
    if (isRequired) score += 999;
    if (configComplete) score += 28;
    else score -= 90;
    if (fillsRequiredTailwind) score += 120;
    if (goalThemeScore) score += goalThemeScore * 1.2;
    score += coachScore;
    if (goalRequiresTheme(payload, "rain")) {
      if (setsRain) score += 145;
      if (rainAbuser) score += 55;
      if (setsSun || /煤炭龟|torkoal|喷火龙|charizard/i.test(`${mon.name || ""} ${mon.slug || ""}`)) score -= 180;
    }
    if (goalRequiresTheme(payload, "sun")) {
      if (setsSun) score += 145;
      if (sunAbuser) score += 55;
      if (setsRain) score -= 180;
    }
    if (goalRequiresTheme(payload, "sand")) {
      if (setsSand) score += 145;
      if (sandAbuser) score += 55;
      if (setsRain || setsSun || setsSnow) score -= 180;
    }
    if (goalRequiresTheme(payload, "snow")) {
      if (setsSnow) score += 145;
      if (snowAbuser) score += 55;
      if (setsRain || setsSun || setsSand) score -= 180;
    }
    if (goalRequiresTheme(payload, "trick-room") && setsTrickRoom) score += 145;
    if (conflictsGoalTheme) score -= 260;
    if (goalHasFireSunCore(payload) && (setsRain || /大嘴鸥|pelipper|班基拉斯|tyranitar|大力鳄|feraligatr|扬沙|sand stream|sandstorm|沙暴|wave crash|波动冲/i.test(`${mon.name || ""} ${mon.slug || ""} ${text}`))) score -= 220;
    if (goalRequiresTheme(payload, "trick-room")) {
      const isTrickRoomSetter = setsTrickRoom;
      if (!isTrickRoomSetter && /喷火龙|charizard|大嘴鸥|pelipper|风妖精|whimsicott|烈箭鹰|talonflame|煤炭龟|torkoal|晴天|日照|drought|大晴天|sunny|雨天|降雨|drizzle|求雨|rain|顺风|tailwind/i.test(`${mon.name || ""} ${mon.slug || ""} ${text}`)) score -= 180;
      if (isTrickRoomSetter) score += 90;
    }
    if (genericOverused && !goalRelevant) score -= avoidNames.length ? 180 : 90;
    if (goalRequiresTailwind(payload) && genericOverused && !candidateSupportsGoalTheme(mon, payload)) score -= 240;
    if (goalRequiresPassChain(payload)) {
      if (/接棒|baton pass|boost pass|强化接棒|传递强化/i.test(text)) score += 90;
      if (/保护|守住|安全上场|转场|轮转|pivot|u-turn|volt switch|parting shot|fake out|follow me|rage powder/i.test(text)) score += 18;
      if (genericGoodstuff && !/接棒|baton pass|boost pass|强化接棒|传递强化/i.test(text)) score -= 160;
      if (/终盘|收割|清场|wincon|cleaner/i.test(text)) score += 14;
    }
    if (coachScore > 0 && !goalRelevant) score += 4;
    if (formatKey === "double") {
      if (/lead-pair|fake out|follow me|rage powder|wide guard|protect|intimidate|speed-control/.test(text)) score += 8;
      if (/spread-pressure|范围|热风|岩崩|魔法闪耀|地震/.test(text)) score += 4;
    } else {
      if (/hazard|removal|status|pivot|safe-entry|defensive-switch/.test(text)) score += 6;
      if (/wallbreaker|cleaner|终盘|收割/.test(text)) score += 4;
    }
    if (wantedSlots.some((slot) => new RegExp(slot.id || slot.label || "", "i").test(text))) score += 5;
    if (avoidNames.some((name) => text.includes(name) || String(mon.name || "").toLowerCase() === name || String(mon.slug || "").toLowerCase() === name)) {
      score -= goalRelevant ? 260 : 520;
    }
    const recentNames = pocketAgRecentGeneratedAvoidNames(payload, format);
    if (recentNames.some((name) => text.includes(name))) score -= goalRequiresPassChain(payload) ? 220 : 150;
    const recentTeams = generatedTeamMemory.get(pocketAgMemoryKey(payload, format)) || [];
    for (const recentTeam of recentTeams) {
      const ownKey = String(mon.name || mon.slug || mon.id || "").toLowerCase();
      if (ownKey && recentTeam.includes(ownKey) && !goalRelevant) score -= 30;
    }
    if (template.id === "pass-chain" && /接棒|baton pass|boost pass|保护|守住|安全上场|终盘|收割/i.test(text)) score += 12;
    return score;
  };

  const pool = candidates
    .map((mon) => ({ ...mon, _score: scoreCandidate(mon), _text: candidateSignals(mon) }))
    .filter((mon) => {
      const key = String(mon.id || mon.slug || mon.name || "").toLowerCase();
      if (!knownKeys.size) return true;
      return knownKeys.has(key) || [mon.slug, mon.name, mon.pokeCamp?.identifier, mon.pokeCamp?.speciesIdentifier].some((value) => knownKeys.has(pocketAgTextKey(value)));
    })
    .filter((mon) => mon._score > -20)
    .sort((a, b) => b._score - a._score);

  const selected = [];
  const used = new Set();
  const usedFamilies = new Set();
  const add = (mon) => {
    if (!mon) return false;
    const key = String(mon.id || mon.slug || mon.name || "").toLowerCase();
    const family = pocketAgFamilyKey(mon) || key;
    if (!key || used.has(key) || usedFamilies.has(family)) return false;
    used.add(key);
    if (family) usedFamilies.add(family);
    selected.push(mon);
    return true;
  };
  const coachBest = (patterns, fallback = null) => pool
    .filter((mon) => patterns.some((pattern) => pattern.test(mon._text)))
    .sort((a, b) => pocketAgCoachFitScore(b, payload, formatKey) - pocketAgCoachFitScore(a, payload, formatKey) || b._score - a._score)[0] || fallback || null;

  for (const ref of required) add(findCandidateByRef(pool, ref) || ref);
  if (goalRequiresPassChain(payload)) {
    add(coachBest([/接棒|baton pass|boost pass|强化接棒|传递强化/i], pool[0]));
    add(coachBest([/保护|守住|安全上场|转场|轮转|pivot|u-turn|volt switch|parting shot|fake out|follow me|rage powder/i], pool[1] || pool[0]));
  }
  if (goalRequiresTailwind(payload)) add(findTailwindCandidate(pool, formatKey, payload));
  for (const theme of ["rain", "sun", "trick-room", "sand", "snow"]) {
    if (goalRequiresTheme(payload, theme)) {
      add(findThemeCandidate(pool, theme, formatKey));
      add(findThemeAbuserCandidate(pool, theme, formatKey, payload, selected));
    }
  }

  if (payload.intent?.megaPlan?.recommendation !== "no-forced-mega") {
    add(coachBest([/mega/i, /进化石/i], pool[0]));
  }
  if (formatKey === "double") {
    add(coachBest([/lead-pair|fake out|follow me|rage powder|wide guard|intimidate|speed-control|首发|开局/i], pool[0]));
    add(coachBest([/spread-pressure|范围|热风|岩崩|魔法闪耀|地震|破盾|输出/i], pool[1] || pool[0]));
    add(coachBest([/speed-control|顺风|戏法空间|电磁波|冰冻之风|黏黏网|tailwind|trick room/i], pool[2] || pool[0]));
    add(coachBest([/defensive-switch|safe-entry|pivot|转场|轮转|联防|抗性/i], pool[3] || pool[1] || pool[0]));
    add(coachBest([/endgame-cleaner|priority|cleaner|终盘|收割|清场/i], pool[4] || pool[0]));
  } else {
    add(coachBest([/primary-core|wallbreaker|输出|破盾|核心/i], pool[0]));
    add(coachBest([/speed-control|顺风|戏法空间|电磁波|冰冻之风|黏黏网|tailwind|trick room|priority/i], pool[1] || pool[0]));
    add(coachBest([/defensive-switch|safe-entry|pivot|转场|轮转|联防|抗性/i], pool[2] || pool[0]));
    add(coachBest([/hazard|removal|status|撒场|清场|状态/i], pool[3] || pool[1] || pool[0]));
    add(coachBest([/endgame-cleaner|cleaner|终盘|收割|priority/i], pool[4] || pool[0]));
  }

  for (const mon of pool) {
    if (selected.length >= 6) break;
    add(mon);
  }

  const selectedMembers = selected.slice(0, 6).map((mon, index) => advicePokemon(mon, index, formatKey, payload));
  const finalTeam = enforceGoalConstraintsOnTeam(selectedMembers, payload, formatKey);
  pocketAgRememberGeneratedTeam(payload, format, finalTeam);
  return finalTeam;
}

function pocketAgMemberRole(member = {}, format = "single", index = 0) {
  const text = pocketAgMemberText(member);
  return pocketAgGuessRole({ ...member, role: member.role || "" }, format, index) || (format === "double" ? "双打协作位" : index === 0 ? "主轴核心" : "补位");
}

function pocketAgFormatPlan(team = [], format = "single", payload = {}) {
  const tailwind = team.find((item) => memberActuallySetsTailwind(item));
  const sun = team.find((item) => memberActuallySetsTheme(item, "sun"));
  const rain = team.find((item) => memberActuallySetsTheme(item, "rain"));
  const trickRoom = team.find((item) => memberActuallySetsTheme(item, "trick-room"));
  const sand = team.find((item) => memberActuallySetsTheme(item, "sand"));
  const snow = team.find((item) => memberActuallySetsTheme(item, "snow"));
  const requiredCore = requiredGoalPokemon(payload)
    .map((ref) => team.find((item) => pocketAgMemberMatches(item, ref)) || ref)
    .filter(Boolean);
  const isGenericGoodstuffMember = (item = {}) => /三首恶龙|hydreigon|暴鲤龙|gyarados/i.test(`${item.name || ""} ${item.slug || ""} ${item.id || ""}`);
  const currentThemes = requestedThemeIds(payload);
  const isThemeRelevantMember = (item = {}) => {
    if (!currentThemes.length && !goalRequiresTailwind(payload)) return true;
    if (requiredCore.some((ref) => pocketAgMemberMatches(item, ref))) return true;
    if (goalRequiresTailwind(payload) && memberActuallySetsTailwind(item)) return true;
    if (currentThemes.some((theme) => memberActuallySetsTheme(item, theme))) return true;
    const text = pocketAgMemberText(item);
    if (currentThemes.includes("rain") && /悠游自如|swift swim|打雷|暴风|hurricane|水炮|波动冲|weather-ball/i.test(text)) return true;
    if (currentThemes.includes("sun") && /叶绿素|太阳之力|chlorophyll|solar power|日光束|热风|weather-ball/i.test(text)) return true;
    if (currentThemes.includes("sand") && /拨沙|沙之力|sand-rush|sand-force|岩|地面|rock|ground/i.test(text)) return true;
    if (currentThemes.includes("snow") && /拨雪|极光幕|暴风雪|slush rush|aurora veil|blizzard|冰/i.test(text)) return true;
    if (currentThemes.includes("trick-room") && /戏法空间|低速|空间|trick-room|trick room/i.test(text)) return true;
    return false;
  };
  const usedPlanKeys = new Set();
  const keyOf = (item = {}) => pocketAgMemberKey(item) || String(item.name || item.id || item.slug || "");
  const mark = (item) => {
    const key = keyOf(item);
    if (key) usedPlanKeys.add(key);
    return item;
  };
  const pickUnused = (patterns = [], fallbacks = []) => {
    const eligible = team.filter((item) => !isGenericGoodstuffMember(item) || isThemeRelevantMember(item));
    const found = eligible.find((item) => {
      const key = keyOf(item);
      return key && !usedPlanKeys.has(key) && patterns.some((pattern) => pattern.test(pocketAgMemberText(item)));
    });
    if (found) return mark(found);
    const fallback =
      fallbacks.find((item) => item && !usedPlanKeys.has(keyOf(item)) && (!isGenericGoodstuffMember(item) || isThemeRelevantMember(item))) ||
      eligible.find((item) => item && !usedPlanKeys.has(keyOf(item))) ||
      fallbacks.find((item) => item && !usedPlanKeys.has(keyOf(item))) ||
      team.find((item) => item && !usedPlanKeys.has(keyOf(item))) ||
      fallbacks.find(Boolean) ||
      team[0];
    return mark(fallback);
  };
  const lead = mark(tailwind || trickRoom || rain || sun || sand || snow || pocketAgFindMember(team, [/lead-pair|fake out|击掌奇袭|speed-control|开局|首发/i]) || team[0]);
  const core = pickUnused([/primary-core|wallbreaker|破盾|输出|核心/i], [...requiredCore, team[0]]);
  const switcher = pickUnused([/defensive-switch|safe-entry|pivot|转场|轮转|联防|抗性/i], [team[1], team[0]]);
  const cleaner = pickUnused([/endgame-cleaner|终盘|收割|清场|priority/i], [team[team.length - 1], team[0]]);
  const support = pickUnused([/speed-control|protect|protection|fake out|follow me|rage powder|wide guard|守住|击掌奇袭|顺风|电磁波|戏法空间|冰冻之风|安全上场|safe-entry/i], [switcher, lead]);
  const leadName = lead ? lead.name || lead.id : "首发位";
  const coreName = requiredCore.length ? requiredCore.map((item) => item.name || item.slug || item.id).join("、") : core ? core.name || core.id : "核心";
  const switchName = switcher ? switcher.name || switcher.id : "轮转位";
  const cleanerName = cleaner ? cleaner.name || cleaner.id : "收割位";
  const supportName = support ? support.name || support.id : switchName;
  const goalClauses = [];
  if (requiredCore.length) goalClauses.push(`本队主轴首先围绕用户指定核心 ${coreName} 配置，不能被泛用高使用率成员挤掉。`);
  if (goalRequiresTailwind(payload)) goalClauses.push(`顺风控速手由 ${(tailwind || support || lead)?.name || "顺风手"} 启动顺风，主要服务 ${coreName} 和 ${cleanerName}；顺风被阻止时用 ${switchName} 轮转拖回合，并留 ${supportName} 做安全上场兜底。`);
  if (goalRequiresTheme(payload, "sun")) goalClauses.push(`晴天线由 ${(sun || support || lead)?.name || "晴天手"} 提供，放大 ${coreName} 的火力或中速进攻窗口；被抢天气时切回 ${switchName} 轮转，并保留 ${supportName} 做备用线。`);
  if (goalRequiresTheme(payload, "rain")) goalClauses.push(`雨天线由 ${(rain || support || lead)?.name || "雨天手"} 提供，服务水系压力或速度收益；被抢天气时保留 ${cleanerName} 的终盘路线，并让 ${supportName} 接管安全上场。`);
  if (goalRequiresTheme(payload, "trick-room")) goalClauses.push(`空间线由 ${(trickRoom || support || lead)?.name || "空间手"} 启动，服务低速高收益核心；非空间回合用守住/换入拖到下一次启动，${supportName} 负责接住失手回合。`);
  if (goalRequiresTheme(payload, "sand")) goalClauses.push(`沙暴线由 ${(sand || support || lead)?.name || "沙暴手"} 提供，服务拨沙/岩地耐久与终盘压制；天气被覆盖时用 ${switchName} 轮转，再交给 ${cleanerName} 收割。`);
  if (goalRequiresTheme(payload, "snow")) goalClauses.push(`雪天线由 ${(snow || support || lead)?.name || "雪天手"} 提供，服务极光幕、冰系压制或拨雪收益；天气被覆盖时由 ${supportName} 保护关键位并等待二次启动。`);
  const megaMembers = team.filter((item) => pocketAgIsMegaItem(item.item) || /Mega 位|Mega 核心|超级核心/i.test(String(item.role || "")));
  const megaCandidate = (payload.metaCandidates || []).find((item) => item.megaSlotCandidate);
  const megaClause =
    megaMembers.length > 1
      ? `本局只从 ${megaMembers.map((item) => item.name || item.id).join("、")} 中选择一个 Mega 作为主轴，另一个只作为对局备选分支；不能同局同时占用 Mega 资源。`
      : megaMembers.length === 1
        ? `本局 Mega 位是 ${megaMembers[0].name || megaMembers[0].id}，由 ${switchName} 的转场/联防与 ${supportName} 的控速/保护负责安全进场。`
      : megaCandidate
        ? `候选池有可用 Mega，但本局不硬凑；改由 ${coreName} / ${switchName} 形成主轴和副轴。`
        : "候选池没有明显可用 Mega，直接按当前主轴推进。";

  if (format === "double") {
    const lead2 = pocketAgFindMember(team.filter((item) => item !== lead), [/lead-pair|fake out|protect|守住|顺风|speed-control|support|protection/i]) || team[1] || lead;
    const lead2Name = lead2 ? lead2.name || lead2.id : leadName;
    return `${goalClauses.join("")}开局由 ${leadName} + ${lead2Name} 抢节奏并保护核心；中盘靠 ${switchName} 负责站场转换、${supportName} 负责控速/保护并覆盖 ${coreName} 的弱点，带出 ${coreName} 继续压制；终盘由 ${cleanerName} 收割。副轴/备用路线是 ${switchName} 轮转拖回合后交给 ${cleanerName} 清场。${megaClause}`;
  }
  return `${goalClauses.join("")}开局由 ${leadName} 建节奏或撒场；中盘由 ${switchName} 安全轮转并覆盖 ${coreName} 的弱点，带着 ${coreName} 找进场并打开突破口；终盘由 ${cleanerName} 收割，${supportName} 作为速度或保护兜底。副轴/备用路线是 ${switchName} 轮转拖回合后交给 ${cleanerName} 清场。${megaClause}`;
}

function pocketAgFormatWatch(team = [], format = "single", payload = {}) {
  const lead = (goalRequiresTailwind(payload) && team.find((item) => memberActuallySetsTailwind(item))) || pocketAgFindMember(team, [/lead-pair|fake out|戏法空间|击掌奇袭|speed-control|开局|首发/i]) || team[0];
  const core = pocketAgFindMember(team, [/primary-core|wallbreaker|破盾|输出|核心/i]) || team[0];
  const switcher = pocketAgFindMember(team, [/defensive-switch|safe-entry|pivot|转场|轮转|联防|抗性|安全上场/i]) || team[1] || team[0];
  const speed = team.find((item) => memberActuallySetsTailwind(item)) || pocketAgFindMember(team, [/speed-control|priority|戏法空间|电磁波|冰冻之风|黏黏网|trick room/i]) || lead;
  const protect = pocketAgFindMember(team, [/protect|protection|守住|击掌奇袭|fake out|follow me|rage powder|wide guard|看我嘛|愤怒粉/i]) || switcher;
  const cleaner = pocketAgFindMember(team, [/endgame-cleaner|终盘|收割|清场|priority/i]) || team[team.length - 1] || core;
  const target = Array.isArray(payload.intent?.targetPokemon) && payload.intent.targetPokemon.length
    ? payload.intent.targetPokemon[0]?.target?.name || payload.intent.targetPokemon[0]?.name || ""
    : "";
  const leadName = lead ? lead.name || lead.id : "首发位";
  const coreName = core ? core.name || core.id : "核心";
  const switchName = switcher ? switcher.name || switcher.id : "轮转位";
  const speedName = speed ? speed.name || speed.id : leadName;
  const protectName = protect ? protect.name || protect.id : switchName;
  const cleanerName = cleaner ? cleaner.name || cleaner.id : coreName;
  const lines = [
    `面对高速压制：先由 ${speedName} 控速或抢先手，再由 ${cleanerName} 收尾。`,
    `面对换入厚度或受队：先由 ${switchName} 换入/轮转，再由 ${coreName} 破盾打开局面。`,
    format === "double"
      ? `面对首发爆发或反首发：先用 ${leadName} + ${protectName} 稳住节奏，遇到对面先攻就切 ${switchName}。`
      : `面对首发爆发或反开局：先由 ${leadName} 抢节奏，必要时让 ${protectName} 保护或拖回合。`,
  ];
  if (goalRequiresTailwind(payload)) lines.push(`顺风主题下，${speedName} 是真实启动者，${protectName} 负责撑住首回合，${cleanerName} 吃顺风收益。`);
  if (goalRequiresTheme(payload, "rain")) lines.push(`雨天主题下，必须写清谁开雨、谁吃雨天收益、谁负责雨天失手后的接回。`);
  if (goalRequiresTheme(payload, "sun")) lines.push(`晴天主题下，必须写清谁开晴、谁接晴天回合、谁在天气被抢后续命。`);
  if (goalRequiresTheme(payload, "trick-room")) lines.push(`空间主题下，必须写清谁开空间、谁在空间里出手、谁把失手回合拖回下一次启动。`);
  if (goalRequiresTheme(payload, "sand")) lines.push(`沙暴主题下，必须写清谁开沙暴、谁吃沙暴收益、天气被覆盖后谁负责接回。`);
  if (goalRequiresTheme(payload, "snow")) lines.push(`雪天主题下，必须写清谁开雪天、谁吃雪天/极光幕收益、天气被覆盖后谁负责二次启动。`);
  if (target) {
    lines.push(`面对 ${target}：先由 ${switchName} / ${protectName} 接住，再由 ${cleanerName} 或 ${coreName} 逼退。`);
  }
  if (goalRequiresTailwind(payload)) lines.push(`顺风被挑衅或首回合倒下时：先守住/换入 ${switchName}，再找机会让 ${speedName} 二次控速。`);
  if (goalRequiresTheme(payload, "sun")) lines.push(`晴天被覆盖时：先用 ${switchName} 轮转吃伤害，再重新开晴天或改由 ${cleanerName} 终盘收割。`);
  if (goalRequiresTheme(payload, "rain")) lines.push(`雨天被覆盖时：先保留 ${speedName} 的控速回合，再用 ${coreName} 或 ${cleanerName} 接管。`);
  if (goalRequiresTheme(payload, "trick-room")) lines.push(`空间被阻止时：先用 ${protectName} 保护关键位，再让空间手重新启动或切换到非空间路线。`);
  if (goalRequiresTheme(payload, "sand")) lines.push(`沙暴被覆盖时：先用 ${switchName} 轮转吃伤害，再重新开沙或转入 ${cleanerName} 的终盘线。`);
  if (goalRequiresTheme(payload, "snow")) lines.push(`雪天被覆盖时：先用 ${protectName} 保护关键位，再让雪天手重新启动或切换到非雪天路线。`);
  const branchModel = payload.intent?.branchModel || payload.branchModel || {};
  const branch = Array.isArray(branchModel.missingBranches) && branchModel.missingBranches[0]?.label ? branchModel.missingBranches[0].label : "";
  if (branch) {
    lines.push(`面对 ${branch}：先由 ${leadName} 或 ${switchName} 处理开局，再由 ${coreName} 或 ${cleanerName} 接管。`);
  }
  return [...new Set(lines)].slice(0, 4);
}

function goalPlanSatisfied(text = "", payload = {}) {
  const joined = String(text || "");
  if (requiredGoalPokemon(payload).some((ref) => !new RegExp(String(ref.name || ref.slug || ref.id || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(joined))) return false;
  if (goalRequiresTailwind(payload) && !/顺风|tailwind|控速/i.test(joined)) return false;
  if (goalRequiresTheme(payload, "sun") && !/晴天|日照|大晴天|drought|sun/i.test(joined)) return false;
  if (goalRequiresTheme(payload, "rain") && !/雨天|降雨|求雨|drizzle|rain/i.test(joined)) return false;
  if (goalRequiresTheme(payload, "trick-room") && !/戏法空间|空间手|trick\s*room/i.test(joined)) return false;
  if (goalRequiresTheme(payload, "sand") && !/沙暴|扬沙|sandstorm|sand stream|sand/i.test(joined)) return false;
  if (goalRequiresTheme(payload, "snow") && !/雪天|雪景|降雪|snowscape|hail|snow/i.test(joined)) return false;
  return true;
}

function pocketAgRepairAdvice(advice, payload = {}, text = "") {
  const result = advice && typeof advice === "object" ? JSON.parse(JSON.stringify(advice)) : {};
  const formatSummary = [];
  const passChainGoal = goalRequiresPassChain(payload);
  const repairPool = Array.isArray(payload.metaCandidates) ? payload.metaCandidates : [];
  const passChainPoolHint = goalRequiresPassChain(payload) && !Array.isArray(payload.metaCandidates)
    ? false
    : repairPool.some((mon) => /接棒|baton pass|boost pass|强化接棒|传递强化/i.test(pocketAgTextBlob([mon.name, mon.slug, mon.commonMoves, mon.moves, mon.roleProfile, mon.supportProfile, mon.understandingReasons])));
  for (const format of ["single", "double"]) {
    const block = result[format] || {};
    const fallbackTeam = pocketAgSelectTeam(payload, format);
    let team = Array.isArray(block.team) ? block.team.slice(0, 6) : [];
    if (team.length < 6) {
      const fillTeam = fallbackTeam;
      const existing = new Set(team.map((item) => String(item.id || item.slug || item.name || "").toLowerCase()));
      for (const mon of fillTeam) {
        const key = String(mon.id || mon.slug || mon.name || "").toLowerCase();
        if (!key || existing.has(key)) continue;
        existing.add(key);
        team.push({ id: String(mon.id || ""), name: mon.name || mon.slug || "", role: pocketAgMemberRole(mon, format, team.length), item: "", ability: "", nature: "", evs: "", level: "50", moves: [], note: "" });
        if (team.length === 6) break;
      }
    }
    const looksGenericMember = (item = {}) => {
      const text = pocketAgTextKey(pocketAgMemberText(item));
      const name = pocketAgTextKey(item.name || item.id || item.slug || "");
      return (
        !text ||
        /^(a|b|c|d|e|f|m1|m2|m3|m4|m5|m6|member\d+|member|slot\d+|slot|core|lead|backup|support|filler|补位|成员\d*|主轴核心|双打协作位|功能位)$/.test(
          name,
        ) ||
        /^(补位|成员|filler|slot|member)$/i.test(item.role || "") ||
        /^(补位|成员|filler|slot|member)$/i.test(item.note || "") ||
        /^(补位|成员|filler|slot|member)$/i.test(item.item || "") ||
        !/[^\w\s]/.test(text) && text.length <= 10
      );
    };
    const concreteNotes = team.filter((item) => String(item.note || "").length >= 12 && /(负责|用来|帮助|覆盖|补|提供|保护|服务|压制|换入|收割|控速|撒场|反制|承担)/i.test(String(item.note || ""))).length;
    const meaningfulSignals = pocketAgTextBlob([team, block.plan || "", block.watch || []]).toLowerCase();
    const structureSignals = [
      /急速折返|伏特替换|抛下狠话|接棒|转场|轮转|安全上场|u-turn|volt switch|parting shot|pivot/i.test(meaningfulSignals),
      /顺风|电磁波|戏法空间|冰冻之风|黏黏网|tailwind|trick room|thunder wave|icy wind|sticky web/i.test(meaningfulSignals),
      /守住|protect|击掌奇袭|fake out|follow me|rage powder|wide guard/i.test(meaningfulSignals),
      /终盘|收割|清场|wincon|cleaner|late-game|sweep/i.test(meaningfulSignals),
      /隐形岩|撒菱|毒菱|黏黏网|stealth rock|spikes|toxic spikes|sticky web/i.test(meaningfulSignals),
      /自我再生|羽栖|偷懒|许愿|寄生种子|recover|roost|slack off|wish|leech seed|leftovers|regenerator/i.test(meaningfulSignals),
      /主轴|副轴|主胜利|备用|替代路线|第二路线|main|backup|secondary/i.test(meaningfulSignals),
    ].filter(Boolean).length;
    const weakPlan = !block.plan || /围绕当前核心补齐抗性|按当前队伍微调|建议队伍如下|当前队伍|补齐抗性、速度控制和收尾位/.test(String(block.plan || ""));
    const genericWatch = !Array.isArray(block.watch) || block.watch.length < 3 || block.watch.every((line) => /怕某某|建议重新生成|当前队伍|按当前队伍/.test(String(line)));
    const genericTeamCount = team.filter(looksGenericMember).length;
    const needsFullFallback =
      genericTeamCount >= 3 ||
      concreteNotes < 2 ||
      structureSignals < 2 ||
      (weakPlan && genericWatch) ||
      !team.some((item) => !looksGenericMember(item));
    if (needsFullFallback) {
      team = fallbackTeam.map((mon) => ({ ...mon, moves: Array.isArray(mon.moves) ? [...mon.moves] : [] }));
    } else {
      team = pocketAgStandardizeAdviceTeam(team, payload, format, fallbackTeam).map((item, index) => {
        const next = { ...item };
        if (!next.role || /补位|成员/.test(String(next.role || ""))) {
          next.role = pocketAgMemberRole(next, format, index);
        }
        if (!next.note || /承担主要输出、强化或收尾任务|按双打节奏补足守住、控速或站场协作|负责转场、钉子、控速或状态压制|补位/.test(String(next.note || ""))) {
          next.note = `${next.role}，负责${format === "double" ? "首发协作、控速、保护或站场" : "轮转、破盾、状态或终盘"}.`;
        }
        return next;
      });
    }
    const needsTailwind = goalRequiresTailwind(payload);
    const needsRain = goalRequiresTheme(payload, "rain");
    const needsSun = goalRequiresTheme(payload, "sun");
    const needsTrickRoom = goalRequiresTheme(payload, "trick-room");
    const needsSand = goalRequiresTheme(payload, "sand");
    const needsSnow = goalRequiresTheme(payload, "snow");
    const hasRealTailwind = team.some((item) => memberActuallySetsTailwind(item));
    const hasRealRain = team.some((item) => memberActuallySetsTheme(item, "rain"));
    const hasRealSun = team.some((item) => memberActuallySetsTheme(item, "sun"));
    const hasRealTrickRoom = team.some((item) => memberActuallySetsTheme(item, "trick-room"));
    const hasRealSand = team.some((item) => memberActuallySetsTheme(item, "sand"));
    const hasRealSnow = team.some((item) => memberActuallySetsTheme(item, "snow"));
    if (needsTailwind && !hasRealTailwind) {
      const setter = findTailwindCandidate(fallbackTeam, format, payload);
      if (setter) {
        const inserted = advicePokemon(setter, 0, format, payload);
        inserted.role = "顺风控速手";
        inserted.note = "真实顺风启动者，负责开顺风、撑住首回合，并把顺风收益交给核心和收割位。";
        team.unshift(inserted);
      }
    }
    if (needsRain && !hasRealRain) {
      const setter = findThemeCandidate(fallbackTeam, "rain", format);
      if (setter) {
        const inserted = advicePokemon(setter, 0, format, payload);
        inserted.role = "雨天启动手";
        inserted.note = "真实雨天来源，负责开雨、接回合，并让雨天收益位安全吃到天气窗口。";
        ensureMove(inserted, "求雨");
        team.unshift(inserted);
      }
    }
    if (passChainGoal) {
      const hasPasser = team.some((item) => /接棒|baton pass|boost pass|强化接棒|传递强化/i.test(pocketAgMemberText(item)));
      const hasReceiver = team.some((item) => /终盘|收割|清场|wincon|cleaner|主轴|核心|破盾/i.test(pocketAgMemberText(item)));
      const hasProtector = team.some((item) => /保护|守住|安全上场|转场|轮转|pivot|u-turn|volt switch|parting shot|fake out|follow me|rage powder/i.test(pocketAgMemberText(item)));
      if (!hasPasser) {
        const candidate = repairPool.find((mon) => /接棒|baton pass|boost pass|强化接棒|传递强化/i.test(pocketAgMemberText(advicePokemon(mon, 0, format, payload)))) || fallbackTeam.find((mon) => /接棒|baton pass|boost pass|强化接棒|传递强化/i.test(`${mon.name || ""} ${mon.slug || ""}`));
        if (candidate) {
          const inserted = advicePokemon(candidate, 0, format, payload);
          inserted.role = "接棒传递者";
          inserted.note = "负责传递强化并把加成送给接收者，不承担泛用输出职责。";
          team.unshift(inserted);
        }
      }
      if (!hasProtector) {
        const protector = fallbackTeam.find((mon) => /保护|守住|安全上场|转场|轮转|pivot|u-turn|volt switch|parting shot|fake out|follow me|rage powder/i.test(pocketAgMemberText(advicePokemon(mon, 0, format, payload)))) || repairPool.find((mon) => /保护|守住|安全上场|转场|轮转|pivot|u-turn|volt switch|parting shot|fake out|follow me|rage powder/i.test(pocketAgMemberText(advicePokemon(mon, 0, format, payload))));
        if (protector) {
          const inserted = advicePokemon(protector, 0, format, payload);
          inserted.role = "安全上场位";
          inserted.note = "负责给接棒/强化链争取安全回合，不能只写成普通补位。";
          team.splice(Math.min(1, team.length), 0, inserted);
        }
      }
      if (!hasReceiver) {
        const receiver = fallbackTeam.find((mon) => /终盘|收割|清场|wincon|cleaner|主轴|核心|破盾/i.test(pocketAgMemberText(advicePokemon(mon, 0, format, payload)))) || repairPool.find((mon) => /终盘|收割|清场|wincon|cleaner|主轴|核心|破盾/i.test(pocketAgMemberText(advicePokemon(mon, 0, format, payload))));
        if (receiver) {
          const inserted = advicePokemon(receiver, 0, format, payload);
          inserted.role = "接收强化终盘";
          inserted.note = "负责吃接棒后的强化并转成终盘胜点。";
          team.push(inserted);
        }
      }
      if (!passChainPoolHint) {
        block.watch = [
          `当前 Champions 候选池里几乎没有明确的接棒/强化传递成员，已改为最接近的合法链条替代。`,
          `这不是普通攻队思路；${team[0]?.name || "首发位"} 负责起手，${team[team.length - 1]?.name || "终盘位"} 负责吃强化并收尾。`,
          `若要更像真正接棒队，需要补入能传递强化的候选，而不是继续加泛用强单体。`,
        ];
      }
    }
    if (needsSun && !hasRealSun) {
      const setter = findThemeCandidate(fallbackTeam, "sun", format);
      if (setter) {
        const inserted = advicePokemon(setter, 0, format, payload);
        inserted.role = "晴天启动手";
        inserted.note = "真实晴天来源，负责开晴、接回合，并让晴天收益位拿到火力窗口。";
        ensureMove(inserted, "大晴天");
        team.unshift(inserted);
      }
    }
    if (needsTrickRoom && !hasRealTrickRoom) {
      const setter = findThemeCandidate(fallbackTeam, "trick-room", format);
      if (setter) {
        const inserted = advicePokemon(setter, 0, format, payload);
        inserted.role = "戏法空间手";
        inserted.note = "真实戏法空间手，负责开空间、拖慢对局节奏，并把低速核心送进出手窗口。";
        ensureMove(inserted, "戏法空间");
        team.unshift(inserted);
      }
    }
    if (needsSand && !hasRealSand) {
      const setter = findThemeCandidate(fallbackTeam, "sand", format);
      if (setter) {
        const inserted = advicePokemon(setter, 0, format, payload);
        inserted.role = "沙暴启动手";
        inserted.note = "真实沙暴来源，负责开沙、接回合，并让拨沙/岩地收益位安全吃到天气窗口。";
        ensureMove(inserted, "沙暴");
        team.unshift(inserted);
      }
    }
    if (needsSnow && !hasRealSnow) {
      const setter = findThemeCandidate(fallbackTeam, "snow", format);
      if (setter) {
        const inserted = advicePokemon(setter, 0, format, payload);
        inserted.role = "雪天启动手";
        inserted.note = "真实雪天来源，负责开雪景或降雪，服务极光幕、冰系压制或拨雪收益。";
        ensureMove(inserted, "雪景");
        team.unshift(inserted);
      }
    }
    team = enforceGoalConstraintsOnTeam(team, payload, format);
    const recentNames = new Set(pocketAgRecentGeneratedAvoidNames(payload, format).map((name) => String(name || "").toLowerCase()));
    if (recentNames.size) {
      team = team
        .sort((a, b) => {
          const aRequired = Number(requiredGoalPokemon(payload).some((ref) => pocketAgMemberMatches(a, ref)) || memberActuallySetsTailwind(a) || requestedThemeIds(payload).some((theme) => memberActuallySetsTheme(a, theme)));
          const bRequired = Number(requiredGoalPokemon(payload).some((ref) => pocketAgMemberMatches(b, ref)) || memberActuallySetsTailwind(b) || requestedThemeIds(payload).some((theme) => memberActuallySetsTheme(b, theme)));
          if (aRequired !== bRequired) return bRequired - aRequired;
          const aPenalty = recentNames.has(String(a.name || a.slug || a.id || "").toLowerCase()) ? 1 : 0;
          const bPenalty = recentNames.has(String(b.name || b.slug || b.id || "").toLowerCase()) ? 1 : 0;
          return aPenalty - bPenalty;
        })
        .slice(0, 6);
    }
    team = enforceGoalConstraintsOnTeam(team, payload, format);
    block.team = team;
    const plan = String(block.plan || "");
    const watch = Array.isArray(block.watch) ? block.watch.filter(Boolean) : [];
    const planNeedsGoalRewrite =
      !goalPlanSatisfied(`${plan} ${watch.join(" ")}`, payload) || (passChainGoal && !/接棒|baton pass|boost pass|强化接棒|传递强化/.test(`${plan} ${watch.join(" ")} ${team.map((item) => item.note || "").join(" ")}`));
    const planNeedsRewrite = planNeedsGoalRewrite || !plan || plan.length < 18 || /围绕当前核心补齐抗性|按当前队伍微调|建议队伍如下|当前队伍|补齐抗性、速度控制和收尾位/.test(plan);
    block.plan = planNeedsRewrite ? pocketAgFormatPlan(team, format, payload) : plan;
    const needsWatch = planNeedsGoalRewrite || watch.length < 3 || watch.every((line) => /怕某某|建议重新生成|当前队伍|按当前队伍/.test(String(line)));
    block.watch = needsWatch ? pocketAgFormatWatch(team, format, payload) : watch.slice(0, 4);
    result[format] = block;
    formatSummary.push(block.plan);
  }
  if (!result.summary || /围绕当前核心补齐抗性|按当前队伍微调|建议队伍如下|当前队伍/.test(String(result.summary || ""))) {
    const focus = payload.intent?.requestedFormat === "double" ? "double" : "single";
    result.summary = result[focus]?.plan || formatSummary.find(Boolean) || "本次优先补齐结构闭环与对局说明。";
  }
  return result;
}

function normalizedItem(value = "") {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function fallbackAdvice(payload, text) {
  const singleTeam = pocketAgSelectTeam(payload, "single");
  const doubleTeam = pocketAgSelectTeam(payload, "double");
  return pocketAgRepairAdvice({
    summary: firstUsefulLine(text),
    single: {
      team: singleTeam,
      plan: "",
      watch: [],
    },
    double: {
      team: doubleTeam,
      plan: "",
      watch: [],
    },
  }, payload, text);
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

function aiEndpoint(baseUrl, path, provider = "") {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1") || normalized.endsWith("/anthropic") || normalized.endsWith("/beta")) return `${normalized}${path}`;
  if (provider === "deepseek" || /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(normalized)) return `${normalized}${path}`;
  return `${normalized}/v1${path}`;
}

function fetchWithTimeout(url, options = {}, timeoutMs = AI_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function aiTimeoutMs(payload = {}) {
  return AI_REQUEST_TIMEOUTS_MS[payload.promptMode] || AI_REQUEST_TIMEOUT_MS;
}

function aiMaxTokens(payload = {}) {
  if (payload.promptMode === "compare") return 3600;
  if (payload.promptMode === "deep") return 3200;
  return 2200;
}

async function requestAI(aiConfig, payload, useJsonSchema) {
  const prompt = buildPrompt(payload);
  const timeoutMs = aiTimeoutMs(payload);
  const maxTokens = aiMaxTokens(payload);
  if (aiConfig.endpoint === "chat") {
    return fetchWithTimeout(aiEndpoint(aiConfig.baseUrl, "/chat/completions", aiConfig.source), {
      method: "POST",
      headers: {
        authorization: `Bearer ${aiConfig.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: maxTokens,
        response_format: useJsonSchema ? { type: "json_object" } : undefined,
      }),
    }, timeoutMs);
  }

  const body = {
    model: aiConfig.model,
    input: prompt,
    stream: false,
    max_output_tokens: maxTokens,
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

  return fetchWithTimeout(aiEndpoint(aiConfig.baseUrl, "/responses", aiConfig.source), {
    method: "POST",
    headers: {
      authorization: `Bearer ${aiConfig.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }, timeoutMs);
}

async function handleAI(req, res) {
  const payload = await readJson(req);
  const aiConfig = resolveRequestAIConfig(payload);
  if (!aiConfig) {
    sendJson(res, 501, {
      error: "缺少网页里的 AI 配置。请在页面里填写 API Key / Base URL / 模型后再试。",
    });
    return;
  }

  let response;
  let data;
  try {
    const useJsonSchemaFirst = aiConfig.endpoint !== "chat";
    response = await requestAI(aiConfig, payload, useJsonSchemaFirst);
    data = await readAIResponse(response);

    if (!response.ok && [400, 422].includes(response.status)) {
      response = await requestAI(aiConfig, payload, false);
      data = await readAIResponse(response);
    }
  } catch (err) {
    const timeoutSeconds = Math.round(aiTimeoutMs(payload) / 1000);
    sendJson(res, 502, {
      error: err.name === "AbortError" ? `AI 接口超过 ${timeoutSeconds} 秒未返回，已停止。本地服务正常，请检查 API Key、订阅、模型或网络。` : `AI 接口连接失败：${err.message || "请检查 Base URL、接口类型、网络或代理配置。"}`,
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
  const parsedAdvice = parseAdviceJson(text);
  const advice = parsedAdvice
    ? pocketAgRepairAdvice(normalizeAdviceItems(parsedAdvice), payload, text)
    : fallbackAdvice(payload, text);
  sendJson(res, 200, {
    model: aiConfig.model,
    provider: aiConfig.source,
    text,
    advice,
    parsed: Boolean(parsedAdvice),
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
    const response = await fetch(aiEndpoint(aiConfig.baseUrl, "/models", aiConfig.source), {
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

export {
  advicePokemon,
  fallbackAdvice,
  normalizeAdviceItems,
  goalHasCharizardTailwind,
  goalHasFireSunCore,
  goalRequiresTailwind,
  pocketAgFormatPlan,
  pocketAgFormatWatch,
  pocketAgRepairAdvice,
  pocketAgSelectTeam,
};

function startServer() {
  createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS" && req.url?.startsWith("/api/")) {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }
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
      if (req.method === "POST" && req.url === "/api/battle-eval") {
        await handleBattleEval(req, res);
        return;
      }
      if ((req.method === "GET" || req.method === "POST") && req.url === "/api/battle-history") {
        await handleBattleHistory(req, res);
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
    console.log(`AI requests use browser-provided config; default model hint: ${OPENAI_MODEL || "unset"}`);
    ensureInitialData();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startServer();
}

