import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { ruleRegistry, RuleRegistryError } from "./server/rules-registry.mjs";
import { showdownAccount } from "./server/showdown-account.mjs";
import { agentController } from "./server/agent-controller.mjs";
import { mergePokecampTeams, normalizePokecampPayload, repairPokecampTeam } from "./server/pokecamp-teams.mjs";

const ROOT = resolve(".");
const require = createRequire(import.meta.url);
const { BattleStream, Dex, TeamValidator, Teams, getPlayerStreams } = require("pokemon-showdown");
const PORT = Number(process.env.PORT || 4174);
const RULE_SYNC_INTERVAL_MS = Number(process.env.RULE_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000);
const BATTLE_HISTORY_PATH = join(ROOT, "data", "battle-history.json");
const TEAM_DATA_PATH = join(ROOT, "data", "team-data.json");
const CHAMPION_DATA_PATH = join(ROOT, "data", "champion-data.json");
const BATTLE_KNOWLEDGE_DATA_PATH = join(ROOT, "data", "battle-knowledge.json");
const POKECAMP_REFERENCE_DATA_PATH = join(ROOT, "data", "pokecamp-reference.json");
const POKECAMP_MONITOR_STATE_PATH = join(ROOT, "data", "pokecamp-monitor.json");
const AGENT_DATA_ROOT = resolve(process.env.AGENT_DATA_ROOT || join(ROOT, "data", "agent"));
const AGENT_LEARNING_ROOT = join(AGENT_DATA_ROOT, "learning");
const TEAM_LAB_ROOT = join(AGENT_DATA_ROOT, "team-lab");
const ZH_HANS_TERMS_PATH = join(ROOT, "data", "zh-hans-terms.json");
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
const showdownImportBridge = new Map();
const strictCandidateLegalityCache = new Map();
const rulesCandidatePoolCache = new Map();
const officialRegulationPoolCache = new Map();
const referenceTermCache = new Map();
let pokecampReferenceWriteTask = Promise.resolve();
const OFFICIAL_REGULATION_POOL_SOURCES = {
  "M-A": {
    announcementUrl: "https://news.pokemon-home.com/sc/page/751.html",
    sourceUrl: "https://web-view.app.pokemonchampions.jp/battle/pages/events/rs177501629259kmzbny/sc/pokemon.html",
  },
  "M-B": {
    announcementUrl: "https://news.pokemon-home.com/sc/page/776.html",
    sourceUrl: "https://web-view.app.pokemonchampions.jp/battle/pages/events/rs178066986988lmoqpm/sc/pokemon.html",
  },
};
const POKEMON_REFERENCE_URL = "https://wiki.52poke.com/wiki/宝可梦列表（按全国图鉴编号）";
const POKECAMP_REFERENCE_SOURCES = {
  pokemon: "https://pokecamp.cc/zh/pokemon",
  moves: "https://pokecamp.cc/zh/moves",
  abilities: "https://pokecamp.cc/zh/abilities",
  items: "https://pokecamp.cc/zh/items",
};
const SHOWDOWN_BRIDGE_PROFILE_PATH = join(ROOT, ".cache", "showdown-bridge-browser");
const POKECAMP_BROWSER_PROFILE_PATH = join(ROOT, ".cache", "pokecamp-browser");
let showdownBridgeContext = null;
let showdownBridgePage = null;
let pokecampBrowserContext = null;
let pokecampBrowserPage = null;
let lastPokecampCrawlPayload = null;
let pokecampReferenceData = readPokecampReferenceData();
let pokecampBrowserState = {
  status: "CLOSED",
  pageUrl: "",
  pageTitle: "",
  browser: "",
  challenge: false,
  lastReadAt: "",
  lastError: "",
  extracted: { scripts: 0, teams: 0 },
  crawl: { status: "IDLE", sourcePageType: "", page: 0, pages: 0, teams: 0, details: 0, errors: 0, startedAt: "", finishedAt: "", lastError: "" },
};
const POKECAMP_MONITOR_SOURCES = [
  { id: "vgc-teams", label: "VGC 队伍页", url: "https://pokecamp.cc/zh/champions/vgc-teams", sourcePageType: "vgc-teams", format: "double" },
  { id: "team-builds-single", label: "队伍构筑 · 单打", url: "https://pokecamp.cc/zh/champions/team-builds", sourcePageType: "team-builds-single", format: "single" },
  { id: "team-builds-double", label: "队伍构筑 · 双打", url: "https://pokecamp.cc/zh/champions/team-builds", sourcePageType: "team-builds-double", format: "double" },
];
const defaultPokecampMonitorState = () => ({
  enabled: false,
  intervalMinutes: 360,
  pages: 3,
  sources: POKECAMP_MONITOR_SOURCES.map((source) => source.id),
  status: "STOPPED",
  lastRunAt: "",
  lastCompletedAt: "",
  nextRunAt: "",
  lastError: "",
  lastResult: null,
});
function readPokecampMonitorState() {
  try {
    const saved = JSON.parse(readFileSync(POKECAMP_MONITOR_STATE_PATH, "utf8"));
    return { ...defaultPokecampMonitorState(), ...saved, sources: Array.isArray(saved.sources) && saved.sources.length ? saved.sources : defaultPokecampMonitorState().sources };
  } catch {
    return defaultPokecampMonitorState();
  }
}
let pokecampMonitorState = readPokecampMonitorState();
let pokecampMonitorTimer = null;
let pokecampMonitorRunning = false;
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

async function handleRulesApi(req, res) {
  if (req.method === "POST") {
    const state = await ruleRegistry.sync();
    sendJson(res, 200, { ok: true, ...state });
    return;
  }
  const state = ruleRegistry.publicState();
  if (req.url === "/api/rules/history") {
    sendJson(res, 200, {
      ok: true,
      status: state.status,
      canOperate: state.canOperate,
      history: state.history,
      lastSyncAt: state.lastSyncAt,
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    status: state.status,
    canOperate: state.canOperate,
    active: state.active,
    differences: state.differences,
    lastSyncAt: state.lastSyncAt,
    sourceUrl: state.sourceUrl,
    showdownCommit: state.showdownCommit,
  });
}

async function handleAccountApi(req, res) {
  if (req.method === "GET") {
    sendJson(res, 200, { ok: true, ...showdownAccount.publicState() });
    return;
  }
  if (req.method === "DELETE") {
    sendJson(res, 200, { ok: true, ...(await showdownAccount.clear()) });
    return;
  }
  const body = await readJson(req).catch(() => ({}));
  if (req.url === "/api/agent/account/bootstrap") {
    sendJson(res, 202, { ok: true, ...(await showdownAccount.bootstrap(body)) });
    return;
  }
  if (req.url === "/api/agent/account/continue") {
    sendJson(res, 200, { ok: true, ...(await showdownAccount.continue()) });
    return;
  }
  if (req.url === "/api/agent/account/focus") {
    sendJson(res, 200, { ok: true, ...(await showdownAccount.focus()) });
    return;
  }
  if (req.url === "/api/agent/account/rotate-pending") {
    sendJson(res, 200, { ok: true, ...(await showdownAccount.rotatePendingCredential()) });
    return;
  }
  if (req.url === "/api/agent/account/reconcile") {
    sendJson(res, 200, { ok: true, ...(await showdownAccount.reconcileRegisteredAccount()) });
    return;
  }
  sendJson(res, 404, { ok: false, error: "Unknown account endpoint." });
}

async function persistPokecampCrawlPayload(payload, options = {}) {
  const sourcePageType = String(options.sourcePageType || payload?.sourcePageType || "vgc-teams").trim();
  const format = options.format === "single" ? "single" : options.format === "double" ? "double" : sourcePageType.includes("single") ? "single" : "double";
  const imported = normalizePokecampPayload(payload, {
    sourcePageType,
    format,
    season: String(options.season || "").trim(),
    regulation: String(options.regulation || "").trim(),
    rulesetId: String(options.rulesetId || "").trim(),
  });
  if (!imported.teams.length) return { ok: false, code: "POKECAMP_NO_TEAMS", error: "抓取结果没有可导入队伍。", imported: { added: 0, updated: 0, total: 0 } };
  const document = readTeamDataDocument();
  const merged = mergePokecampTeams(document, imported);
  const sourceKey = (team) => [String(team?.source || "").toLowerCase(), String(team?.sourcePageType || ""), String(team?.season || team?.regulation || ""), String(team?.title || "")].join("::");
  const memberKey = (team) => (team?.members || []).map((member) => String(member?.name || member?.localizedName || member?.slug || "").replace(/\s+/g, "").toLowerCase()).join("|");
  const fingerprint = (team) => createHash("sha1").update(JSON.stringify({
    title: team?.title,
    sourcePageType: team?.sourcePageType,
    format: team?.format,
    season: team?.season,
    regulation: team?.regulation,
    rentalCode: team?.rentalCode,
    members: memberKey(team),
    detailStatus: team?.detailStatus,
    strategy: team?.strategy,
    configurations: (team?.configurations || []).map((configuration) => ({ name: configuration?.name, item: configuration?.item, ability: configuration?.ability, nature: configuration?.nature, stats: configuration?.stats, actualStats: configuration?.actualStats, moves: configuration?.moves, notes: configuration?.notes })),
  })).digest("hex");
  const changed = imported.teams.reduce((count, team) => {
    const previous = (document.teams || []).find((candidate) => String(candidate.id) === String(team.id) || sourceKey(candidate) === sourceKey(team) || (sourceKey(candidate).replace(/::[^:]*$/, "") === sourceKey(team).replace(/::[^:]*$/, "") && memberKey(candidate) === memberKey(team)));
    if (!previous) return count;
    const current = (merged.teams || []).find((candidate) => String(candidate.id) === String(previous.id) || sourceKey(candidate) === sourceKey(team));
    return current && fingerprint(previous) !== fingerprint(current) ? count + 1 : count;
  }, 0);
  await writeFile(TEAM_DATA_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return {
    ok: true,
    source: "PokéCamp",
    imported: { ...merged.imported, updated: changed },
    totalTeams: merged.teams.length,
    formats: { single: merged.teams.filter((team) => team.format === "single").length, double: merged.teams.filter((team) => team.format === "double").length },
    sourcePageType,
    crawl: { teams: payload?.teams?.length || 0, sourcePageType: payload?.sourcePageType || sourcePageType },
  };
}

async function writePokecampMonitorState() {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(POKECAMP_MONITOR_STATE_PATH, `${JSON.stringify(pokecampMonitorState, null, 2)}\n`, "utf8");
}

function pokecampMonitorSnapshot() {
  return {
    ok: true,
    ...pokecampMonitorState,
    running: pokecampMonitorRunning,
    sources: POKECAMP_MONITOR_SOURCES.map((source) => ({ ...source, enabled: pokecampMonitorState.sources.includes(source.id) })),
    browser: pokecampBrowserSnapshot(),
  };
}

function schedulePokecampMonitor() {
  if (pokecampMonitorTimer) clearInterval(pokecampMonitorTimer);
  pokecampMonitorTimer = null;
  if (!pokecampMonitorState.enabled) return;
  const intervalMs = Math.max(15, Number(pokecampMonitorState.intervalMinutes) || 360) * 60_000;
  pokecampMonitorState.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  pokecampMonitorTimer = setInterval(() => { runPokecampMonitor().catch((error) => console.error(`PokéCamp monitor failed: ${error.message}`)); }, intervalMs);
  pokecampMonitorTimer.unref();
}

async function runPokecampMonitor() {
  if (pokecampMonitorRunning) return pokecampMonitorSnapshot();
  pokecampMonitorRunning = true;
  const startedAt = new Date().toISOString();
  let scanned = 0;
  let added = 0;
  let updated = 0;
  let details = 0;
  const failures = [];
  pokecampMonitorState = { ...pokecampMonitorState, status: "RUNNING", lastRunAt: startedAt, lastError: "", lastResult: null };
  await writePokecampMonitorState().catch(() => undefined);
  try {
    for (const source of POKECAMP_MONITOR_SOURCES.filter((item) => pokecampMonitorState.sources.includes(item.id))) {
      const opened = await launchPokecampBrowser(source.url);
      if (!opened.ok || opened.challenge) {
        failures.push({ source: source.id, error: opened.error || "等待 PokéCamp 人工验证" });
        break;
      }
      const switched = await setPokecampFormat(source.format);
      if (!switched.ok) { failures.push({ source: source.id, error: switched.error || "赛制切换失败" }); continue; }
      const crawled = await crawlPokecampCurrentPage({ maxPages: pokecampMonitorState.pages, sourcePageType: source.sourcePageType });
      if (!crawled.ok) { failures.push({ source: source.id, error: crawled.error || "抓取失败" }); continue; }
      const imported = await persistPokecampCrawlPayload(crawled.payload, { sourcePageType: source.sourcePageType, format: source.format, season: "M-B", regulation: "M-B" });
      if (!imported.ok) { failures.push({ source: source.id, error: imported.error }); continue; }
      scanned += imported.crawl.teams;
      added += imported.imported.added;
      updated += imported.imported.updated;
      details += crawled.preview?.details || 0;
    }
    const completedAt = new Date().toISOString();
    const success = failures.length === 0;
    pokecampMonitorState = {
      ...pokecampMonitorState,
      status: success ? "IDLE" : "WAITING_OR_FAILED",
      lastCompletedAt: completedAt,
      lastError: failures.map((item) => `${item.source}: ${item.error}`).join("；"),
      lastResult: { scanned, added, updated, details, failures, startedAt, completedAt },
    };
  } finally {
    pokecampMonitorRunning = false;
    schedulePokecampMonitor();
    await writePokecampMonitorState().catch(() => undefined);
  }
  return pokecampMonitorSnapshot();
}

async function handlePokecampMonitorApi(req, res) {
  const url = new URL(req.url || "/api/pokecamp/monitor/status", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname.endsWith("/status")) { sendJson(res, 200, pokecampMonitorSnapshot()); return; }
  if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "未知的 PokéCamp 监听接口。" }); return; }
  const body = await readJson(req).catch(() => ({}));
  if (url.pathname.endsWith("/stop")) {
    pokecampMonitorState = { ...pokecampMonitorState, enabled: false, status: "STOPPED", nextRunAt: "" };
    schedulePokecampMonitor();
    await writePokecampMonitorState();
    sendJson(res, 200, pokecampMonitorSnapshot());
    return;
  }
  if (url.pathname.endsWith("/run")) { sendJson(res, 202, { ...pokecampMonitorSnapshot(), accepted: true }); runPokecampMonitor().catch((error) => console.error(`PokéCamp monitor failed: ${error.message}`)); return; }
  if (url.pathname.endsWith("/start")) {
    const sources = Array.isArray(body.sources) ? body.sources.filter((id) => POKECAMP_MONITOR_SOURCES.some((source) => source.id === id)) : pokecampMonitorState.sources;
    pokecampMonitorState = { ...pokecampMonitorState, enabled: true, status: "IDLE", intervalMinutes: Math.max(15, Math.min(1440, Number(body.intervalMinutes || pokecampMonitorState.intervalMinutes || 360))), pages: Math.max(1, Math.min(30, Number(body.pages || pokecampMonitorState.pages || 3))), sources: sources.length ? sources : POKECAMP_MONITOR_SOURCES.map((source) => source.id) };
    schedulePokecampMonitor();
    await writePokecampMonitorState();
    sendJson(res, 202, { ...pokecampMonitorSnapshot(), accepted: true });
    runPokecampMonitor().catch((error) => console.error(`PokéCamp monitor failed: ${error.message}`));
    return;
  }
  sendJson(res, 404, { ok: false, error: "未知的 PokéCamp 监听接口。" });
}

async function handlePokecampTeamImport(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "仅支持 POST 导入 PokéCamp 队伍数据。" });
    return;
  }
  const body = await readJson(req).catch(() => ({}));
  const payload = body.payload ?? body.data ?? body.teams ?? body.items ?? body;
  let imported;
  try {
    imported = normalizePokecampPayload(payload, {
      format: body.format === "double" ? "double" : body.format === "single" ? "single" : "",
      season: String(body.season || "").trim(),
      regulation: String(body.regulation || "").trim(),
      rulesetId: String(body.rulesetId || "").trim(),
      sourcePageType: String(body.sourcePageType || "").trim(),
    });
  } catch (error) {
    sendJson(res, 422, { ok: false, code: "POKECAMP_PAYLOAD_INVALID", error: `PokéCamp 数据无法解析：${error.message || "JSON 格式错误"}` });
    return;
  }
  if (!imported.teams.length) {
    sendJson(res, 422, { ok: false, code: "POKECAMP_NO_TEAMS", error: "没有识别到包含至少 3 只宝可梦且带单双打标记的队伍。请导入页面导出的 JSON，或补充 format 字段。" });
    return;
  }
  const document = readTeamDataDocument();
  const merged = mergePokecampTeams(document, imported);
  await writeFile(TEAM_DATA_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  sendJson(res, 200, {
    ok: true,
    source: "PokéCamp",
    imported: merged.imported,
    totalTeams: merged.teams.length,
    formats: { single: merged.teams.filter((team) => team.format === "single").length, double: merged.teams.filter((team) => team.format === "double").length },
    seasons: merged.availableSeasons,
    sourcePages: ["https://pokecamp.cc/zh/champions/vgc-teams", "https://pokecamp.cc/zh/champions/team-builds"],
  });
}

function handlePokecampTeamsApi(req, res) {
  const url = new URL(req.url || "/api/pokecamp/teams", "http://127.0.0.1");
  const document = readTeamDataDocument();
  const allTeams = Array.isArray(document?.teams) ? document.teams : [];
  const source = String(url.searchParams.get("source") || "pokecamp").trim().toLowerCase();
  const format = String(url.searchParams.get("format") || "all").trim().toLowerCase();
  const pageType = String(url.searchParams.get("pageType") || "all").trim().toLowerCase();
  const search = String(url.searchParams.get("search") || "").trim().toLowerCase();
  const pageSize = Math.max(1, Math.min(48, Number(url.searchParams.get("pageSize") || 24)));
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const filtered = allTeams.filter((team) => {
    const isPokecamp = String(team.source || "").toLowerCase().includes("pokecamp");
    if (source === "pokecamp" && !isPokecamp) return false;
    if (pageType === "vgc-teams" && team.sourcePageType !== "vgc-teams") return false;
    if (pageType === "team-builds" && !String(team.sourcePageType || "").startsWith("team-builds")) return false;
    if (format !== "all" && team.format !== format) return false;
    if (!search) return true;
    const haystack = [team.title, team.source, team.season, team.regulation, ...(team.members || []).flatMap((member) => [member.name, member.localizedName, member.slug])]
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(search);
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const teams = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((team) => {
    const repaired = repairPokecampTeam(team);
    const quality = (configurations = []) => (configurations || []).reduce((score, configuration) => score + [configuration.item, configuration.ability, configuration.nature, configuration.stats, configuration.moves?.length].filter(Boolean).length, 0);
    const sourceConfigurations = repaired.configurations?.length >= Math.min(6, team.members?.length || 0)
      ? repaired.configurations
      : (quality(repaired.configurations) > quality(team.configurations) ? repaired.configurations : team.configurations);
    const strategy = pokecampStrategySummary(team);
    const configurations = Array.isArray(sourceConfigurations) ? sourceConfigurations.slice(0, 6).map((configuration) => {
      const cleanConfiguration = cleanStoredPokecampConfiguration(configuration);
      return {
        name: cleanConfiguration.name,
        item: cleanConfiguration.item,
        ability: cleanConfiguration.ability,
        abilities: cleanConfiguration.abilities,
        abilityTransition: cleanConfiguration.abilityTransition,
        nature: cleanConfiguration.nature,
        stats: cleanConfiguration.stats,
        actualStats: cleanConfiguration.actualStats,
        teraType: cleanConfiguration.teraType,
        role: cleanConfiguration.role,
        moves: cleanConfiguration.moves,
        notes: cleanConfiguration.notes,
        noteLinks: cleanConfiguration.noteLinks,
        references: cleanConfiguration.references,
      };
    }) : [];
    const hasConfigurationNotes = configurations.some((configuration) => configuration.notes?.some((note) => String(note).replace(/\s+/g, "").length >= 20));
    const hasTeamDetails = Object.values(team.details || {}).some((value) => Array.isArray(value) && value.some((item) => String(item || "").replace(/\s+/g, "").length >= 8));
    const configurationStrategyBlocks = configurations.flatMap((configuration) => {
      const note = (configuration.notes || []).join(" ").replace(/^使用方法、详细：\s*/i, "").trim();
      if (note.replace(/\s+/g, "").length < 20) return [];
      return [
        { type: "heading", text: `${configuration.name || "宝可梦"} · 配置思路` },
        { type: "paragraph", text: note },
      ];
    });
    const effectiveStrategyBlocks = strategy.complete && strategy.blocks.length ? strategy.blocks : configurationStrategyBlocks;
    const effectiveStrategyText = strategy.complete ? strategy.text : configurationStrategyBlocks.filter((block) => block.type === "paragraph").map((block) => block.text).join("\n\n");
    return {
    id: team.id,
    title: team.title,
    source: team.source,
    sourcePageType: team.sourcePageType,
    detailStatus: team.detailStatus || "UNKNOWN",
    format: team.format,
    formatLabel: team.formatLabel,
    season: team.season,
    regulation: team.regulation,
    rate: team.rate,
    rank: team.rank,
    author: team.author,
    href: team.href || team.articleUrl || team.sourceUrl,
    description: team.description,
    strategy: team.strategy,
      strategyText: effectiveStrategyText,
      strategyBlocks: effectiveStrategyBlocks,
      strategyLinks: mergePokecampLinks(strategy.links, pokecampConfigurationLinks(configurations, team.members || [])),
      strategyTitle: strategy.headline,
      strategyPublished: strategy.published,
      strategyAuthor: strategy.authorHandle,
      strategyComplete: strategy.complete,
      strategyAvailable: strategy.complete || hasConfigurationNotes || hasTeamDetails,
      strategySource: strategy.complete ? "article" : configurationStrategyBlocks.length ? "configuration-notes" : hasTeamDetails ? "team-details" : strategy.source,
    members: Array.isArray(team.members) ? team.members.slice(0, 6).map((member) => {
      const spriteCandidates = pokecampSpriteCandidates(member);
      const baseValue = String(member.name || member.localizedName || member.slug || "").replace(/^超级\s*/i, "").replace(/\s*[（(]?[XYＸＹ][）)]?$/i, "").trim();
      const speciesSlug = pokecampSpriteSlug(member.name || member.localizedName || member.slug) || pokecampSpriteSlug(baseValue);
      return {
        id: member.id,
        name: member.name || member.localizedName || member.slug,
        localizedName: member.localizedName,
        slug: member.slug,
        sprite: member.sprite || spriteCandidates[0] || "",
        spriteCandidates,
        types: strictTypesFor(speciesSlug || baseValue).map((type) => CANDIDATE_TYPE_LABELS[type] || type),
        item: member.item,
      };
    }) : [],
    configurations,
    details: team.details || {},
    };
  });
  const formatCounts = {
    all: allTeams.filter((team) => String(team.source || "").toLowerCase().includes("pokecamp")).length,
    single: allTeams.filter((team) => String(team.source || "").toLowerCase().includes("pokecamp") && team.format === "single").length,
    double: allTeams.filter((team) => String(team.source || "").toLowerCase().includes("pokecamp") && team.format === "double").length,
  };
  sendJson(res, 200, {
    ok: true,
    source: "PokéCamp",
    fetchedAt: document.fetchedAt || "",
    total: filtered.length,
    totalAll: formatCounts.all,
    formatCounts,
    page: currentPage,
    pageSize,
    totalPages,
    pageType,
    pageTypeCounts: {
      all: formatCounts.all,
      vgc: allTeams.filter((team) => String(team.source || "").toLowerCase().includes("pokecamp") && team.sourcePageType === "vgc-teams").length,
      builds: allTeams.filter((team) => String(team.source || "").toLowerCase().includes("pokecamp") && String(team.sourcePageType || "").startsWith("team-builds")).length,
    },
    teams,
  });
}

async function importLatestPokecampCrawl(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "仅支持 POST 导入最近一次 PokéCamp 抓取结果。" });
    return;
  }
  if (!lastPokecampCrawlPayload?.teams?.length) {
    sendJson(res, 404, { ok: false, code: "POKECAMP_NO_CRAWL", error: "暂无可导入的抓取结果。请先完成抓取。" });
    return;
  }
  const body = await readJson(req).catch(() => ({}));
  const sourcePageType = String(body.sourcePageType || lastPokecampCrawlPayload.sourcePageType || "vgc-teams").trim();
  const format = body.format === "single" ? "single" : body.format === "double" ? "double" : sourcePageType.includes("single") ? "single" : "double";
  const result = await persistPokecampCrawlPayload(lastPokecampCrawlPayload, {
    sourcePageType,
    format,
    season: String(body.season || "").trim(),
    regulation: String(body.regulation || "").trim(),
    rulesetId: String(body.rulesetId || "").trim(),
  });
  if (!result.ok) {
    sendJson(res, 422, { ok: false, code: result.code, error: result.error, preview: { rawTeams: lastPokecampCrawlPayload.teams.length, sourcePageType, format } });
    return;
  }
  sendJson(res, 200, result);
}

function pokecampBrowserSnapshot() {
  return { ok: true, ...pokecampBrowserState, open: Boolean(pokecampBrowserContext && !pokecampBrowserPage?.isClosed()) };
}

function pokecampChallengePage(title = "", body = "") {
  return /just a moment|checking your browser|verify you are human|cf-chl|cloudflare|正在进行安全验证|安全服务防护|请稍候/i.test(`${title}\n${body}`);
}

async function launchPokecampBrowser(url = "") {
  const executable = await localShowdownBrowserExecutable();
  if (!executable) return { ok: false, status: 503, error: "未找到可用于读取 PokéCamp 的 Chrome 或 Edge 浏览器。" };
  try {
    const { chromium } = await import("playwright");
    await mkdir(POKECAMP_BROWSER_PROFILE_PATH, { recursive: true });
    if (!pokecampBrowserContext || !pokecampBrowserContext.pages) {
      pokecampBrowserContext = await chromium.launchPersistentContext(POKECAMP_BROWSER_PROFILE_PATH, {
        headless: false,
        executablePath: executable,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
      pokecampBrowserContext.on("close", () => {
        pokecampBrowserContext = null;
        pokecampBrowserPage = null;
        pokecampBrowserState = { ...pokecampBrowserState, status: "CLOSED", challenge: false };
      });
    }
    pokecampBrowserPage = pokecampBrowserPage && !pokecampBrowserPage.isClosed()
      ? pokecampBrowserPage
      : await pokecampBrowserContext.newPage();
    const target = /^https:\/\/pokecamp\.cc\/zh\/(?:champions\/(?:vgc-teams|team-builds)|pokemon|moves|abilities|items)(?:[/?#]|$)/i.test(url)
      ? url
      : "https://pokecamp.cc/zh/champions/vgc-teams";
    await pokecampBrowserPage.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    const info = await pokecampBrowserPage.evaluate(() => ({ title: document.title, body: document.body?.innerText || "", url: location.href }));
    const challenge = pokecampChallengePage(info.title, info.body);
    pokecampBrowserState = {
      ...pokecampBrowserState,
      status: challenge ? "WAITING_FOR_HUMAN_VERIFICATION" : "READY_TO_READ",
      pageUrl: info.url,
      pageTitle: info.title,
      browser: executable.toLowerCase().includes("msedge") ? "Edge" : "Chrome",
      challenge,
      lastError: "",
    };
    return pokecampBrowserSnapshot();
  } catch (error) {
    pokecampBrowserState = { ...pokecampBrowserState, status: "FAILED", lastError: error.message || "浏览器启动失败" };
    return { ok: false, status: 503, error: pokecampBrowserState.lastError };
  }
}

async function readPokecampBrowser() {
  if (!pokecampBrowserPage || pokecampBrowserPage.isClosed()) return { ok: false, status: 409, error: "PokéCamp 浏览器尚未打开。" };
  try {
    const extracted = await pokecampBrowserPage.evaluate(() => {
      const text = document.body?.innerText || "";
      const json = [];
      for (const node of document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__, script')) {
        const value = node.textContent?.trim();
        if (!value || value.length < 20 || value.length > 8_000_000) continue;
        try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object") json.push(parsed); } catch { /* public script may not be JSON */ }
      }
      const links = [...document.querySelectorAll("a")].map((node) => ({ title: node.textContent?.trim(), href: node.href })).filter((item) => item.title || item.href);
      const pokemonLinks = links.filter((item) => /\/zh\/champions\/pokemon\//i.test(item.href || "") && item.title);
      const format = /\u53cc\u6253|\bVGC\b/i.test(text) ? "double" : /\u5355\u6253|\bBSS\b/i.test(text) ? "single" : "";
      const regulation = (text.match(/\u8d5b\u5236\s*([A-Z]-[A-Z0-9]+)/i) || [])[1] || "";
      const domTeams = [];
      for (let index = 0; index + 5 < pokemonLinks.length; index += 6) {
        const members = pokemonLinks.slice(index, index + 6).map((item) => ({ name: item.title, localizedName: item.title, href: item.href }));
        domTeams.push({ title: `PokéCamp ${regulation || "team"} #${Math.floor(index / 6) + 1}`, format, season: regulation, regulation, sourcePage: location.href, sourceUrl: location.href, members });
      }
      return { title: document.title, url: location.href, text: text.slice(0, 500_000), json, links, domTeams };
    });
    if (pokecampChallengePage(extracted.title, extracted.text)) {
      pokecampBrowserState = { ...pokecampBrowserState, status: "WAITING_FOR_HUMAN_VERIFICATION", challenge: true, pageTitle: extracted.title, pageUrl: extracted.url, lastError: "仍处于 Cloudflare 验证页，请完成验证后再读取。" };
      return { ok: false, status: 409, code: "WAITING_FOR_HUMAN_VERIFICATION", error: pokecampBrowserState.lastError, state: pokecampBrowserSnapshot() };
    }
    const payload = { sourcePage: extracted.url, title: extracted.title, pageText: extracted.text, links: extracted.links, pageData: extracted.domTeams.length ? { teams: extracted.domTeams } : extracted.json };
    let imported;
    try {
      imported = normalizePokecampPayload(extracted.domTeams.length ? { teams: extracted.domTeams } : extracted.json, { sourcePageType: /team-builds/i.test(extracted.url) ? "team-builds" : "vgc-teams" });
    } catch { imported = { teams: [] }; }
    pokecampBrowserState = { ...pokecampBrowserState, status: imported.teams.length ? "DATA_READY" : "READY_TO_READ", challenge: false, lastReadAt: new Date().toISOString(), extracted: { scripts: extracted.json.length, teams: imported.teams.length }, pageTitle: extracted.title, pageUrl: extracted.url, lastError: imported.teams.length ? "" : "页面已读取，但未发现可导入的结构化队伍数据。" };
    return { ok: true, state: pokecampBrowserSnapshot(), payload, preview: { teams: imported.teams.length, scripts: extracted.json.length, pageUrl: extracted.url } };
  } catch (error) {
    pokecampBrowserState = { ...pokecampBrowserState, status: "FAILED", lastError: error.message || "页面读取失败" };
    return { ok: false, status: 503, error: pokecampBrowserState.lastError, state: pokecampBrowserSnapshot() };
  }
}

async function debugPokecampBrowser() {
  if (!pokecampBrowserPage || pokecampBrowserPage.isClosed()) return { ok: false, status: 409, error: "PokéCamp 浏览器尚未打开。" };
  const data = await pokecampBrowserPage.evaluate(() => {
    const visible = (node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
    const exact = [...document.querySelectorAll("body *")].filter((node) => visible(node) && /^(查看.*详情|添加到我的队伍|More pages|下一页|下一頁|单打|双打)$/.test((node.textContent || "").trim())).slice(-80).map((node) => ({ tag: node.tagName, text: (node.textContent || "").trim(), role: node.getAttribute("role"), cls: String(node.className || "").slice(0, 180), html: node.outerHTML.slice(0, 900) }));
    const pokemonAnchors = [...document.querySelectorAll('a[href*="/zh/champions/pokemon/"], a[href*="/zh/pokemon/"]')].filter(visible);
    const cards = pokemonAnchors.slice(0, 12).map((anchor) => {
      let node = anchor;
      for (let depth = 0; depth < 8 && node.parentElement; depth += 1) {
        node = node.parentElement;
        const count = node.querySelectorAll('a[href*="/zh/champions/pokemon/"], a[href*="/zh/pokemon/"]').length;
        if (count === 6) return { tag: node.tagName, cls: String(node.className || "").slice(0, 180), text: (node.innerText || "").slice(0, 1000), html: node.outerHTML.slice(0, 5000) };
      }
      return null;
    }).filter(Boolean);
    const formatNodes = [...document.querySelectorAll("body *")].filter((node) => visible(node) && /单打|双打/.test((node.textContent || "").trim()) && (node.textContent || "").trim().length < 80).slice(0, 20).map((node) => ({ text: (node.textContent || "").trim(), tag: node.tagName, role: node.getAttribute("role"), cls: String(node.className || "").slice(0, 180), html: node.outerHTML.slice(0, 2000), parent: node.parentElement?.outerHTML?.slice(0, 2500) }));
    const formatTargets = [...document.querySelectorAll("body *")].filter((node) => visible(node) && /^(单打|双打)\s*\d+\s*支$/.test((node.textContent || "").trim())).map((node) => {
      const ancestors = [];
      let current = node;
      for (let depth = 0; depth < 7 && current; depth += 1, current = current.parentElement) ancestors.push({ tag: current.tagName, role: current.getAttribute("role"), href: current.getAttribute("href"), cls: String(current.className || "").slice(0, 180), html: current.outerHTML.slice(0, 2400) });
      return { text: (node.textContent || "").trim(), ancestors, clickable: node.closest("button,a,[role=button]")?.outerHTML?.slice(0, 3500) || "" };
    });
    return { url: location.href, title: document.title, exact, formatNodes, formatTargets, cards, body: (document.body?.innerText || "").slice(-1200) };
  });
  return { ok: true, data };
}

async function setPokecampFormat(format = "double") {
  if (!pokecampBrowserPage || pokecampBrowserPage.isClosed()) return { ok: false, status: 409, error: "PokéCamp 浏览器尚未打开。" };
  const desired = format === "single" ? "单打" : "双打";
  const result = await pokecampBrowserPage.evaluate(async (desired) => {
    const visible = (node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
    const selector = document.querySelector('button[aria-label^="数据与赛制"]');
    if (selector && selector.getAttribute("aria-expanded") !== "true") selector.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const popupCandidates = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [data-slot="dialog-content"], [data-slot="popover-content"], [data-radix-popper-content-wrapper], [data-base-ui-popup], [data-base-ui-popup-trigger] + *')].filter(visible);
    const popup = popupCandidates.find((node) => /单打|双打/.test(node.innerText || ""));
    const popupDebug = popup ? { text: (popup.innerText || "").slice(0, 8000), html: popup.outerHTML.slice(0, 12000) } : null;
    const popupLabels = popup ? [...popup.querySelectorAll("button,[role=button],a")].filter((node) => visible(node) && (node.textContent || "").trim() === desired) : [];
    const popupTarget = popupLabels[0];
    if (popupTarget) {
      const formatButton = popupTarget.closest("button,[role=button],a") || popupTarget;
      formatButton.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      // Both build-page formats are sourced from the in-game ladder. The
      // VGC teams page uses Limitless; choosing it for build-page doubles
      // silently leaves the page on singles.
      const sourceName = /\/team-builds(?:[/?#]|$)/i.test(location.pathname) ? "游戏内" : "Limitless";
      const sourceGroup = [...document.querySelectorAll('[role="group"][aria-label="数据来源"]')].find(visible);
      const sourceButton = sourceGroup && [...sourceGroup.querySelectorAll("button")].find((node) => visible(node) && (node.innerText || "").trim().startsWith(sourceName));
      sourceButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 650));
      return { ok: true, found: [{ tag: formatButton.tagName, popup: true }, ...(sourceButton ? [{ tag: sourceButton.tagName, source: sourceName }] : [])], popupDebug };
    }
    const candidates = [...document.querySelectorAll("button,[role=button],a")]
      .filter((node) => visible(node) && (node.textContent || "").trim() === desired)
      .filter((node, index, list) => list.indexOf(node) === index);
    const target = candidates.find((node) => node.getAttribute("aria-pressed") !== "true" && !node.className?.toString().includes("bg-primary")) || candidates[0];
    if (!target) return { ok: false, found: [], popupDebug, popupCandidates: popupCandidates.map((node) => ({ text: (node.innerText || "").slice(0, 1500), html: node.outerHTML.slice(0, 3000) })) };
    target.click();
    return { ok: true, found: candidates.map((node) => ({ tag: node.tagName, cls: String(node.className || "").slice(0, 120), pressed: node.getAttribute("aria-pressed") })) };
  }, desired);
  await pokecampBrowserPage.waitForTimeout(800);
  const info = await pokecampBrowserPage.evaluate(() => ({ title: document.title, url: location.href, text: document.body?.innerText || "" }));
  return { ok: result.ok, format, result, pageTitle: info.title, pageUrl: info.url, preview: (info.text.match(/单打\s+\d+\s+支|双打\s+\d+\s+支/) || [])[0] || "" };
}

async function crawlPokecampCurrentPage({ maxPages = 1, sourcePageType = "vgc-teams" } = {}) {
  if (!pokecampBrowserPage || pokecampBrowserPage.isClosed()) return { ok: false, status: 409, error: "PokéCamp 浏览器尚未打开。" };
  const page = pokecampBrowserPage;
  const limit = Math.max(1, Math.min(30, Number(maxPages) || 1));
  const allTeams = [];
  let details = 0;
  let errors = 0;
  let pageCount = 0;
  pokecampBrowserState = { ...pokecampBrowserState, status: "CRAWLING", crawl: { status: "RUNNING", sourcePageType, page: 0, pages: limit, teams: 0, details: 0, errors: 0, startedAt: new Date().toISOString(), finishedAt: "", lastError: "" } };
  try {
    // Format changes preserve the last pagination page on PokéCamp. Always
    // reset to page 1 before a crawl so a requested page budget is complete.
    await page.evaluate(() => {
      const visible = (node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
      const firstPage = [...document.querySelectorAll("button,a")].find((node) => visible(node) && (node.textContent || "").trim() === "1" && !node.disabled);
      firstPage?.click();
    });
    await page.waitForTimeout(650);
    for (let pageIndex = 1; pageIndex <= limit; pageIndex += 1) {
      pageCount = pageIndex;
      await page.waitForTimeout(250);
      const result = await page.evaluate(({ sourcePageType, pageIndex }) => {
        const visible = (node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
        const formatText = [...document.querySelectorAll("[data-slot=badge],h2,h3")].map((node) => (node.textContent || "").trim()).find((value) => /^(\u5355\u6253|\u53cc\u6253)$/.test(value)) || "";
        const format = formatText === "\u5355\u6253" ? "single" : formatText === "\u53cc\u6253" ? "double" : sourcePageType === "team-builds-single" ? "single" : sourcePageType === "team-builds-double" || sourcePageType === "vgc-teams" ? "double" : "";
        const text = document.body?.innerText || "";
        const regulation = (text.match(/\u8d5b\u5236\s*([A-Z]-[A-Z0-9]+)/i) || [])[1] || "";
        const cards = [];
        const detailButtons = [...document.querySelectorAll("button")].filter((button) => visible(button) && /^(查看队伍详情|查看构筑详情)$/.test((button.textContent || "").trim()));
        for (const button of detailButtons) {
          let card = button;
          for (let depth = 0; depth < 10 && card.parentElement; depth += 1) {
            card = card.parentElement;
            const members = [...card.querySelectorAll('a[href*="/zh/champions/pokemon/"], a[href*="/zh/pokemon/"]')].filter(visible);
            if (members.length >= 6) {
              const memberData = members.slice(0, 6).map((anchor) => ({ name: anchor.getAttribute("aria-label") || anchor.textContent?.trim(), href: new URL(anchor.getAttribute("href"), location.href).href, item: anchor.querySelector("[title]")?.getAttribute("title") || "" }));
              const cardText = (card.innerText || "").trim();
              const cardLines = cardText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
              const formatIndex = cardLines.findIndex((line) => line === "单打" || line === "双打");
              const title = cardLines.slice(formatIndex + 1).find((line) => line && !/^(有租借队伍|查看队伍详情|查看构筑详情|添加到我的队伍|添加到我的队伍)$/.test(line) && !/^@/.test(line) && !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(line)) || `PokéCamp ${regulation || "team"} p${pageIndex}-${cards.length + 1}`;
              cards.push({ title, format, season: regulation, regulation, sourcePage: location.href, sourceUrl: location.href, members: memberData, cardText, detailButtonIndex: detailButtons.indexOf(button), detailStatus: "PENDING" });
              break;
            }
          }
        }
        const next = [...document.querySelectorAll("button,a")].find((node) => visible(node) && /^(下一页|下一頁|Next|›|>)$/.test((node.textContent || "").trim()) && !node.disabled);
        const numbered = [...document.querySelectorAll("button,a")].filter((node) => visible(node) && /^(\d+)$/.test((node.textContent || "").trim()));
        return { cards, format, hasNext: Boolean(next), numbered: numbered.map((node) => (node.textContent || "").trim()), pageUrl: location.href };
      }, { sourcePageType, pageIndex });
      if (sourcePageType !== "vgc-teams" && result.format && result.format !== (sourcePageType === "team-builds-single" ? "single" : "double")) {
        throw new Error(`页面赛制与请求不一致：请求 ${sourcePageType}，页面显示 ${result.format}`);
      }
      // Read each card's dialog before changing pages. The site only keeps the current
      // page's dialog triggers mounted in the DOM.
      for (const [cardIndex, card] of result.cards.entries()) {
        let detail = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // A failed close leaves the previous Radix dialog mounted. Dismiss it
          // before selecting the next card so detailButtonIndex always belongs
          // to the visible list page, not a stale dialog behind it.
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.waitForTimeout(140);
          detail = await page.evaluate(async (target) => {
          const visible = (node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
          const closeDialog = (dialog) => {
            const close = [...dialog.querySelectorAll('button,[role="button"]')].find((node) =>
              node.getAttribute("data-slot") === "dialog-close" ||
              /^(关闭|關閉|Close|×|X)$/i.test((node.textContent || "").trim()) ||
              /close|关闭|關閉/i.test(`${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`));
            close?.click();
          };
          // Escape normally handles PokéCamp's icon-only close control. This
          // fallback covers a dialog that was left open after a transient load.
          for (const dialog of [...document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"]')].filter(visible)) closeDialog(dialog);
          const buttons = [...document.querySelectorAll("button")].filter((button) => visible(button) && /^(查看队伍详情|查看构筑详情)$/.test((button.textContent || "").trim()));
          const button = buttons[target.index];
          if (!button) return null;
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 900));
          const dialogs = [...document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"]')].filter(visible);
          const dialog = dialogs[dialogs.length - 1];
          if (!dialog) return null;
          const cards = [...dialog.querySelectorAll('a[href*="/zh/champions/pokemon/"], a[href*="/zh/pokemon/"]')].filter(visible).map((anchor) => {
            let cardNode = anchor;
            for (let depth = 0; depth < 8 && cardNode.parentElement; depth += 1) {
              cardNode = cardNode.parentElement;
              const text = (cardNode.innerText || "").trim();
              if (/道具|性格|特性|招式/.test(text) && text.length < 2500) return { text, html: cardNode.outerHTML.slice(0, 9000), name: anchor.getAttribute("aria-label") || anchor.textContent?.trim(), href: new URL(anchor.getAttribute("href"), location.href).href };
            }
            return { text: (anchor.parentElement?.parentElement?.innerText || "").trim(), name: anchor.getAttribute("aria-label") || anchor.textContent?.trim(), href: new URL(anchor.getAttribute("href"), location.href).href };
          });
          const content = (dialog.innerText || "").slice(0, 30_000);
          const configuredCards = cards.filter((entry) => /道具|性格|特性|招式/.test(entry.text || "")).length;
          // A title-only dialog is not a successful detail read. It is usually
          // the previous dialog or a still-loading current dialog; force the
          // outer retry loop to reopen this exact card.
          const expected = Math.min(6, Math.max(1, target.expectedMembers || 6));
          const complete = configuredCards >= expected && content.length >= 450;
          closeDialog(dialog);
          return { content, cards, configuredCards, expected, complete };
          }, {
            index: Number.isInteger(card.detailButtonIndex) ? card.detailButtonIndex : cardIndex,
            expectedMembers: card.members?.length || 6,
          });
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.waitForTimeout(100);
          if (detail?.complete && !/详情加载失败|请稍后重试/.test(detail.content)) break;
          await page.waitForTimeout(700 * (attempt + 1));
        }
        if (detail?.complete && !/详情加载失败|请稍后重试/.test(detail.content)) {
          card.detailText = detail.content;
          card.detailConfigurations = detail.cards || [];
          card.detailStatus = "COMPLETE";
          details += 1;
        } else {
          card.detailStatus = "RETRY_REQUIRED";
          errors += 1;
        }
        allTeams.push(card);
        pokecampBrowserState = { ...pokecampBrowserState, crawl: { ...pokecampBrowserState.crawl, page: pageCount, teams: allTeams.length, details, errors } };
      }
      if (pageIndex >= limit || (!result.hasNext && !result.numbered.some((value) => Number(value) > pageIndex))) break;
      const moved = await page.evaluate((targetPage) => {
        const visible = (node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
        const next = [...document.querySelectorAll("button,a")].find((node) => visible(node) && /^(下一页|下一頁|Next|›|>)$/.test((node.textContent || "").trim()) && !node.disabled);
        if (next) { next.click(); return true; }
        const numbered = [...document.querySelectorAll("button,a")].find((node) => visible(node) && (node.textContent || "").trim() === String(targetPage));
        if (numbered) { numbered.click(); return true; }
        return false;
      }, pageIndex + 1);
      if (!moved) break;
      await page.waitForTimeout(650);
    }
    const payload = { teams: allTeams, sourcePageType, sourcePage: page.url() };
    lastPokecampCrawlPayload = payload;
    pokecampBrowserState = { ...pokecampBrowserState, status: "DATA_READY", lastReadAt: new Date().toISOString(), crawl: { ...pokecampBrowserState.crawl, status: "COMPLETED", page: pageCount, teams: allTeams.length, details, errors, finishedAt: new Date().toISOString() } };
    return { ok: true, state: pokecampBrowserSnapshot(), payload, preview: { pages: pageCount, teams: allTeams.length, details, errors, pageUrl: page.url() } };
  } catch (error) {
    pokecampBrowserState = { ...pokecampBrowserState, status: "FAILED", crawl: { ...pokecampBrowserState.crawl, status: "FAILED", page: pageCount, teams: allTeams.length, details, errors, finishedAt: new Date().toISOString(), lastError: error.message || "抓取失败" }, lastError: error.message || "抓取失败" };
    return { ok: false, status: 503, error: pokecampBrowserState.lastError, state: pokecampBrowserSnapshot(), partial: { teams: allTeams.length, details, errors, pages: pageCount } };
  }
}

async function handlePokecampBrowserApi(req, res) {
  const url = new URL(req.url || "/api/pokecamp/browser/status", "http://127.0.0.1");
  const body = req.method === "POST" ? await readJson(req).catch(() => ({})) : {};
  if (req.method === "GET" && url.pathname.endsWith("/status")) { sendJson(res, 200, pokecampBrowserSnapshot()); return; }
  if (req.method === "POST" && url.pathname.endsWith("/open")) { sendJson(res, 200, await launchPokecampBrowser(String(body.url || ""))); return; }
  if (req.method === "POST" && url.pathname.endsWith("/read")) { sendJson(res, 200, await readPokecampBrowser()); return; }
  if (req.method === "POST" && url.pathname.endsWith("/crawl")) {
    const maxPages = Math.max(1, Math.min(30, Number(body.pages || body.maxPages || (String(body.sourcePageType || "").includes("build") ? 30 : 30))));
    sendJson(res, 200, await crawlPokecampCurrentPage({ maxPages, sourcePageType: String(body.sourcePageType || "vgc-teams") }));
    return;
  }
  if (req.method === "GET" && url.pathname.endsWith("/crawl/latest")) {
    if (!lastPokecampCrawlPayload) { sendJson(res, 404, { ok: false, error: "暂无已完成的 PokéCamp 抓取结果。" }); return; }
    sendJson(res, 200, { ok: true, payload: lastPokecampCrawlPayload, preview: { teams: lastPokecampCrawlPayload.teams.length, sourcePageType: lastPokecampCrawlPayload.sourcePageType } });
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/crawl/import")) { await importLatestPokecampCrawl(req, res); return; }
  if (req.method === "GET" && url.pathname.endsWith("/debug")) { sendJson(res, 200, await debugPokecampBrowser()); return; }
  if (req.method === "POST" && url.pathname.endsWith("/format")) { sendJson(res, 200, await setPokecampFormat(String(body.format || "double"))); return; }
  if (req.method === "POST" && url.pathname.endsWith("/close")) {
    await pokecampBrowserContext?.close().catch(() => {});
    pokecampBrowserContext = null; pokecampBrowserPage = null;
    pokecampBrowserState = { ...pokecampBrowserState, status: "CLOSED", challenge: false, pageUrl: "", pageTitle: "" };
    sendJson(res, 200, pokecampBrowserSnapshot()); return;
  }
  sendJson(res, 405, { ok: false, error: "未知的 PokéCamp 浏览器接口。" });
}

async function handleAgentApi(req, res) {
  const url = new URL(req.url || "/api/agent/status", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/agent/hot-teams") {
    const format = url.searchParams.get("format") === "single" ? "single" : "double";
    const snapshot = ruleRegistry.operational({ format, rulesetId: String(url.searchParams.get("rulesetId") || "") });
    const { pool, selected, preview } = chooseLadderHotTeam(snapshot);
    sendJson(res, 200, {
      ok: true,
      ...rulesetMetadata(snapshot),
      dataSeason: pool[0]?.sourceSeason || "",
      seasonMatched: pool.some((item) => item.seasonMatched),
      total: pool.length,
      items: pool.slice(0, Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 240)))),
      selected,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agent/status") {
    const state = await agentController.status();
    sendJson(res, 200, { ok: true, ...state, account: showdownAccount.publicState(), rules: ruleRegistry.publicState().status });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agent/ratings") {
    const data = await agentController.ratings(
      String(url.searchParams.get("rulesetId") || ""),
      String(url.searchParams.get("showdownFormatId") || ""),
    );
    sendJson(res, 200, { ok: true, ...data });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agent/replays") {
    const data = await agentController.replays(String(url.searchParams.get("rulesetId") || ""));
    sendJson(res, 200, { ok: true, ...data });
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/agent/replay/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const rulesetId = String(parts[3] || "").trim();
    let fileName = "";
    try { fileName = decodeURIComponent(String(parts.slice(4).join("/") || "").trim()); } catch { fileName = ""; }
    if (!rulesetId || !fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..") || !fileName.toLowerCase().endsWith(".html")) {
      sendJson(res, 400, { ok: false, error: "非法回放文件路径。" });
      return;
    }
    const root = resolve(ROOT, "data", "agent", "showdown-replays", rulesetId);
    const filePath = resolve(root, fileName);
    if (!filePath.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) {
      sendJson(res, 403, { ok: false, error: "禁止访问该回放文件。" });
      return;
    }
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error("Not a file");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": "inline",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      createReadStream(filePath).pipe(res);
    } catch {
      sendJson(res, 404, { ok: false, error: "回放文件不存在。" });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agent/models") {
    await Promise.all(ruleRegistry.publicState().active.map((snapshot) => syncPolicyTrainingMilestones(snapshot.rulesetId, snapshot.battleType)));
    const data = await agentController.models(String(url.searchParams.get("rulesetId") || ""));
    sendJson(res, 200, { ok: true, ...data });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agent/learning") {
    const format = url.searchParams.get("format") === "double" ? "double" : "single";
    const requestedRulesetId = String(url.searchParams.get("rulesetId") || "").trim();
    const snapshot = learningSnapshot(format, requestedRulesetId);
    const root = join(AGENT_LEARNING_ROOT, snapshot.rulesetId);
    await importLocalAgentReplays(snapshot, format);
    await syncPolicyTrainingMilestones(snapshot.rulesetId, format);
    const [summary, failures, matchups, teamRegistry, modelRegistry, evaluations, trainingProgress] = await Promise.all([
      learnFromAgentTraces(snapshot.rulesetId, format),
      readFile(join(root, "failure-memory.json"), "utf8").then(JSON.parse).catch(() => null),
      readFile(join(root, "opponent-matchups.json"), "utf8").then(JSON.parse).catch(() => null),
      readAgentTeamRegistry(snapshot.rulesetId),
      readPolicyModelRegistry(snapshot.rulesetId),
      listModelEvaluations(snapshot.rulesetId),
      policyTrainingProgress(snapshot.rulesetId, format),
    ]);
    sendJson(res, 200, { ok: true, ...rulesetMetadata(snapshot), historical: Boolean(snapshot.historical), summary, failures, matchups, teamRegistry, modelRegistry, evaluations: evaluations.items, trainingProgress });
    return;
  }
  const body = await readJson(req).catch(() => ({}));
  if (req.method === "POST" && url.pathname === "/api/agent/stop") {
    sendJson(res, 200, { ok: true, ...(await agentController.stop()) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/promote") {
    const snapshot = ruleRegistry.operational({ format: body.format || "double", rulesetId: String(body.rulesetId || "") });
    const version = String(body.version || "").trim();
    const registry = await readPolicyModelRegistry(snapshot.rulesetId);
    const challenger = (registry.challengers || []).find((item) => item.version === version);
    if (!challenger || challenger.status !== "ready_to_promote") {
      sendJson(res, 409, { ok: false, code: "MODEL_NOT_READY", error: "该 Challenger 尚未通过私服对抗评测，不能晋级。", status: challenger?.status || "not_found" });
      return;
    }
    registry.champion = { version, status: "active", promotedAt: new Date().toISOString(), evaluationId: challenger.evaluationId };
    challenger.status = "promoted";
    await writePolicyModelRegistry(snapshot.rulesetId, registry);
    sendJson(res, 200, { ok: true, ...registry });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/train") {
    const format = body.format === "double" ? "double" : "single";
    const snapshot = ruleRegistry.operational({ format, rulesetId: String(body.rulesetId || "") });
    const result = await trainAgentPolicy({ ...body, format, rulesetId: snapshot.rulesetId });
    if (result.ok && result.status === "trained") {
      const registry = await readPolicyModelRegistry(snapshot.rulesetId);
      registry.challengers = [
        { version: result.policy.version, status: "trained", trainingGames: result.policy.dataset.selected, trainingSamples: result.policy.dataset.train, trainingFingerprint: result.policy.trainingFingerprint, parentVersion: result.policy.parentVersion, createdAt: result.policy.trainedAt },
        ...(registry.challengers || []).filter((item) => item.version !== result.policy.version),
      ].slice(0, 20);
      await writePolicyModelRegistry(snapshot.rulesetId, registry);
      result.modelRegistry = registry;
      result.trainingProgress = await policyTrainingProgress(snapshot.rulesetId, format, null, registry);
    }
    sendJson(res, result.ok ? 200 : 422, { ok: result.ok, ...result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/evaluate") {
    const format = body.format === "double" ? "double" : "single";
    const snapshot = ruleRegistry.operational({ format, rulesetId: String(body.rulesetId || "") });
    const registry = await readPolicyModelRegistry(snapshot.rulesetId);
    const challengerVersion = String(body.challengerVersion || body.version || "").trim();
    const challenger = await readPolicySnapshot(snapshot.rulesetId, challengerVersion);
    const champion = await readPolicySnapshot(snapshot.rulesetId, registry.champion?.version);
    if (!challenger) { sendJson(res, 404, { ok: false, code: "POLICY_NOT_FOUND", error: "找不到 Challenger 策略快照，请先训练。" }); return; }
    const evaluation = await runPolicyAdversarial({ rulesetId: snapshot.rulesetId, format, championVersion: registry.champion?.version, challengerVersion, games: Number(body.games || 20) });
    sendJson(res, evaluation.ok ? 200 : 422, evaluation);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/analyze") {
    const format = body.format === "double" ? "double" : "single";
    const snapshot = learningSnapshot(format, String(body.rulesetId || "").trim());
    await importLocalAgentReplays(snapshot, format);
    const summary = await learnFromAgentTraces(snapshot.rulesetId, format);
    await syncPolicyTrainingMilestones(snapshot.rulesetId, format);
    sendJson(res, 200, { ok: true, ...rulesetMetadata(snapshot), historical: Boolean(snapshot.historical), summary });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/analyze-replay") {
    const format = body.format === "double" ? "double" : "single";
    const result = await analyzeLocalAgentReplay({ ...body, format });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/evolve-team") {
    const format = body.format === "double" ? "double" : "single";
    const snapshot = ruleRegistry.operational({ format, rulesetId: String(body.rulesetId || "") });
    const result = await evolveAgentTeam({ ...body, format, rulesetId: snapshot.rulesetId });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/start") {
    const format = body.format === "single" ? "single" : "double";
    const snapshot = ruleRegistry.operational({ format, rulesetId: String(body.rulesetId || "").trim() });
    if (body.acknowledgeAutomationPolicy !== true) throw Object.assign(new Error("启动公开排位前必须确认单账号、单连接、不操纵匹配并遵守平台自动化规则。"), { status: 400, code: "AUTOMATION_ACK_REQUIRED" });
    const prepared = prepareBattleTeam(body.teamText || "", format, "排位队伍", snapshot.rulesetId);
    if (!prepared.ok || !prepared.strictLegal) throw Object.assign(new Error(`排位队伍未通过 ${snapshot.name} 校验。`), { status: 422, code: "EXACT_FORMAT_ILLEGAL", details: { problems: prepared.problems || [] } });
    const parsedTeamMembers = (Teams.import(prepared.showdownTeamText) || []).slice(0, 6).map((member) => ({
      id: strictKey(member.species || member.name || ""),
      name: member.species || member.name || "",
      sprite: strictKey(member.species || member.name || ""),
      item: member.item || "",
      ability: member.ability || "",
      moves: Array.isArray(member.moves) ? member.moves.slice(0, 4) : [],
      nature: member.nature || "",
      stats: member.evs || "",
    })).filter((member) => member.id && member.name);
    if (!parsedTeamMembers.length) {
      throw Object.assign(new Error("排位队伍解析成功但没有可显示的本场成员，已阻止启动。"), { status: 422, code: "SUBMITTED_TEAM_EMPTY" });
    }
    const credential = await showdownAccount.credential();
    const games = Math.max(1, Math.min(Number(body.games || 1) || 1, Number(process.env.AGENT_MAX_BATCH_GAMES || 10)));
    const requestedTeamPool = Array.isArray(body.teamPool) ? body.teamPool.slice(0, 500) : [];
    const preparedTeamPool = [];
    for (const candidate of requestedTeamPool) {
      const candidateText = String(candidate?.teamText || "").trim();
      if (!candidateText) continue;
      let candidatePrepared;
      try { candidatePrepared = prepareBattleTeam(candidateText, format, `热门队伍 ${candidate?.id || "unknown"}`, snapshot.rulesetId); } catch { continue; }
      if (!candidatePrepared.ok || !candidatePrepared.strictLegal) continue;
      const candidateMembers = (Teams.import(candidatePrepared.showdownTeamText) || []).slice(0, 6).map((member) => ({
        id: strictKey(member.species || member.name || ""),
        name: member.species || member.name || "",
        sprite: strictKey(member.species || member.name || ""),
        item: member.item || "",
        ability: member.ability || "",
        moves: Array.isArray(member.moves) ? member.moves.slice(0, 4) : [],
        nature: member.nature || "",
        stats: member.evs || "",
      })).filter((member) => member.id && member.name);
      if (candidateMembers.length !== 6) continue;
      preparedTeamPool.push({
        id: String(candidate.id || `hot-${preparedTeamPool.length + 1}`),
        title: String(candidate.title || "当前规则热门队伍"),
        source: String(candidate.source || "热门队伍数据"),
        rate: Number(candidate.rate || 0),
        rank: Number(candidate.rank || 9999),
        team: candidatePrepared.showdownTeamText,
        teamMembers: candidateMembers,
        packedTeam: Teams.pack(Teams.import(candidatePrepared.showdownTeamText) || []),
      });
    }
    const state = await agentController.start({
      rulesetId: snapshot.rulesetId,
      showdownFormatId: snapshot.showdownFormatId,
      battleType: snapshot.battleType,
      openTeamSheets: snapshot.rules.includes("Open Team Sheets"),
      username: credential.username,
      password: credential.password,
      team: prepared.showdownTeamText,
      teamMembers: parsedTeamMembers,
      teamVersion: String(body.teamVersion || "manual"),
      teamSource: String(body.teamSource || "workbench"),
      teamId: String(body.teamId || ""),
      teamTitle: String(body.teamTitle || ""),
      teamPool: preparedTeamPool,
      continuous: body.continuous === true,
      sessionId: String(body.sessionId || ""),
      games,
      policy: String(body.policy || "structured").trim().toLowerCase(),
    });
    sendJson(res, 202, { ok: true, ...state, ...rulesetMetadata(snapshot) });
    return;
  }
  sendJson(res, 404, { ok: false, error: "Unknown agent endpoint." });
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
34. 硬约束必须按最终 6 只和实际招式校验。不能编造可用宝可梦、招式、道具或特性；也不能用相近宝可梦、普通转场或泛用攻队替代缺失的核心机制。接棒、天气、空间、顺风等目标必须有对应的真实启动者和收益链，否则该结果会被服务端拒绝。
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

function rulesetMetadata(snapshot = {}) {
  return {
    rulesetId: snapshot.rulesetId || "",
    showdownFormatId: snapshot.showdownFormatId || "",
    battleType: snapshot.battleType || "",
    regulation: snapshot.regulation || "",
    formatHash: snapshot.formatHash || "",
    legalPoolHash: snapshot.legalPoolHash || "",
    showdownCommit: snapshot.showdownCommit || "",
  };
}

function showdownFormatFor(format = "single", rulesetId = "") {
  const snapshot = rulesetId ? ruleRegistry.get(rulesetId) : ruleRegistry.activeFor(format);
  return snapshot?.showdownFormatId || "";
}

function championsRulesEngine(format = "single", rulesetId = "") {
  let snapshot;
  try {
    snapshot = ruleRegistry.operational({ format, rulesetId });
  } catch (error) {
    return {
      ok: false,
      code: error.code || "RULE_REGISTRY_NOT_ACTIVE",
      status: error.status || 503,
      error: error.message,
      details: error.details || {},
    };
  }
  const id = snapshot.showdownFormatId;
  const rules = Dex.formats.get(id);
  if (!rules?.exists) {
    return {
      ok: false,
      code: "EXACT_RULES_UNAVAILABLE",
      status: 503,
      id,
      error: `本地 Pokemon Showdown 引擎未包含 ${snapshot.name || id} 规则，无法进行精确测试。请更新依赖后重试。`,
      ...rulesetMetadata(snapshot),
    };
  }
  return {
    ok: true,
    id: rules.id,
    name: rules.name,
    mod: rules.mod,
    gameType: rules.gameType,
    exact: true,
    ...rulesetMetadata(snapshot),
  };
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

function validateShowdownTeam(text = "", format = "single", rulesetId = "") {
  const snapshot = ruleRegistry.operational({ format, rulesetId });
  const formatId = snapshot.showdownFormatId;
  const team = Teams.import(text);
  if (!team?.length) {
    return {
      ok: false,
      format: formatId,
      ...rulesetMetadata(snapshot),
      problems: ["没有解析到有效的 Showdown 队伍文本。"],
      teamSize: 0,
    };
  }
  const officialPool = officialRegulationPool(snapshot.regulation);
  if (!officialPool) {
    return {
      ok: false,
      format: formatId,
      ...rulesetMetadata(snapshot),
      problems: [`官方赛制 ${snapshot.regulation} 的可用宝可梦名单资产缺失，已禁止配队和排位。`],
      teamSize: team.length,
      officialPoolCount: 0,
    };
  }
  const officialIds = officialPool ? new Set(officialPool.entries.flatMap((entry) => entry.showdownIds || officialPoolEntryKeys(entry))) : null;
  const unavailable = officialIds
    ? team.filter((member) => !officialIds.has(strictKey(member.species || member.name || ""))).map((member) => member.species || member.name || "未知宝可梦")
    : [];
  const validator = TeamValidator.get(formatId);
  const problems = [
    ...(validator.validateTeam(team) || []).filter((problem) => !/is level 50, but this format allows level 100/i.test(problem)),
    ...(unavailable.length ? [`以下宝可梦不在官方赛制 ${snapshot.regulation} 可用名单：${unavailable.join("、")}`] : []),
  ];
  return {
    ok: problems.length === 0,
    format: formatId,
    ...rulesetMetadata(snapshot),
    problems,
    teamSize: team.length,
    officialPoolCount: officialPool?.count || 0,
  };
}

function officialPoolEntryKeys(entry = {}) {
  const keys = new Set();
  for (const id of entry.showdownIds || []) keys.add(strictKey(id));
  const homeId = String(entry.homeId || "").trim();
  const dex = String(Number(entry.dex || 0));
  if (homeId) keys.add(strictKey(homeId));
  if (entry.slug) keys.add(strictKey(entry.slug));
  if (entry.name) keys.add(strictKey(entry.name));
  if (dex && dex !== "0") keys.add(strictKey(entry.dex));
  return [...keys];
}

function officialSpeciesAllowed(speciesId = "", rulesetId = "") {
  const snapshot = ruleRegistry.get(rulesetId);
  const pool = officialRegulationPool(snapshot?.regulation);
  if (!pool) return false;
  const id = strictKey(speciesId);
  return pool.entries.some((entry) => (entry.showdownIds || officialPoolEntryKeys(entry)).some((candidate) => strictKey(candidate) === id));
}

function officialRegulationPool(regulation = "") {
  const key = String(regulation || "").trim().toUpperCase();
  if (!key || !OFFICIAL_REGULATION_POOL_SOURCES[key]) return null;
  if (officialRegulationPoolCache.has(key)) return officialRegulationPoolCache.get(key);
  const filePath = join(ROOT, "data", "official-regulation-pools.json");
  try {
    const document = JSON.parse(readFileSync(filePath, "utf8"));
    const saved = document?.regulations?.[key];
    if (saved?.entries?.length) {
      const value = { ...saved, entries: saved.entries.map((entry) => ({ ...entry, keys: officialPoolEntryKeys(entry) })) };
      officialRegulationPoolCache.set(key, value);
      return value;
    }
  } catch {}
  return null;
}

function officialPoolForSnapshot(snapshot = {}) {
  const pool = officialRegulationPool(snapshot.regulation);
  if (!pool) return null;
  return {
    regulation: snapshot.regulation,
    count: pool.entries.length,
    sourceUrl: pool.sourceUrl,
    announcementUrl: pool.announcementUrl,
    entries: pool.entries.map(({ keys, ...entry }) => entry),
  };
}

async function handleOfficialPoolApi(req, res) {
  const url = new URL(req.url || "/api/rules/pool", "http://127.0.0.1");
  const requestedRulesetId = String(url.searchParams.get("rulesetId") || "").trim();
  const requestedFormat = url.searchParams.get("format") === "single" ? "single" : "double";
  const requestedRegulation = String(url.searchParams.get("regulation") || "").trim().toUpperCase();
  const snapshot = requestedRulesetId
    ? ruleRegistry.get(requestedRulesetId)
    : ruleRegistry.activeFor(requestedFormat);
  const regulation = requestedRegulation || snapshot?.regulation || "";
  const pool = officialRegulationPool(regulation);
  if (!pool) {
    sendJson(res, 404, { ok: false, code: "OFFICIAL_POOL_NOT_FOUND", error: `没有找到赛制 ${regulation || "unknown"} 的官方可用宝可梦名单。` });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    regulation,
    rulesetId: requestedRulesetId || snapshot?.rulesetId || "",
    battleType: snapshot?.battleType || "",
    count: pool.entries.length,
    sourceUrl: pool.sourceUrl,
    announcementUrl: pool.announcementUrl,
    entries: pool.entries.map(({ keys, ...entry }) => ({
      ...entry,
      showdownIds: entry.showdownIds || [],
      ...officialPokemonDetails(entry),
    })),
    referenceUrl: POKEMON_REFERENCE_URL,
  });
}

function officialPokemonDetails(entry = {}) {
  const species = (entry.showdownIds || [])
    .map((id) => SHOWDOWN_SPECIES_BY_ID.get(strictKey(id)))
    .find((item) => item?.exists);
  if (!species) return { forme: "", spriteId: "", types: [], baseStats: {}, baseStatTotal: 0, abilities: [] };
  const baseStats = {
    hp: Number(species.baseStats?.hp || 0),
    atk: Number(species.baseStats?.atk || 0),
    def: Number(species.baseStats?.def || 0),
    spa: Number(species.baseStats?.spa || 0),
    spd: Number(species.baseStats?.spd || 0),
    spe: Number(species.baseStats?.spe || 0),
  };
  const abilities = Object.entries(species.abilities || {})
    .filter(([, id]) => id)
    .map(([slot, id]) => ({ id, name: id, localizedName: candidateTerm("abilities", id), hidden: slot === "H" }));
  return {
    englishName: species.name,
    forme: species.forme || "",
    spriteId: species.spriteid || species.id,
    types: (species.types || []).map((id) => ({ id, name: CANDIDATE_TYPE_LABELS[id] || id })),
    baseStats,
    baseStatTotal: Object.values(baseStats).reduce((sum, value) => sum + value, 0),
    abilities,
  };
}

function readTeamDataDocument() {
  try {
    return JSON.parse(readFileSync(TEAM_DATA_PATH, "utf8"));
  } catch {
    return { season: "", availableSeasons: [], teams: [] };
  }
}

function readTeamDataFile() {
  const data = readTeamDataDocument();
  return Array.isArray(data?.teams) ? data.teams : [];
}

function pokecampSpriteSlug(value = "") {
  const original = String(value || "").replace(/\u00a0/g, " ").trim();
  if (!original) return "";
  let name = original.replace(/\s+/g, "");
  let suffix = "";
  const localizedAliases = {
    清洗洛托姆: "rotom-wash",
    加热洛托姆: "rotom-heat",
    结冰洛托姆: "rotom-frost",
    旋转洛托姆: "rotom-fan",
    切割洛托姆: "rotom-mow",
  };
  if (localizedAliases[name]) return localizedAliases[name];
  const dictionary = candidateReferenceData.terms?.pokemon || {};
  const findSlug = (localized) => Object.entries(dictionary).find(([, translated]) => String(translated).replace(/\s+/g, "") === localized)?.[0] || "";
  const mega = name.match(/^超级(.+)$/i);
  if (mega) {
    const rest = mega[1];
    const form = rest.match(/^(.+?)([XYＸＹ])$/i);
    name = form && findSlug(form[1]) ? form[1] : rest;
    suffix = `-mega${form ? `-${(form[2] || "").replace(/[ＸＹ]/g, (letter) => letter === "Ｘ" ? "X" : "Y").toLowerCase()}` : ""}`;
  }
  const form = name.match(/^(.*?)[（(](阿罗拉|伽勒尔|洗翠|帕底亚|黄昏|黑夜|白昼|午夜)的样子[）)]$/);
  if (form) {
    name = form[1];
    suffix = `-${({ 阿罗拉: "alola", 伽勒尔: "galar", 洗翠: "hisui", 帕底亚: "paldea", 黄昏: "dusk", 黑夜: "midnight", 白昼: "midday", 午夜: "midnight" })[form[2]] || ""}`;
  }
  const slug = findSlug(name);
  if (!slug) return "";
  return `${slug}${suffix}`.replace(/[^a-z0-9-]/gi, "").toLowerCase();
}

function pokecampSpriteCandidates(member = {}) {
  const value = String(member?.name || member?.localizedName || member?.slug || "").replace(/\u00a0/g, " ").trim();
  const candidates = [];
  const add = (url) => { if (url && !candidates.includes(url)) candidates.push(url); };
  const primarySlug = pokecampSpriteSlug(value);
  if (primarySlug) add(`https://play.pokemonshowdown.com/sprites/gen5/${primarySlug}.png`);

  // Showdown does not ship every new Mega sprite. Keep the base species visible
  // so a missing form asset never turns a real team member into an empty slot.
  const baseValue = value.replace(/^超级\s*/i, "").replace(/\s*[（(]?[XYＸＹ][）)]?$/i, "").trim();
  const baseSlug = pokecampSpriteSlug(baseValue);
  if (baseSlug) {
    add(`https://play.pokemonshowdown.com/sprites/gen5/${baseSlug}.png`);
    add(`https://img.pokemondb.net/sprites/scarlet-violet/normal/${baseSlug}.png`);
    const species = SHOWDOWN_SPECIES_BY_ID.get(strictKey(baseSlug));
    const dexNumber = Number(species?.num || 0);
    if (dexNumber > 0) add(`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dexNumber}.png`);
  }
  const dex = Number(member?.id || member?.dex || member?.nationalDex || 0);
  if (dex > 0) add(`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dex}.png`);
  return candidates;
}

function cleanPokecampInlineText(value = "") {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\[([^\[\]]{0,160})\]/gs, (_, inner) => inner.replace(/\s+/g, " ").trim())
    .replace(/[\[\]]/g, "")
    .replace(/[ \t]+([，。！？、：；）》）】])/g, "$1")
    .replace(/([（(【])\s+/g, "$1")
    .replace(/([。！？])\s*(战术与解说|组队思路|常规选出|基本选出|对战思路|对策|对知名构筑的应对|首发|后排|感想|备注)(?=\S)/g, "$1\n$2");
}

function pokecampStrategyBlocks(value = "") {
  const headings = /^(战术与解说|组队思路|常规选出|基本选出|对战思路|对策|对知名构筑的应对|首发|后排|感想|备注)$/;
  const headingWithBody = /^(战术与解说|组队思路|常规选出|基本选出|对战思路|对策|对知名构筑的应对|首发|后排|感想|备注)(?=\S)(.*)$/;
  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ type: "paragraph", text });
    paragraph = [];
  };
  for (const rawLine of cleanPokecampInlineText(value).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { flushParagraph(); continue; }
    const split = headingWithBody.exec(line);
    if (split) {
      flushParagraph();
      blocks.push({ type: "heading", text: split[1] });
      if (split[2].trim()) paragraph.push(split[2].trim());
      continue;
    }
    if (headings.test(line)) {
      flushParagraph();
      blocks.push({ type: "heading", text: line });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

function pokecampStrategyLinks(value = "", members = []) {
  const memberNames = new Set(members.map((member) => String(member.name || member.localizedName || member.slug || "").trim()).filter(Boolean));
  const ignored = new Set(["宝可梦", "对方", "自己", "我方", "对手"]);
  const compact = (label) => String(label || "").replace(/\s+/g, "").trim();
  const canonicalLabel = (label) => {
    const compactLabel = compact(label);
    const member = [...memberNames].find((name) => compact(name) === compactLabel);
    if (member) return member;
    for (const dictionary of Object.values(candidateReferenceData.terms || {})) {
      const translated = Object.values(dictionary || {}).find((name) => compact(name) === compactLabel);
      if (translated) return String(translated);
    }
    return String(label || "").replace(/\s+/g, " ").trim();
  };
  const seen = new Set();
  return [...String(value || "").matchAll(/\[([^\[\]]{1,160})\]/gs)]
    .map((match) => canonicalLabel(match[1]))
    .filter(Boolean)
    .filter((label) => !ignored.has(label))
    .filter((label) => { if (seen.has(label)) return false; seen.add(label); return true; })
    .map((label) => {
      const kind = memberNames.has(label) ? "pokemon" : referenceTermCategory(label);
      const id = referenceTermId(kind, label);
      return {
        text: label,
        kind,
        href: referencePokecampUrl(kind, label, id) || referenceWikiUrl(label),
      };
    });
}

function splitAbilityChain(value = "") {
  const cleaned = cleanPokecampInlineText(value)
    .replace(/推荐(?:的)?(?:能力点数|努力值|配点)(?:\s*[:：]?\s*)/gi, "")
    .replace(/能力点数推荐|推荐能力点数/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned
    .split(/\s*(?:→|->|=>)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pokecampConfigurationLinks(configurations = [], members = []) {
  const memberNames = new Map((members || []).map((member) => [strictKey(member.name || member.localizedName || member.slug), String(member.name || member.localizedName || member.slug || "").trim()]));
  const links = [];
  const seen = new Set();
  const add = (label, kind) => {
    const normalized = String(label || "").replace(/\s+/g, " ").trim();
    if (!normalized || normalized === "推荐能力点数" || normalized === "能力点数") return;
    const key = `${kind}:${strictKey(normalized)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const id = referenceTermId(kind, normalized);
    links.push({ text: normalized, kind, href: referencePokecampUrl(kind, normalized, id) || referenceWikiUrl(normalized) });
  };
  for (const configuration of configurations || []) {
    const pokemon = String(configuration.name || configuration.localizedName || configuration.slug || "").trim();
    const memberName = memberNames.get(strictKey(pokemon));
    add(memberName || pokemon, "pokemon");
    add(configuration.itemLabel || configuration.item, "item");
    for (const ability of splitAbilityChain(configuration.ability || configuration.abilityLabel || "")) add(ability, "ability");
    for (const move of Array.isArray(configuration.moves) ? configuration.moves : []) add(typeof move === "string" ? move : move?.name, "move");
  }
  return links;
}

function mergePokecampLinks(...groups) {
  const result = [];
  const seen = new Set();
  for (const group of groups) for (const link of Array.isArray(group) ? group : []) {
    if (!link?.text || !link?.kind) continue;
    const key = `${link.kind}:${strictKey(link.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}

function pokecampStrategySummary(team = {}) {
  const raw = String(team.strategy || team.description || "").replace(/\r/g, "").trim();
  if (!raw) return { text: "", complete: false, source: "missing" };
  const names = (team.members || []).map((member) => String(member.name || member.localizedName || member.slug || "").trim()).filter(Boolean);
  let cut = raw.length;
  for (const name of names) {
    if (!name) continue;
    const pattern = new RegExp(`(?:^|\\n)\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*(?:\\n[^\\n]{1,18}){1,3}\\n道具`, "m");
    const match = pattern.exec(raw);
    if (match && match.index < cut) cut = match.index;
  }
  const article = raw.slice(0, cut).replace(/\n{3,}/g, "\n\n").trim();
  const links = pokecampStrategyLinks(article, team.members || []);
  const parsedBlocks = pokecampStrategyBlocks(article);
  const headline = parsedBlocks[0]?.type === "paragraph" ? parsedBlocks[0].text : "";
  const published = (article.match(/(?:^|\n)\s*发布于\s*([^\n]+)/) || [])[1]?.trim() || "";
  const authorHandle = (article.match(/(?:^|\n)\s*(@[^\n\s]+)/) || [])[1]?.trim() || "";
  const blocks = parsedBlocks.map((block) => {
    if (block.type === "paragraph") return { ...block, text: block.text.replace(/^@[^\s]+\s+/, "").trim() };
    return block;
  }).filter((block, index) => {
    if (index === 0 && headline && block.text === headline) return false;
    if (/^发布于\s*/.test(block.text) || /^@[^\s]+$/.test(block.text)) return false;
    return true;
  });
  const content = blocks.map((block) => block.text).join("\n\n").trim();
  const text = content;
  const meaningful = text.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "").length;
  const complete = meaningful >= 80 || /战术与解说|组队思路|常规选出|基本选出|对策|首发/.test(text);
  return { text, blocks, links, complete, headline, published, authorHandle, source: complete ? "article" : "configuration-only" };
}

function referenceCategoryKey(category = "") {
  return ({ item: "items", items: "items", move: "moves", moves: "moves", ability: "abilities", abilities: "abilities", pokemon: "pokemon" })[String(category).toLowerCase()] || String(category).toLowerCase();
}

function referenceTermCategory(label = "") {
  const text = String(label || "").trim();
  const compact = strictKey(text);
  const dictionaries = candidateReferenceData.terms || {};
  for (const [category, dictionary] of Object.entries(dictionaries)) {
    if (!["pokemon", "moves", "abilities", "items"].includes(category)) continue;
    if (Object.entries(dictionary || {}).some(([key, value]) => strictKey(key) === compact || strictKey(value) === compact)) return category === "moves" ? "move" : category === "abilities" ? "ability" : category === "items" ? "item" : "pokemon";
  }
  if (Dex.species.get(text)?.exists || /^超级/.test(text)) return "pokemon";
  if (Dex.moves.get(text)?.exists) return "move";
  if (Dex.abilities.get(text)?.exists) return "ability";
  if (Dex.items.get(text)?.exists) return "item";
  return "move";
}

function referenceTermId(category, label = "") {
  const categoryKey = referenceCategoryKey(category);
  const text = String(label || "").trim();
  const dictionary = candidateReferenceData.terms?.[categoryKey] || {};
  const key = Object.keys(dictionary).find((candidate) => strictKey(candidate) === strictKey(text) || strictKey(dictionary[candidate]) === strictKey(text));
  if (key) return key;
  if (categoryKey === "pokemon") {
    const mega = text.match(/^超级\s*(.+)$/);
    if (mega) {
      const baseKey = Object.keys(dictionary).find((candidate) => strictKey(dictionary[candidate]) === strictKey(mega[1]));
      if (baseKey) return `${baseKey}-mega`;
    }
  }
  return strictKey(text);
}

function referenceWikiUrl(label = "") {
  return `https://wiki.52poke.com/wiki/${encodeURIComponent(String(label || "").trim())}`;
}

function referencePokecampUrl(category, label = "", id = "") {
  const route = { pokemon: "pokemon", moves: "moves", move: "moves", items: "items", item: "items", abilities: "abilities", ability: "abilities" }[String(category || "").toLowerCase()];
  if (!route) return "";
  const categoryKey = referenceCategoryKey(category);
  const raw = String(id || label || "").trim();
  if (!raw) return `https://pokecamp.cc/zh/${route}`;
  if (categoryKey === "pokemon") {
    const species = Dex.species.get(raw);
    if (species?.num > 0) return `https://pokecamp.cc/zh/pokemon/${encodeURIComponent(String(species.num))}`;
    if (/^\d+$/.test(raw)) return `https://pokecamp.cc/zh/pokemon/${encodeURIComponent(raw)}`;
  }
  const slugAliases = {
    flashfire: "flash-fire",
    focussash: "focus-sash",
    sitrusberry: "sitrus-berry",
    quickclaw: "quick-claw",
    leftovers: "leftovers",
  };
  const slug = slugAliases[strictKey(raw)] || raw
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[^a-zA-Z0-9\u3400-\u9fff-]/g, "")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `https://pokecamp.cc/zh/${route}/${encodeURIComponent(slug)}`;
}

function referencePokecampDetailUrls(category, label = "", id = "") {
  const categoryKey = referenceCategoryKey(category);
  const route = { pokemon: "pokemon", moves: "moves", abilities: "abilities", items: "items" }[categoryKey];
  if (!route) return [];
  const raw = String(id || label || "").trim();
  const terms = candidateReferenceData.terms?.[categoryKey] || {};
  const translatedKey = Object.keys(terms).find((key) => strictKey(key) === strictKey(raw) || strictKey(terms[key]) === strictKey(raw));
  const dexEntry = categoryKey === "pokemon" ? Dex.species.get(translatedKey || raw) : categoryKey === "moves" ? Dex.moves.get(translatedKey || raw) : categoryKey === "abilities" ? Dex.abilities.get(translatedKey || raw) : Dex.items.get(translatedKey || raw);
  const candidates = new Set();
  const add = (value) => { const text = String(value || "").trim(); if (text) candidates.add(text); };
  if (categoryKey === "pokemon") {
    const numeric = Number(dexEntry?.num || raw);
    if (Number.isFinite(numeric) && numeric > 0) add(String(numeric));
    add(dexEntry?.id);
    add(translatedKey);
    const megaMatch = String(label).match(/^超级\s*(.+)$/);
    if (megaMatch) {
      const baseKey = Object.keys(terms).find((key) => strictKey(terms[key]) === strictKey(megaMatch[1]));
      const base = Dex.species.get(baseKey || megaMatch[1]);
      add(base?.num);
      add(base?.id);
    }
  } else {
    add(dexEntry?.id);
    add(translatedKey);
    add(raw);
  }
  return [...candidates].map((candidate) => referencePokecampUrl(categoryKey, label, candidate));
}

function decodePokecampText(value = "") {
  return String(value || "")
    .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parsePokecampNextData(html = "") {
  const match = String(html).match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try { return JSON.parse(decodePokecampText(match[1])); } catch { return null; }
}

function pokecampDescriptionFromHtml(html = "") {
  const meta = String(html).match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  return decodePokecampText(meta?.[1] || "").replace(/\s+/g, " ").trim();
}

function pokecampAbsoluteAsset(url = "") {
  const value = String(url || "").trim();
  if (!value) return "";
  return value.startsWith("http") ? value : `https://pokecamp.cc${value.startsWith("/") ? "" : "/"}${value}`;
}

function pokecampPageRecord(category, pageProps = {}, html = "", url = "") {
  const categoryKey = referenceCategoryKey(category);
  const raw = pageProps?.[categoryKey === "moves" ? "move" : categoryKey === "abilities" ? "ability" : categoryKey === "items" ? "item" : "pokemon"] || {};
  if (!raw || typeof raw !== "object" || !Object.keys(raw).length) return null;
  const displayName = String(raw.nameZh || raw.displayName || raw.localizedName || raw.name || "").trim();
  const englishName = String(raw.nameEn || raw.identifier || raw.name || "").trim();
  const effectText = String(raw.effectText || raw.flavorText || pokecampDescriptionFromHtml(html) || "").trim();
  if (!displayName && !effectText) return null;
  const result = {
    id: String(raw.identifier || raw.id || strictKey(englishName || displayName)),
    name: displayName || englishName,
    localizedName: displayName || englishName,
    englishName,
    description: effectText,
    source: "PokéCamp",
    sourceUrl: url,
    href: url,
  };
  if (categoryKey === "moves") Object.assign(result, { basePower: raw.power || 0, accuracy: raw.accuracy || 0, pp: raw.pp || 0, priority: raw.priority || 0, type: raw.type || "", category: raw.damageClassLabel || raw.damageClass || "" });
  if (categoryKey === "abilities") Object.assign(result, { generation: raw.generationId || 0 });
  if (categoryKey === "pokemon") {
    const stats = Array.isArray(raw.stats) ? raw.stats : [];
    const statMap = { hp: "hp", attack: "atk", defense: "def", "special-attack": "spa", "special-defense": "spd", speed: "spe" };
    const baseStats = Object.fromEntries(stats.map((entry) => [statMap[entry?.stat?.name] || entry?.stat?.name, Number(entry?.base_stat || 0)]).filter(([key, value]) => key && value));
    const types = (raw.types || []).map((entry) => {
      const rawType = String(entry?.type?.name || entry?.name || "").trim();
      const titleType = rawType ? `${rawType[0].toUpperCase()}${rawType.slice(1)}` : "";
      return CANDIDATE_TYPE_LABELS[rawType] || CANDIDATE_TYPE_LABELS[titleType] || rawType;
    }).filter(Boolean);
    const abilities = (raw.abilities || []).map((entry) => ({ name: candidateTerm("abilities", entry?.ability?.name || entry?.name || ""), englishName: entry?.ability?.name || entry?.name || "", hidden: Boolean(entry?.is_hidden) })).filter((entry) => entry.name);
    const spriteUrl = pokecampAbsoluteAsset(raw.sprites?.other?.["official-artwork"]?.front_default || raw.sprites?.front_default);
    Object.assign(result, { types, baseStats, abilities, spriteUrl, spriteCandidates: [spriteUrl, `https://play.pokemonshowdown.com/sprites/gen5/${raw.identifier || result.id}.png`].filter(Boolean) });
  }
  return result;
}

async function persistPokecampReferenceRecord(category, record) {
  if (!record) return;
  const categoryKey = referenceCategoryKey(category);
  const next = { ...pokecampReferenceData, fetchedAt: new Date().toISOString(), records: { pokemon: {}, moves: {}, abilities: {}, items: {}, ...(pokecampReferenceData.records || {}) } };
  const key = String(record.id || strictKey(record.name || record.localizedName || ""));
  next.records[categoryKey] = { ...(next.records[categoryKey] || {}), [key]: record };
  next.sources = { ...(next.sources || {}), [categoryKey]: { ...(next.sources?.[categoryKey] || {}), url: POKECAMP_REFERENCE_SOURCES[categoryKey] || record.sourceUrl, fetchedAt: next.fetchedAt, count: Object.keys(next.records[categoryKey]).length } };
  pokecampReferenceData = next;
  pokecampReferenceWriteTask = pokecampReferenceWriteTask.then(async () => {
    await mkdir(join(ROOT, "data"), { recursive: true });
    await writeFile(POKECAMP_REFERENCE_DATA_PATH, JSON.stringify(next, null, 2), "utf8");
  }).catch(() => undefined);
  await pokecampReferenceWriteTask;
}

async function fetchPokecampDetail(category, label, id = "") {
  for (const url of referencePokecampDetailUrls(category, label, id)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { "user-agent": "Mozilla/5.0 ChampionForge/1.0", accept: "text/html" } });
      const html = await response.text();
      if (!response.ok) continue;
      const next = parsePokecampNextData(html);
      const record = pokecampPageRecord(category, next?.props?.pageProps || {}, html, url);
      if (record?.description && /[\u4e00-\u9fff]/.test(record.description)) {
        await persistPokecampReferenceRecord(category, record);
        return record;
      }
    } catch {}
  }
  return null;
}

function battleTermReference(category, value = "") {
  const label = String(value || "").trim();
  if (!label) return null;
  const categoryKey = referenceCategoryKey(category);
  const lookupLabel = label.split(/[→>]/)[0].trim();
  const terms = candidateReferenceData.terms?.[categoryKey] || {};
  const key = Object.keys(terms).find((candidate) => strictKey(candidate) === strictKey(lookupLabel) || String(terms[candidate]).trim() === lookupLabel);
  const id = key || strictKey(lookupLabel);
  const knowledge = candidateReferenceData.knowledge?.[categoryKey] || {};
  const entry = knowledge[id]
    || knowledge[strictKey(id)]
    || Object.entries(knowledge).find(([candidate]) => strictKey(candidate) === strictKey(id))?.[1]
    || Object.values(knowledge).find((item) => strictKey(item?.name) === strictKey(lookupLabel));
  const dexEntry = categoryKey === "moves" ? Dex.moves.get(id) : categoryKey === "items" ? Dex.items.get(id) : categoryKey === "abilities" ? Dex.abilities.get(id) : null;
  const wikiLabel = terms[lookupLabel] || candidateTerm(categoryKey, id) || lookupLabel;
  if (!entry && !dexEntry?.exists) return { id, label, name: wikiLabel, description: "暂无本地资料，悬停时将从 PokéCamp 获取。", href: referencePokecampUrl(categoryKey, wikiLabel, id) || referenceWikiUrl(wikiLabel), sourceUrl: referencePokecampUrl(categoryKey, wikiLabel, id) || referenceWikiUrl(wikiLabel), wikiUrl: referenceWikiUrl(wikiLabel) };
  const description = entry?.shortDesc || entry?.desc || dexEntry?.shortDesc || dexEntry?.desc || "暂无说明";
  return {
    id: entry?.id || dexEntry?.id || id,
    label,
    name: entry?.name || dexEntry?.name || candidateTerm(categoryKey, id) || label,
    englishName: dexEntry?.name || entry?.name || id,
    description,
    href: referencePokecampUrl(categoryKey, wikiLabel, id) || referenceWikiUrl(wikiLabel),
    sourceUrl: referencePokecampUrl(categoryKey, wikiLabel, id) || referenceWikiUrl(wikiLabel),
    wikiUrl: referenceWikiUrl(wikiLabel),
    type: dexEntry?.type || "",
    category: dexEntry?.category || "",
    basePower: dexEntry?.basePower || 0,
    accuracy: dexEntry?.accuracy || 0,
    pp: dexEntry?.pp || 0,
    priority: dexEntry?.priority || 0,
  };
}

function referencePokemonDetails(label = "") {
  const dictionary = candidateReferenceData.terms?.pokemon || {};
  const normalizedLabel = String(label || "").replace(/\s+/g, "").trim();
  const megaMatch = normalizedLabel.match(/^超级(.+)$/);
  const baseLabel = megaMatch?.[1] || normalizedLabel;
  const translatedKey = Object.keys(dictionary).find((key) => String(dictionary[key]).replace(/\s+/g, "") === baseLabel);
  const raw = translatedKey || baseLabel;
  const candidates = [
    ...(megaMatch ? [`${raw}-Mega`, `${raw}-Mega-X`, `${raw}-Mega-Y`] : []),
    raw, strictKey(raw), strictKey(raw).replace(/^mega/, ""),
  ].filter(Boolean);
  const species = candidates.map((candidate) => Dex.species.get(candidate)).find((entry) => entry?.exists);
  if (!species) return { name: label, description: "暂无本地资料，悬停时将从 PokéCamp 获取。", href: referencePokecampUrl("pokemon", label, raw) || referenceWikiUrl(label), sourceUrl: referencePokecampUrl("pokemon", label, raw) || referenceWikiUrl(label), wikiUrl: referenceWikiUrl(label) };
  const baseStats = { hp: species.baseStats?.hp || 0, atk: species.baseStats?.atk || 0, def: species.baseStats?.def || 0, spa: species.baseStats?.spa || 0, spd: species.baseStats?.spd || 0, spe: species.baseStats?.spe || 0 };
  const localizedAbilities = Object.values(species.abilities || {}).filter(Boolean).map((ability) => ({ name: candidateTerm("abilities", ability), englishName: ability }));
  const typeLabels = (species.types || []).map((type) => CANDIDATE_TYPE_LABELS[type] || type);
  const spriteCandidates = [
    `https://play.pokemonshowdown.com/sprites/gen5/${species.id}.png`,
    Number(species.num) > 0 ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${species.num}.png` : "",
  ].filter(Boolean);
  const localizedName = megaMatch ? `超级${dictionary[translatedKey] || baseLabel}` : dictionary[translatedKey] || label;
  return { id: species.id, name: localizedName, englishName: species.name, description: `${typeLabels.join(" / ")}属性 · 种族值总和 ${Object.values(baseStats).reduce((sum, value) => sum + Number(value || 0), 0)}`, href: referencePokecampUrl("pokemon", localizedName, species.num || species.id) || referenceWikiUrl(localizedName), sourceUrl: referencePokecampUrl("pokemon", localizedName, species.num || species.id) || referenceWikiUrl(localizedName), wikiUrl: referenceWikiUrl(localizedName), types: typeLabels, baseStats, abilities: localizedAbilities, spriteUrl: spriteCandidates[0] || "", spriteCandidates };
}

async function fetchReferenceTerm(category, value) {
  const categoryKey = referenceCategoryKey(category);
  const label = String(value || "").trim();
  if (!label) return null;
  const cacheKey = `${categoryKey}:${strictKey(label)}`;
  if (referenceTermCache.has(cacheKey)) return referenceTermCache.get(cacheKey);
  const records = pokecampReferenceData?.records?.[categoryKey] || {};
  const record = Object.values(records).find((item) => strictKey(item?.name) === strictKey(label) || strictKey(item?.localizedName) === strictKey(label) || strictKey(item?.id) === strictKey(label));
  if (record) {
    const localizedTypes = categoryKey === "pokemon" && Array.isArray(record.types) ? record.types.map((type) => {
      const rawType = String(type?.name || type || "").trim();
      const titleType = rawType ? `${rawType[0].toUpperCase()}${rawType.slice(1)}` : "";
      return CANDIDATE_TYPE_LABELS[rawType] || CANDIDATE_TYPE_LABELS[titleType] || rawType;
    }).filter(Boolean) : record.types;
    if (categoryKey === "pokemon" && JSON.stringify(localizedTypes) !== JSON.stringify(record.types)) await persistPokecampReferenceRecord(categoryKey, { ...record, types: localizedTypes });
    const result = { ...record, ...(localizedTypes ? { types: localizedTypes } : {}), name: record.localizedName || record.name || label, label, source: "PokéCamp", sourceUrl: record.sourceUrl || POKECAMP_REFERENCE_SOURCES[categoryKey] || referenceWikiUrl(label), href: record.sourceUrl || POKECAMP_REFERENCE_SOURCES[categoryKey] || referenceWikiUrl(label) };
    if (record.description && !/暂无资料|暂无本地资料|暂无说明/.test(record.description)) { referenceTermCache.set(cacheKey, result); return result; }
  }
  const local = categoryKey === "pokemon" ? referencePokemonDetails(label) : battleTermReference(categoryKey, label);
  const hasLocalDescription = local && local.description && /[\u4e00-\u9fff]/.test(local.description) && !/暂无本地资料|暂无说明/.test(local.description);
  const isMegaPokemon = categoryKey === "pokemon" && /^超级\s*/.test(label);
  const remote = !isMegaPokemon ? await fetchPokecampDetail(categoryKey, label, local?.id || referenceTermId(categoryKey, label)) : null;
  if (remote) {
    const result = { ...local, ...remote, label, name: remote.localizedName || remote.name || local?.name || label, source: "PokéCamp", sourceUrl: remote.sourceUrl, href: remote.href };
    referenceTermCache.set(cacheKey, result);
    return result;
  }
  if (hasLocalDescription) { referenceTermCache.set(cacheKey, local); return local; }
  const fallback = local
    ? { ...local, englishDescription: local.description, description: "暂无中文资料，悬停时将从 PokéCamp 获取。" }
    : { label, name: label, href: referenceWikiUrl(label), sourceUrl: referenceWikiUrl(label), description: "暂无中文资料，悬停时将从 PokéCamp 获取。" };
  try {
    const apiUrl = `https://wiki.52poke.com/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(fallback.name || label)}&format=json&origin=*`;
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "ChampionForge/1.0" } });
    const payload = await response.json();
    const page = Object.values(payload?.query?.pages || {})[0];
    const extract = String(page?.extract || "").trim();
    const result = { ...fallback, name: page?.title || fallback.name || label, description: extract || fallback.description, sourceUrl: referenceWikiUrl(page?.title || fallback.name || label), href: referenceWikiUrl(page?.title || fallback.name || label), source: "52Poké" };
    referenceTermCache.set(cacheKey, result);
    return result;
  } catch (error) {
    const result = { ...fallback, source: "52Poké", sourceError: error.message };
    referenceTermCache.set(cacheKey, result);
    return result;
  }
}

function readPokecampReferenceData() {
  try {
    const data = JSON.parse(readFileSync(POKECAMP_REFERENCE_DATA_PATH, "utf8"));
    return { records: { pokemon: {}, moves: {}, abilities: {}, items: {}, ...(data.records || {}) }, ...data };
  } catch {
    return { records: { pokemon: {}, moves: {}, abilities: {}, items: {} }, sources: {}, fetchedAt: "" };
  }
}

function mergeReferenceRecords(category, payload) {
  const records = {};
  const add = (value = {}) => {
    if (!value || typeof value !== "object") return;
    const name = String(value.localizedName || value.name || value.title || value.label || value.cnName || "").trim();
    if (!name || name.length > 120) return;
    const id = String(value.id || value.slug || value.key || strictKey(name)).trim();
    const description = String(value.description || value.desc || value.effect || value.shortDesc || value.effectText || "").replace(/\s+/g, " ").trim();
    records[id] = {
      id,
      name: String(value.name || value.slug || id),
      localizedName: String(value.localizedName || value.cnName || value.title || name),
      description,
      sourceUrl: String(value.sourceUrl || value.href || POKECAMP_REFERENCE_SOURCES[category] || ""),
      ...(value.types ? { types: value.types } : {}),
      ...(value.baseStats ? { baseStats: value.baseStats } : {}),
      ...(value.abilities ? { abilities: value.abilities } : {}),
      ...(value.spriteUrl ? { spriteUrl: value.spriteUrl } : {}),
      ...(value.basePower ? { basePower: value.basePower } : {}),
      ...(value.accuracy ? { accuracy: value.accuracy } : {}),
      ...(value.pp ? { pp: value.pp } : {}),
      ...(value.priority ? { priority: value.priority } : {}),
    };
  };
  const walk = (value, depth = 0) => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) { value.forEach((item) => walk(item, depth + 1)); return; }
    if (typeof value !== "object") return;
    if (value.name || value.localizedName || value.cnName || value.title) add(value);
    Object.values(value).forEach((item) => { if (item && typeof item === "object") walk(item, depth + 1); });
  };
  walk(payload.json);
  for (const item of payload.links || []) {
    const name = String(item.title || "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 80) continue;
    const sourceUrl = String(item.href || "");
    if (!sourceUrl || !new RegExp(`/zh/${category === "moves" ? "moves" : category}(?:/|$)`, "i").test(sourceUrl)) continue;
    add({ name, localizedName: name, slug: sourceUrl.split("/").filter(Boolean).pop(), sourceUrl });
  }
  return records;
}

async function syncPokecampReferenceData(categories = Object.keys(POKECAMP_REFERENCE_SOURCES)) {
  if (!pokecampBrowserPage || pokecampBrowserPage.isClosed()) return { ok: false, status: 409, error: "请先在数据中心打开并完成 PokéCamp 验证。" };
  const selected = categories.map((category) => referenceCategoryKey(category)).filter((category) => POKECAMP_REFERENCE_SOURCES[category]);
  const next = { ...pokecampReferenceData, fetchedAt: new Date().toISOString(), sources: { ...(pokecampReferenceData.sources || {}) }, records: { pokemon: {}, moves: {}, abilities: {}, items: {}, ...(pokecampReferenceData.records || {}) } };
  const summary = [];
  for (const category of selected) {
    const sourceUrl = POKECAMP_REFERENCE_SOURCES[category];
    await pokecampBrowserPage.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await pokecampBrowserPage.waitForTimeout(900);
    const gate = await pokecampBrowserPage.evaluate(() => ({ title: document.title, text: document.body?.innerText || "", url: location.href }));
    if (pokecampChallengePage(gate.title, gate.text)) {
      pokecampBrowserState = { ...pokecampBrowserState, status: "WAITING_FOR_HUMAN_VERIFICATION", challenge: true, pageTitle: gate.title, pageUrl: gate.url, lastError: "请在打开的 PokéCamp 页面完成一次验证后再同步资料。" };
      return { ok: false, status: 409, code: "WAITING_FOR_HUMAN_VERIFICATION", error: pokecampBrowserState.lastError, state: pokecampBrowserSnapshot() };
    }
    const payload = await pokecampBrowserPage.evaluate(() => {
      const json = [];
      for (const node of document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__, script[type="application/ld+json"]')) {
        const value = node.textContent?.trim();
        if (!value || value.length > 12_000_000) continue;
        try { json.push(JSON.parse(value)); } catch {}
      }
      const links = [...document.querySelectorAll("a[href]")].map((node) => ({ title: (node.textContent || "").replace(/\s+/g, " ").trim(), href: node.href })).filter((item) => item.title && item.href);
      return { json, links, text: (document.body?.innerText || "").slice(0, 200000) };
    });
    const records = mergeReferenceRecords(category, payload);
    if (!Object.keys(records).length && !payload.json.length && !payload.links.length) {
      pokecampBrowserState = { ...pokecampBrowserState, status: "FAILED", challenge: false, pageTitle: gate.title, pageUrl: gate.url, lastError: `未能从 PokéCamp ${category} 页面读取资料。` };
      return { ok: false, status: 503, error: pokecampBrowserState.lastError, state: pokecampBrowserSnapshot() };
    }
    next.records[category] = { ...(next.records[category] || {}), ...records };
    next.sources[category] = { url: sourceUrl, fetchedAt: next.fetchedAt, count: Object.keys(next.records[category]).length };
    summary.push({ category, count: Object.keys(records).length, total: Object.keys(next.records[category]).length, url: sourceUrl });
  }
  pokecampReferenceData = next;
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(POKECAMP_REFERENCE_DATA_PATH, JSON.stringify(next, null, 2), "utf8");
  referenceTermCache.clear();
  return { ok: true, fetchedAt: next.fetchedAt, summary, sources: next.sources };
}

async function handleReferenceApi(req, res) {
  const url = new URL(req.url || "/api/reference/status", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname.endsWith("/status")) { sendJson(res, 200, { ok: true, fetchedAt: pokecampReferenceData.fetchedAt, sources: pokecampReferenceData.sources, counts: Object.fromEntries(Object.entries(pokecampReferenceData.records || {}).map(([key, value]) => [key, Object.keys(value || {}).length])) }); return; }
  if (req.method === "POST" && url.pathname.endsWith("/sync")) { const body = await readJson(req).catch(() => ({})); sendJson(res, 200, await syncPokecampReferenceData(Array.isArray(body.categories) && body.categories.length ? body.categories : Object.keys(POKECAMP_REFERENCE_SOURCES))); return; }
  sendJson(res, 405, { ok: false, error: "未知的 PokéCamp 资料接口。" });
}

async function handleReferenceTermApi(req, res) {
  const url = new URL(req.url || "/api/reference/term", "http://127.0.0.1");
  const category = String(url.searchParams.get("category") || "").trim();
  const name = String(url.searchParams.get("name") || "").trim();
  if (!name || !["pokemon", "move", "moves", "item", "items", "ability", "abilities"].includes(category.toLowerCase())) {
    sendJson(res, 400, { ok: false, error: "资料分类或名称无效。" });
    return;
  }
  const reference = await fetchReferenceTerm(category, name);
  sendJson(res, 200, { ok: true, ...reference, category: referenceCategoryKey(category), label: name });
}

function pokecampLabeledBlock(raw = "", label = "", stopLabels = []) {
  const lines = String(raw || "").split(/\r?\n/).map((line) => cleanPokecampInlineText(line).trim()).filter(Boolean);
  const start = lines.findIndex((line) => line === label || line.startsWith(`${label}:`) || line.startsWith(`${label}：`));
  if (start < 0) return "";
  const firstLine = lines[start].slice(label.length).replace(/^\s*[:：]\s*/, "").trim();
  const stops = new Set(stopLabels);
  const values = [];
  if (firstLine) values.push(firstLine);
  for (let index = start + 1; index < lines.length; index += 1) {
    if (stops.has(lines[index])) break;
    values.push(lines[index]);
  }
  return values.join(" ").replace(/\s*(→|->|=>)\s*/g, " $1 ").replace(/\s+/g, " ").trim();
}

function pokecampStatsFromRaw(raw = "") {
  const block = pokecampLabeledBlock(raw, "能力点数", ["实数值", "招式", "道具", "性格", "特性", "太晶属性"]);
  if (!block || /推荐能力点数|能力点数推荐/.test(block)) return "";
  const inline = [...block.matchAll(/(HP|攻击|防御|特攻|特防|速度)\s*[:：]?\s*(\d+)/g)]
    .map((match) => `${match[1]} ${match[2]}`);
  if (inline.length) return inline.join(" / ");
  const lines = block.split(/\s+/).filter(Boolean);
  const result = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (/^(HP|攻击|防御|特攻|特防|速度)$/.test(lines[index]) && /^\d+$/.test(lines[index + 1])) result.push(`${lines[index]} ${lines[index + 1]}`);
  }
  return result.join(" / ");
}

function cleanStoredPokecampConfiguration(configuration = {}) {
  const raw = Array.isArray(configuration.notes) ? configuration.notes.join("\n") : String(configuration.notes || "");
  const cleanLine = (line) => cleanPokecampInlineText(line).replace(/\s+/g, " ").trim();
  const fallbackMoves = (Array.isArray(configuration.moves) ? configuration.moves : [])
    .map((move) => cleanLine(move))
    .filter((move) => move && move.length <= 18 && !/[。！？；，]/.test(move))
    .slice(0, 4);
  let moves = fallbackMoves;
  let notes = [];
  let noteLinks = [];
  let actualStats = "";
  let stats = typeof configuration.stats === "string" ? configuration.stats : "";
  const rawAbility = pokecampLabeledBlock(raw, "特性", ["能力点数", "努力值", "推荐能力点数", "道具", "性格", "招式", "太晶属性", "等级"]);
  const abilities = splitAbilityChain(rawAbility || configuration.ability || "");
  const ability = abilities.join(" → ");
  if (raw) {
    const actual = raw.match(/实数值\s*([0-9]+(?:\s*-\s*[0-9]+){5})/s);
    actualStats = actual?.[1]?.replace(/\s+/g, "") || "";
    stats = pokecampStatsFromRaw(raw) || stats;
    const lines = raw.split(/\r?\n/).map(cleanLine).filter(Boolean);
    const moveStart = lines.findIndex((line) => line === "招式");
    if (moveStart >= 0) {
      const parsedMoves = [];
      let noteStart = lines.length;
      for (let index = moveStart + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line) continue;
        const looksLikeNote = /[。！？；，]/.test(line) || line.length > 18 || /^(调整|以前|这个队伍|至少|连败|只要|不需要|被|和|剩下)/.test(line);
        if (looksLikeNote || parsedMoves.length >= 4) { noteStart = index; break; }
        parsedMoves.push(line);
      }
      if (parsedMoves.length) moves = parsedMoves;
      if (noteStart < lines.length) {
        const rawLines = raw.split(/\r?\n/);
        const sourceIndex = rawLines.findIndex((line) => cleanLine(line) === lines[noteStart]);
        const noteRawText = rawLines.slice(Math.max(0, sourceIndex)).join("\n").trim();
        const noteText = cleanPokecampInlineText(noteRawText).replace(/\s+/g, " ").trim();
        if (noteText) {
          notes = [noteText];
          noteLinks = pokecampStrategyLinks(noteRawText);
        }
      }
    }
  }
  const abilityReferences = abilities.map((item) => battleTermReference("abilities", item)).filter(Boolean);
  const result = {
    ...configuration,
    ability,
    abilities,
    abilityTransition: abilities.length > 1,
    stats,
    actualStats,
    moves,
    notes,
    noteLinks: mergePokecampLinks(noteLinks, pokecampConfigurationLinks([{ ...configuration, ability, abilities, moves }], [])),
    references: {
      item: battleTermReference("items", configuration.item),
      ability: abilityReferences[0] || battleTermReference("abilities", ability),
      abilities: abilityReferences,
      moves: moves.map((move) => battleTermReference("moves", move)).filter(Boolean),
    },
  };
  return result;
}

function readChampionDataFile() {
  try {
    return JSON.parse(readFileSync(CHAMPION_DATA_PATH, "utf8"));
  } catch {
    return { formats: {} };
  }
}

const CANDIDATE_CATEGORY_LABELS = {
  weather: "天气",
  speed: "控速",
  trickroom: "空间",
  support: "辅助",
  offense: "输出",
  endgame: "终盘",
};

const CANDIDATE_TYPE_LABELS = {
  Normal: "一般", Fire: "火", Water: "水", Electric: "电", Grass: "草", Ice: "冰",
  Fighting: "格斗", Poison: "毒", Ground: "地面", Flying: "飞行", Psychic: "超能力",
  Bug: "虫", Rock: "岩石", Ghost: "幽灵", Dragon: "龙", Dark: "恶", Steel: "钢", Fairy: "妖精",
};

const CANDIDATE_NATURE_LABELS = {
  Hardy: "勤奋", Lonely: "怕寂寞", Brave: "勇敢", Adamant: "固执", Naughty: "顽皮",
  Bold: "大胆", Docile: "坦率", Relaxed: "悠闲", Impish: "淘气", Lax: "乐天",
  Timid: "胆小", Hasty: "急躁", Serious: "认真", Jolly: "爽朗", Naive: "天真",
  Modest: "内敛", Mild: "慢吞吞", Quiet: "冷静", Bashful: "害羞", Rash: "马虎",
  Calm: "温和", Gentle: "温顺", Sassy: "自大", Careful: "慎重", Quirky: "浮躁",
};

function readCandidateReferenceData() {
  const fallback = { terms: { moves: {}, abilities: {}, items: {}, pokemon: {} }, knowledge: { pokemon: {} } };
  try { fallback.terms = JSON.parse(readFileSync(ZH_HANS_TERMS_PATH, "utf8")); } catch {}
  try { fallback.knowledge = JSON.parse(readFileSync(BATTLE_KNOWLEDGE_DATA_PATH, "utf8")); } catch {}
  return fallback;
}

const candidateReferenceData = readCandidateReferenceData();

function candidateTerm(category, value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const dictionary = candidateReferenceData.terms?.[category] || {};
  const lower = text.toLowerCase();
  const hyphenated = lower.replace(/[\s_]+/g, "-");
  const translated = dictionary[text] || dictionary[lower] || dictionary[hyphenated] || dictionary[strictKey(text)];
  if (translated) return translated;
  if (category === "items") {
    const megaMatch = strictKey(text).match(/^([a-z0-9]+)ite([xy])?$/);
    if (megaMatch) {
      const pokemonName = candidateReferenceData.terms?.pokemon?.[megaMatch[1]];
      if (pokemonName) return `${pokemonName}进化石${megaMatch[2]?.toUpperCase() || ""}`;
    }
  }
  return text;
}

function canonicalCandidateValue(category, value = "", modDex = Dex) {
  const text = String(value || "").trim();
  if (!text) return "";
  const aliases = candidateReferenceData.terms?.aliases?.[category] || {};
  const alias = aliases[text.toLowerCase()] || aliases[strictKey(text)] || text;
  const entry = modDex?.[category]?.get?.(alias);
  return entry?.exists ? entry.name : alias;
}

function canonicalCandidateConfiguration(configuration = {}, modDex = Dex) {
  return {
    ...configuration,
    item: canonicalCandidateValue("items", configuration.item, modDex),
    ability: canonicalCandidateValue("abilities", configuration.ability, modDex),
    nature: modDex.natures.get(configuration.nature)?.name || configuration.nature || "",
    moves: (configuration.moves || []).map((move) => canonicalCandidateValue("moves", move, modDex)).filter(Boolean),
  };
}

function candidateSpecies(modDex, value = "", meta = {}) {
  const raw = String(value || meta.slug || meta.name || "").trim();
  const candidates = [
    raw,
    raw.replace(/-female$/i, "-F").replace(/-male$/i, "-M"),
    ...showdownSpeciesVariants(raw),
    legalShowdownSpeciesName(raw, meta),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const species = modDex.species.get(candidate);
    if (species?.exists) return species;
  }
  return modDex.species.get(raw);
}

function candidateCategories(configuration = {}, species = {}, modDex = Dex) {
  const moveIds = (configuration.moves || []).map(strictKey);
  const abilityId = strictKey(configuration.ability);
  const categories = new Set();
  if (["drizzle", "drought", "sandstream", "snowwarning", "orichalcumpulse", "hadronengine"].includes(abilityId) || moveIds.some((id) => ["raindance", "sunnyday", "sandstorm", "snowscape"].includes(id))) categories.add("weather");
  if (moveIds.some((id) => ["tailwind", "icywind", "electroweb", "thunderwave", "rocktomb", "scaryface", "bulldoze", "stringshot", "glaciate"].includes(id))) categories.add("speed");
  if (moveIds.includes("trickroom")) categories.add("trickroom");
  if (["intimidate", "prankster", "friendguard", "armortail", "hospitality", "shadowtag", "arenatrap", "imposter"].includes(abilityId) || moveIds.some((id) => ["transform", "fakeout", "followme", "ragepowder", "helpinghand", "wideguard", "quickguard", "partingshot", "uturn", "voltswitch", "flipturn", "encore", "taunt", "spore", "reflect", "lightscreen", "allyswitch", "lifedew", "coaching", "willowisp", "snarl", "charm", "imprison", "batonpass"].includes(id))) categories.add("support");
  if (moveIds.some((id) => ["suckerpunch", "extremespeed", "aquajet", "grassyglide", "iceshard", "shadowsneak", "dragon dance", "dragondance", "swordsdance", "nastyplot", "quiverdance", "bulkup", "calmmind", "shellsmash"].includes(id))) categories.add("endgame");
  const damagingMoves = (configuration.moves || []).filter((move) => modDex.moves.get(move)?.category && modDex.moves.get(move).category !== "Status").length;
  if (damagingMoves >= 2) categories.add("offense");
  if (!categories.size) categories.add("support");
  return [...categories];
}

function candidateRole(categories = [], species = {}, configuration = {}) {
  const moveIds = (configuration.moves || []).map(strictKey);
  const abilityId = strictKey(configuration.ability);
  if (abilityId === "imposter" || moveIds.includes("transform")) return "复制应变";
  if (moveIds.includes("batonpass")) return "强化接力";
  const labels = [];
  if (categories.includes("weather")) labels.push("天气启动");
  if (categories.includes("trickroom")) labels.push("空间启动");
  if (categories.includes("speed")) labels.push("速度控制");
  if (moveIds.some((id) => ["followme", "ragepowder", "wideguard", "quickguard"].includes(id))) labels.push("掩护辅助");
  else if (abilityId === "intimidate" || moveIds.some((id) => ["fakeout", "partingshot", "uturn", "voltswitch", "flipturn"].includes(id))) labels.push("轮转辅助");
  else if (categories.includes("support")) labels.push("辅助干扰");
  if (categories.includes("endgame")) labels.push((configuration.moves || []).some((move) => ["Sucker Punch", "Extreme Speed", "Aqua Jet", "Grassy Glide", "Ice Shard", "Shadow Sneak"].includes(Dex.moves.get(move)?.name)) ? "先制终盘" : "强化终盘");
  if (categories.includes("offense") && labels.length < 2) {
    const atk = Number(species.baseStats?.atk || 0);
    const spa = Number(species.baseStats?.spa || 0);
    labels.push(atk > spa * 1.15 ? "物理输出" : spa > atk * 1.15 ? "特殊输出" : "混合输出");
  }
  return [...new Set(labels)].slice(0, 2).join(" / ") || "通用配置";
}

function localizedCandidateSet(configuration, species, modDex, { source = "实战样本", usageCount = 1 } = {}) {
  const categories = candidateCategories(configuration, species, modDex);
  const moves = (configuration.moves || []).map((move) => modDex.moves.get(move)?.name || move).filter(Boolean).slice(0, 4);
  const ability = modDex.abilities.get(configuration.ability)?.name || configuration.ability || "";
  const item = modDex.items.get(configuration.item)?.name || configuration.item || "";
  const nature = modDex.natures.get(configuration.nature)?.name || configuration.nature || "";
  return {
    id: createHash("sha1").update([species.id, item, ability, nature, configuration.stats || configuration.evs || "", ...moves].join("|")).digest("hex").slice(0, 12),
    role: candidateRole(categories, species, { ...configuration, moves }),
    categories,
    item,
    itemLabel: candidateTerm("items", item),
    ability,
    abilityLabel: candidateTerm("abilities", ability),
    nature,
    natureLabel: CANDIDATE_NATURE_LABELS[nature] || nature,
    stats: configuration.stats || configuration.evs || "",
    moves,
    moveLabels: moves.map((move) => candidateTerm("moves", move)),
    source,
    usageCount,
  };
}

function fallbackCandidateConfiguration(species, snapshot, modDex) {
  const baseSpecies = modDex.species.get(species.baseSpecies || species.name);
  const knowledge = candidateReferenceData.knowledge?.pokemon?.[species.id] || candidateReferenceData.knowledge?.pokemon?.[baseSpecies.id] || {};
  const models = Object.entries(knowledge.smogon || {});
  const preferredModel = models.find(([key]) => snapshot.battleType === "double" ? /double|vgc/i.test(key) : /ou|uu|battle/i.test(key))?.[1] || models[0]?.[1] || {};
  const requiredItems = species.requiredItems || species.requiredItem ? [...(species.requiredItems || []), species.requiredItem].filter(Boolean) : [];
  const abilities = [...(preferredModel.abilities || []).map((entry) => entry.name), ...Object.values(baseSpecies.abilities || {})].filter(Boolean);
  const items = [...requiredItems, ...(preferredModel.items || []).map((entry) => entry.name), "Leftovers", "Focus Sash"].filter((item) => item && strictKey(item) !== "nothing");
  let learnset = {};
  try { learnset = modDex.species.getLearnsetData(baseSpecies.id)?.learnset || {}; } catch {}
  const currentMoves = Object.entries(learnset).filter(([, sources]) => (sources || []).some((source) => String(source).startsWith("9"))).map(([move]) => move);
  const preferredMoves = (preferredModel.moves || []).map((entry) => entry.name);
  const movePool = [...preferredMoves, "Protect", ...currentMoves]
    .map((move) => modDex.moves.get(move)?.name || "")
    .filter((move, index, array) => move && array.indexOf(move) === index);
  const physical = Number(baseSpecies.baseStats?.atk || 0) >= Number(baseSpecies.baseStats?.spa || 0);
  const nature = physical ? "Jolly" : "Timid";
  const stats = physical ? "H2/A32/S32" : "H2/C32/S32";
  for (const ability of abilities.slice(0, 4)) {
    for (const item of items.slice(0, 8)) {
      for (let start = 0; start < Math.min(8, Math.max(1, movePool.length - 3)); start += 1) {
        const moves = movePool.slice(start, start + 4);
        if (moves.length < 4) continue;
        const configuration = { slug: baseSpecies.id, item, ability, nature, stats, moves };
        if (strictShowdownCandidateIsLegal(configuration, snapshot.battleType, snapshot.rulesetId)) return configuration;
      }
    }
  }
  return null;
}

function rulesCandidatePool(snapshot) {
  const cacheKey = `pool|${snapshot.rulesetId}`;
  if (rulesCandidatePoolCache.has(cacheKey)) return rulesCandidatePoolCache.get(cacheKey);
  const format = snapshot.battleType === "double" ? "double" : "single";
  const formatData = readChampionDataFile()?.formats?.[format] || {};
  const ranked = formatData.pokemon || [];
  const modDex = Dex.mod(Dex.formats.get(snapshot.showdownFormatId).mod || "base");
  const officialPool = officialRegulationPool(snapshot.regulation);
  const officialSpeciesIds = officialPool
    ? new Set(officialPool.entries.flatMap((entry) => entry.showdownIds || []).map(strictKey))
    : new Set();
  const configurations = readTeamDataFile()
    .filter((team) => team.format === format)
    .flatMap((team) => team.configurations || []);
  const configurationGroups = new Map();
  const megaItemIds = new Set(modDex.species.all().flatMap((species) => [...(species.requiredItems || []), species.requiredItem].filter(Boolean).map(strictKey)));
  for (const config of configurations) {
    const normalizedConfig = canonicalCandidateConfiguration(config, modDex);
    const species = candidateSpecies(modDex, normalizedConfig.slug || normalizedConfig.name, normalizedConfig);
    if (!species?.exists || !strictShowdownCandidateIsLegal(normalizedConfig, format, snapshot.rulesetId)) continue;
    const familyId = modDex.species.get(species.baseSpecies || species.name).id || species.id;
    const configKey = [familyId, strictKey(normalizedConfig.item), strictKey(normalizedConfig.ability), ...(normalizedConfig.moves || []).map(strictKey).sort()].join("|");
    const existing = configurationGroups.get(configKey);
    if (existing) existing.usageCount += 1;
    else configurationGroups.set(configKey, { speciesId: species.id, familyId, configuration: normalizedConfig, usageCount: 1 });
  }
  const pool = ranked.flatMap((entry) => {
    const species = candidateSpecies(modDex, entry.slug || entry.name, entry);
    if (!species?.exists) return [];
    if (!officialSpeciesIds.has(strictKey(species.id))) return [];
    const baseSpecies = modDex.species.get(species.baseSpecies || species.name);
    const familyId = baseSpecies.id || species.id;
    const requiredItemIds = new Set([...(species.requiredItems || []), species.requiredItem].filter(Boolean).map(strictKey));
    const observed = [...configurationGroups.values()].filter((group) => {
      if (group.familyId !== familyId) return false;
      const itemId = strictKey(group.configuration.item);
      if (requiredItemIds.size) return requiredItemIds.has(itemId);
      if (species.id !== baseSpecies.id) return group.speciesId === species.id;
      return group.speciesId === baseSpecies.id && !megaItemIds.has(itemId);
    });
    let sets = observed
      .sort((a, b) => b.usageCount - a.usageCount)
      .map((group) => localizedCandidateSet(group.configuration, species, modDex, { usageCount: group.usageCount }));
    if (!sets.length) {
      const fallback = fallbackCandidateConfiguration(species, snapshot, modDex);
      if (fallback) sets = [localizedCandidateSet(fallback, species, modDex, { source: "规则生成", usageCount: 0 })];
    }
    if (!sets.length) return [];
    const categories = [...new Set(sets.flatMap((set) => set.categories))];
    const distinctRoles = [...new Set(sets.map((set) => set.role))];
    return [{
      id: strictKey(entry.slug || species.id),
      showdownSpecies: species.name,
      teamSpecies: requiredItemIds.size ? baseSpecies.name : species.name,
      name: species.name,
      localizedName: entry.name || species.name,
      dex: String(species.num || entry.id || ""),
      sprite: species.num > 0 ? species.num : Number(entry.id || 0),
      spriteUrl: entry.sprite || "",
      types: species.types || [],
      typeLabels: (species.types || []).map((type) => CANDIDATE_TYPE_LABELS[type] || type),
      role: distinctRoles.length === 1 ? distinctRoles[0] : categories.map((category) => CANDIDATE_CATEGORY_LABELS[category]).slice(0, 3).join(" · "),
      categories,
      rank: Number(entry.rank || 0),
      meta: entry.rank ? `${formatData.season || "环境"} #${entry.rank}` : "当前规则可用",
      sets,
      setTotal: sets.length,
      legal: true,
    }];
  });
  rulesCandidatePoolCache.set(cacheKey, pool);
  return pool;
}

async function handleRulesCandidatesApi(req, res) {
  const url = new URL(req.url || "/api/rules/candidates", "http://127.0.0.1");
  const format = url.searchParams.get("format") === "single" ? "single" : "double";
  const snapshot = ruleRegistry.operational({ format, rulesetId: String(url.searchParams.get("rulesetId") || "") });
  const query = String(url.searchParams.get("query") || "").trim().toLowerCase();
  const category = String(url.searchParams.get("category") || "all");
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 24)));
  const pool = rulesCandidatePool(snapshot);
  const officialPool = officialRegulationPool(snapshot.regulation);
  const sourceTotal = readChampionDataFile()?.formats?.[format]?.pokemon?.length || pool.length;
  const filtered = pool.flatMap((item) => {
    const itemText = [item.name, item.localizedName, item.role, item.meta, ...(item.types || []), ...(item.typeLabels || [])].join(" ").toLowerCase();
    const matchingSets = item.sets.filter((set) => {
      const matchesCategory = category === "all" || set.categories.includes(category);
      const setText = [set.role, set.item, set.itemLabel, set.ability, set.abilityLabel, set.nature, set.natureLabel, ...(set.moves || []), ...(set.moveLabels || [])].join(" ").toLowerCase();
      return matchesCategory && (!query || itemText.includes(query) || setText.includes(query));
    });
    return matchingSets.length ? [{ ...item, sets: matchingSets }] : [];
  });
  const configurationTotal = pool.reduce((sum, item) => sum + item.sets.length, 0);
  const matchedConfigurationTotal = filtered.reduce((sum, item) => sum + item.sets.length, 0);
  sendJson(res, 200, {
    ok: true,
    ...rulesetMetadata(snapshot),
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    poolTotal: pool.length,
    officialPoolCount: officialPool?.entries?.length || 0,
    officialPoolSourceUrl: officialPool?.sourceUrl || "",
    sourceTotal,
    excludedTotal: Math.max(0, sourceTotal - pool.length),
    configurationTotal,
    matchedConfigurationTotal,
    offset,
    limit,
    hasMore: offset + limit < filtered.length,
  });
}

function strictKey(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

function strictFamilyKey(value = "") {
  const raw = strictKey(value);
  const species = SHOWDOWN_SPECIES_BY_ID.get(raw);
  const baseSpecies = strictKey(species?.baseSpecies || "");
  if (baseSpecies) return baseSpecies;
  return raw
    .replace(/mega[xy]?$/i, "")
    .replace(/gmax$/i, "")
    .replace(/(alola|alolan|galar|galarian|hisui|hisuian|paldea|paldean|female|male|midday|midnight|dusk)$/i, "");
}

function strictVariationScore(value = "", seed = "") {
  if (!seed) return 0;
  let hash = 2166136261;
  for (const char of `${seed}:${value}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 47;
}

function strictText(member = {}) {
  return [member.name, member.slug, member.item, member.ability, ...(member.moves || [])].join(" ").toLowerCase();
}

function strictTypesFor(slug = "") {
  const species = SHOWDOWN_SPECIES_BY_ID.get(String(slug || "").replace(/[^a-z0-9]/gi, "").toLowerCase());
  return Array.isArray(species?.types) ? species.types : [];
}

function strictBaseSpeedFor(slug = "") {
  const species = SHOWDOWN_SPECIES_BY_ID.get(String(slug || "").replace(/[^a-z0-9]/gi, "").toLowerCase());
  return Number(species?.baseStats?.spe || 0);
}

const STRICT_ATTACK_TYPES = Dex.types.all().map((type) => type.name).filter((type) => type && type !== "Stellar");
const STRICT_TYPE_MULTIPLIER_CACHE = new Map();
function strictTypeMultiplier(member = {}, attackType = "") {
  const cacheKey = `${member.slug || ""}|${member.item || ""}|${member.ability || ""}|${attackType}`;
  if (STRICT_TYPE_MULTIPLIER_CACHE.has(cacheKey)) return STRICT_TYPE_MULTIPLIER_CACHE.get(cacheKey);
  const text = strictText(member);
  if (attackType === "Ground" && /levitate|air-balloon/.test(text)) {
    STRICT_TYPE_MULTIPLIER_CACHE.set(cacheKey, 0);
    return 0;
  }
  let multiplier = 1;
  for (const defenseType of member.types?.length ? member.types : strictTypesFor(member.slug)) {
    const relation = Dex.types.get(defenseType)?.damageTaken?.[attackType] || 0;
    if (relation === 3) {
      STRICT_TYPE_MULTIPLIER_CACHE.set(cacheKey, 0);
      return 0;
    }
    if (relation === 1) multiplier *= 2;
    if (relation === 2) multiplier *= 0.5;
  }
  STRICT_TYPE_MULTIPLIER_CACHE.set(cacheKey, multiplier);
  return multiplier;
}

function strictDefenseMultiplier(member = {}, attackType = "") {
  return member.defense?.[attackType] ?? strictTypeMultiplier(member, attackType);
}

function strictIsMegaItem(item = "") {
  const value = String(item || "").trim().toLowerCase();
  return /进化石/.test(value) || (/[a-z0-9]+ite(?:-[xy])?$/.test(value) && value !== "eviolite");
}

function strictTags(member = {}, format = "single") {
  const text = strictText(member);
  const tags = new Set();
  const add = (tag, pattern) => pattern.test(text) && tags.add(tag);
  add("pivot", /u-turn|volt-switch|parting-shot|flip-turn|teleport|chilly-reception/);
  // A Choice Scarf, priority move, or weather speed ability only improves that
  // member's own speed. Keep it separate from moves that actually control the
  // turn order for teammates, otherwise reports invent false team synergies.
  add("speed-control", /tailwind|trick-room|thunder-wave|icy-wind|electroweb|sticky-web|scary-face/);
  add("speed", /tailwind|trick-room|thunder-wave|icy-wind|electroweb|sticky-web|choice-scarf|swift-swim|chlorophyll|sand-rush|slush-rush|priority/);
  add("protect", /protect|wide-guard|quick-guard|follow-me|rage-powder|fake-out/);
  add("hazard", /stealth-rock|spikes|toxic-spikes|sticky-web/);
  add("removal", /rapid-spin|mortal-spin|defog|tidy-up/);
  add("status", /will-o-wisp|toxic|yawn|thunder-wave|encore|taunt|light-screen|reflect|aurora-veil/);
  add("recovery", /recover|roost|slack-off|synthesis|moonlight|shore-up|drain-punch|leech-seed/);
  add("setup", /swords-dance|nasty-plot|calm-mind|dragon-dance|bulk-up|iron-defense|belly-drum|focus-energy/);
  add("priority", /extreme-speed|sucker-punch|aqua-jet|mach-punch|bullet-punch|shadow-sneak|ice-shard|jet-punch/);
  if (tags.has("priority")) tags.add("speed");
  add("intimidate", /intimidate/);
  add("prankster", /prankster/);
  add("wallbreaker", /choice-band|choice-specs|life-orb|booster-energy|dragon-dance|swords-dance|nasty-plot|belly-drum/);
  const damagingMoves = (member.moves || []).map((move) => Dex.moves.get(move)).filter((move) => move?.exists && move.category !== "Status" && Number(move.basePower || 0) >= 70);
  if (damagingMoves.length >= 2) tags.add("wallbreaker");
  if (format === "double" && /heat-wave|rock-slide|dazzling-gleam|earthquake|surf|blizzard|hyper-voice|muddy-water/.test(text)) tags.add("spread");
  if (/regenerator|intimidate|levitate|water-absorb|flash-fire|lightning-rod|thick-fat|unaware/.test(text) || tags.has("recovery")) tags.add("defensive");
  if (tags.has("pivot") || tags.has("protect") || tags.has("intimidate") || tags.has("defensive")) tags.add("safe-entry");
  if (tags.has("wallbreaker") || tags.has("setup") || tags.has("priority")) tags.add("wincon");
  return tags;
}

const STRICT_THEMES = ["sun", "rain", "sand", "snow", "trick-room", "tailwind", "pass-chain"];
const STRICT_THEME_LABELS = { sun: "晴天", rain: "雨天", sand: "沙暴", snow: "雪天", "trick-room": "戏法空间", tailwind: "顺风", "pass-chain": "强化接棒" };
function strictThemeLabel(theme = "") {
  return STRICT_THEME_LABELS[theme] || String(theme || "体系");
}

function strictGoalMatchesPokemon(goal = "", candidate = {}) {
  if (strictGoalExplicitlyForbids(goal, candidate)) return false;
  const rawGoal = String(goal || "");
  const chineseGoal = rawGoal.replace(/[^\u3400-\u9fff]+/g, "");
  const chineseName = String(candidate.name || "").replace(/[^\u3400-\u9fff]+/g, "");
  const slug = String(candidate.slug || "").trim();
  return (
    (chineseName.length >= 2 && chineseGoal.includes(chineseName)) ||
    (slug.length >= 4 && new RegExp(`(?:^|[^a-z0-9])${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i").test(rawGoal))
  );
}

function strictUniquePokemonRefs(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = strictKey(entry?.slug || entry?.id || entry?.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function strictAvoidedTeamFamilies(value = []) {
  const entries = Array.isArray(value) ? value : String(value || "").split(/[、,，/\n]+/);
  return new Set(entries.map((item) => strictFamilyKey(typeof item === "object" ? item.slug || item.name || item.id : item)).filter(Boolean));
}

function strictAvoidedTeamFamilySets(value = [], fallback = []) {
  const rawTeams = Array.isArray(value) && value.some((item) => Array.isArray(item))
    ? value
    : fallback?.length
      ? [fallback]
      : [];
  return rawTeams
    .map((team) => strictAvoidedTeamFamilies(team))
    .filter((families) => families.size);
}

function strictIsDistinctFromAvoidedTeam(team = [], constraints = {}) {
  const avoidedTeams = constraints.avoidTeamFamilySets?.length
    ? constraints.avoidTeamFamilySets
    : constraints.avoidTeamFamilies?.size
      ? [constraints.avoidTeamFamilies]
      : [];
  // Every previous result must differ by at least two members. Comparing each
  // team independently avoids the false failures caused by merging histories.
  const maxShared = Math.max(0, Math.min(5, Number(constraints.maxSharedWithAvoided ?? 4)));
  return avoidedTeams.every((avoided) => team.filter((member) => avoided.has(strictFamilyKey(member.slug))).length <= maxShared);
}

function strictThemeInfo(member = {}, theme = "") {
  const text = strictText(member);
  const has = (pattern) => pattern.test(text);
  // A system exists only when the selected configuration can actually activate or
  // exploit it. Species names are deliberately excluded: a Pelipper without
  // Drizzle and Rain Dance is not a rain setter for this build.
  if (theme === "sun") return { source: has(/drought|sunny-day/), abuser: has(/chlorophyll|solar-power|solar-beam|weather-ball|heat-wave|eruption/) };
  if (theme === "rain") return { source: has(/drizzle|rain-dance/), abuser: has(/swift-swim|thunder|hurricane|electro-shot|weather-ball|hydro-pump|wave-crash/) };
  if (theme === "sand") return { source: has(/sand-stream|sandstorm/), abuser: has(/sand-rush|sand-force/) };
  if (theme === "snow") return { source: has(/snow-warning|snowscape/), abuser: has(/slush-rush|aurora-veil|blizzard/) };
  if (theme === "trick-room") {
    const hasSlowDamage = strictBaseSpeedFor(member.slug) <= 65 && (member.moves || []).some((move) => {
      const data = Dex.moves.get(move);
      return data?.exists && data.category !== "Status" && Number(data.basePower || 0) >= 70;
    });
    return { source: has(/trick-room/), abuser: hasSlowDamage };
  }
  if (theme === "tailwind") return { source: has(/tailwind/), abuser: Number(member.speed || 0) >= 70 || has(/choice-scarf|protosynthesis|quark-drive/) };
  if (theme === "pass-chain") return {
    source: has(/baton-pass/) && has(/swords-dance|nasty-plot|calm-mind|iron-defense|agility|focus-energy|bulk-up|belly-drum/),
    abuser: !has(/baton-pass/) && ((member.tags || strictTags(member)).has("wincon") || has(/choice-band|choice-specs|life-orb|priority/)),
  };
  return { source: false, abuser: false };
}

function strictPassReceiverScore(member = {}) {
  const tags = member.tags || strictTags(member);
  const text = strictText(member);
  let score = 0;
  if (tags.has("wallbreaker")) score += 42;
  if (tags.has("setup")) score += 26;
  if (tags.has("priority")) score += 18;
  if (member.mega) score += 12;
  if (/choice-band|choice-specs|life-orb|booster-energy/.test(text)) score += 14;
  if (/fake-out|parting-shot|will-o-wisp|light-screen|reflect/.test(text)) score -= 18;
  if (tags.has("defensive") && !tags.has("setup")) score -= 8;
  return score;
}

function strictPassReceiver(team = [], passer = null) {
  return team
    .filter((member) => member !== passer && strictThemeInfo(member, "pass-chain").abuser)
    .sort((a, b) => strictPassReceiverScore(b) - strictPassReceiverScore(a))[0] || null;
}

function strictRequirementKey(value = "") {
  if (typeof value !== "object" || !value) return strictKey(value);
  return strictKey(value.name || value.slug || value.id || value.move || value.item || value.ability || value.value || "");
}

function strictRequirementLabel(value = "") {
  if (typeof value !== "object" || !value) return String(value || "");
  return String(value.name || value.slug || value.id || value.move || value.item || value.ability || value.value || "未命名要求");
}

function strictRequirementOwnerKey(value = "") {
  if (typeof value !== "object" || !value) return "";
  return strictKey(value.pokemonSlug || value.pokemon || value.memberSlug || value.owner || "");
}

function strictMemberMatchesRequirement(member = {}, category = "", value = "") {
  const required = strictRequirementKey(value);
  if (!required) return false;
  const owner = strictRequirementOwnerKey(value);
  if (owner && strictKey(member.slug) !== owner) return false;
  if (category === "moves") return (member.moves || []).some((move) => strictKey(move) === required);
  if (category === "items") return strictKey(member.item) === required;
  if (category === "abilities") return strictKey(member.ability) === required;
  return false;
}

function strictGoalExplicitlyForbids(goal = "", candidate = {}) {
  const compactGoal = String(goal || "").toLowerCase().replace(/\s+/g, "");
  return [candidate.name, candidate.slug]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().replace(/\s+/g, ""))
    .some((value) => ["不要", "禁用", "不用"].some((prefix) => compactGoal.includes(`${prefix}${value}`)));
}

function strictFeedbackPriorities(history = []) {
  const priorities = new Set();
  const notes = [];
  for (const item of Array.isArray(history) ? history : []) {
    if (item?.eligibleForBuildFeedback === false) continue;
    const text = [item.feedbackSignals, item.avoid, item.actionTags, item.badOpponents, ...(item.failureReasons || [])].filter(Boolean).join(" ").toLowerCase();
    if (!text) continue;
    if (/missing[-\s]?speed|控速|speed[-\s]?control|tailwind|trick[-\s]?room/.test(text)) priorities.add("speed");
    if (/missing[-\s]?protect|保护|protect|集火/.test(text)) priorities.add("protect");
    if (/missing[-\s]?(pivot|safe[-\s]?entry)|安全上场|换入|转场|pivot/.test(text)) priorities.add("safe-entry");
    if (/missing[-\s]?spread|范围招|spread/.test(text)) priorities.add("spread");
    if ((Number(item.winRate || 100) < 50 || /实战负|loss/.test(text)) && notes.length < 3) notes.push(String(item.avoid || item.feedbackSignals || "实战回放暴露结构压力。"));
  }
  return { priorities: [...priorities], notes: [...new Set(notes)] };
}

const AGENT_FAILURE_CODES = {
  LEAD_MISMATCH: "首发与对手节奏不匹配",
  SPEED_CONTROL_MISSING: "缺少可执行的速度控制",
  SPEED_TIE_LOST: "关键速度线落后",
  UNSAFE_ENTRY: "缺少安全上场或轮换入口",
  WRONG_TARGET: "目标选择暴露了交换价值",
  IMMUNITY_CLICK: "攻击打在免疫或无效目标上",
  DAMAGE_CHECK_FAILED: "输出不足以完成关键击杀",
  PREMATURE_TERA: "过早消耗关键资源",
  SETUP_GREED: "强化回合贪多导致不可逆损失",
  RESOURCE_MISUSE: "保护、天气或终盘资源使用不当",
  ENDGAME_MISSED: "终盘路线没有兑现",
  FALLBACK_ACTION: "策略回退或非法动作",
  TIMEOUT: "超时或连接中断",
};

function agentLineText(trace = {}) {
  return (trace.events || [])
    .map((event) => event.line || event.command || JSON.stringify(event))
    .join("\n");
}

function agentActionList(trace = {}) {
  return (trace.actions || [])
    .filter((event) => event.type === "agent-action")
    .map((event) => String(event.command || ""));
}

function agentTraceFailureAttribution(trace = {}) {
  const text = agentLineText(trace);
  const actions = agentActionList(trace);
  const result = String(trace.result || "unknown");
  const failures = [];
  const add = (code, turn, confidence, evidence, repairTargets) => failures.push({
    code,
    label: AGENT_FAILURE_CODES[code] || code,
    turn: Number(turn || 0),
    confidence,
    evidence,
    repairTargets,
  });
  if (actions.some((item) => /default|random/i.test(item))) add("FALLBACK_ACTION", trace.turns, 0.98, ["真实 trace 记录到了 default/random 动作"], ["policy", "legalActionMask"]);
  if (/time|forfeit|disconnected|outoftime/i.test(text) && /timeout|forfeit|disconnected/i.test(`${text} ${trace.result}`)) add("TIMEOUT", trace.turns, 0.96, ["回放或 trace 出现超时/投降/断线信号"], ["connection", "timer"]);
  if (result === "loss") {
    const hasSpeed = /tailwind|trick room|icy wind|electroweb|thunder wave|glare|rock tomb|bulldoze/i.test(text);
    const hasProtect = /protect|detect|spiky shield|king's shield|wide guard/i.test(text);
    const hasSwitch = /\|(switch|drag)\|/i.test(text);
    if (!hasSpeed) add("SPEED_CONTROL_MISSING", 1, 0.66, ["整场公开日志未出现控速动作"], ["speedControl", "speedPlan"]);
    if (!hasSwitch) add("UNSAFE_ENTRY", Math.max(1, Number(trace.turns || 1) - 1), 0.58, ["失败对局没有记录安全轮换"], ["pivot", "defensiveSwitch", "protect"]);
    if (!hasProtect && /double|vgc/i.test(String(trace.battleType || ""))) add("RESOURCE_MISUSE", 1, 0.53, ["双打公开日志未出现保护/广域防守"], ["protect", "wideGuard"]);
    const firstFaint = text.match(/\|faint\|([^\n]+)/i);
    if (firstFaint && Number(trace.turns || 0) <= 3) add("LEAD_MISMATCH", 1, 0.7, [`前 3 回合内出现首个击倒：${firstFaint[1]}`], ["lead", "leadMatchup"]);
    if (/immune|\|-immune\|/i.test(text)) add("IMMUNITY_CLICK", 0, 0.74, ["公开日志记录到了免疫事件"], ["targeting", "moveCoverage"]);
    if (/tera|terastallize|mega/i.test(text) && Number(trace.turns || 0) <= 2) add("PREMATURE_TERA", 1, 0.55, ["前两回合使用了关键形态资源"], ["resourcePlan", "endgame"]);
    if (/boost|quiver dance|swords dance|nasty plot|calm mind|dragon dance/i.test(text) && /faint/i.test(text)) add("SETUP_GREED", 0, 0.54, ["强化行为与随后击倒同时出现"], ["setupTiming", "protect"]);
  }
  if (result === "loss" && !failures.length) add("ENDGAME_MISSED", trace.turns, 0.42, ["结果为负但公开日志没有足够细节定位更早错误"], ["endgame", "policySearch"]);
  return failures;
}

function agentActionTags(trace = {}) {
  const text = agentLineText(trace);
  const tags = {};
  const add = (key, pattern) => { const count = (text.match(pattern) || []).length; if (count) tags[key] = count; };
  add("speed-control", /tailwind|trick room|icy wind|electroweb|thunder wave|glare/gi);
  add("protect", /protect|detect|spiky shield|king's shield|wide guard/gi);
  add("pivot", /u-turn|volt switch|flip turn|parting shot|chilly reception/gi);
  add("setup", /swords dance|nasty plot|dragon dance|quiver dance|calm mind|bulk up/gi);
  add("switch", /\|(switch|drag)\|/gi);
  add("faint", /\|faint\|/gi);
  add("fallback", /default|random/gi);
  return tags;
}

async function readAgentJsonFiles(root) {
  try {
    const names = (await readdir(root)).filter((name) => name.endsWith(".json"));
    return (await Promise.all(names.map(async (name) => {
      try { return JSON.parse(await readFile(join(root, name), "utf8")); } catch { return null; }
    }))).filter(Boolean);
  } catch { return []; }
}

async function readAgentTraces(rulesetId = "") {
  const root = join(AGENT_DATA_ROOT, "traces", rulesetId);
  return (await readAgentJsonFiles(root)).filter((item) => item.rulesetId === rulesetId);
}

function aggregateAgentLearning(traces = [], rulesetId = "", format = "single") {
  const scoped = traces.filter((trace) => trace.rulesetId === rulesetId && (format !== "double" ? trace.battleType !== "double" : trace.battleType === "double"));
  const counts = new Map();
  const opponentMatchups = new Map();
  const failureDetails = [];
  for (const trace of scoped) {
    const attributions = agentTraceFailureAttribution(trace);
    for (const failure of attributions) {
      const current = counts.get(failure.code) || { code: failure.code, label: failure.label, count: 0, confidence: 0, repairTargets: new Set(), evidence: [] };
      current.count += 1;
      current.confidence = Math.max(current.confidence, failure.confidence);
      failure.repairTargets.forEach((target) => current.repairTargets.add(target));
      current.evidence.push(...failure.evidence.slice(0, 2));
      counts.set(failure.code, current);
      failureDetails.push({ battleId: trace.battleId, ...failure });
    }
    const opponent = String(trace.opponentName || trace.opponent || "unknown");
    const matchup = opponentMatchups.get(opponent) || { opponent, games: 0, wins: 0, losses: 0, ties: 0 };
    matchup.games += 1;
    if (trace.result === "win") matchup.wins += 1;
    else if (trace.result === "loss") matchup.losses += 1;
    else if (trace.result === "tie") matchup.ties += 1;
    opponentMatchups.set(opponent, matchup);
  }
  const failures = [...counts.values()].map((item) => ({
    ...item,
    repairTargets: [...item.repairTargets],
    evidence: [...new Set(item.evidence)].slice(0, 5),
    avoid: `${item.label}；优先补足 ${[...item.repairTargets].join("、")}`,
  })).sort((a, b) => b.count - a.count || b.confidence - a.confidence);
  const games = scoped.filter((trace) => ["win", "loss", "tie"].includes(trace.result));
  const wins = games.filter((trace) => trace.result === "win").length;
  const losses = games.filter((trace) => trace.result === "loss").length;
  const ties = games.filter((trace) => trace.result === "tie").length;
  return {
    schemaVersion: 1,
    rulesetId,
    format,
    generatedAt: new Date().toISOString(),
    games: games.length,
    wins,
    losses,
    ties,
    winRate: games.length ? Math.round((wins / games.length) * 1000) / 10 : 0,
    failures,
    failureDetails: failureDetails.slice(-200),
    opponentMatchups: [...opponentMatchups.values()].sort((a, b) => b.games - a.games),
    eligibleTraceCount: scoped.length,
  };
}

function learningSnapshot(format = "single", rulesetId = "") {
  const state = ruleRegistry.publicState();
  const requested = String(rulesetId || "").trim();
  const snapshot = requested
    ? ruleRegistry.get(requested)
    : ruleRegistry.activeFor(format);
  if (!snapshot || snapshot.battleType !== format || snapshot.status !== "active") {
    return ruleRegistry.operational({ format, rulesetId: requested });
  }
  const historical = !state.active.some((item) => item.rulesetId === snapshot.rulesetId);
  if (!historical) return ruleRegistry.operational({ format, rulesetId: snapshot.rulesetId });
  return { ...snapshot, historical: true };
}

async function importLocalAgentReplays(snapshot, format) {
  const replayRoot = join(AGENT_DATA_ROOT, "showdown-replays", snapshot.rulesetId);
  const traceRoot = join(AGENT_DATA_ROOT, "traces", snapshot.rulesetId);
  const replayFiles = await readdir(replayRoot).catch(() => []);
  const existing = await readAgentTraces(snapshot.rulesetId);
  const imported = new Set(existing.map((item) => item.replayFile).filter(Boolean));
  let importedCount = 0;
  await mkdir(traceRoot, { recursive: true });
  for (const fileName of replayFiles.filter((name) => name.toLowerCase().endsWith(".html"))) {
    if (imported.has(fileName)) continue;
    try {
      const html = await readFile(join(replayRoot, fileName), "utf8");
      const log = extractLocalReplayLog(html);
      if (!log) continue;
      const playerName = fileName.split(" - battle-")[0].trim();
      const report = parseShowdownReplayLog(log, playerName, "");
      const eligible = replayMatchesRulesEngine(report.tier, snapshot) && Boolean(report.candidateSide);
      const trace = {
        schemaVersion: 1,
        rulesetId: snapshot.rulesetId,
        showdownFormatId: snapshot.showdownFormatId,
        battleType: format,
        battleId: `local-${fileName}`,
        replayFile: fileName,
        policyVersion: "replay-import",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        result: report.result,
        turns: report.turns,
        opponentName: report.candidateSide === "p1" ? report.players.p2 : report.candidateSide === "p2" ? report.players.p1 : "",
        events: report.trace.map((line) => ({ type: "replay-line", line })),
        actions: [],
        eligibleForBuildFeedback: eligible,
      };
      trace.failureAttributions = agentTraceFailureAttribution(trace);
      const hash = createHash("sha1").update(`${snapshot.rulesetId}:${fileName}`).digest("hex").slice(0, 12);
      await writeFile(join(traceRoot, `import-${hash}.json`), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
      imported.add(fileName);
      importedCount += 1;
    } catch {
      // One malformed replay must not hide the other usable local replays.
    }
  }
  return importedCount;
}

async function learnFromAgentTraces(rulesetId = "", format = "single") {
  const traces = await readAgentTraces(rulesetId);
  const summary = aggregateAgentLearning(traces, rulesetId, format);
  const root = join(AGENT_LEARNING_ROOT, rulesetId);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "battle-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(join(root, "failure-memory.json"), `${JSON.stringify({ rulesetId, format, updatedAt: summary.generatedAt, items: summary.failures }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "opponent-matchups.json"), `${JSON.stringify({ rulesetId, format, updatedAt: summary.generatedAt, items: summary.opponentMatchups }, null, 2)}\n`, "utf8");
  const learningEntry = {
    id: `agent-learning-${rulesetId}-${format}`,
    key: `agent-learning:${rulesetId}:${format}`,
    type: "agent-ladder-learning",
    rulesetId,
    format,
    eligibleForBuildFeedback: true,
    games: summary.games,
    wins: summary.wins,
    losses: summary.losses,
    ties: summary.ties,
    winRate: summary.winRate,
    feedbackSignals: summary.failures.map((item) => item.code).join(","),
    actionTags: summary.failures.flatMap((item) => item.repairTargets || []).join(","),
    failureReasons: summary.failures.map((item) => item.avoid),
    avoid: summary.failures.slice(0, 8).map((item) => item.avoid).join("；"),
    badOpponents: summary.opponentMatchups.filter((item) => item.losses > item.wins).map((item) => item.opponent).join("、"),
    source: "local-agent-traces",
    updatedAt: summary.generatedAt,
  };
  const existingHistory = await readBattleHistoryFile();
  await writeBattleHistoryFile([learningEntry, ...existingHistory.filter((item) => item.key !== learningEntry.key)]);
  return summary;
}

function policySnapshotPath(rulesetId, version) {
  return join(AGENT_DATA_ROOT, "models", rulesetId, "policies", `${version}.json`);
}

async function readPolicyModelRegistry(rulesetId) {
  try { return JSON.parse(await readFile(join(AGENT_DATA_ROOT, "models", rulesetId, "registry.json"), "utf8")); }
  catch { return { rulesetId, champion: { version: "structured-visible-state-v1", status: "active" }, challengers: [], evaluations: [], updatedAt: "" }; }
}

async function writePolicyModelRegistry(rulesetId, registry) {
  const root = join(AGENT_DATA_ROOT, "models", rulesetId);
  await mkdir(root, { recursive: true });
  registry.rulesetId = rulesetId;
  registry.evaluations = (registry.evaluations || []).map(summarizeModelEvaluation);
  registry.challengers = (registry.challengers || []).map((item) => item.evaluation
    ? { ...item, evaluation: summarizeModelEvaluation(item.evaluation) }
    : item);
  registry.updatedAt = new Date().toISOString();
  await writeFile(join(root, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registry;
}

async function persistModelEvaluation(rulesetId, evaluation) {
  const root = join(AGENT_DATA_ROOT, "models", rulesetId, "evaluations");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${evaluation.id}.json`), `${JSON.stringify(evaluation, null, 2)}\n`, "utf8");
  const summary = summarizeModelEvaluation(evaluation);
  const registry = await readPolicyModelRegistry(rulesetId);
  registry.evaluations = [summary, ...(registry.evaluations || []).filter((item) => item.id !== evaluation.id)].slice(0, 50);
  registry.challengers = (registry.challengers || []).map((item) => item.version === evaluation.challengerVersion
    ? { ...item, status: evaluation.passed ? "ready_to_promote" : "rejected", evaluationId: evaluation.id, evaluation: summary }
    : item);
  await writePolicyModelRegistry(rulesetId, registry);
  return evaluation;
}

function summarizeModelEvaluation(evaluation = {}) {
  return {
    id: evaluation.id,
    rulesetId: evaluation.rulesetId,
    format: evaluation.format,
    championVersion: evaluation.championVersion,
    challengerVersion: evaluation.challengerVersion,
    type: evaluation.type,
    createdAt: evaluation.createdAt,
    games: evaluation.games,
    wins: evaluation.wins,
    losses: evaluation.losses,
    ties: evaluation.ties,
    winRate: evaluation.winRate,
    challengerWinRate: evaluation.challengerWinRate,
    wilsonLowerBound: evaluation.wilsonLowerBound,
    illegalActions: evaluation.illegalActions,
    recoveries: evaluation.recoveries,
    eloDelta: evaluation.eloDelta,
    generalization: evaluation.generalization,
    compositeScore: evaluation.compositeScore,
    fixedTestSet: evaluation.fixedTestSet ? { games: evaluation.fixedTestSet.games, wins: evaluation.fixedTestSet.wins, losses: evaluation.fixedTestSet.losses, ties: evaluation.fixedTestSet.ties, winRate: evaluation.fixedTestSet.winRate, illegalActions: evaluation.fixedTestSet.illegalActions, fixtureHash: evaluation.fixedTestSet.fixtureHash } : null,
    environment: evaluation.environment,
    passed: Boolean(evaluation.passed),
  };
}

async function listModelEvaluations(rulesetId) {
  const registry = await readPolicyModelRegistry(rulesetId);
  return { items: registry.evaluations || [] };
}

function fixedTestSetPath(rulesetId) {
  return join(AGENT_DATA_ROOT, "models", rulesetId, "fixed-test-set.json");
}

async function loadOrCreateFixedTestSet(snapshot, format, limit = 12) {
  const file = fixedTestSetPath(snapshot.rulesetId);
  try {
    const existing = JSON.parse(await readFile(file, "utf8"));
    if (existing?.rulesetId === snapshot.rulesetId && Array.isArray(existing.teams) && existing.teams.length) return existing;
  } catch {}
  const teams = [];
  for (const team of hotOpponentPool(format).slice(0, 120)) {
    const prepared = prepareBattleTeam(team.showdownText || "", format, team.title || team.id || "固定测试队", snapshot.rulesetId);
    if (!prepared.ok || !prepared.strictLegal) continue;
    teams.push({ id: team.id, title: team.title, rate: team.rate, rank: team.rank, packedTeam: prepared.packedTeam, teamText: prepared.showdownTeamText });
    if (teams.length >= Math.max(4, Math.min(24, limit))) break;
  }
  const fixture = {
    schemaVersion: 1,
    rulesetId: snapshot.rulesetId,
    format,
    createdAt: new Date().toISOString(),
    source: "same-ruleset-hot-team-pool",
    teams,
    hash: createHash("sha256").update(JSON.stringify(teams)).digest("hex").slice(0, 16),
  };
  await mkdir(join(AGENT_DATA_ROOT, "models", snapshot.rulesetId), { recursive: true });
  await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  return fixture;
}

async function evaluatePolicyOnFixedSet({ rulesetId = "", format = "single", policy, games = 2 } = {}) {
  const snapshot = ruleRegistry.operational({ format, rulesetId });
  const fixture = await loadOrCreateFixedTestSet(snapshot, format, 12);
  const baseline = { version: "fixed-baseline-v1", weights: {}, deterministic: true };
  const results = [];
  for (const [index, team] of fixture.teams.entries()) {
    for (let game = 0; game < Math.max(1, Math.min(4, games)); game += 1) {
      const candidateFirst = (index + game) % 2 === 0;
      const result = await runLocalBattle({
        format,
        formatId: snapshot.showdownFormatId,
        p1Team: team.packedTeam,
        p2Team: fixture.teams[(index + game + 1) % fixture.teams.length]?.packedTeam || team.packedTeam,
        p1Name: candidateFirst ? "Challenger" : "Fixed",
        p2Name: candidateFirst ? "Fixed" : "Challenger",
        candidateName: "Challenger",
        p1Policy: candidateFirst ? policyForAgent(policy) : baseline,
        p2Policy: candidateFirst ? baseline : policyForAgent(policy),
        maxTurns: 80,
        seed: [index + 1, game + 3, 17, 29],
      });
      results.push({ fixtureTeamId: team.id, game: game + 1, ...result });
    }
  }
  return { ...policyEvaluationMetrics(results), fixtureHash: fixture.hash, fixtureGames: fixture.teams.length, results };
}

async function readPolicySnapshot(rulesetId, version) {
  try { return JSON.parse(await readFile(policySnapshotPath(rulesetId, version), "utf8")); } catch { return null; }
}

async function ensurePolicySnapshot(rulesetId, format, version = "structured-visible-state-v1") {
  const existing = await readPolicySnapshot(rulesetId, version);
  if (existing) return existing;
  if (version !== "structured-visible-state-v1") return null;
  const policy = {
    schemaVersion: 1,
    id: version,
    version,
    rulesetId,
    format,
    parentVersion: "",
    weights: normalizePolicyWeights({}),
    deterministic: true,
    trainedAt: "",
    source: "built-in-structured-policy",
  };
  await mkdir(join(AGENT_DATA_ROOT, "models", rulesetId, "policies"), { recursive: true });
  await writeFile(policySnapshotPath(rulesetId, version), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return policy;
}

function policyTrainingFeatures(trace = {}) {
  const features = {};
  const add = (key, amount = 1) => { features[key] = (features[key] || 0) + amount; };
  for (const event of trace.events || []) {
    if (event.type !== "agent-action") continue;
    const command = String(event.command || "").toLowerCase();
    if (command.includes("switch")) add("switch");
    if (command.includes("protect") || command.includes("detect")) add("protect");
    if (command.includes("tailwind") || command.includes("trick room") || command.includes("icy wind") || command.includes("electroweb")) add("speed-control");
    if (command.includes("u-turn") || command.includes("volt switch") || command.includes("parting shot") || command.includes("baton pass")) add("pivot");
    if (command.includes("swords dance") || command.includes("nasty plot") || command.includes("dragon dance") || command.includes("quiver dance")) add("setup");
    if (command.includes("move")) add("damage");
  }
  for (const event of trace.events || []) {
    const line = String(event.line || event.command || "").toLowerCase();
    if (/tailwind|trick room|icy wind|electroweb|thunder wave|glare/.test(line)) add("speed-control", 0.25);
    if (/protect|detect|wide guard/.test(line)) add("protect", 0.25);
  }
  return features;
}

function normalizePolicyWeights(weights = {}) {
  const normalized = {};
  for (const key of ["damage", "protect", "speed-control", "pivot", "setup", "switch", "disrupt", "spread", "recovery", "hazard", "removal"]) {
    const value = Number(weights[key] || 0);
    normalized[key] = Math.max(-24, Math.min(24, Math.round(value * 100) / 100));
  }
  return normalized;
}

function policyTrainingSplit(traces = [], maxSamples = 0) {
  const eligible = traces.filter((trace) => trace.policyVersion !== "replay-import" && ["win", "loss", "tie"].includes(trace.result));
  const ordered = [...eligible].sort((a, b) => {
    const byTime = String(a.finishedAt || a.startedAt || "").localeCompare(String(b.finishedAt || b.startedAt || ""));
    if (byTime) return byTime;
    return String(a.battleId || a.replayFile || "").localeCompare(String(b.battleId || b.replayFile || ""));
  });
  const selected = maxSamples > 0 ? ordered.slice(0, maxSamples) : ordered;
  const trainEnd = Math.floor(selected.length * 0.7);
  const validationEnd = Math.floor(selected.length * 0.85);
  return { eligible: ordered.length, selected: selected.length, selectedTraces: selected, train: selected.slice(0, trainEnd), validation: selected.slice(trainEnd, validationEnd), test: selected.slice(validationEnd) };
}

function policyTraceIdentity(trace = {}) {
  return {
    id: String(trace.battleId || trace.replayFile || trace.id || ""),
    result: String(trace.result || ""),
    policyVersion: String(trace.policyVersion || "structured-visible-state-v1"),
  };
}

function policyTrainingFingerprint({ rulesetId = "", format = "single", baseVersion = "", traces = [] } = {}) {
  return createHash("sha256").update(JSON.stringify({
    rulesetId,
    format,
    baseVersion,
    traces: traces.map(policyTraceIdentity),
  })).digest("hex");
}

async function policySnapshotsForRegistry(rulesetId, registry) {
  return (await Promise.all((registry.challengers || []).map(async (item) => {
    const policy = await readPolicySnapshot(rulesetId, item.version);
    return policy ? { item, policy } : null;
  }))).filter(Boolean);
}

async function policyTrainingProgress(rulesetId, format, traces = null, registry = null) {
  const allTraces = traces || await readAgentTraces(rulesetId);
  const split = policyTrainingSplit(allTraces);
  const modelRegistry = registry || await readPolicyModelRegistry(rulesetId);
  const snapshots = await policySnapshotsForRegistry(rulesetId, modelRegistry);
  const latestSelected = snapshots.reduce((maximum, entry) => Math.max(maximum, Number(entry.policy.dataset?.selected || entry.item.trainingGames || 0)), 0);
  const newEligibleGames = Math.max(0, split.selected - latestSelected);
  const minimumNewGames = 5;
  const nextAutomaticCheckpoint = (Math.floor(split.eligible / 50) + 1) * 50;
  return {
    eligibleGames: split.eligible,
    lastTrainingGames: latestSelected,
    newEligibleGames,
    minimumNewGames,
    gamesUntilManualTraining: Math.max(0, minimumNewGames - newEligibleGames),
    nextAutomaticCheckpoint,
    gamesUntilAutomaticCheckpoint: Math.max(0, nextAutomaticCheckpoint - split.eligible),
  };
}

function addPolicyTrainingExample(accumulator, trace) {
  const direction = trace.result === "win" ? 1 : trace.result === "loss" ? -1 : 0;
  const features = policyTrainingFeatures(trace);
  for (const [key, value] of Object.entries(features)) accumulator[key] = (accumulator[key] || 0) + direction * Number(value || 0);
}

async function trainAgentPolicy({ rulesetId = "", format = "single", baseVersion = "structured-visible-state-v1", maxSamples = 0, version = "" } = {}) {
  const snapshot = learningSnapshot(format, rulesetId);
  const traces = await readAgentTraces(snapshot.rulesetId);
  const split = policyTrainingSplit(traces, Number(maxSamples || 0));
  if (split.train.length < 4) return { ok: false, status: "insufficient_data", error: "至少需要 4 局非回放导入的已完成对局才能训练策略。", ruleset: rulesetMetadata(snapshot), samples: split.train.length };
  const registry = await readPolicyModelRegistry(snapshot.rulesetId);
  const trainingFingerprint = policyTrainingFingerprint({ rulesetId: snapshot.rulesetId, format, baseVersion, traces: split.selectedTraces });
  const snapshots = await policySnapshotsForRegistry(snapshot.rulesetId, registry);
  const duplicate = snapshots.find(({ policy }) => policy.trainingFingerprint === trainingFingerprint);
  if (duplicate) {
    return {
      ok: true,
      status: "no_new_data",
      message: "没有新增有效排位数据，未生成新 Challenger。",
      existingVersion: duplicate.policy.version,
      trainingProgress: await policyTrainingProgress(snapshot.rulesetId, format, traces, registry),
      ruleset: rulesetMetadata(snapshot),
    };
  }
  const latestSelected = snapshots
    .filter(({ policy }) => policy.parentVersion === baseVersion)
    .reduce((maximum, { policy, item }) => Math.max(maximum, Number(policy.dataset?.selected || item.trainingGames || 0)), 0);
  const newEligibleGames = Math.max(0, split.selected - latestSelected);
  if (!version && latestSelected > 0 && newEligibleGames < 5) {
    return {
      ok: true,
      status: "no_new_data",
      message: newEligibleGames
        ? `仅新增 ${newEligibleGames} 局有效排位数据；至少新增 5 局才会生成新 Challenger。`
        : "没有新增有效排位数据，未生成新 Challenger。",
      existingVersion: snapshots.sort((a, b) => Number(b.policy.dataset?.selected || 0) - Number(a.policy.dataset?.selected || 0))[0]?.policy.version || "",
      trainingProgress: await policyTrainingProgress(snapshot.rulesetId, format, traces, registry),
      ruleset: rulesetMetadata(snapshot),
    };
  }
  const rawWeights = {};
  split.train.forEach((trace) => addPolicyTrainingExample(rawWeights, trace));
  const parentPolicy = await ensurePolicySnapshot(snapshot.rulesetId, format, baseVersion);
  const learnedDelta = Object.fromEntries(Object.entries(rawWeights).map(([key, value]) => [key, Number(value) / Math.max(1, split.train.length)]));
  const weights = normalizePolicyWeights(Object.fromEntries(
    [...new Set([...Object.keys(parentPolicy?.weights || {}), ...Object.keys(learnedDelta)])]
      .map((key) => [key, Number(parentPolicy?.weights?.[key] || 0) + Number(learnedDelta[key] || 0)]),
  ));
  const trainedVersion = version || `${baseVersion}-trained-${split.train.length}-${trainingFingerprint.slice(0, 10)}`;
  const policy = {
    schemaVersion: 1,
    id: trainedVersion,
    version: trainedVersion,
    rulesetId: snapshot.rulesetId,
    format,
    parentVersion: baseVersion,
    trainingFingerprint,
    weights,
    learnedDelta: normalizePolicyWeights(learnedDelta),
    deterministic: true,
    trainedAt: new Date().toISOString(),
    dataset: { total: traces.length, eligible: split.eligible, selected: split.selected, train: split.train.length, validation: split.validation.length, test: split.test.length, excludedReplayImports: traces.length - split.eligible },
    sourceTraceIds: split.train.map((trace) => trace.battleId).filter(Boolean).slice(-500),
    selectedTraceIds: split.selectedTraces.map((trace) => trace.battleId).filter(Boolean).slice(-1000),
  };
  await mkdir(join(AGENT_DATA_ROOT, "models", snapshot.rulesetId, "policies"), { recursive: true });
  await writeFile(policySnapshotPath(snapshot.rulesetId, trainedVersion), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { ok: true, status: "trained", policy, trainingProgress: await policyTrainingProgress(snapshot.rulesetId, format, traces, registry), ruleset: rulesetMetadata(snapshot) };
}

async function syncPolicyTrainingMilestones(rulesetId, format) {
  const snapshot = learningSnapshot(format, rulesetId);
  const traces = await readAgentTraces(snapshot.rulesetId);
  const eligibleGames = policyTrainingSplit(traces).eligible;
  if (eligibleGames < 50) return readPolicyModelRegistry(snapshot.rulesetId);
  const registry = await readPolicyModelRegistry(snapshot.rulesetId);
  let changed = false;
  const challengerCount = (registry.challengers || []).length;
  registry.challengers = (registry.challengers || []).filter((item) => {
    const isLegacyPlaceholder = /^challenger-\d+$/.test(String(item.version || "")) && item.status === "pending_evaluation";
    return !isLegacyPlaceholder;
  });
  changed ||= registry.challengers.length !== challengerCount;
  for (let checkpoint = 50; checkpoint <= Math.floor(eligibleGames / 50) * 50; checkpoint += 50) {
    const version = `challenger-${checkpoint}`;
    const existingSnapshot = await readPolicySnapshot(snapshot.rulesetId, version);
    if (existingSnapshot) continue;
    const result = await trainAgentPolicy({
      rulesetId: snapshot.rulesetId,
      format,
      baseVersion: registry.champion?.version || "structured-visible-state-v1",
      maxSamples: checkpoint,
      version,
    });
    if (!result.ok || result.status !== "trained") continue;
    registry.challengers = [
      { version, status: "trained", trainingGames: checkpoint, trainingSamples: result.policy.dataset.train, trainingFingerprint: result.policy.trainingFingerprint, parentVersion: result.policy.parentVersion, createdAt: result.policy.trainedAt },
      ...(registry.challengers || []).filter((item) => item.version !== version),
    ].slice(0, 20);
    changed = true;
  }
  if (changed) await writePolicyModelRegistry(snapshot.rulesetId, registry);
  return registry;
}

function policyForAgent(policy = null) {
  return policy ? { version: policy.version || policy.id, weights: policy.weights || {}, deterministic: Boolean(policy.deterministic) } : null;
}

function policyEvaluationMetrics(results = []) {
  const games = results.length;
  const wins = results.filter((item) => item.result === "win").length;
  const losses = results.filter((item) => item.result === "loss").length;
  const ties = results.filter((item) => item.result === "tie").length;
  const illegalActions = results.reduce((sum, item) => sum + Number(item.actions?.errors?.length || 0), 0);
  const recoveries = results.reduce((sum, item) => sum + Number(item.actions?.recoveries?.length || 0), 0);
  return { games, wins, losses, ties, winRate: games ? Math.round((wins / games) * 1000) / 10 : 0, illegalActions, recoveries };
}

function policyEloDelta(results = [], kFactor = 24) {
  let challengerRating = 1500;
  let championRating = 1500;
  for (const item of results) {
    const expected = 1 / (1 + 10 ** ((championRating - challengerRating) / 400));
    const actual = item.result === "win" ? 1 : item.result === "tie" ? 0.5 : 0;
    const delta = kFactor * (actual - expected);
    challengerRating += delta;
    championRating -= delta;
  }
  return Math.round((challengerRating - 1500) * 10) / 10;
}

function policyGeneralization(results = []) {
  const matchups = new Map();
  for (const item of results) {
    const key = [item.challengerTeamId || item.teamId || "unknown", item.championTeamId || item.opponentTeamId || "unknown"].join("::");
    const record = matchups.get(key) || { wins: 0, games: 0 };
    record.games += 1;
    if (item.result === "win") record.wins += 1;
    matchups.set(key, record);
  }
  if (!matchups.size) return 0;
  const successful = [...matchups.values()].filter((item) => item.wins / item.games >= 0.5).length;
  return Math.round((successful / matchups.size) * 1000) / 10;
}

function policyCompositeScore(results = [], fixedTestSet = {}) {
  const metrics = policyEvaluationMetrics(results);
  const recent = policyEvaluationMetrics(results.slice(-Math.max(1, Math.ceil(results.length / 2))));
  const eloScore = Math.max(0, Math.min(100, 50 + policyEloDelta(results)));
  const generalization = policyGeneralization(results);
  const score = (metrics.winRate * 0.35) + (eloScore * 0.25) + (recent.winRate * 0.15) + (Number(fixedTestSet.winRate || 0) * 0.15) + (generalization * 0.1);
  return {
    eloDelta: policyEloDelta(results),
    recentWinRate: recent.winRate,
    generalization,
    compositeScore: Math.round(score * 10) / 10,
  };
}

function wilsonLowerBound(wins, games, z = 1.96) {
  if (!games) return 0;
  const p = wins / games;
  const denominator = 1 + (z * z) / games;
  const centre = p + (z * z) / (2 * games);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * games)) / games);
  return Math.round(((centre - spread) / denominator) * 1000) / 10;
}

async function evaluatePolicyAgainstTeams({ rulesetId = "", format = "single", candidatePolicy, opponentPolicy, gamesPerTeam = 2, teams = null, role = "candidate" } = {}) {
  const snapshot = ruleRegistry.operational({ format, rulesetId });
  const rulesEngine = championsRulesEngine(format, snapshot.rulesetId);
  if (!rulesEngine.ok) return { ok: false, error: rulesEngine.error, results: [] };
  const pool = (teams || hotOpponentPool(format)).slice(0, 12);
  const results = [];
  for (const [teamIndex, team] of pool.entries()) {
    const prepared = prepareBattleTeam(team.showdownText || "", format, team.title || team.id || "评测队伍", snapshot.rulesetId);
    if (!prepared.ok || !prepared.strictLegal) continue;
    for (let index = 0; index < Math.max(1, Math.min(4, gamesPerTeam)); index += 1) {
      const opponentSource = pool[(teamIndex + index + 1) % Math.max(1, pool.length)] || team;
      const opponentPrepared = prepareBattleTeam(opponentSource.showdownText || "", format, opponentSource.title || opponentSource.id || "对手队伍", snapshot.rulesetId);
      if (!opponentPrepared.ok || !opponentPrepared.strictLegal) continue;
      const candidateTeam = prepared.packedTeam;
      const opponentTeam = opponentPrepared.packedTeam;
      const result = await runLocalBattle({
        format,
        formatId: rulesEngine.id,
        p1Team: candidateTeam,
        p2Team: opponentTeam,
        p1Name: "Challenger",
        p2Name: "Champion",
        candidateName: role === "champion" ? "Champion" : "Challenger",
        p1Policy: policyForAgent(candidatePolicy),
        p2Policy: policyForAgent(opponentPolicy),
        maxTurns: 80,
        seed: [index + 1, 2, 3, 4].map((value) => value + results.length),
      });
      results.push({ teamId: team.id, teamTitle: team.title, ...result });
    }
  }
  return { ok: results.length > 0, ...policyEvaluationMetrics(results), wilsonLowerBound: wilsonLowerBound(results.filter((item) => item.result === "win").length, results.length), results };
}

async function runPolicyAdversarial({ rulesetId = "", format = "single", championVersion = "", challengerVersion = "", games = 20 } = {}) {
  const snapshot = ruleRegistry.operational({ format, rulesetId });
  const registry = await readPolicyModelRegistry(snapshot.rulesetId);
  const resolvedChampionVersion = championVersion || registry.champion?.version || "structured-visible-state-v1";
  const champion = await ensurePolicySnapshot(snapshot.rulesetId, format, resolvedChampionVersion);
  const challenger = await readPolicySnapshot(snapshot.rulesetId, challengerVersion);
  if (!champion) return { ok: false, status: "missing_policy", error: "Champion 策略快照不存在，不能进行可复现对抗。", ruleset: rulesetMetadata(snapshot) };
  if (!challenger) return { ok: false, status: "missing_policy", error: "Challenger 尚未训练出可加载的策略快照。", ruleset: rulesetMetadata(snapshot) };
  if (challenger.version === champion.version) return { ok: false, status: "same_policy", error: "Champion 与 Challenger 必须是不同模型版本。", ruleset: rulesetMetadata(snapshot) };
  if (champion.rulesetId !== snapshot.rulesetId || challenger.rulesetId !== snapshot.rulesetId || champion.format !== format || challenger.format !== format) {
    return { ok: false, status: "policy_scope_mismatch", error: "模型快照与当前 rulesetId 或单双打类型不一致。", ruleset: rulesetMetadata(snapshot) };
  }
  const baseline = champion;
  const fixture = await loadOrCreateFixedTestSet(snapshot, format, 12);
  const teams = fixture.teams || [];
  if (teams.length < 2) return { ok: false, status: "missing_fixture", error: "当前规则下没有足够的合法私服对抗队伍。", ruleset: rulesetMetadata(snapshot) };
  const gameCount = Math.max(2, Math.min(100, Number(games) || 20));
  const results = [];
  for (let index = 0; index < gameCount; index += 1) {
    const pairIndex = Math.floor(index / 2);
    const challengerTeam = teams[pairIndex % teams.length];
    const championTeam = teams[(pairIndex * 5 + 3) % teams.length];
    if (!challengerTeam?.packedTeam || !championTeam?.packedTeam || challengerTeam.id === championTeam.id) continue;
    const challengerFirst = index % 2 === 0;
    const result = await runLocalBattle({
      format,
      formatId: snapshot.showdownFormatId,
      p1Team: challengerFirst ? challengerTeam.packedTeam : championTeam.packedTeam,
      p2Team: challengerFirst ? championTeam.packedTeam : challengerTeam.packedTeam,
      p1Name: challengerFirst ? "Challenger" : "Champion",
      p2Name: challengerFirst ? "Champion" : "Challenger",
      candidateName: "Challenger",
      p1Policy: policyForAgent(challengerFirst ? challenger : baseline),
      p2Policy: policyForAgent(challengerFirst ? baseline : challenger),
      maxTurns: 80,
      seed: [index + 11, 22, 33, 44],
    });
    results.push({ game: index + 1, pair: pairIndex + 1, side: challengerFirst ? "p1" : "p2", challengerTeamId: challengerTeam.id, championTeamId: championTeam.id, ...result });
  }
  const metrics = policyEvaluationMetrics(results);
  const fixed = await evaluatePolicyOnFixedSet({ rulesetId: snapshot.rulesetId, format, policy: challenger, games: 1 });
  const comparison = policyCompositeScore(results, fixed);
  const lowerBound = wilsonLowerBound(metrics.wins, metrics.games);
  const passed = metrics.games >= 20
    && fixed.games > 0
    && metrics.illegalActions === 0
    && fixed.illegalActions === 0
    && metrics.winRate >= 55
    && lowerBound >= 45
    && fixed.winRate >= 52;
  const evaluation = {
    id: `evaluation-${Date.now()}`,
    rulesetId: snapshot.rulesetId,
    format,
    championVersion: baseline.version,
    challengerVersion: challenger.version,
    type: "private-adversarial",
    environment: { runtime: "local-showdown-battlestream", network: false, accountRequired: false, players: "owned-model-vs-owned-model", fixtureHash: fixture.hash },
    createdAt: new Date().toISOString(),
    ...metrics,
    ...comparison,
    challengerWinRate: metrics.winRate,
    fixedTestSet: fixed,
    wilsonLowerBound: lowerBound,
    passed,
    results,
  };
  await persistModelEvaluation(snapshot.rulesetId, evaluation);
  return { ok: true, status: evaluation.passed ? "ready_to_promote" : "rejected", evaluation, ruleset: rulesetMetadata(snapshot) };
}

function extractLocalReplayLog(html = "") {
  const match = String(html).match(/<script[^>]*class=["']battle-log-data["'][^>]*>([\s\S]*?)<\/script>/i);
  return match ? match[1].replace(/^\s+|\s+$/g, "") : "";
}

async function analyzeLocalAgentReplay({ rulesetId = "", format = "single", fileName = "", playerName = "" } = {}) {
  const snapshot = ruleRegistry.operational({ format, rulesetId });
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..") || !fileName.toLowerCase().endsWith(".html")) {
    throw Object.assign(new Error("非法本地回放文件名。"), { status: 400, code: "INVALID_REPLAY_FILE" });
  }
  const root = resolve(AGENT_DATA_ROOT, "showdown-replays", snapshot.rulesetId);
  const filePath = resolve(root, fileName);
  if (!filePath.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) throw Object.assign(new Error("禁止访问该回放文件。"), { status: 403, code: "REPLAY_PATH_FORBIDDEN" });
  const html = await readFile(filePath, "utf8");
  const log = extractLocalReplayLog(html);
  if (!log) throw Object.assign(new Error("本地 HTML 回放没有可解析的 Showdown 日志。"), { status: 422, code: "REPLAY_LOG_MISSING" });
  const report = parseShowdownReplayLog(log, playerName, "");
  const trace = {
    schemaVersion: 1,
    rulesetId: snapshot.rulesetId,
    showdownFormatId: snapshot.showdownFormatId,
    battleType: format,
    battleId: `local-${fileName}`,
    replayFile: fileName,
    policyVersion: "replay-import",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    result: report.result,
    turns: report.turns,
    opponentName: report.candidateSide === "p1" ? report.players.p2 : report.candidateSide === "p2" ? report.players.p1 : "",
    events: report.trace.map((line) => ({ type: "replay-line", line })),
    actions: [],
    eligibleForBuildFeedback: snapshot.showdownFormatId.toLowerCase() === String(report.tier || "").toLowerCase().replace(/[^a-z0-9]+/g, "") || report.tier === snapshot.name,
  };
  const attributions = agentTraceFailureAttribution(trace);
  trace.failureAttributions = attributions;
  const traceRoot = join(AGENT_DATA_ROOT, "traces", snapshot.rulesetId);
  await mkdir(traceRoot, { recursive: true });
  const traceFile = `import-${Date.now()}-${createHash("sha1").update(fileName).digest("hex").slice(0, 8)}.json`;
  await writeFile(join(traceRoot, traceFile), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  const summary = await learnFromAgentTraces(snapshot.rulesetId, format);
  return { traceFile, trace, report, attributions, summary, ruleset: rulesetMetadata(snapshot) };
}

function teamTextFromBuild(build = []) {
  const sets = (Array.isArray(build) ? build : []).map((member) => ({
    species: legalShowdownSpeciesName(member.slug || member.name || member.id, member),
    item: showdownLegalValue(member.item, "", "items"),
    ability: showdownLegalValue(member.ability, "", "abilities"),
    nature: showdownLegalValue(member.nature, "", "natures"),
    moves: (member.moves || []).map((move) => showdownLegalValue(move, "", "moves")).filter(Boolean).slice(0, 4),
    level: Number(member.level || 50),
    evs: typeof member.evs === "object" ? member.evs : {},
    championStats: typeof member.evs === "string" ? member.evs : "",
  })).filter((member) => member.species && member.item && member.ability && member.moves.length >= 4);
  if (!sets.length) return "";
  return sets.map((member) => {
    const lines = [`${member.species} @ ${member.item}`, `Ability: ${member.ability}`, "Level: 50"];
    const evs = member.championStats ? championStatPointsFromChampionStats(member.championStats, "") : "";
    if (evs) lines.push(`EVs: ${evs}`);
    else lines.push("EVs: 1 HP");
    const nature = member.nature;
    if (nature) lines.push(`${nature} Nature`);
    member.moves.forEach((move) => lines.push(`- ${move}`));
    return lines.join("\n");
  }).join("\n\n") + "\n";
}

function buildFeedbackHistory(summary = {}) {
  return [{
    rulesetId: summary.rulesetId,
    format: summary.format,
    eligibleForBuildFeedback: true,
    games: summary.games,
    wins: summary.wins,
    losses: summary.losses,
    ties: summary.ties,
    winRate: summary.winRate,
    actionTags: (summary.failures || []).map((item) => item.code).join(","),
    failureReasons: (summary.failures || []).map((item) => item.avoid || item.label),
    avoid: (summary.failures || []).slice(0, 6).map((item) => item.avoid || item.label).join("；"),
    badOpponents: (summary.opponentMatchups || []).filter((item) => item.losses > item.wins).map((item) => item.opponent).join("、"),
  }];
}

async function evaluateGeneratedTeam(teamText, format, rulesetId, gamesPerOpponent = 1) {
  const rulesEngine = championsRulesEngine(format, rulesetId);
  if (!rulesEngine.ok) return { ok: false, error: rulesEngine.error, games: 0, wins: 0, losses: 0, ties: 0, results: [] };
  const own = prepareBattleTeam(teamText, format, "Challenger", rulesetId);
  if (!own.ok || !own.strictLegal) return { ok: false, error: own.problems?.join("；") || "候选队伍不合法", games: 0, wins: 0, losses: 0, ties: 0, results: [] };
  const opponentPool = hotOpponentPool(format);
  const opponents = [];
  for (const opponent of opponentPool) {
    const target = prepareBattleTeam(opponent.showdownText || "", format, opponent.title || opponent.id || "固定靶队", rulesetId);
    if (!target.ok || !target.strictLegal) continue;
    opponents.push(opponent);
    if (opponents.length >= 5) break;
  }
  if (!opponents.length) return { ok: false, error: `当前 ${rulesetId} 没有通过严格规则校验的固定靶队。请更新同规则队伍数据。`, games: 0, wins: 0, losses: 0, ties: 0, results: [] };
  const results = [];
  for (const opponent of opponents) {
    const target = prepareBattleTeam(opponent.showdownText || "", format, opponent.title || opponent.id || "固定靶队", rulesetId);
    if (!target.ok || !target.strictLegal) continue;
    for (let index = 0; index < Math.max(1, Math.min(2, gamesPerOpponent)); index += 1) {
      const pairing = index % 2 === 0
        ? { p1Team: own.packedTeam, p2Team: target.packedTeam, p1Name: "Candidate", p2Name: "Meta" }
        : { p1Team: target.packedTeam, p2Team: own.packedTeam, p1Name: "Meta", p2Name: "Candidate" };
      const result = await runLocalBattle({
        format,
        formatId: rulesEngine.id,
        rulesetId,
        ...pairing,
        candidateName: "Candidate",
        maxTurns: 80,
      });
      results.push({ opponentId: opponent.id, opponentTitle: opponent.title, ...result, failureReasons: battleFailureReasons(result, format) });
    }
  }
  const wins = results.filter((item) => item.result === "win").length;
  const losses = results.filter((item) => item.result === "loss").length;
  const ties = results.filter((item) => item.result === "tie").length;
  return { ok: results.length > 0, games: results.length, wins, losses, ties, winRate: results.length ? Math.round((wins / results.length) * 1000) / 10 : 0, results };
}

async function readAgentTeamRegistry(rulesetId) {
  const path = join(AGENT_LEARNING_ROOT, rulesetId, "team-registry.json");
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return { schemaVersion: 1, rulesetId, champion: null, challengers: [], updatedAt: "" }; }
}

function teamLabPath(rulesetId) {
  return join(TEAM_LAB_ROOT, rulesetId, "experiments.json");
}

async function readTeamLab(rulesetId) {
  try {
    const data = JSON.parse(await readFile(teamLabPath(rulesetId), "utf8"));
    return {
      schemaVersion: 1,
      rulesetId,
      experiments: Array.isArray(data.experiments) ? data.experiments : [],
      updatedAt: data.updatedAt || "",
    };
  } catch {
    return { schemaVersion: 1, rulesetId, experiments: [], updatedAt: "" };
  }
}

async function writeTeamLab(rulesetId, value) {
  const root = join(TEAM_LAB_ROOT, rulesetId);
  await mkdir(root, { recursive: true });
  const payload = { schemaVersion: 1, rulesetId, experiments: value.experiments || [], updatedAt: new Date().toISOString() };
  await writeFile(teamLabPath(rulesetId), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function teamLabCandidateKey(candidate = {}) {
  return (candidate.team || candidate.build?.team || [])
    .map((member) => `${strictFamilyKey(member.slug || member.name || member.id)}:${strictKey(member.item || "")}:${(member.moves || []).map(strictKey).sort().join(",")}`)
    .sort()
    .join("|");
}

function teamLabCandidateScore(candidate = {}) {
  const evaluation = candidate.evaluation || {};
  const buildReport = candidate.build?.buildReport || candidate.buildReport || {};
  const team = candidate.build?.team || candidate.team || [];
  const validation = candidate.validation || { ok: Boolean(candidate.build?.ok) };
  const games = Number(evaluation.games || 0);
  const winRate = Math.max(0, Math.min(100, Number(evaluation.winRate || 0)));
  const battle = games > 0 ? winRate * 0.55 : 0;
  const structure =
    (validation.ok ? 10 : 0)
    + (team.length === 6 ? 5 : 0)
    + (buildReport.plan ? 2 : 0)
    + (buildReport.evolution || buildReport.synergies?.length >= 2 ? 3 : 0);

  const matchupResults = new Map();
  for (const result of evaluation.results || []) {
    const key = String(result.opponentId || result.opponentTitle || "unknown");
    const item = matchupResults.get(key) || { points: 0, games: 0 };
    item.games += 1;
    item.points += result.result === "win" ? 1 : result.result === "tie" ? 0.5 : 0;
    matchupResults.set(key, item);
  }
  const matchupRates = [...matchupResults.values()].map((item) => item.games ? item.points / item.games : 0);
  const generalization = matchupRates.length
    ? (matchupRates.reduce((sum, value) => sum + value, 0) / matchupRates.length) * 15
    : 0;

  const synergies = Math.min(4, Number(buildReport.synergies?.length || 0));
  const risks = Math.min(6, Number(buildReport.risks?.length || 0));
  const synergyRisk = Math.max(0, Math.min(10, synergies * 2.5 - risks * 1.5));
  const total = Math.max(0, Math.min(100, battle + structure + generalization + synergyRisk));
  return {
    total: Math.round(total * 10) / 10,
    battle: Math.round(battle * 10) / 10,
    structure: Math.round(structure * 10) / 10,
    generalization: Math.round(generalization * 10) / 10,
    synergyRisk: Math.round(synergyRisk * 10) / 10,
  };
}

function teamLabCandidateSummary(candidate = {}) {
  const evaluation = candidate.evaluation || {};
  const score = teamLabCandidateScore(candidate);
  return {
    id: candidate.id,
    rulesetId: candidate.rulesetId,
    format: candidate.format,
    createdAt: candidate.createdAt,
    status: candidate.status || "pending_evaluation",
    score: score.total,
    scoreScale: 100,
    scoreBreakdown: score,
    team: candidate.build?.team || candidate.team || [],
    buildReport: candidate.build?.buildReport || {},
    validation: candidate.validation || { ok: Boolean(candidate.build?.ok) },
    evaluation: {
      ok: Boolean(evaluation.ok),
      games: Number(evaluation.games || 0),
      wins: Number(evaluation.wins || 0),
      losses: Number(evaluation.losses || 0),
      ties: Number(evaluation.ties || 0),
      winRate: Number(evaluation.winRate || 0),
      error: evaluation.error || "",
      results: (evaluation.results || []).slice(0, 20),
    },
    evidence: {
      source: "strict-search-plus-local-showdown",
      rulesetId: candidate.rulesetId,
      feedbackGames: Number(candidate.feedbackGames || 0),
      feedbackFailures: candidate.feedbackFailures || [],
    },
  };
}

async function handleTeamLabApi(req, res) {
  const url = new URL(req.url || "/api/team-lab", "http://127.0.0.1");
  const body = req.method === "GET" ? {} : await readJson(req).catch(() => ({}));
  const format = (url.searchParams.get("format") || body.format) === "double" ? "double" : "single";
  const requestedRulesetId = String(url.searchParams.get("rulesetId") || "").trim();
  if (req.method === "GET") {
    const snapshot = ruleRegistry.operational({ format, rulesetId: requestedRulesetId });
    const lab = await readTeamLab(snapshot.rulesetId);
    const registry = await readAgentTeamRegistry(snapshot.rulesetId);
    sendJson(res, 200, {
      ok: true,
      ...rulesetMetadata(snapshot),
      experiments: lab.experiments.map(teamLabCandidateSummary),
      champion: registry.champion ? teamLabCandidateSummary(registry.champion) : null,
      challengers: (registry.challengers || []).map(teamLabCandidateSummary),
      updatedAt: lab.updatedAt,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/team-lab/generate") {
    const snapshot = ruleRegistry.operational({ format, rulesetId: String(body.rulesetId || requestedRulesetId) });
    const count = Math.max(1, Math.min(8, Number(body.count || 5) || 5));
    const gamesPerOpponent = Math.max(1, Math.min(2, Number(body.gamesPerOpponent || 1) || 1));
    const summary = await learnFromAgentTraces(snapshot.rulesetId, format);
    const feedback = buildFeedbackHistory(summary);
    const lab = await readTeamLab(snapshot.rulesetId);
    const generated = [];
    const seen = new Set(lab.experiments.map(teamLabCandidateKey));
    const corePokemon = strictUniquePokemonRefs(Array.isArray(body.corePokemon) ? body.corePokemon : []).slice(0, 3);
    const historicalTeams = lab.experiments
      .map((candidate) => candidate.build?.team || candidate.team || [])
      .filter((team) => team.length === 6)
      .slice(0, 20);
    for (let index = 0; index < count; index += 1) {
      const avoidTeams = [
        ...generated.map((candidate) => candidate.build?.team || candidate.team || []),
        ...historicalTeams,
      ];
      const built = strictBuildTeam({
        format,
        rulesetId: snapshot.rulesetId,
        userGoal: String(body.userGoal || ""),
        currentTeam: corePokemon,
        goalConstraints: { requiredPokemon: corePokemon },
        buildMethod: "evolution",
        evolution: true,
        forceGenerated: true,
        variationSeed: `team-lab-${Date.now()}-${index}`,
        battleHistory: feedback,
        avoidTeams,
        avoidTeam: avoidTeams[0] || [],
        maxSharedWithAvoided: 3,
      });
      if (!built.ok) continue;
      const key = teamLabCandidateKey({ team: built.team });
      if (seen.has(key)) continue;
      seen.add(key);
      const teamText = teamTextFromBuild(built.team);
      const validation = validateShowdownTeam(teamText, format, snapshot.rulesetId);
      if (!validation.ok) continue;
      const evaluation = body.evaluate === false
        ? { ok: false, games: 0, wins: 0, losses: 0, ties: 0, winRate: 0, results: [], error: "等待本地对战评估" }
        : await evaluateGeneratedTeam(teamText, format, snapshot.rulesetId, gamesPerOpponent);
      const candidate = {
        id: `lab-${Date.now()}-${index + 1}`,
        createdAt: new Date().toISOString(),
        rulesetId: snapshot.rulesetId,
        format,
        build: built,
        teamText,
        validation,
        evaluation,
        feedbackGames: summary.games,
        feedbackFailures: (summary.failures || []).slice(0, 8),
        corePokemon: corePokemon.map((item) => item.slug || item.id || item.name),
        status: evaluation.ok && evaluation.games >= 4 && evaluation.winRate >= 50 ? "challenger" : "pending_evaluation",
      };
      candidate.score = teamLabCandidateScore(candidate).total;
      generated.push(candidate);
    }
    lab.experiments = [...generated, ...lab.experiments].slice(0, 40);
    const saved = await writeTeamLab(snapshot.rulesetId, lab);
    sendJson(res, 200, {
      ok: true,
      ...rulesetMetadata(snapshot),
      summary,
      corePokemon,
      experiments: generated.map(teamLabCandidateSummary),
      totalExperiments: saved.experiments.length,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/team-lab/promote") {
    const snapshot = ruleRegistry.operational({ format, rulesetId: String(body.rulesetId || requestedRulesetId) });
    const candidateId = String(body.candidateId || "").trim();
    const lab = await readTeamLab(snapshot.rulesetId);
    const candidate = lab.experiments.find((item) => item.id === candidateId);
    if (!candidate) {
      sendJson(res, 404, { ok: false, error: "找不到该配队实验候选。" });
      return;
    }
    if (!candidate.evaluation?.ok || Number(candidate.evaluation.games || 0) < 4) {
      sendJson(res, 422, { ok: false, error: "候选尚未完成足够的本地实战评估，不能晋级。" });
      return;
    }
    const registry = await readAgentTeamRegistry(snapshot.rulesetId);
    const promoted = { ...candidate, status: "active", promotedAt: new Date().toISOString() };
    if (registry.champion) registry.champion.status = "archived";
    registry.champion = promoted;
    registry.challengers = [
      ...(registry.challengers || []).filter((item) => item.id !== candidateId),
      { ...candidate, status: "promoted" },
    ].slice(-10);
    candidate.status = "promoted";
    await writeTeamLab(snapshot.rulesetId, lab);
    await writeAgentTeamRegistry(snapshot.rulesetId, registry);
    sendJson(res, 200, { ok: true, ...rulesetMetadata(snapshot), champion: teamLabCandidateSummary(promoted), registry });
    return;
  }

  sendJson(res, 405, { ok: false, error: "不支持的配队实验操作。" });
}

async function writeAgentTeamRegistry(rulesetId, registry) {
  const root = join(AGENT_LEARNING_ROOT, rulesetId);
  await mkdir(root, { recursive: true });
  registry.updatedAt = new Date().toISOString();
  await writeFile(join(root, "team-registry.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registry;
}

async function evolveAgentTeam({ rulesetId, format = "single", userGoal = "", currentTeam = [], gamesPerOpponent = 1 } = {}) {
  const snapshot = ruleRegistry.operational({ format, rulesetId });
  const summary = await learnFromAgentTraces(snapshot.rulesetId, format);
  const feedback = buildFeedbackHistory(summary);
  const generated = [];
  for (let index = 0; index < 5; index += 1) {
    const built = strictBuildTeam({
      format,
      rulesetId: snapshot.rulesetId,
      userGoal,
      currentTeam,
      buildMethod: "strict",
      forceGenerated: true,
      variationSeed: `agent-challenger-${summary.games}-${index}`,
      battleHistory: feedback,
      avoidTeam: index === 0 ? [] : generated[0]?.build?.team || currentTeam,
    });
    if (!built.ok) continue;
    const teamText = teamTextFromBuild(built.team);
    if (!teamText) continue;
    const evaluation = await evaluateGeneratedTeam(teamText, format, snapshot.rulesetId, gamesPerOpponent);
    generated.push({
      id: `challenger-${Date.now()}-${index + 1}`,
      createdAt: new Date().toISOString(),
      rulesetId: snapshot.rulesetId,
      format,
      build: built,
      teamText,
      evaluation,
      score: evaluation.games ? (0.6 * evaluation.winRate / 100 + 0.2 * Math.min(1, built.buildReport?.synergies?.length / 4 || 0) + 0.2 * Math.min(1, summary.games / 50)) : 0,
    });
  }
  const ranked = generated.sort((a, b) => b.score - a.score);
  const registry = await readAgentTeamRegistry(snapshot.rulesetId);
  const best = ranked[0] || null;
  if (best && best.evaluation.ok && best.evaluation.games > 0) {
    const threshold = best.evaluation.games >= 4 && best.evaluation.winRate >= 50;
    best.status = threshold ? "active" : "pending_evaluation";
    registry.challengers = [best, ...(registry.challengers || [])].slice(0, 10);
    if (threshold && (!registry.champion || best.evaluation.winRate >= Number(registry.champion.evaluation?.winRate || 0))) {
      if (registry.champion) registry.champion.status = "archived";
      registry.champion = { ...best, status: "active", promotedAt: new Date().toISOString() };
    }
  } else if (best) {
    best.status = "rejected_no_exact_evaluation";
  }
  await writeAgentTeamRegistry(snapshot.rulesetId, registry);
  return { ok: ranked.some((item) => item.evaluation?.ok), ...summary, ruleset: rulesetMetadata(snapshot), candidates: ranked, registry };
}

function strictGoalConstraints(payload = {}, available = []) {
  const incoming = payload.goalConstraints || payload.intent?.goalConstraints || {};
  const goal = String(payload.userGoal || payload.goal || "").toLowerCase();
  const champion = readChampionDataFile();
  const knownPokemon = Object.values(champion?.formats || {}).flatMap((format) => format?.pokemon || []);
  const themes = new Set([...(incoming.themes || [])]);
  const themePatterns = {
    sun: /晴天|日照|大晴天|\bsun\b|drought/,
    rain: /雨天|降雨|求雨|\brain\b|drizzle/,
    sand: /沙暴|沙队|扬沙|\bsand\b/,
    snow: /雪天|雪景|降雪|\bsnow\b|hail/,
    "trick-room": /戏法空间|空间|trick\s*room/,
    tailwind: /顺风|tailwind/,
    "pass-chain": /接棒|强化接棒|baton\s*pass|pass\s*chain/,
  };
  for (const [theme, pattern] of Object.entries(themePatterns)) if (pattern.test(goal)) themes.add(theme);
  const inferredMatches = [...available, ...knownPokemon].filter((candidate) => strictGoalMatchesPokemon(goal, candidate));
  const explicitMatches = [...available, ...knownPokemon].filter((candidate) => {
    if (strictGoalExplicitlyForbids(goal, candidate)) return false;
    const name = String(candidate.name || "").toLowerCase().trim();
    const slug = String(candidate.slug || "").toLowerCase().trim();
    return (name.length >= 2 && goal.includes(name)) || (slug.length >= 4 && goal.includes(slug));
  });
  // Prefer a specific form explicitly named in the goal over a shorter base-name
  // substring (for example, 清洗洛托姆 over 洛托姆).
  const inferredPokemon = inferredMatches.filter((candidate) => {
    const ownName = String(candidate.name || "").replace(/[^\u3400-\u9fff]+/g, "");
    return !inferredMatches.some((other) => {
      const otherName = String(other.name || "").replace(/[^\u3400-\u9fff]+/g, "");
      return other !== candidate && otherName.length > ownName.length && otherName.includes(ownName);
    });
  });
  const requiredPokemon = strictUniquePokemonRefs([...(Array.isArray(incoming.requiredPokemon) ? incoming.requiredPokemon : []), ...explicitMatches, ...inferredPokemon]);
  const availableSpecies = new Set(available.map((candidate) => strictKey(candidate.slug || candidate.id || candidate.name)));
  const unavailable = strictUniquePokemonRefs([
    ...(Array.isArray(incoming.unavailablePokemon) ? incoming.unavailablePokemon : []),
    ...inferredPokemon.filter((candidate) => !availableSpecies.has(strictKey(candidate.slug || candidate.id || candidate.name))),
  ]);
  const requiresSetup = /强化队|强化|setups*(team|squad)?|boost(?:ing)?s*(team|squad)?/i.test(goal);
  const forbidden = [
    ...available
      .filter((candidate) => strictGoalExplicitlyForbids(goal, candidate))
      .map((candidate) => candidate.slug),
    ...(incoming.forbiddenPokemon || []).map((item) => item.slug || item.name || item.id),
  ].map(strictKey);
  const feedback = strictFeedbackPriorities(payload.battleHistory || []);
  return {
    themes: [...themes].filter((theme) => STRICT_THEMES.includes(theme)),
    requiredPokemon,
    unavailable,
    forbidden,
    requiredMoves: Array.isArray(incoming.requiredMoves) ? incoming.requiredMoves : [],
    requiredItems: Array.isArray(incoming.requiredItems) ? incoming.requiredItems : [],
    requiredAbilities: Array.isArray(incoming.requiredAbilities) ? incoming.requiredAbilities : [],
    requiresSetup,
    aiPreferred: Array.isArray(payload.aiDraft?.pokemon)
      ? payload.aiDraft.pokemon.map((item) => strictFamilyKey(item?.slug || item?.name || item)).filter(Boolean)
      : [],
    aiVariation: String(payload.aiDraft?.variationSeed || payload.variationSeed || ""),
    avoidTeamFamilies: strictAvoidedTeamFamilies(payload.avoidTeam || payload.avoidPreviousTeam || []),
    avoidTeamFamilySets: strictAvoidedTeamFamilySets(payload.avoidTeams, payload.avoidTeam || payload.avoidPreviousTeam || []),
    feedbackPriorities: feedback.priorities,
    feedbackNotes: feedback.notes,
    maxSharedWithAvoided: Number.isFinite(Number(payload.maxSharedWithAvoided ?? incoming.maxSharedWithAvoided))
      ? Number(payload.maxSharedWithAvoided ?? incoming.maxSharedWithAvoided)
      : 4,
  };
}

function strictShowdownCandidateIsLegal(candidate = {}, format = "single", rulesetId = "") {
  const key = [rulesetId, format, candidate.slug, candidate.item, candidate.ability, candidate.nature, candidate.evs, ...(candidate.moves || [])].join("|");
  if (strictCandidateLegalityCache.has(key)) return strictCandidateLegalityCache.get(key);
  const species = legalShowdownSpeciesName(candidate.slug || candidate.id || candidate.name, candidate);
  const item = showdownLegalValue(candidate.item, "", "items");
  const ability = showdownLegalValue(candidate.ability, "", "abilities");
  const nature = showdownLegalValue(candidate.nature, "", "natures");
  const moves = (candidate.moves || []).map((move) => showdownLegalValue(move, "", "moves")).filter(Boolean).slice(0, 4);
  const minimumMoves = strictKey(species) === "ditto" ? 1 : 4;
  if (!species || !officialSpeciesAllowed(species, rulesetId) || !item || !ability || moves.length < minimumMoves) {
    strictCandidateLegalityCache.set(key, false);
    return false;
  }
  const lines = [`${species} @ ${item}`, `Ability: ${ability}`, "Level: 50"];
  const evs = championStatPointsFromChampionStats(candidate.evs, "");
  if (evs) lines.push(`EVs: ${evs}`);
  if (nature) lines.push(`${nature} Nature`);
  moves.forEach((move) => lines.push(`- ${move}`));
  const parsed = Teams.import(lines.join("\n"))[0];
  const validator = TeamValidator.get(showdownFormatFor(format, rulesetId));
  const problems = parsed ? (validator.validateSet(parsed) || []) : ["无法解析候选配置。"];
  const legal = !problems.some((problem) => !/is level 50, but this format allows level 100/i.test(problem));
  strictCandidateLegalityCache.set(key, legal);
  return legal;
}

function strictCandidateGraph(format = "single", rulesetId = "") {
  const snapshot = ruleRegistry.operational({ format, rulesetId });
  const teamData = readTeamDataDocument();
  const season = snapshot.regulation;
  const dataSeason = String(teamData.season || teamData.availableSeasons?.[0] || "");
  const champion = readChampionDataFile();
  const sourceTeams = (Array.isArray(teamData.teams) ? teamData.teams : []).filter((team) => team.season === dataSeason && team.format === format && (!team.rulesetId || team.rulesetId === snapshot.rulesetId));
  const knownPokemon = Object.values(champion?.formats || {}).flatMap((formatData) => formatData?.pokemon || []);
  const knownByKey = new Map(knownPokemon.map((mon) => [strictKey(mon.slug || mon.id || mon.name), mon]));
  const availableByKey = new Map((champion?.formats?.[format]?.pokemon || []).map((mon) => [strictKey(mon.slug || mon.id || mon.name), mon]));
  for (const [key, mon] of availableByKey) {
    if (!officialSpeciesAllowed(mon.slug || mon.id || mon.name, snapshot.rulesetId)) availableByKey.delete(key);
  }
  for (const team of sourceTeams) {
    for (const config of team.configurations || []) {
      const key = strictKey(config.slug || config.name || config.id);
      if (!key || availableByKey.has(key) || !config.item || !config.ability || !Array.isArray(config.moves) || config.moves.length < 4) continue;
      const known = knownByKey.get(key) || {};
      // A same-season, same-format complete team is legality evidence even when the usage ranking is truncated.
      availableByKey.set(key, {
        ...known,
        id: known.id || config.id || config.slug,
        slug: config.slug || known.slug || config.name,
        name: known.name || config.name || config.slug,
        sampleVerified: true,
      });
    }
  }
  const available = [...availableByKey.values()];
  const bySpecies = new Map();
  for (const team of sourceTeams) {
    for (const config of team.configurations || []) {
      const key = strictKey(config.slug || config.name || config.id);
      const mon = availableByKey.get(key);
      if (!mon || !config.item || !config.ability || !Array.isArray(config.moves) || config.moves.length < 4) continue;
      const candidate = {
        id: String(mon.id || config.id || config.slug),
        slug: config.slug || mon.slug,
        name: mon.name || config.name || config.slug,
        item: String(config.item),
        ability: String(config.ability),
        nature: String(config.nature || ""),
        evs: String(config.stats || ""),
        moves: config.moves.slice(0, 4).map(String),
        speed: Number(mon.stats?.速度 || mon.stats?.speed || strictBaseSpeedFor(config.slug || mon.slug)),
        rank: Number(mon.rank || 9999),
        types: strictTypesFor(config.slug || mon.slug),
        evidence: { teamId: team.id, title: team.title || `${dataSeason} 热门样本`, source: team.source || "热门队伍", season: dataSeason, regulation: snapshot.regulation, rulesetId: snapshot.rulesetId, format },
      };
      candidate.tags = strictTags(candidate, format);
      candidate.defense = Object.fromEntries(STRICT_ATTACK_TYPES.map((attackType) => [attackType, strictTypeMultiplier(candidate, attackType)]));
      candidate.mega = strictIsMegaItem(candidate.item);
      if (!strictShowdownCandidateIsLegal(candidate, format, snapshot.rulesetId)) continue;
      const list = bySpecies.get(strictKey(candidate.slug)) || [];
      const signature = JSON.stringify([candidate.item, candidate.ability, candidate.moves]);
      if (!list.some((item) => JSON.stringify([item.item, item.ability, item.moves]) === signature)) list.push(candidate);
      bySpecies.set(strictKey(candidate.slug), list);
    }
  }
  return { season, dataSeason, ruleset: snapshot, available, bySpecies, candidates: [...bySpecies.values()].flat() };
}

function strictMemberScore(member, team = [], format = "single", constraints = {}) {
  const tags = member.tags || strictTags(member, format);
  let score = Math.max(0, 160 - Number(member.rank || 9999)) * 0.08;
  for (const tag of ["wincon", "speed", "safe-entry", "defensive", "pivot", "hazard", "removal", "protect", "spread"]) if (tags.has(tag)) score += 7;
  if (tags.has("prankster") && tags.has("status")) score += 12;
  const megaCount = team.filter((own) => own.mega).length;
  if (member.mega && megaCount === 0) score += 24;
  if (member.mega && megaCount === 1) score += 3;
  for (const theme of constraints.themes || []) {
    const info = strictThemeInfo(member, theme);
    if (info.source) score += 80;
    if (info.abuser) score += 38;
  }
  for (const move of constraints.requiredMoves || []) if (strictMemberMatchesRequirement(member, "moves", move)) score += 120;
  for (const item of constraints.requiredItems || []) if (strictMemberMatchesRequirement(member, "items", item)) score += 110;
  for (const ability of constraints.requiredAbilities || []) if (strictMemberMatchesRequirement(member, "abilities", ability)) score += 100;
  if (constraints.requiresSetup && tags.has("setup")) score += 56;
  if (constraints.requiresSetup && (tags.has("protect") || tags.has("safe-entry"))) score += 14;
  for (const priority of constraints.feedbackPriorities || []) if (tags.has(priority)) score += 20;
  for (const own of team) {
    const ownTags = own.tags || strictTags(own, format);
    const ownTypes = new Set(own.types || strictTypesFor(own.slug));
    const sharedTypes = (member.types || strictTypesFor(member.slug)).filter((type) => ownTypes.has(type)).length;
    score -= sharedTypes * 18;
    if (tags.has("pivot") && (ownTags.has("wincon") || own.mega)) score += 12;
    if (tags.has("speed") && ownTags.has("wincon")) score += 12;
    if (tags.has("defensive") && ownTags.has("wallbreaker")) score += 8;
  }
  // Make an existing weakness cluster expensive while the beam is still choosing members.
  // Final validation also checks this, but scoring it here prevents an otherwise popular
  // weather attacker from pushing every valid switch-in out of the beam.
  for (const attackType of STRICT_ATTACK_TYPES) {
    const existingWeak = team.filter((own) => strictDefenseMultiplier(own, attackType) > 1).length;
    const existingAnswers = team.filter((own) => strictDefenseMultiplier(own, attackType) < 1).length;
    const multiplier = strictDefenseMultiplier(member, attackType);
    if (existingWeak + Number(multiplier > 1) >= 2 && existingAnswers + Number(multiplier < 1) === 0) score -= 52;
    if (multiplier < 1 && existingWeak >= 1) score += 18;
    if (multiplier === 0 && existingWeak >= 1) score += 8;
  }
  // In AI-original mode, a verified AI pick should beat a generic popular filler
  // when both choices preserve the same structural requirements. Final selection
  // also compares retained-pick count, so this only helps keep those branches in
  // the beam long enough to be validated.
  if ((constraints.aiPreferred || []).includes(strictFamilyKey(member.slug))) score += 108;
  const repeatedAcrossHistory = (constraints.avoidTeamFamilySets || []).filter((families) => families.has(strictFamilyKey(member.slug))).length;
  // Hard requirements are locked separately. This small penalty only decides
  // between otherwise viable fillers, keeping repeated requests exploratory.
  if (repeatedAcrossHistory) score -= repeatedAcrossHistory * 14;
  // Variation only resolves near-ties between otherwise suitable candidates; it
  // must never outweigh a verified system role, defensive answer, or hard core.
  if (constraints.aiVariation) score += strictVariationScore(member.slug, constraints.aiVariation) * 0.42;
  return score;
}

function strictConflictsWithThemes(member = {}, constraints = {}) {
  const text = strictText(member);
  const themes = new Set(constraints.themes || []);
  const weatherThemes = ["rain", "sun", "sand", "snow"];
  const incompatibleWeatherPayoffs = {
    rain: /chlorophyll|solar-power|solar-beam|sand-rush|sand-force|slush-rush|aurora-veil/,
    sun: /swift-swim|thunder|hurricane|electro-shot|sand-rush|sand-force|slush-rush|aurora-veil/,
    sand: /swift-swim|thunder|hurricane|electro-shot|chlorophyll|solar-power|solar-beam|slush-rush|aurora-veil/,
    snow: /swift-swim|thunder|hurricane|electro-shot|chlorophyll|solar-power|solar-beam|sand-rush|sand-force/,
  };
  if (!weatherThemes.some((theme) => themes.has(theme)) && weatherThemes.some((theme) => {
    const info = strictThemeInfo(member, theme);
    return info.source || info.abuser;
  })) return true;
  if (!themes.has("trick-room") && /trick-room/.test(text)) return true;
  if (themes.has("trick-room") && /tailwind/.test(text)) return true;
  for (const theme of weatherThemes) {
    if (themes.has(theme) && incompatibleWeatherPayoffs[theme].test(text)) return true;
  }
  if (themes.has("rain") && /drought|sunny-day|heat-wave|fire-blast|flare-blitz|eruption|solar-beam|charizardite-y|torkoal|ninetales/.test(text)) return true;
  if (themes.has("sun") && /drizzle|rain-dance|hydro-pump|muddy-water|wave-crash|waterfall|thunder|hurricane|pelipper|politoed/.test(text)) return true;
  if (themes.has("sand") && /drizzle|rain-dance|drought|sunny-day|snow-warning|snowscape/.test(text)) return true;
  if (themes.has("snow") && /drizzle|rain-dance|drought|sunny-day|sand-stream|sandstorm/.test(text)) return true;
  return false;
}

function strictTeamValidation(team = [], format = "single", constraints = {}) {
  const failures = [];
  const tags = new Set(team.flatMap((member) => [...(member.tags || [])]));
  const mega = team.filter((member) => member.mega);
  const typeCounts = new Map();
  for (const member of team) {
    if (constraints.rulesetId && !officialSpeciesAllowed(member.slug || member.id || member.name, constraints.rulesetId)) failures.push(`队伍成员 ${member.name || member.slug || "未知宝可梦"} 不在当前赛制官方可用名单。`);
    for (const type of member.types || strictTypesFor(member.slug)) typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }
  if (team.length !== 6) failures.push(`只构筑出 ${team.length}/6 个有验证配置的位置。`);
  if (new Set(team.map((member) => strictFamilyKey(member.slug))).size !== team.length) failures.push("队伍出现同族或形态重复。");
  if (new Set(team.map((member) => strictKey(member.item))).size !== team.length) failures.push("同一队伍出现重复道具，无法确认其符合当前规则。");
  if (mega.length > 2) failures.push("Mega 候选超过两个。");
  for (const [type, count] of typeCounts) if (count > 2) failures.push(`${type} 属性成员达到 ${count} 只，联防与换入点过度重叠。`);
  for (const attackType of STRICT_ATTACK_TYPES) {
    const weak = team.filter((member) => strictTypeMultiplier(member, attackType) > 1).length;
    const answers = team.filter((member) => strictTypeMultiplier(member, attackType) < 1).length;
    if (weak >= 2 && answers === 0) failures.push(`面对 ${attackType} 打点有 ${weak} 个弱点位，却没有抗性或免疫换入点。`);
  }
  for (const required of constraints.requiredPokemon || []) {
    const key = strictKey(required.slug || required.id || required.name);
    if (!team.some((member) => strictKey(member.slug) === key)) failures.push(`缺少用户指定核心：${required.name || required.slug || required.id}。`);
  }
  for (const forbidden of constraints.forbidden || []) {
    if (team.some((member) => strictKey(member.slug) === strictKey(forbidden))) failures.push(`队伍包含用户禁止的宝可梦：${forbidden}。`);
  }
  for (const move of constraints.requiredMoves || []) {
    if (!team.some((member) => strictMemberMatchesRequirement(member, "moves", move))) failures.push(`缺少用户指定招式：${strictRequirementLabel(move)}。`);
  }
  for (const item of constraints.requiredItems || []) {
    if (!team.some((member) => strictMemberMatchesRequirement(member, "items", item))) failures.push(`缺少用户指定道具：${strictRequirementLabel(item)}。`);
  }
  for (const ability of constraints.requiredAbilities || []) {
    if (!team.some((member) => strictMemberMatchesRequirement(member, "abilities", ability))) failures.push(`缺少用户指定特性：${strictRequirementLabel(ability)}。`);
  }
  for (const theme of constraints.themes || []) {
    const source = team.some((member) => strictThemeInfo(member, theme).source);
    const abuser = team.some((member) => {
      const info = strictThemeInfo(member, theme);
      return info.abuser && (theme === "tailwind" || !info.source);
    });
    if (!source) failures.push(`${theme} 体系没有真实启动者。`);
    if (!abuser) failures.push(`${theme} 体系没有独立收益位。`);
    if (theme === "trick-room" && team.filter((member) => strictThemeInfo(member, theme).abuser).length < 2) failures.push("trick-room 体系至少需要两名真实低速输出位。");
  }
  if ((constraints.themes || []).includes("pass-chain")) {
    const passer = team.find((member) => strictThemeInfo(member, "pass-chain").source);
    const receiver = strictPassReceiver(team, passer);
    const safety = team.find((member) => member !== passer && member !== receiver && ((member.tags || new Set()).has("protect") || (member.tags || new Set()).has("safe-entry")));
    if (!passer) failures.push("接棒体系缺少同一只实际携带强化招式和接棒的传递者。 ");
    if (!receiver) failures.push("接棒体系缺少独立的强化接收者。 ");
    if (!safety) failures.push("接棒体系缺少独立的保护或安全上场成员。 ");
  }
  if (constraints.requiresSetup) {
    const setupMembers = team.filter((member) => (member.tags || new Set()).has("setup"));
    if (setupMembers.length < 2) failures.push("强化队至少需要两名实际携带强化招式的成员。");
    if (!team.some((member) => (member.tags || new Set()).has("protect") || (member.tags || new Set()).has("safe-entry"))) failures.push("强化队缺少保护强化回合或安全上场资源。");
    if (!setupMembers.some((member) => (member.tags || new Set()).has("wincon"))) failures.push("强化队缺少能将强化转化为终盘压力的成员。");
  }
  if (format === "single") {
    if (!tags.has("wincon")) failures.push("缺少明确的突破或终盘胜点。");
    if (!tags.has("speed")) failures.push("缺少速度控制、高速压制或先制兜底。");
    if (!tags.has("safe-entry")) failures.push("缺少安全上场、转场或防守中转。");
    if (!tags.has("hazard") && !tags.has("removal") && !tags.has("status")) failures.push("缺少撒场、清场或状态消耗资源。");
  } else {
    if (!tags.has("speed")) failures.push("双打缺少真实控速或速度收益。");
    if (!tags.has("protect")) failures.push("双打缺少守住、掩护、击掌或广域防守等安全回合资源。");
    if (!tags.has("wincon")) failures.push("双打缺少明确输出或终盘收割位。");
  }
  return { ok: !failures.length, failures, tags, mega };
}

function strictSynergyReport(team = [], format = "single", constraints = {}) {
  const links = [];
  const isPassChain = (constraints.themes || []).includes("pass-chain");
  const passer = isPassChain ? team.find((member) => strictThemeInfo(member, "pass-chain").source) : null;
  const receiver = isPassChain ? strictPassReceiver(team, passer) : null;
  if (passer && receiver) links.push(`${passer.name} 先强化再接棒，把强化交给 ${receiver.name} 完成终盘。`);
  // Put requested-system links first. Otherwise common pivot text can fill the
  // short report before it ever explains why a rain, sun, or Trick Room team
  // works as that system.
  for (const theme of constraints.themes || []) {
    if (theme === "pass-chain") continue;
    const source = strictPreferredThemeSource(team, theme);
    if (!source) continue;
    let reported = 0;
    for (const target of team) {
      if (target === source || !strictThemeInfo(target, theme).abuser) continue;
      links.push(`${source.name} 启动${strictThemeLabel(theme)}，由 ${target.name} 吃到体系收益。`);
      reported += 1;
      if (reported >= 2) break;
    }
  }
  for (const source of team) {
    for (const target of team) {
      if (source === target) continue;
      const sourceTags = source.tags || new Set();
      const targetTags = target.tags || new Set();
      if (sourceTags.has("pivot") && (targetTags.has("wincon") || target.mega)) links.push(`${source.name} 用转场让 ${target.name} 安全上场。`);
      if (sourceTags.has("speed-control") && targetTags.has("wincon")) links.push(`${source.name} 的控速服务 ${target.name} 的突破或收割。`);
      if (sourceTags.has("defensive") && targetTags.has("wallbreaker")) links.push(`${source.name} 承接压力，为 ${target.name} 保留进攻回合。`);
    }
  }
  return [...new Set(links)].slice(0, 4);
}

function strictPreferredThemeSource(team = [], theme = "") {
  const sourcePattern = {
    sun: /drought/,
    rain: /drizzle/,
    sand: /sand-stream/,
    snow: /snow-warning/,
  }[theme];
  const sources = team.filter((member) => strictThemeInfo(member, theme).source);
  return sources.find((member) => sourcePattern?.test(strictText(member))) || sources[0] || null;
}

function strictBuildPlan(team = [], format = "single", constraints = {}) {
  const isPassChain = (constraints.themes || []).includes("pass-chain");
  const passer = isPassChain ? team.find((member) => strictThemeInfo(member, "pass-chain").source) : null;
  const receiver = isPassChain ? strictPassReceiver(team, passer) : null;
  const activeTheme = (constraints.themes || []).find((theme) => STRICT_THEMES.includes(theme) && theme !== "pass-chain");
  const systemSetter = activeTheme ? strictPreferredThemeSource(team, activeTheme) : null;
  const lead = passer || systemSetter || team.find((member) => (member.tags || new Set()).has("hazard") || (member.tags || new Set()).has("speed-control") || (member.tags || new Set()).has("speed")) || team[0];
  const pivot = team.find((member) => (member.tags || new Set()).has("pivot") || (member.tags || new Set()).has("defensive")) || team[1] || team[0];
  const closer = receiver || team.find((member) => (member.tags || new Set()).has("wincon")) || team.at(-1);
  const themes = (constraints.themes || []).map(strictThemeLabel);
  const themeLine = isPassChain
    ? passer && receiver
      ? `${passer.name} 先获得强化回合并用接棒传给 ${receiver.name}，其余成员负责保护传递与清除阻断。`
      : "接棒体系缺少完整传递链，不能输出为可用队伍。"
    : constraints.requiresSetup ? "以双强化主轴制造压力，优先保护强化回合，再由强化收益位接管终盘。" : themes.length ? `围绕 ${themes.join(" + ")} 组件抢到启动回合，再让收益位接管节奏。` : "以平衡/半攻轮换推进，不强塞天气或空间轴。";
  return `${themeLine} 开局优先由 ${lead?.name || "首发位"} 建立节奏；中盘用 ${pivot?.name || "中转位"} 吃伤害或转场，给核心创造进场；终盘交给 ${closer?.name || "终盘位"} 完成收割。`;
}

function strictFullSampleCandidate(graph, format, constraints = {}, exactFamilies = []) {
  const configuredTeams = readTeamDataFile().filter((entry) => entry.season === graph.dataSeason && entry.format === format && (!entry.rulesetId || entry.rulesetId === graph.ruleset?.rulesetId) && (entry.configurations || []).length >= 6);
  const requestedWeather = ["rain", "sun", "sand", "snow"].filter((theme) => (constraints.themes || []).includes(theme));
  const candidateForConfig = (config = {}) => {
    const variants = graph.bySpecies.get(strictKey(config.slug || config.name || config.id)) || [];
    return variants.find((member) => strictKey(member.item) === strictKey(config.item) && strictKey(member.ability) === strictKey(config.ability) && JSON.stringify(member.moves.map(strictKey)) === JSON.stringify((config.moves || []).slice(0, 4).map(strictKey))) || null;
  };
  const samples = configuredTeams
    .map((source) => ({ source, team: source.configurations.slice(0, 6).map(candidateForConfig) }))
    .filter(({ team }) => team.length === 6 && team.every(Boolean))
    .filter(({ team }) => {
      if (!exactFamilies.length) return true;
      const families = new Set(team.map((member) => strictFamilyKey(member.slug)));
      return families.size === exactFamilies.length && exactFamilies.every((family) => families.has(family));
    })
    .filter(({ team }) => !team.some((member) => (constraints.forbidden || []).includes(strictKey(member.slug))))
    .filter(({ team }) => strictIsDistinctFromAvoidedTeam(team, constraints))
    .filter(({ team }) => team.every((member) => !strictConflictsWithThemes(member, constraints)))
    .filter(({ team }) => {
      const validation = strictTeamValidation(team, format, constraints);
      if (!validation.ok) return false;
      const activeWeather = requestedWeather.length
        ? ["rain", "sun", "sand", "snow"].filter((theme) => team.some((member) => strictThemeInfo(member, theme).source))
        : [];
      if (requestedWeather.length === 1 && activeWeather.some((theme) => theme !== requestedWeather[0])) return false;
      const text = team.map(strictText).join(" ");
      if ((constraints.themes || []).includes("rain") && /chlorophyll|solar-power|solar-beam|sand-rush|sand-force|slush-rush|aurora-veil/.test(text)) return false;
      if ((constraints.themes || []).includes("sun") && /swift-swim|thunder|hurricane|electro-shot|sand-rush|sand-force|slush-rush|aurora-veil/.test(text)) return false;
      if ((constraints.themes || []).includes("sand") && /swift-swim|chlorophyll|solar-power|slush-rush|aurora-veil/.test(text)) return false;
      if ((constraints.themes || []).includes("snow") && /swift-swim|chlorophyll|solar-power|sand-rush|sand-force/.test(text)) return false;
      if (team.filter((member) => strictThemeInfo(member, "tailwind").source).length > 2) return false;
      return requestedWeather.every((theme) => team.some((member) => strictThemeInfo(member, theme).source));
    })
    .sort((a, b) => Number(b.source.rate || 0) - Number(a.source.rate || 0) || Number(a.source.rank || 9999) - Number(b.source.rank || 9999) || strictVariationScore(String(a.source.id || a.source.title || ""), constraints.aiVariation) - strictVariationScore(String(b.source.id || b.source.title || ""), constraints.aiVariation));
  return samples[0] || null;
}

function strictRiskReport(team = [], format = "single", constraints = {}) {
  const themes = new Set(constraints.themes || []);
  const risks = [];
  const named = (member) => member?.name || "核心成员";
  if (themes.has("pass-chain")) {
    const passer = team.find((member) => strictThemeInfo(member, "pass-chain").source);
    const receiver = strictPassReceiver(team, passer);
    const safety = team.find((member) => member !== passer && member !== receiver && ((member.tags || new Set()).has("protect") || (member.tags || new Set()).has("safe-entry")));
    risks.push(`优先保护 ${named(passer)} 的强化与接棒回合；面对挑衅、击掌或集火时先用 ${named(safety)} 争取安全回合，再把强化交给 ${named(receiver)}。`);
  }
  for (const [theme, label] of [["rain", "雨天"], ["sun", "晴天"], ["sand", "沙暴"], ["snow", "雪天"]]) {
    if (!themes.has(theme)) continue;
    const source = strictPreferredThemeSource(team, theme);
    const abuser = team.find((member) => member !== source && strictThemeInfo(member, theme).abuser);
    risks.push(`对手抢 ${label} 时，优先保留 ${named(source)} 的启动机会；${named(abuser)} 不要在天气被覆盖前过早换入。`);
  }
  if (themes.has("trick-room")) {
    const setter = team.find((member) => strictThemeInfo(member, "trick-room").source);
    risks.push(`空间回合优先保护 ${named(setter)} 开出戏法空间；空间结束前预留低速输出位，避免高速成员被迫站场。`);
  }
  if (themes.has("tailwind")) {
    const setter = team.find((member) => strictThemeInfo(member, "tailwind").source);
    risks.push(`顺风由 ${named(setter)} 开启后再推进主输出；对手有挑衅或反顺风时保留第二条控速或先制收割路线。`);
  }
  if (format === "double") risks.push("注意首发集火、守住与范围招的回合交换；不要为了输出让两只核心同时暴露在同一轮压制下。");
  else risks.push("注意速度线、钉子资源与转场血量；终盘位进场前先完成必要的消耗或清场。");
  return [...new Set(risks)].slice(0, 3);
}

function strictBuildResult(team = [], format = "single", graph = {}, constraints = {}, intent = "new-team", current = [], source = null, aiDraft = null, alternatives = []) {
  const validation = strictTeamValidation(team, format, constraints);
  const synergies = strictSynergyReport(team, format, constraints);
  const ruleset = graph.ruleset || {};
  const dataLabel = graph.dataSeason ? `数据赛季 ${graph.dataSeason}` : "当前数据";
  const mega = validation.mega;
  const isPassChain = (constraints.themes || []).includes("pass-chain");
  const passer = isPassChain ? team.find((member) => strictThemeInfo(member, "pass-chain").source) : null;
  const receiver = isPassChain ? strictPassReceiver(team, passer) : null;
  const safety = isPassChain ? team.find((member) => member !== passer && member !== receiver && ((member.tags || new Set()).has("protect") || (member.tags || new Set()).has("safe-entry"))) : null;
  return {
    ok: true,
    format,
    season: graph.season,
    dataSeason: graph.dataSeason || "",
    ...rulesetMetadata(ruleset),
    buildMethod: aiDraft?.mode === "engine-guided" ? "engine-guided" : aiDraft ? "ai-designed" : source ? "sample" : "strict",
    team: team.map((member) => ({
      id: member.id,
      slug: member.slug,
      name: member.name,
      item: member.item,
      ability: member.ability,
      nature: member.nature,
      evs: member.evs,
      level: "50",
      moves: member.moves,
      role: member === passer ? "强化接棒/首发位" : member === receiver ? "强化接收/终盘位" : member === safety ? "安全回合/保护位" : member.tags.has("speed") ? "控速/节奏位" : member.tags.has("pivot") ? "轮换中转位" : member.tags.has("defensive") ? "联防中转位" : member.tags.has("wincon") ? "突破/终盘位" : "结构补位",
      note: source
        ? `来自当前 ${ruleset.regulation || graph.season} 同格式完整热门样本（${dataLabel}）。`
        : aiDraft
          ? `该成员配置经当前 ${ruleset.regulation || graph.season} 同格式样本验证；六人组合不是完整热门队原样复用。`
          : member.mega
            ? "Mega 候选；本局只作为已规划的 Mega 资源使用。"
            : `配置来自当前 ${ruleset.regulation || graph.season} 同格式热门样本。`,
      evidence: member.evidence,
    })),
    buildReport: {
      plan: strictBuildPlan(team, format, constraints),
      synergies,
      risks: strictRiskReport(team, format, constraints),
      mega: mega.length ? { primary: mega[0].name, secondary: mega[1]?.name || "", reason: mega.length > 1 ? "两个 Mega 只作为不同对局分支，不可同局同时 Mega。" : "该 Mega 补足当前主轴的突破或终盘能力。" } : { primary: "", secondary: "", reason: "当前验证候选没有能提升主轴且不破坏结构的 Mega，未强塞。" },
      feedback: (constraints.feedbackPriorities || []).length ? { priorities: constraints.feedbackPriorities, notes: constraints.feedbackNotes || [] } : null,
      changes: intent === "current-team" ? { kept: current.filter((item) => team.some((member) => strictFamilyKey(member.slug) === strictFamilyKey(item.slug || item.name || item.id))).map((item) => item.name || item.slug), replaced: current.filter((item) => !team.some((member) => strictFamilyKey(member.slug) === strictFamilyKey(item.slug || item.name || item.id))).map((item) => item.name || item.slug) } : null,
      source: source ? { id: source.id, title: source.title || "完整热门样本", provider: source.source || "热门队伍" } : null,
      aiDesign: aiDraft ? {
        proposed: (aiDraft.aiSelected || aiDraft.pokemon || []).map((item) => item.name || item.slug || item).filter(Boolean),
        engineAdded: (aiDraft.engineAdded || []).map((item) => item.name || item.slug || item).filter(Boolean),
        retained: team.filter((member) => (aiDraft.aiSelected || aiDraft.pokemon || []).some((item) => strictFamilyKey(item?.slug || item?.name || item) === strictFamilyKey(member.slug))).map((member) => member.name),
        adjusted: team.filter((member) => !(aiDraft.pokemon || []).some((item) => strictFamilyKey(item?.slug || item?.name || item) === strictFamilyKey(member.slug))).map((member) => member.name),
        rationale: String(aiDraft.rationale || ""),
        completionNote: String(aiDraft.completionNote || ""),
      } : null,
    },
    alternatives: alternatives.map((entry, index) => {
      const alternativeTeam = entry.team || entry;
      const alternativeValidation = strictTeamValidation(alternativeTeam, format, constraints);
      const alternativeMega = alternativeValidation.mega;
      return {
        id: `strict-variant-${index + 1}`,
        score: Math.round(Number(entry.score || 0) * 10) / 10,
        team: alternativeTeam.map((member) => ({
          id: member.id,
          slug: member.slug,
          name: member.name,
          item: member.item,
          ability: member.ability,
          nature: member.nature,
          evs: member.evs,
          level: "50",
          moves: member.moves,
          role: member.tags.has("speed") ? "控速/节奏位" : member.tags.has("pivot") ? "轮换中转位" : member.tags.has("defensive") ? "联防中转位" : member.tags.has("wincon") ? "突破/终盘位" : "结构补位",
          note: `该成员配置经当前 ${ruleset.regulation || graph.season} 同格式样本验证；六人组合不是完整热门队原样复用。`,
          evidence: member.evidence,
        })),
        plan: strictBuildPlan(alternativeTeam, format, constraints),
        synergies: strictSynergyReport(alternativeTeam, format, constraints),
        risks: strictRiskReport(alternativeTeam, format, constraints),
        mega: alternativeMega.length ? { primary: alternativeMega[0].name, secondary: alternativeMega[1]?.name || "", reason: alternativeMega.length > 1 ? "两个 Mega 只作为不同对局分支，不可同局同时 Mega。" : "该 Mega 补足当前主轴的突破或终盘能力。" } : { primary: "", secondary: "", reason: "当前验证候选没有能提升主轴且不破坏结构的 Mega，未强塞。" },
      };
    }),
  };
}

function strictBuildTeam(payload = {}) {
  const format = payload.format === "double" ? "double" : "single";
  const rulesetId = String(payload.rulesetId || "").trim();
  const graph = strictCandidateGraph(format, rulesetId);
  const constraints = { ...strictGoalConstraints(payload, graph.available), rulesetId: graph.ruleset.rulesetId };
  const variantsFor = (ref = "", exactOnly = false) => {
    const exact = graph.bySpecies.get(strictKey(ref));
    if (exact?.length) return exact;
    if (exactOnly) return [];
    return [...graph.bySpecies.entries()].find(([key]) => strictFamilyKey(key) === strictFamilyKey(ref))?.[1] || [];
  };
  const diagnostics = [];
  if (constraints.unavailable.length) diagnostics.push(...constraints.unavailable.map((item) => `${item.name || item.slug || item.id} 不在当前 ${graph.season} ${format} 可用池。`));
  const current = Array.isArray(payload.currentTeam) ? payload.currentTeam : [];
  const intent = payload.intent || "new-team";
  const requiredKeys = new Set(constraints.requiredPokemon.map((item) => strictKey(item.slug || item.name || item.id)));
  const unavailableKeys = new Set(constraints.unavailable.map((item) => strictKey(item.slug || item.name || item.id)));
  const forbiddenKeys = new Set((constraints.forbidden || []).map(strictKey));
  if (intent === "complete-team" || intent === "moveset-only") current.forEach((item) => requiredKeys.add(strictKey(item.slug || item.name || item.id)));
  for (const key of requiredKeys) if (!unavailableKeys.has(key) && !variantsFor(key, true).length) diagnostics.push(`找不到 ${key} 的当前 ${graph.season} ${format} 验证配置。`);
  for (const key of requiredKeys) if (forbiddenKeys.has(key)) diagnostics.push(`硬性要求冲突：${key} 同时被指定为核心和禁止项。`);
  for (const [category, requirements] of [["moves", constraints.requiredMoves], ["items", constraints.requiredItems], ["abilities", constraints.requiredAbilities]]) {
    for (const requirement of requirements || []) {
      if (!graph.candidates.some((member) => strictMemberMatchesRequirement(member, category, requirement))) diagnostics.push(`当前 ${graph.season} ${format} 没有可验证的${category === "moves" ? "招式" : category === "items" ? "道具" : "特性"}：${strictRequirementLabel(requirement)}。`);
    }
  }
  if (diagnostics.length) return { ok: false, code: "BUILD_UNSATISFIED", format, diagnostics };

  const locked = [];
  for (const item of current) {
    const configured = item?.config || {};
    const variants = variantsFor(item.slug || item.name || item.id, true);
    const configuredVariant = variants.find((member) => {
      const hasItem = configured.item && strictKey(member.item) === strictKey(configured.item);
      const hasAbility = configured.ability && strictKey(member.ability) === strictKey(configured.ability);
      const configuredMoves = Array.isArray(configured.moves) ? configured.moves.filter(Boolean).map(strictKey) : [];
      const hasMoves = configuredMoves.length && configuredMoves.every((move) => member.moves.map(strictKey).includes(move));
      return (hasItem || hasAbility || hasMoves) && (!configured.item || hasItem) && (!configured.ability || hasAbility) && (!configuredMoves.length || hasMoves);
    });
    const fallbackVariant = variants.find((member) => !locked.some((own) => strictKey(own.item) === strictKey(member.item))) || variants[0];
    if (configuredVariant || fallbackVariant) locked.push(configuredVariant || fallbackVariant);
  }
  if ((intent === "complete-team" || intent === "moveset-only") && locked.length !== current.length) return { ok: false, code: "BUILD_UNSATISFIED", format, rulesetId: graph.ruleset.rulesetId, diagnostics: [`当前队伍中存在没有 ${graph.season} 同格式验证配置的成员，锁定模式不能偷偷替换。`] };
  if (intent === "moveset-only" && locked.length !== 6) return { ok: false, code: "BUILD_UNSATISFIED", format, diagnostics: ["只改配置需要先拥有完整的六只队伍。"] };

  // An engine-guided draft was already selected from a complete, validated
  // current-format build. Recreate that exact result instead of treating it as
  // a free-form AI six and accidentally changing its verified configurations.
  if (payload.aiDraft?.mode === "engine-guided") {
    const resolved = strictBuildTeam({ ...payload, buildMethod: "strict", forceGenerated: true, variationSeed: payload.aiDraft.variationSeed, aiDraft: undefined });
    if (!resolved.ok) return resolved;
    resolved.buildMethod = "engine-guided";
    resolved.buildReport.aiDesign = {
      proposed: (payload.aiDraft.aiSelected || []).map((item) => item.name || item.slug || item).filter(Boolean),
      engineAdded: (payload.aiDraft.engineAdded || payload.aiDraft.pokemon || []).map((item) => item.name || item.slug || item).filter(Boolean),
      retained: [],
      adjusted: resolved.team.map((member) => member.name),
      rationale: String(payload.aiDraft.rationale || ""),
      completionNote: String(payload.aiDraft.completionNote || ""),
    };
    return resolved;
  }

  const aiDesigned = payload.buildMethod === "ai-designed" && constraints.aiPreferred.length > 0;
  const evolutionMode = payload.buildMethod === "evolution" || payload.evolution === true;
  const shouldPreferFullSample = !payload.forceGenerated && !evolutionMode && !aiDesigned && !constraints.feedbackPriorities?.length && ((constraints.themes || []).length || (constraints.requiredPokemon || []).length);
  const fullSample = shouldPreferFullSample ? strictFullSampleCandidate(graph, format, constraints) : null;
  if (fullSample) return strictBuildResult(fullSample.team, format, graph, constraints, intent, current, fullSample.source);

  const rankedPool = graph.candidates
    .filter((member) => !constraints.forbidden.includes(strictKey(member.slug)) && (!strictConflictsWithThemes(member, constraints) || requiredKeys.has(strictKey(member.slug))))
    .sort((a, b) => strictMemberScore(b, locked, format, constraints) - strictMemberScore(a, locked, format, constraints));
  const variantsBySpecies = new Map();
  for (const member of rankedPool) {
    const key = strictFamilyKey(member.slug);
    const variants = variantsBySpecies.get(key) || [];
    if (variants.length < 2) variants.push(member);
    variantsBySpecies.set(key, variants);
  }
  const primaryPool = [...variantsBySpecies.values()].flat().slice(0, aiDesigned ? 240 : 120);
  // Keep at least one verified resist / immunity answer for every attacking type in
  // the beam. Theme scoring otherwise crowds out the exact switch-in required to
  // close a shared weakness (notably Rock against common sun cores).
  const coveragePool = STRICT_ATTACK_TYPES
    .map((attackType) => rankedPool.find((member) => strictDefenseMultiplier(member, attackType) < 1))
    .filter(Boolean);
  const pool = [...new Map([...primaryPool, ...coveragePool].map((member) => [`${member.slug}:${member.item}:${member.ability}:${member.moves.join(",")}`, member])).values()];
  const seeds = [];
  const megaLimit = /双\s*mega|two\s*mega|两个\s*mega/i.test(String(payload.userGoal || "")) ? 2 : 1;
  const addUnique = (team, member) => {
    if (!member || forbiddenKeys.has(strictKey(member.slug)) || team.some((own) => strictFamilyKey(own.slug) === strictFamilyKey(member.slug)) || team.some((own) => strictKey(own.item) === strictKey(member.item)) || (member.mega && team.filter((own) => own.mega).length >= megaLimit)) return null;
    const memberTypes = member.types?.length ? member.types : strictTypesFor(member.slug);
    if (memberTypes.some((type) => team.filter((own) => (own.types?.length ? own.types : strictTypesFor(own.slug)).includes(type)).length >= 2)) return null;
    if (constraints.requiresSetup && (member.tags || new Set()).has("setup") && team.filter((own) => (own.tags || new Set()).has("setup")).length >= 2 && !requiredKeys.has(strictKey(member.slug))) return null;
    for (const theme of constraints.themes || []) {
      const limit = theme === "trick-room" ? 2 : 1;
      if (strictThemeInfo(member, theme).source && team.filter((own) => strictThemeInfo(own, theme).source).length >= limit) return null;
    }
    return [...team, member];
  };
  if (aiDesigned) {
    const requiredFamilies = [...requiredKeys].map((key) => strictFamilyKey(key));
    const preferred = [...new Set([...requiredFamilies, ...(constraints.aiPreferred || [])])].slice(0, 6);
    if (preferred.length === 6) {
      const exactSample = strictFullSampleCandidate(graph, format, constraints, preferred);
      if (exactSample && strictSynergyReport(exactSample.team, format, constraints).length >= 2) {
        return strictBuildResult(exactSample.team, format, graph, constraints, intent, current, null, payload.aiDraft);
      }
      let draftTeams = [[]];
      const preferredEntries = preferred
        .map((family) => ({ family, variants: rankedPool.filter((member) => strictFamilyKey(member.slug) === family).slice(0, 24) }))
        .sort((a, b) => a.variants.length - b.variants.length);
      for (const { variants } of preferredEntries) {
        const expanded = [];
        for (const team of draftTeams) {
          for (const member of variants) {
            const next = addUnique(team, member);
            if (next) expanded.push(next);
          }
        }
        draftTeams = expanded
          .sort((a, b) => b.reduce((sum, member) => sum + strictMemberScore(member, b.filter((item) => item !== member), format, constraints), 0) - a.reduce((sum, member) => sum + strictMemberScore(member, a.filter((item) => item !== member), format, constraints), 0))
          .slice(0, 512);
        if (!draftTeams.length) break;
      }
      const direct = draftTeams
        .filter((team) => team.length === 6)
        .map((team) => ({ team, validation: strictTeamValidation(team, format, constraints), score: team.reduce((sum, member) => sum + strictMemberScore(member, team.filter((item) => item !== member), format, constraints), 0) }))
        .sort((a, b) => Number(b.validation.ok) - Number(a.validation.ok) || b.score - a.score);
      const selectedDraft = direct.find((entry) => entry.validation.ok && strictIsDistinctFromAvoidedTeam(entry.team, constraints) && strictSynergyReport(entry.team, format, constraints).length >= 2);
      if (selectedDraft) {
        return strictBuildResult(selectedDraft.team, format, graph, constraints, intent, current, null, payload.aiDraft);
      }
    }
  }
  let initial = [];
  if (intent === "complete-team" || intent === "moveset-only") initial = locked;
  else {
    for (const key of requiredKeys) {
      const requiredVariant = variantsFor(key, true)
        .slice()
        .sort((a, b) => strictMemberScore(b, initial, format, constraints) - strictMemberScore(a, initial, format, constraints))[0];
      initial = addUnique(initial, requiredVariant) || initial;
    }
    for (const member of locked) {
      const next = addUnique(initial, member);
      if (next) initial = next;
    }
    for (const theme of constraints.themes || []) {
      const source = rankedPool.find((member) => strictThemeInfo(member, theme).source && addUnique(initial, member));
      const withSource = addUnique(initial, source);
      if (withSource) initial = withSource;
      const abuser = theme === "pass-chain"
        ? rankedPool
          .filter((member) => strictThemeInfo(member, theme).abuser && !strictThemeInfo(member, theme).source && addUnique(initial, member))
          .sort((a, b) => strictPassReceiverScore(b) - strictPassReceiverScore(a))[0]
        : rankedPool.find((member) => strictThemeInfo(member, theme).abuser && !strictThemeInfo(member, theme).source && addUnique(initial, member));
      const withAbuser = addUnique(initial, abuser);
      if (withAbuser) initial = withAbuser;
    }
    for (const [category, requirements] of [["moves", constraints.requiredMoves], ["items", constraints.requiredItems], ["abilities", constraints.requiredAbilities]]) {
      for (const requirement of requirements || []) {
        if (initial.some((member) => strictMemberMatchesRequirement(member, category, requirement))) continue;
        const candidate = rankedPool.find((member) => strictMemberMatchesRequirement(member, category, requirement) && addUnique(initial, member));
        const next = addUnique(initial, candidate);
        if (next) initial = next;
      }
    }
    if (constraints.requiresSetup) {
      while (initial.filter((member) => (member.tags || new Set()).has("setup")).length < 2) {
        const setupMember = rankedPool.find((member) => (member.tags || new Set()).has("setup") && addUnique(initial, member));
        const next = addUnique(initial, setupMember);
        if (!next) break;
        initial = next;
      }
    }
    // Lock in answers for any weakness already doubled by a required core or a
    // required system pair before general-purpose popularity scoring fills slots.
    while (initial.length < 6) {
      const uncovered = STRICT_ATTACK_TYPES.filter((attackType) =>
        initial.filter((member) => strictDefenseMultiplier(member, attackType) > 1).length >= 2
        && !initial.some((member) => strictDefenseMultiplier(member, attackType) < 1)
      );
      if (!uncovered.length) break;
      const answer = rankedPool
        .filter((member) => addUnique(initial, member))
        .sort((a, b) => {
          const aCoverage = uncovered.filter((attackType) => strictDefenseMultiplier(a, attackType) < 1).length;
          const bCoverage = uncovered.filter((attackType) => strictDefenseMultiplier(b, attackType) < 1).length;
          return bCoverage - aCoverage || strictMemberScore(b, initial, format, constraints) - strictMemberScore(a, initial, format, constraints);
        })[0];
      const next = addUnique(initial, answer);
      if (!next) break;
      initial = next;
    }
  }
  seeds.push(initial);
  let beam = seeds;
  while (beam.length && beam[0].length < 6) {
    const expanded = [];
    for (const team of beam) {
      for (const member of pool) {
        const next = addUnique(team, member);
        if (!next) continue;
        expanded.push(next);
      }
    }
    const seen = new Set();
    beam = expanded
      .sort((a, b) => b.reduce((sum, member) => sum + strictMemberScore(member, b.filter((item) => item !== member), format, constraints), 0) - a.reduce((sum, member) => sum + strictMemberScore(member, a.filter((item) => item !== member), format, constraints), 0))
      .filter((team) => {
        const key = team.map((member) => `${member.slug}:${member.item}`).sort().join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 80);
  }
  const complete = beam.filter((team) => team.length === 6);
  const aiRetainedCount = (team = []) => {
    if (!aiDesigned) return 0;
    const families = new Set(constraints.aiPreferred || []);
    return team.filter((member) => families.has(strictFamilyKey(member.slug))).length;
  };
  const ranked = complete
    .map((team) => ({
      team,
      validation: strictTeamValidation(team, format, constraints),
      retained: aiRetainedCount(team),
      score: team.reduce((sum, member) => sum + strictMemberScore(member, team.filter((item) => item !== member), format, constraints), 0),
    }))
    .sort((a, b) => Number(b.validation.ok) - Number(a.validation.ok) || b.retained - a.retained || b.score - a.score);
  const scoreEvolutionTeam = (team) => team.reduce((sum, member) => sum + strictMemberScore(member, team.filter((item) => item !== member), format, constraints), 0);
  const evolutionSeed = String(payload.variationSeed || constraints.aiVariation || "evolution-default");
  const teamKey = (team) => team.map((member) => `${strictFamilyKey(member.slug)}:${strictKey(member.item)}`).sort().join("|");
  const sharedFamilies = (first = [], second = []) => {
    const families = new Set(first.map((member) => strictFamilyKey(member.slug)));
    return second.filter((member) => families.has(strictFamilyKey(member.slug))).length;
  };
  const selectDiversePopulation = (entries = [], limit = 24, maxShared = 3) => {
    const selectedPopulation = [];
    const unique = new Set();
    for (const entry of entries) {
      const key = teamKey(entry.team);
      if (unique.has(key)) continue;
      unique.add(key);
      if (selectedPopulation.every((other) => sharedFamilies(other.team, entry.team) <= maxShared)) selectedPopulation.push(entry);
      if (selectedPopulation.length >= limit) return selectedPopulation;
    }
    for (const entry of entries) {
      const key = teamKey(entry.team);
      if (selectedPopulation.some((other) => teamKey(other.team) === key)) continue;
      selectedPopulation.push(entry);
      if (selectedPopulation.length >= limit) break;
    }
    return selectedPopulation;
  };
  let finalRanked = ranked;
  let evolutionStats = null;
  if (evolutionMode) {
    const valid = ranked.filter((entry) => entry.validation.ok && strictIsDistinctFromAvoidedTeam(entry.team, constraints) && strictSynergyReport(entry.team, format, constraints).length >= 2);
    let population = valid.slice(0, 24);
    const generations = 4;
    const makeChild = (genes = [], salt = "") => {
      let child = [];
      const addGene = (member) => {
        const next = addUnique(child, member);
        if (next) child = next;
      };
      genes.forEach(addGene);
      for (const key of requiredKeys) addGene(rankedPool.find((member) => strictKey(member.slug) === key));
      for (const theme of constraints.themes || []) {
        if (!child.some((member) => strictThemeInfo(member, theme).source)) addGene(rankedPool.find((member) => strictThemeInfo(member, theme).source && addUnique(child, member)));
        if (!child.some((member) => {
          const info = strictThemeInfo(member, theme);
          return info.abuser && (theme === "tailwind" || !info.source);
        })) addGene(rankedPool.find((member) => {
          const info = strictThemeInfo(member, theme);
          return info.abuser && (theme === "tailwind" || !info.source) && addUnique(child, member);
        }));
      }
      for (const [category, requirements] of [["moves", constraints.requiredMoves], ["items", constraints.requiredItems], ["abilities", constraints.requiredAbilities]]) {
        for (const requirement of requirements || []) {
          if (!child.some((member) => strictMemberMatchesRequirement(member, category, requirement))) addGene(rankedPool.find((member) => strictMemberMatchesRequirement(member, category, requirement) && addUnique(child, member)));
        }
      }
      const orderedPool = [...pool].sort((a, b) => strictVariationScore(`${a.slug}:${salt}`, evolutionSeed) - strictVariationScore(`${b.slug}:${salt}`, evolutionSeed));
      for (const member of orderedPool) {
        if (child.length >= 6) break;
        addGene(member);
      }
      const validation = strictTeamValidation(child, format, constraints);
      if (child.length !== 6 || !validation.ok || !strictIsDistinctFromAvoidedTeam(child, constraints) || strictSynergyReport(child, format, constraints).length < 2) return null;
      return { team: child, validation, retained: aiRetainedCount(child), score: scoreEvolutionTeam(child) };
    };
    for (let generation = 0; generation < generations && population.length; generation += 1) {
      const elites = selectDiversePopulation(population, Math.min(10, population.length), 3);
      const offspring = [];
      for (let index = 0; index < 36; index += 1) {
        const first = elites[index % elites.length]?.team || [];
        const distantParents = elites.filter((entry) => sharedFamilies(first, entry.team) <= 3);
        const second = (distantParents[(index * 5 + generation + 1) % Math.max(1, distantParents.length)] || elites[(index * 5 + generation + 1) % elites.length])?.team || [];
        const crossover = first.filter((_, gene) => (gene + index + generation) % 2 === 0).concat(second.filter((_, gene) => (gene + index + generation) % 2 === 1));
        const child = makeChild(crossover, `crossover-${generation}-${index}`);
        if (child) offspring.push(child);
        const mutable = first.filter((member) => !requiredKeys.has(strictKey(member.slug)));
        if (mutable.length) {
          const mutationCount = Math.min(mutable.length, 1 + (strictVariationScore(`count:${generation}:${index}`, evolutionSeed) % 2));
          const mutationGenes = [...first];
          for (let mutation = 0; mutation < mutationCount; mutation += 1) {
            const mutationIndex = strictVariationScore(`${generation}:${index}:${mutation}`, evolutionSeed) % mutable.length;
            const member = mutable[mutationIndex];
            const position = mutationGenes.indexOf(member);
            if (position >= 0) mutationGenes.splice(position, 1);
          }
          const mutant = makeChild(mutationGenes, `mutation-${generation}-${index}`);
          if (mutant) offspring.push(mutant);
        }
      }
      population = selectDiversePopulation([...elites, ...offspring].sort((a, b) => b.score - a.score), 24, 3);
    }
    finalRanked = population.sort((a, b) => b.score - a.score);
    evolutionStats = { generations, population: population.length, method: "selection-crossover-mutation" };
  }
  const selected = finalRanked.find((entry) => entry.validation.ok && strictIsDistinctFromAvoidedTeam(entry.team, constraints));
  if (!selected) {
    const best = finalRanked[0];
    const retryReason = constraints.avoidTeamFamilies?.size ? "当前硬性要求下无法替换至少两名成员，系统没有把上一支队伍原样重发。" : "系统没有用不相关热门宝可梦填空。";
    return { ok: false, code: "BUILD_UNSATISFIED", format, diagnostics: [...(best?.validation.failures || ["当前验证配置无法组成完整六人队。"]), retryReason] };
  }
  const synergies = strictSynergyReport(selected.team, format, constraints);
  if (synergies.length < 2) return { ok: false, code: "BUILD_UNSATISFIED", format, diagnostics: ["当前验证配置无法形成至少两条可追溯的队友联动，因此未输出硬凑阵容。"] };
  const alternativeEntries = [];
  for (const entry of finalRanked) {
    if (!entry.validation.ok || !strictIsDistinctFromAvoidedTeam(entry.team, constraints) || strictSynergyReport(entry.team, format, constraints).length < 2) continue;
    const families = new Set(entry.team.map((member) => strictFamilyKey(member.slug)));
    const maxShared = evolutionMode ? 3 : 4;
    if (alternativeEntries.some((other) => other.team.filter((member) => families.has(strictFamilyKey(member.slug))).length > maxShared)) continue;
    alternativeEntries.push(entry);
    if (alternativeEntries.length >= 5) break;
  }
  if (!alternativeEntries.length) alternativeEntries.push(selected);
  const result = strictBuildResult(selected.team, format, graph, constraints, intent, current, null, aiDesigned ? payload.aiDraft : null, alternativeEntries);
  if (evolutionStats) {
    result.buildMethod = "evolution";
    result.buildReport.evolution = evolutionStats;
  }
  return result;
}

async function handleStrictTeamBuild(req, res) {
  const payload = await readJson(req).catch(() => ({}));
  const format = payload.format === "double" ? "double" : "single";
  const snapshot = ruleRegistry.operational({ format, rulesetId: String(payload.rulesetId || "").trim() });
  const rulesetPayload = {
    ...payload,
    format,
    rulesetId: snapshot.rulesetId,
    battleHistory: Array.isArray(payload.battleHistory) ? payload.battleHistory.filter((item) => item?.rulesetId === snapshot.rulesetId) : [],
  };
  const engineGuided = rulesetPayload.buildMethod === "engine-guided";
  let result = strictBuildTeam(engineGuided
    ? { ...rulesetPayload, buildMethod: "strict", forceGenerated: true, aiDraft: undefined }
    : rulesetPayload);
  if (engineGuided && !result.ok) {
    // Last-resort availability path: an explicit same-format complete sample
    // is better than leaving a valid user request on an error screen.
    result = strictBuildTeam({ ...rulesetPayload, buildMethod: "sample", forceGenerated: false, aiDraft: undefined });
    if (result.ok) result.buildReport.emergencySampleFallback = true;
  }
  if (engineGuided && result.ok) {
    result.buildMethod = "engine-guided";
    result.buildReport.aiDesign = {
      proposed: [],
      engineAdded: result.team.map((member) => member.name),
      retained: [],
      adjusted: result.team.map((member) => member.name),
      rationale: "AI 服务没有给出可用六人草案，已按同一目标直接生成严格可用队伍。",
      completionNote: result.buildReport.emergencySampleFallback
        ? `原创严格搜索未找到完整闭环，已使用同一 ${snapshot.regulation} 目标格式的完整样本作为最后兜底。`
        : `这是本地 ${snapshot.regulation} 目标格式候选池的原创严格构筑，不是完整热门样本复用。`,
    };
  }
  result = { ...rulesetMetadata(snapshot), ...result, rulesetId: snapshot.rulesetId, showdownFormatId: snapshot.showdownFormatId, regulation: snapshot.regulation };
  sendJson(res, result.ok ? 200 : 422, result);
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
  return [item.key || "", item.rulesetId || "", item.format || "", item.teamSignature || "", item.updatedAt || ""].join("|");
}

async function handleBattleHistory(req, res) {
  if (req.method === "GET") {
    const items = await readBattleHistoryFile();
    sendJson(res, 200, { ok: true, items });
    return;
  }
  const body = await readJson(req).catch(() => ({}));
  if (req.method === "DELETE") {
    const id = String(body.id || "").trim();
    if (!id) {
      sendJson(res, 400, { ok: false, error: "缺少要删除的对局记录。" });
      return;
    }
    const items = await writeBattleHistoryFile((await readBattleHistoryFile()).filter((item) => item.id !== id));
    sendJson(res, 200, { ok: true, items });
    return;
  }
  const incoming = (Array.isArray(body.items) ? body.items : body.entry ? [body.entry] : []).map((item) => {
    const format = item?.format === "double" ? "double" : "single";
    const snapshot = ruleRegistry.operational({ format, rulesetId: String(item?.rulesetId || body.rulesetId || "").trim() });
    return { ...item, ...rulesetMetadata(snapshot), format };
  });
  const existing = await readBattleHistoryFile();
  const merged = [];
  const seen = new Set();
  for (const item of [...incoming, ...existing].filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
    const stableKey = [item.key || "", item.rulesetId || "", item.format || "", item.teamSignature || ""].join("|");
    const key = stableKey.trim() ? stableKey : battleHistoryEntryKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  const items = await writeBattleHistoryFile(merged);
  sendJson(res, 200, { ok: true, items });
}

function showdownReplayLogUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.hostname !== "replay.pokemonshowdown.com") return null;
    const match = url.pathname.match(/^\/([a-z0-9-]+?)(?:\.log)?\/?$/i);
    if (!match) return null;
    return { id: match[1], url: `https://replay.pokemonshowdown.com/${match[1]}`, logUrl: `https://replay.pokemonshowdown.com/${match[1]}.log` };
  } catch {
    return null;
  }
}

function replayMatchesRulesEngine(tier = "", rulesEngine = {}) {
  const normalizeTier = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return Boolean(normalizeTier(tier) && normalizeTier(tier) === normalizeTier(rulesEngine.name));
}

function parseShowdownReplayLog(log = "", playerName = "", playerSide = "") {
  const players = {};
  const playerRatings = {};
  const moves = { p1: [], p2: [] };
  const actionEvents = { p1: [], p2: [] };
  const switches = { p1: 0, p2: 0 };
  const faints = { p1: 0, p2: 0 };
  const trace = [];
  let tier = "";
  let winner = "";
  let turns = 0;
  let rated = false;
  let hasLogError = false;
  for (const rawLine of String(log || "").split(/\r?\n/)) {
    const parts = rawLine.split("|");
    const type = parts[1] || "";
    if (type === "tier") tier = parts[2] || "";
    if (type === "rated") rated = true;
    if (type === "player") {
      const side = parts[2] || "";
      players[side] = parts[3] || side;
      const rating = Number(parts[5] || 0);
      if (Number.isFinite(rating) && rating > 0) playerRatings[side] = rating;
    }
    if (type === "turn") turns = Math.max(turns, Number(parts[2] || 0));
    if (type === "move") {
      const side = (parts[2] || "").slice(0, 2);
      const move = parts[3] || "未知招式";
      if (moves[side]) moves[side].push(move);
      if (actionEvents[side]) actionEvents[side].push({ type: "move", side, turn: turns, action: move });
    }
    if (type === "switch" || type === "drag") {
      const side = (parts[2] || "").slice(0, 2);
      if (switches[side] !== undefined) switches[side] += 1;
      if (actionEvents[side]) actionEvents[side].push({ type: "switch", side, turn: turns, action: parts[3] || "换入" });
    }
    if (type === "faint") {
      const side = (parts[2] || "").slice(0, 2);
      if (faints[side] !== undefined) faints[side] += 1;
    }
    if (type === "win") winner = parts[2] || "";
    if (type === "error") hasLogError = true;
    if (trace.length < 90 && ["turn", "move", "switch", "drag", "faint", "win", "tie"].includes(type)) trace.push(rawLine.replace(/^\|/, ""));
  }
  const normalizedPlayer = String(playerName || "").trim().toLowerCase();
  const selectedSide = /^(p1|p2)$/i.test(String(playerSide || "")) ? String(playerSide).toLowerCase() : "";
  const candidateSide = selectedSide || (normalizedPlayer
    ? Object.entries(players).find(([, name]) => String(name).trim().toLowerCase() === normalizedPlayer)?.[0] || ""
    : "");
  const winnerSide = Object.entries(players).find(([, name]) => String(name) === winner)?.[0] || "";
  const result = winner ? (candidateSide ? (winnerSide === candidateSide ? "win" : "loss") : "recorded") : "tie";
  return { tier, players, playerRatings, moves, actionEvents, switches, faints, turns, winner, winnerSide, candidateSide, result, rated, hasLogError, trace };
}

function scorePublicReplayQuality(report = {}, rulesEngine = {}, { minRating = 1500, minActions = 8 } = {}) {
  const candidateSide = report.candidateSide || "";
  const opponentSide = candidateSide === "p1" ? "p2" : candidateSide === "p2" ? "p1" : "";
  const candidateRating = Number(report.playerRatings?.[candidateSide] || 0);
  const opponentRating = Number(report.playerRatings?.[opponentSide] || 0);
  const candidateActions = report.actionEvents?.[candidateSide] || [];
  const exactFormat = replayMatchesRulesEngine(report.tier, rulesEngine);
  const completed = Boolean(report.winner || report.result === "tie");
  const checks = {
    exactFormat,
    identifiedPlayer: Boolean(candidateSide),
    ratedPlayers: candidateRating > 0 && opponentRating > 0,
    candidateRating: candidateRating >= minRating,
    opponentRating: opponentRating >= minRating,
    enoughActions: candidateActions.length >= minActions,
    completed,
    cleanLog: !report.hasLogError,
  };
  const points = [
    [checks.exactFormat, 25],
    [checks.identifiedPlayer, 15],
    [checks.ratedPlayers, 15],
    [checks.candidateRating, 15],
    [checks.opponentRating, 15],
    [checks.enoughActions, 5],
    [checks.completed, 5],
    [checks.cleanLog, 5],
  ];
  const score = points.reduce((sum, [passed, value]) => sum + (passed ? value : 0), 0);
  const highQuality = score >= 85 && checks.exactFormat && checks.identifiedPlayer && checks.ratedPlayers && checks.candidateRating && checks.opponentRating && checks.enoughActions && checks.completed && checks.cleanLog;
  const mediumQuality = score >= 60 && checks.exactFormat && checks.identifiedPlayer && checks.enoughActions && checks.completed;
  const label = highQuality ? "HIGH" : mediumQuality ? "MEDIUM" : "LOW";
  const reasons = [];
  if (!checks.exactFormat) reasons.push(`赛制不匹配：${report.tier || "未识别"}`);
  if (!checks.identifiedPlayer) reasons.push("未识别要训练的一方");
  if (!checks.ratedPlayers) reasons.push("回放没有双方有效评级，无法确认高分段质量");
  if (!checks.candidateRating) reasons.push(`己方评级不足 ${minRating} 或未提供`);
  if (!checks.opponentRating) reasons.push(`对手评级不足 ${minRating} 或未提供`);
  if (!checks.enoughActions) reasons.push(`逐回合动作不足 ${minActions} 个`);
  if (!checks.completed) reasons.push("回放没有完整胜负结果");
  if (!checks.cleanLog) reasons.push("日志包含 Showdown 错误");
  return {
    score,
    label,
    trainingEligible: highQuality,
    stateSource: "public-log-prefix",
    confidence: highQuality ? "medium" : mediumQuality ? "low" : "insufficient",
    candidateSide,
    opponentSide,
    candidateRating,
    opponentRating,
    candidateActions: candidateActions.length,
    minRating,
    minActions,
    checks,
    reasons,
  };
}

function publicReplayTrainingTrace({ replay, report, quality, format, rulesEngine, playerName = "" } = {}) {
  const candidateSide = quality.candidateSide;
  const actions = (report.actionEvents?.[candidateSide] || []).map((item, index) => ({
    type: "agent-action",
    source: "public-showdown-replay",
    turn: item.turn,
    command: item.type === "switch" ? `/choose switch ${item.action}` : `/choose move ${item.action}`,
    actionType: item.type,
    action: item.action,
    sampleIndex: index,
    visibleState: report.trace.slice(0, Math.min(report.trace.length, index + 1)),
  }));
  return {
    schemaVersion: 2,
    rulesetId: rulesEngine.rulesetId,
    showdownFormatId: rulesEngine.showdownFormatId,
    battleType: format,
    battleId: `public-replay-${replay.id}`,
    replayId: replay.id,
    replayFile: "",
    sourceUrl: replay.url,
    dataSource: "public-showdown-replay",
    policyVersion: "public-replay-quality-v1",
    playerName,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    result: report.result,
    turns: report.turns,
    opponentName: quality.opponentSide ? report.players?.[quality.opponentSide] || "" : "",
    sampleCount: actions.length,
    quality,
    trainingEligible: quality.trainingEligible,
    events: actions,
    publicTrace: report.trace,
    noHiddenOpponentState: true,
  };
}

async function handleShowdownReplay(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const format = body.format === "double" ? "double" : "single";
  const rulesEngine = championsRulesEngine(format, String(body.rulesetId || "").trim());
  if (!rulesEngine.ok) {
    sendJson(res, rulesEngine.status || 503, { ok: false, code: rulesEngine.code || "EXACT_RULES_UNAVAILABLE", error: rulesEngine.error, rulesEngine });
    return;
  }
  const replay = showdownReplayLogUrl(body.url);
  if (!replay) {
    sendJson(res, 400, { ok: false, error: "只支持 replay.pokemonshowdown.com 的公开回放链接。" });
    return;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(replay.logUrl, { signal: controller.signal, headers: { accept: "text/plain" } }).finally(() => clearTimeout(timeout));
    if (!response.ok) {
      sendJson(res, response.status === 404 ? 404 : 502, { ok: false, error: response.status === 404 ? "找不到这条公开回放，请确认链接完整且未被删除。" : `回放服务返回 ${response.status}。` });
      return;
    }
    const report = parseShowdownReplayLog(await response.text(), body.playerName || "", body.playerSide || "");
    const formatMatches = replayMatchesRulesEngine(report.tier, rulesEngine);
    const quality = scorePublicReplayQuality(report, rulesEngine, {
      minRating: Math.max(1000, Number(body.minRating || 1500)),
      minActions: Math.max(4, Number(body.minActions || 8)),
    });
    const opponentSide = report.candidateSide === "p1" ? "p2" : report.candidateSide === "p2" ? "p1" : "";
    const opponent = opponentSide ? report.players[opponentSide] || "对手" : "对手";
    const failureReasons = [];
    if (!formatMatches) failureReasons.push(`回放赛制为 ${report.tier || "未识别"}，不是 ${rulesEngine.name}；已保存供查看，但不会用于当前构筑反馈。`);
    if (!report.candidateSide) failureReasons.push("未填写或未匹配你的 Showdown 用户名，无法判断胜负归属；仍已保存回放摘要。");
    if (report.result === "loss" && report.candidateSide) failureReasons.push(`实战负于 ${opponent}；优先复盘第 ${report.turns || "?"} 回合前后的换人、控速与终盘资源。`);
    if (!quality.trainingEligible) failureReasons.push(`样本质量 ${quality.score}/100（${quality.label}）；不会进入策略训练，只用于复盘和配队反馈。`);
    const ownMoves = report.candidateSide ? report.moves[report.candidateSide] || [] : [];
    const feedbackSignals = [];
    if (report.result === "loss" && rulesEngine.gameType === "doubles") {
      if (!ownMoves.some((move) => /tailwind|trick room|icy wind|electroweb|thunder wave|glare/i.test(move))) feedbackSignals.push("missing-speed-control");
      if (!ownMoves.some((move) => /protect|detect|spiky shield|king's shield|wide guard/i.test(move))) feedbackSignals.push("missing-protect");
      if (Number(report.switches[report.candidateSide] || 0) < 1) feedbackSignals.push("missing-safe-entry");
    }
    const entry = {
      id: `showdown-replay-${replay.id}`,
      key: `showdown-replay:${replay.id}`,
      contextKey: String(body.contextKey || ""),
      type: "public-showdown-replay",
      sourceUrl: replay.url,
      format,
      rulesetId: rulesEngine.rulesetId,
      showdownFormatId: rulesEngine.showdownFormatId,
      regulation: rulesEngine.regulation,
      formatHash: rulesEngine.formatHash,
      sourceFormat: report.tier,
      rulesEngine,
      eligibleForBuildFeedback: formatMatches && Boolean(report.candidateSide),
      quality,
      trainingEligible: quality.trainingEligible,
      buildIntent: String(body.buildIntent || ""),
      userGoal: String(body.userGoal || ""),
      teamSignature: String(body.teamSignature || ""),
      wins: report.result === "win" ? 1 : 0,
      losses: report.result === "loss" ? 1 : 0,
      ties: report.result === "tie" ? 1 : 0,
      games: 1,
      winRate: report.result === "win" ? 100 : report.result === "loss" ? 0 : 50,
      feedbackSignals,
      failureReasons,
      badOpponents: report.result === "win" ? [] : [{ title: opponent, result: report.result, turns: report.turns, reasons: failureReasons }],
      results: [{
        id: `showdown-replay-${replay.id}-1`,
        title: opponent,
        result: report.result,
        turns: report.turns,
        winner: report.winner,
        trace: report.trace,
        actions: {
          moves: Object.values(report.moves).reduce((sum, value) => sum + value.length, 0),
          switches: Object.values(report.switches).reduce((sum, value) => sum + value, 0),
          teamPreview: 1,
          tags: { publicReplay: 1, ...(formatMatches ? { exactFormat: 1 } : {}) },
        },
        failureReasons,
    }],
      updatedAt: new Date().toISOString(),
    };
    const existing = await readBattleHistoryFile();
    const items = await writeBattleHistoryFile([entry, ...existing.filter((item) => item.id !== entry.id)]);
    let trainingTrace = null;
    if (quality.trainingEligible) {
      trainingTrace = publicReplayTrainingTrace({ replay, report, quality, format, rulesEngine, playerName: body.playerName || "" });
      const traceRoot = join(AGENT_DATA_ROOT, "traces", rulesEngine.rulesetId);
      await mkdir(traceRoot, { recursive: true });
      await writeFile(join(traceRoot, `${trainingTrace.battleId}.json`), `${JSON.stringify(trainingTrace, null, 2)}\n`, "utf8");
    }
    sendJson(res, 200, { ok: true, entry, items, quality, trainingTrace: trainingTrace ? { battleId: trainingTrace.battleId, sampleCount: trainingTrace.sampleCount, trainingEligible: true } : null, replay: { ...replay, ...report, formatMatches, rulesEngine, quality } });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: err.name === "AbortError" ? "获取公开回放超时，请稍后再试。" : `读取公开回放失败：${err.message || "网络错误。"}` });
  }
}

function championStatPointsFromChampionStats(value = "", fallback = "") {
  const text = String(value || "").trim();
  const aliases = { h: "HP", a: "Atk", b: "Def", c: "SpA", d: "SpD", s: "Spe" };
  const entries = [...text.matchAll(/(?:^|[\s/,])([habcds])\s*(\d{1,3})(?=$|[\s/,])/gi)]
    .map((match) => ({ key: String(match[1] || "").toLowerCase(), value: Number(match[2] || 0) }))
    .filter((entry) => aliases[entry.key] && entry.value > 0);
  if (!entries.length) return text || String(fallback || "");
  return entries.map((entry) => `${entry.value} ${aliases[entry.key]}`).join(" / ");
}

function normalizeChampionShowdownText(text = "") {
  return String(text || "").replace(/^(\s*EVs:\s*)([^\r\n]+)$/gim, (_, prefix, raw) => `${prefix}${championStatPointsFromChampionStats(raw, "")}`);
}

function pruneShowdownImportBridge() {
  const now = Date.now();
  for (const [token, item] of showdownImportBridge) if (Number(item.expiresAt || 0) <= now) showdownImportBridge.delete(token);
}

async function localShowdownBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next known local browser path.
    }
  }
  return "";
}

async function launchShowdownBridgeBrowser(token = "") {
  const item = showdownImportBridge.get(token);
  if (!item) return { ok: false, status: 404, error: "导入令牌不存在或已过期。请回 Champion Lab 再点一次一键导入。" };
  const executable = await localShowdownBrowserExecutable();
  if (!executable) return { ok: false, status: 503, error: "未找到可用于桥接的 Chrome 或 Edge 浏览器。" };
  try {
    const { chromium } = await import("playwright");
    await mkdir(SHOWDOWN_BRIDGE_PROFILE_PATH, { recursive: true });
    if (!showdownBridgeContext || !showdownBridgeContext.pages) {
      showdownBridgeContext = await chromium.launchPersistentContext(SHOWDOWN_BRIDGE_PROFILE_PATH, {
        headless: false,
        executablePath: executable,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
      showdownBridgeContext.on("close", () => {
        showdownBridgeContext = null;
        showdownBridgePage = null;
      });
    }
    showdownBridgePage = showdownBridgePage && !showdownBridgePage.isClosed()
      ? showdownBridgePage
      : showdownBridgeContext.pages().find((page) => /pokemonshowdown\.com/.test(page.url())) || await showdownBridgeContext.newPage();
    await showdownBridgePage.goto("https://play.pokemonshowdown.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    const imported = await showdownBridgePage.evaluate(async (payload) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const modernTeams = window.PS?.teams;
        if (modernTeams?.unshift && modernTeams?.save) {
          modernTeams.unshift({ name: payload.name, format: payload.formatId, folder: "", packedTeam: payload.packedTeam, iconCache: null, isBox: false, key: "" });
          modernTeams.save();
          return true;
        }
        const legacyStorage = window.Storage;
        if (legacyStorage?.teams && legacyStorage?.saveTeams) {
          legacyStorage.teams.unshift({ name: payload.name, format: payload.formatId, folder: "", team: payload.packedTeam, capacity: 6, iconCache: "" });
          legacyStorage.saveTeams();
          return true;
        }
        await sleep(200);
      }
      return false;
    }, item);
    if (!imported) return { ok: false, status: 503, error: "Showdown 队伍库未在限定时间内就绪。请稍后再试。" };
    showdownImportBridge.delete(token);
    await showdownBridgePage.evaluate(() => window.app?.send?.("/teambuilder")).catch(() => {});
    return { ok: true, browser: executable.includes("msedge") ? "Edge" : "Chrome" };
  } catch (error) {
    return { ok: false, status: 503, error: `无法启动本地 Showdown 桥接：${error.message || "浏览器自动化不可用。"}` };
  }
}

async function handleShowdownImportBridge(req, res) {
  pruneShowdownImportBridge();
  const url = new URL(req.url || "/api/showdown-bridge", "http://127.0.0.1");
  const complete = url.pathname.endsWith("/complete");
  const launch = url.pathname.endsWith("/launch");
  const body = req.method === "POST" ? await readJson(req).catch(() => ({})) : {};
  const token = String(body.token || url.searchParams.get("token") || "").trim();
  if (launch) {
    const result = await launchShowdownBridgeBrowser(token);
    sendJson(res, result.ok ? 200 : result.status || 500, result);
    return;
  }
  if (complete) {
    if (token) showdownImportBridge.delete(token);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET") {
    const item = showdownImportBridge.get(token);
    if (!item) {
      sendJson(res, 404, { ok: false, error: "导入令牌不存在或已过期。请回 Champion Lab 再点一次一键导入。" });
      return;
    }
    sendJson(res, 200, { ok: true, token, payload: item });
    return;
  }
  const format = String(body.format || "single").includes("double") ? "double" : "single";
  const rulesEngine = championsRulesEngine(format, String(body.rulesetId || "").trim());
  if (!rulesEngine.ok) {
    sendJson(res, rulesEngine.status || 503, { ok: false, code: rulesEngine.code || "EXACT_RULES_UNAVAILABLE", error: rulesEngine.error });
    return;
  }
  const prepared = prepareBattleTeam(body.teamText || "", format, "待导入队伍", rulesEngine.rulesetId);
  if (!prepared.ok || !prepared.strictLegal) {
    sendJson(res, 422, {
      ok: false,
      code: "EXACT_FORMAT_ILLEGAL",
      error: `待导入队伍未通过 ${rulesEngine.name} 校验，未创建导入令牌。`,
      problems: prepared.problems || [],
    });
    return;
  }
  const nextToken = randomUUID().replace(/-/g, "");
  const expiresAt = Date.now() + 90_000;
  showdownImportBridge.set(nextToken, {
    packedTeam: prepared.packedTeam,
    formatId: rulesEngine.id,
    rulesetId: rulesEngine.rulesetId,
    name: String(body.name || "Champion Lab Team").trim().slice(0, 48) || "Champion Lab Team",
    expiresAt,
  });
  sendJson(res, 200, { ok: true, token: nextToken, expiresAt, rulesEngine });
}

function prepareBattleTeam(text = "", format = "single", label = "队伍", rulesetId = "") {
  const team = Teams.import(normalizeChampionShowdownText(text));
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
  const showdownTeamText = Teams.export(repaired.slice(0, 6));
  const validation = validateShowdownTeam(packedText, format, rulesetId);
  return {
    ok: true,
    label,
    strictLegal: validation.ok,
    problems: [...skipped, ...(validation.problems || [])],
    teamSize: repaired.length,
    packedTeam: packedText,
    showdownTeamText,
    ...rulesetMetadata(validation),
  };
}

function availableSwitchIndexes(request = {}, activeIndex = 0, reservedIndexes = new Set()) {
  const side = request.side?.pokemon || [];
  return side
    .map((pokemon, index) => ({ pokemon, index: index + 1 }))
    .filter(({ pokemon, index }) => {
      if (pokemon.active) return false;
      if (String(pokemon.condition || "").includes("0 fnt")) return false;
      if (reservedIndexes.has(index)) return false;
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

function createBattleAgentState(playerId = "p1", policy = null) {
  return {
    playerId,
    foeId: playerId === "p1" ? "p2" : "p1",
    foes: new Map(),
    pendingChargeMoves: new Map(),
    policy: policy || { version: "structured-visible-state-v1", weights: {}, deterministic: false },
    deterministic: Boolean(policy?.deterministic),
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
    if (ident.side === agent.playerId) agent.pendingChargeMoves?.delete(ident.slot);
    if (ident.side === agent.foeId) {
      agent.foes.set(ident.slot, {
        name: ident.name,
        hp: hpRatio(parts[4] || ""),
        active: true,
      });
    }
  } else if (cmd === "-prepare") {
    const ident = parseBattleIdent(parts[2]);
    if (ident.side === agent.playerId) agent.pendingChargeMoves?.set(ident.slot, String(parts[3] || "").replace(/[^a-z0-9]+/gi, "").toLowerCase());
  } else if (cmd === "-damage" || cmd === "-heal" || cmd === "faint") {
    const ident = parseBattleIdent(parts[2]);
    if (cmd === "faint" && ident.side === agent.playerId) agent.pendingChargeMoves?.delete(ident.slot);
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

function policyWeight(agent = null, key = "") {
  const value = Number(agent?.policy?.weights?.[key]);
  return Number.isFinite(value) ? value : 0;
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
  // The local evaluator is a baseline tactical agent, not a full battle AI. It
  // should prefer moves that resolve this turn over charge moves whose target
  // rules change between charge and release phases when weather is interrupted.
  if (data.flags?.charge) score -= format === "double" ? 28 : 18;
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
  for (const tag of tags) score += policyWeight(agent, tag);
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
  for (const tag of battleMoveTags({ id: moveText })) score += policyWeight(agent, tag);
  return score;
}

function battleScoreNoise(format = "single", agent = null) {
  if (agent?.deterministic) return 0;
  return (Math.random() - 0.5) * (format === "double" ? 6 : 4);
}

function chooseBattleSwitch(request = {}, format = "single", activeIndex = 0, agent = null, reservedIndexes = new Set()) {
  const switches = availableSwitchIndexes(request, activeIndex, reservedIndexes);
  if (!switches.length) return "default";
  const sidePokemon = request.side?.pokemon || [];
  const options = switches
    .map((index) => sidePokemon[index - 1])
    .filter(Boolean)
    .map((pokemon, optionIndex) => ({
      pokemon,
      index: switches[optionIndex],
      score: switchBattleValue(pokemon, request, format, activeIndex, agent) + battleScoreNoise(format, agent),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return options[0]?.index ? `switch ${options[0].index}` : "default";
}

function scoreBattleMove(move = {}, format = "single", turn = 1, activeIndex = 0, request = {}, agent = null) {
  if (!move || move.disabled) return -999;
  return moveBattleValue(move, format, turn, activeIndex, request, agent) + battleScoreNoise(format, agent);
}

function targetSuffixForMove(move = {}, format = "single", activeIndex = 0, agent = null) {
  const data = moveDataFor(move);
  // A charged move needs a target when it starts, but Showdown rejects one on
  // the forced release turn. Observe -prepare and only omit the suffix once.
  if (data.flags?.charge && agent?.pendingChargeMoves?.get(activeIndex) === data.id) {
    agent.pendingChargeMoves.delete(activeIndex);
    return "";
  }
  const target = move?.target || data.target;
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
    const chosenSwitches = new Set();
    return request.forceSwitch
      .map((required, index) => {
        if (!required) return "pass";
        const choice = chooseBattleSwitch(request, format, index, agent, chosenSwitches);
        const switchIndex = String(choice).match(/^switch\s+(\d+)$/)?.[1];
        if (!switchIndex) return "pass";
        chosenSwitches.add(Number(switchIndex));
        return `switch ${switchIndex}`;
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

function isRecoverableBattleTargetError(detail = "") {
  return /can't move: (?:you can't choose a target for|.+ needs a target)/i.test(String(detail || ""));
}

async function runBattlePlayer(stream, format, actionLog, playerId, agent, candidatePlayerId = "p1") {
  let turn = 1;
  for await (const chunk of stream) {
    for (const line of chunk.split("\n")) {
      observeBattleLine(agent, line);
      if (line.startsWith("|turn|")) turn = Number(line.split("|")[2] || turn) || turn;
      if (line.startsWith("|error|")) {
        const detail = line.slice(7);
        if (isRecoverableBattleTargetError(detail)) {
          actionLog.recoveries.push(`${playerId}: ${detail}`);
          pushBattleTrace(actionLog, `[${playerId.toUpperCase()}] 目标选择已由模拟器自动修正。`);
          stream.write("default");
          continue;
        }
        actionLog.errors.push(`${playerId}: ${detail}`);
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

async function runLocalBattle({ format = "single", formatId, p1Team, p2Team, maxTurns = 80, seed = null, p1Name = "Candidate", p2Name = "Meta", candidateName = "Candidate", p1Policy = null, p2Policy = null }) {
  const battleStream = new BattleStream();
  const streams = getPlayerStreams(battleStream);
  const actionLog = { moves: 0, switches: 0, teamPreview: 0, errors: [], recoveries: [], tags: {}, trace: [] };
  const p1Agent = createBattleAgentState("p1", p1Policy);
  const p2Agent = createBattleAgentState("p2", p2Policy);
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
          const detail = line.slice(7);
          if (isRecoverableBattleTargetError(detail)) actionLog.recoveries.push(detail);
          else actionLog.errors.push(detail);
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
      const evs = championStatPointsFromChampionStats(config.stats, "");
      if (evs) lines.push(`EVs: ${evs}`);
      if (nature) lines.push(`${nature} Nature`);
      for (const move of moves.slice(0, 4)) lines.push(`- ${move}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function ladderHotTeamPool(snapshot) {
  const format = snapshot.battleType === "double" ? "double" : "single";
  const allTeams = readTeamDataFile()
    .filter((team) => team.format === format && Array.isArray(team.members) && team.members.length >= 6)
    .sort((a, b) => Number(b.rate || 0) - Number(a.rate || 0) || Number(a.rank || 9999) - Number(b.rank || 9999));
  const sameRegulation = allTeams.filter((team) => String(team.season || "").toLowerCase() === String(snapshot.regulation || "").toLowerCase());
  const sourceTeams = sameRegulation.length ? sameRegulation : allTeams;
  const formatLabel = format === "double" ? "VGC 双打" : "BSS 单打";
  const candidates = [];
  for (const team of sourceTeams) {
    const rawText = showdownTextForHotTeam(team);
    if (!rawText) continue;
    let prepared;
    try { prepared = prepareBattleTeam(rawText, format, `热门队伍 ${team.id || "unknown"}`, snapshot.rulesetId); } catch { continue; }
    if (!prepared.ok || !prepared.strictLegal || prepared.teamSize < 6) continue;
    const parsed = Teams.import(prepared.showdownTeamText) || [];
    candidates.push({
      id: String(team.id || `hot-${candidates.length + 1}`),
      title: String(team.title || `${formatLabel} 热门样本`),
      source: String(team.source || "热门队伍数据"),
      sourceSeason: String(team.season || "unknown"),
      seasonMatched: sameRegulation.length > 0,
      format,
      rate: Number(team.rate || 0),
      rank: Number(team.rank || 9999),
      rentalCode: String(team.rentalCode || ""),
      members: parsed.map((member) => {
        const species = Dex.species.get(member.species);
        return { name: member.species, slug: species?.id || strictKey(member.species), sprite: Number(species?.num || 0) };
      }).filter((member) => member.name).slice(0, 6),
      teamText: prepared.showdownTeamText,
      rulesetId: snapshot.rulesetId,
      showdownFormatId: snapshot.showdownFormatId,
    });
  }
  return candidates;
}

function chooseLadderHotTeam(snapshot) {
  const pool = ladderHotTeamPool(snapshot);
  const selected = sampleWeighted(pool, 1)[0] || null;
  const preview = sampleWeighted(pool, Math.min(120, pool.length));
  return { pool, selected, preview };
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
  const rulesEngine = championsRulesEngine(format, String(body.rulesetId || "").trim());
  if (!rulesEngine.ok) {
    sendJson(res, rulesEngine.status || 503, { ok: false, code: rulesEngine.code || "EXACT_RULES_UNAVAILABLE", error: rulesEngine.error, rulesEngine });
    return;
  }
  const own = prepareBattleTeam(body.teamText || "", format, "候选队伍", rulesEngine.rulesetId);
  if (!own.ok) {
    sendJson(res, 400, { ok: false, error: own.problems[0], problems: own.problems });
    return;
  }
  if (!own.strictLegal) {
    sendJson(res, 422, {
      ok: false,
      code: "EXACT_FORMAT_ILLEGAL",
      error: `候选队伍未通过 ${rulesEngine.name} 校验，不能用自定义规则替代测试。`,
      problems: own.problems,
      rulesEngine,
    });
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
    const opponentTeam = prepareBattleTeam(opponent.showdownText || "", format, opponent.title || opponent.id || "固定靶队", rulesEngine.rulesetId);
    if (!opponentTeam.ok) {
      results.push({
        opponentId: opponent.id || "",
        opponentTitle: opponent.title || "固定靶队",
        rulesetId: rulesEngine.rulesetId,
        showdownFormatId: rulesEngine.showdownFormatId,
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
    if (!opponentTeam.strictLegal) {
      results.push({
        opponentId: opponent.id || "",
        opponentTitle: opponent.title || "固定靶队",
        rulesetId: rulesEngine.rulesetId,
        showdownFormatId: rulesEngine.showdownFormatId,
        result: "skipped",
        formatId: rulesEngine.id,
        strictLegal: false,
        failureReasons: [`靶队未通过 ${rulesEngine.name} 校验，未使用自定义规则降级模拟。`, ...opponentTeam.problems.slice(0, 5)],
        actions: { moves: 0, switches: 0, teamPreview: 0, errors: [], recoveries: [], tags: {}, trace: [`跳过对局：靶队未通过 ${rulesEngine.name} 校验。`, ...opponentTeam.problems.slice(0, 5).map((problem) => `原因：${problem}`)] },
      });
      continue;
    }
    const formatId = rulesEngine.id;
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
          rulesetId: rulesEngine.rulesetId,
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
          rulesetId: rulesEngine.rulesetId,
          showdownFormatId: rulesEngine.showdownFormatId,
          regulation: rulesEngine.regulation,
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
  if (!played.length) {
    sendJson(res, 422, {
      ok: false,
      code: "NO_EXACT_ELIGIBLE_OPPONENTS",
      error: `没有通过 ${rulesEngine.name} 校验的靶队；本次没有用普通双打或自定义规则替代。`,
      warnings: [...new Set(warnings)].slice(0, 12),
      results,
      rulesEngine,
    });
    return;
  }
  sendJson(res, 200, {
    ok: played.length > 0,
    mode: opponentSource === "hot" ? "local-showdown-hot-meta" : "local-showdown-fixed-meta",
    agentVersion: "tactical-single-double-v2",
    format,
    rulesetId: rulesEngine.rulesetId,
    showdownFormatId: rulesEngine.showdownFormatId,
    regulation: rulesEngine.regulation,
    formatHash: rulesEngine.formatHash,
    rulesEngine,
    games: played.length,
    wins,
    losses,
    ties,
    winRate: played.length ? Math.round((wins / played.length) * 100) : 0,
    warnings: [...new Set(warnings)].slice(0, 12),
    results,
    note: `${rulesEngine.name} 精确规则模拟。${opponentSource === "hot" ? "靶队来自热门队池随机抽样" : "靶队为固定热门队"}，基础动作代理用于发现结构压力点，不等同于公开天梯胜率。`,
  });
}

function extractOutputText(data) {
  const chatText = data.choices?.[0]?.message?.content;
  if (typeof chatText === "string") return chatText;
  if (Array.isArray(chatText)) {
    const text = chatText
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (typeof data.choices?.[0]?.text === "string") return data.choices[0].text;
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
    slug: String(mon.slug || ""),
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

const PASS_CHAIN_PATTERNS = {
  baton: /接棒|バトンタッチ|baton[-\s]?pass|boost[-\s]?pass|传递强化/i,
  setup: /剑舞|龙之舞|健美|诡计|冥想|蝶舞|破壳|腹鼓|聚气|つるぎのまい|りゅうのまい|ビルドアップ|わるだくみ|めいそう|ちょうのまい|からをやぶる|はらだいこ|きあいだめ|swords[-\s]?dance|dragon[-\s]?dance|bulk[-\s]?up|nasty[-\s]?plot|calm[-\s]?mind|quiver[-\s]?dance|shell[-\s]?smash|belly[-\s]?drum|focus[-\s]?energy/i,
  safety: /守住|看穿|击掌奇袭|看我嘛|愤怒粉|广域防守|急速折返|伏特替换|抛下狠话|protect|detect|fake[-\s]?out|follow[-\s]?me|rage[-\s]?powder|wide[-\s]?guard|u-turn|volt[-\s]?switch|parting[-\s]?shot/i,
  receiver: /剑舞|龙之舞|健美|诡计|冥想|蝶舞|破壳|腹鼓|终盘|收割|清场|破盾|主轴|核心|swords[-\s]?dance|dragon[-\s]?dance|bulk[-\s]?up|nasty[-\s]?plot|calm[-\s]?mind|quiver[-\s]?dance|shell[-\s]?smash|belly[-\s]?drum|endgame|cleaner|wincon|wallbreaker/i,
};

function memberActuallyBatonPass(member = {}) {
  return PASS_CHAIN_PATTERNS.baton.test(pocketAgMemberConfigText(member));
}

function memberActuallySetsUpForPass(member = {}) {
  return PASS_CHAIN_PATTERNS.setup.test(pocketAgMemberConfigText(member));
}

function memberProvidesPassChainSafety(member = {}) {
  return PASS_CHAIN_PATTERNS.safety.test(pocketAgMemberConfigText(member));
}

function memberCanReceivePass(member = {}) {
  return PASS_CHAIN_PATTERNS.receiver.test(pocketAgMemberText(member));
}

function candidateActuallyBatonPass(mon = {}) {
  return PASS_CHAIN_PATTERNS.baton.test(candidateVerifiedMoveText(mon));
}

function candidateActuallySetsUpForPass(mon = {}) {
  return PASS_CHAIN_PATTERNS.setup.test(candidateVerifiedMoveText(mon));
}

function candidateProvidesPassChainSafety(mon = {}) {
  return PASS_CHAIN_PATTERNS.safety.test(candidateVerifiedSupportText(mon));
}

function candidateCanReceivePass(mon = {}) {
  return !candidateActuallyBatonPass(mon) && (PASS_CHAIN_PATTERNS.receiver.test(candidateText(mon)) || PASS_CHAIN_PATTERNS.receiver.test(candidateVerifiedMoveText(mon)) || Boolean(mon.formatFit?.single?.score || mon.formatFit?.double?.score));
}

function preferredPassSetupMove(mon = {}) {
  const text = candidateVerifiedMoveText(mon);
  const options = [
    [/(剑舞|つるぎのまい|swords[-\s]?dance)/i, "剑舞"],
    [/(龙之舞|りゅうのまい|dragon[-\s]?dance)/i, "龙之舞"],
    [/(健美|ビルドアップ|bulk[-\s]?up)/i, "健美"],
    [/(诡计|わるだくみ|nasty[-\s]?plot)/i, "诡计"],
    [/(冥想|めいそう|calm[-\s]?mind)/i, "冥想"],
    [/(蝶舞|ちょうのまい|quiver[-\s]?dance)/i, "蝶舞"],
    [/(破壳|からをやぶる|shell[-\s]?smash)/i, "破壳"],
    [/(腹鼓|はらだいこ|belly[-\s]?drum)/i, "腹鼓"],
    [/(聚气|きあいだめ|focus[-\s]?energy)/i, "聚气"],
  ];
  return options.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function preferredPassSafetyMove(mon = {}) {
  const text = candidateVerifiedSupportText(mon);
  const options = [
    [/(守住|まもる|protect)/i, "守住"],
    [/(击掌奇袭|ねこだまし|fake[-\s]?out)/i, "击掌奇袭"],
    [/(看我嘛|このゆびとまれ|follow[-\s]?me)/i, "看我嘛"],
    [/(愤怒粉|いかりのこな|rage[-\s]?powder)/i, "愤怒粉"],
    [/(广域防守|ワイドガード|wide[-\s]?guard)/i, "广域防守"],
    [/(急速折返|とんぼがえり|u-turn)/i, "急速折返"],
    [/(伏特替换|ボルトチェンジ|volt[-\s]?switch)/i, "伏特替换"],
    [/(抛下狠话|すてゼリフ|parting[-\s]?shot)/i, "抛下狠话"],
  ];
  return options.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function ensurePassChainMoves(member = {}, setupMove = "") {
  const required = ["接棒", setupMove].filter(Boolean);
  const current = Array.isArray(member.moves) ? member.moves.filter(Boolean) : [];
  const remaining = current.filter((move) => !required.some((requiredMove) => pocketAgTextKey(move) === pocketAgTextKey(requiredMove)));
  member.moves = [...required, ...remaining].slice(0, 4);
  return member;
}

function passChainCapability(payload = {}) {
  const candidates = Array.isArray(payload.metaCandidates) ? payload.metaCandidates : [];
  const passers = candidates.filter(candidateActuallyBatonPass);
  const setupPassers = passers.filter(candidateActuallySetsUpForPass);
  const receivers = candidates.filter((mon) => !candidateActuallyBatonPass(mon) && candidateCanReceivePass(mon));
  const safety = candidates.filter(candidateProvidesPassChainSafety);
  const required = requiredGoalPokemon(payload);
  const namedCore = required.length === 1 ? required[0] : null;
  const namedCorePasser = namedCore ? setupPassers.find((mon) => pocketAgMemberMatches(mon, namedCore)) : null;
  const violations = [];
  if (!setupPassers.length) violations.push("当前格式候选池没有可验证的“接棒 + 强化招式”传递者。");
  if (namedCore && !namedCorePasser) violations.push(`${namedCore.name || namedCore.slug} 没有在当前格式中验证到可用的“接棒 + 强化”配置。`);
  if (!receivers.length) violations.push("当前格式候选池没有可验证的独立强化接收者。");
  if (!safety.length) violations.push("当前格式候选池没有可验证的安全上场/保护位。");
  return { passers, setupPassers, receivers, safety, namedCore, namedCorePasser, violations };
}

function enforcePassChainTeamStructure(team = [], payload = {}, format = "single") {
  const capability = passChainCapability(payload);
  if (capability.violations.length) return team.slice(0, 6);
  const formatKey = format === "double" ? "double" : "single";
  const candidateKey = (candidate = {}) => pocketAgTextKey(candidate.slug || candidate.name || candidate.id || "");
  const conflictingAxis = (candidate = {}) => /戏法空间|trick[-\s]?room|顺风|tailwind|日照|大晴天|降雨|求雨|扬沙|沙暴|降雪|雪景|drought|drizzle|sunny[-\s]?day|rain[-\s]?dance|sandstorm|snowscape|weather[-\s]?ball/i.test(candidateVerifiedMoveText(candidate));
  const receiverScore = (candidate = {}) => {
    const text = `${candidateText(candidate)} ${candidateConfigText(candidate)}`;
    let score = Number(candidate.formatFit?.[formatKey]?.score || 0);
    if (candidateActuallySetsUpForPass(candidate)) score += 80;
    if (/终盘|收割|清场|破盾|主轴|核心|wallbreaker|cleaner|wincon/i.test(text)) score += 42;
    if (/先制|priority|神速|突袭|子弹拳|影子偷袭/i.test(text)) score += 18;
    if (conflictingAxis(candidate)) score -= 180;
    if (candidateActuallyBatonPass(candidate)) score -= 400;
    return score;
  };
  const safetyScore = (candidate = {}) => {
    const text = `${candidateText(candidate)} ${candidateConfigText(candidate)}`;
    let score = Number(candidate.formatFit?.[formatKey]?.score || 0);
    if (/击掌奇袭|看我嘛|愤怒粉|广域防守|威吓|fake[-\s]?out|follow[-\s]?me|rage[-\s]?powder|wide[-\s]?guard|intimidate/i.test(text)) score += 95;
    if (/守住|protect|急速折返|伏特替换|抛下狠话|protect|u-turn|volt[-\s]?switch|parting[-\s]?shot/i.test(text)) score += 30;
    if (conflictingAxis(candidate)) score -= 120;
    if (candidateActuallyBatonPass(candidate)) score -= 260;
    return score;
  };
  const fillerScore = (candidate = {}) => {
    const text = `${candidateText(candidate)} ${candidateConfigText(candidate)}`;
    let score = Number(candidate.formatFit?.[formatKey]?.score || 0) + Number(candidate.understandingScore || 0) * 0.25;
    if (candidateActuallySetsUpForPass(candidate)) score += 36;
    if (candidateProvidesPassChainSafety(candidate)) score += 28;
    if (/终盘|收割|清场|破盾|wallbreaker|cleaner|wincon/i.test(text)) score += 24;
    if (conflictingAxis(candidate)) score -= 140;
    if (candidateActuallyBatonPass(candidate)) score -= 220;
    return score;
  };
  const next = [];
  const add = (candidate, role, note, configure) => {
    if (!candidate || next.length >= 6) return null;
    const key = candidateKey(candidate);
    if (!key || next.some((item) => candidateKey(item) === key)) return null;
    const member = advicePokemon(candidate, next.length, format, payload);
    member.role = role;
    member.note = note;
    configure?.(member);
    next.push(member);
    return member;
  };
  const passerCandidate = capability.namedCorePasser || capability.setupPassers[0];
  const passer = add(
    passerCandidate,
    "强化接棒者 / 主轴核心",
    "实际携带强化招式与接棒，负责先强化，再把能力变化交给接收者；不能按普通输出位使用。",
    (member) => ensurePassChainMoves(member, preferredPassSetupMove(passerCandidate)),
  );
  const receiverCandidate = capability.receivers
    .filter((candidate) => candidateKey(candidate) !== candidateKey(passerCandidate))
    .sort((a, b) => receiverScore(b) - receiverScore(a))[0];
  add(
    receiverCandidate,
    "接收强化终盘",
    `负责接收${passer?.name || "接棒者"}的强化，并把优势转成终盘收割。`,
  );
  const safetyCandidate = capability.safety
    .filter((candidate) => ![candidateKey(passerCandidate), candidateKey(receiverCandidate)].includes(candidateKey(candidate)))
    .sort((a, b) => safetyScore(b) - safetyScore(a))[0];
  add(
    safetyCandidate,
    "安全上场/保护位",
    "负责用守住、击掌、掩护或转场保护强化与接棒回合，不能只算普通补位。",
    (member) => ensureMove(member, preferredPassSafetyMove(safetyCandidate)),
  );
  const candidates = Array.isArray(payload.metaCandidates) ? payload.metaCandidates : [];
  for (const candidate of candidates.slice().sort((a, b) => fillerScore(b) - fillerScore(a))) {
    if (next.length >= 6) break;
    if (conflictingAxis(candidate)) continue;
    const text = `${candidateText(candidate)} ${candidateConfigText(candidate)}`;
    const role = candidateActuallySetsUpForPass(candidate)
      ? "副轴强化收割"
      : candidateProvidesPassChainSafety(candidate)
        ? "接棒保护/干扰"
        : /终盘|收割|清场|破盾|wallbreaker|cleaner|wincon/i.test(text)
          ? "副轴破盾/终盘"
          : "协作补位";
    add(candidate, role, "围绕接棒主轴补足二次突破、保护或残局火力，不引入无关天气、空间或重复控速。 ");
  }
  return next;
}

function primaryAdviceFormat(payload = {}) {
  if (payload.intent?.requestedFormat === "double") return "double";
  if (payload.intent?.requestedFormat === "single") return "single";
  return payload.format === "double" ? "double" : "single";
}

function hardGoalPreflightViolations(payload = {}) {
  const constraints = goalConstraints(payload);
  const unavailable = Array.isArray(constraints.unavailablePokemon) ? constraints.unavailablePokemon : [];
  const violations = unavailable.map((item) => `${item.name || item.slug || item.id} 不在当前${payload.formatLabel || primaryAdviceFormat(payload)}可用池，不能用相近宝可梦替代。`);
  if (goalRequiresPassChain(payload) && !violations.length) violations.push(...passChainCapability(payload).violations);
  return [...new Set(violations)];
}

function hardGoalAdviceViolations(advice = {}, payload = {}) {
  const violations = hardGoalPreflightViolations(payload);
  if (violations.length) return violations;
  const format = primaryAdviceFormat(payload);
  const team = Array.isArray(advice?.[format]?.team) ? advice[format].team : [];
  for (const ref of requiredGoalPokemon(payload)) {
    if (!team.some((member) => pocketAgMemberMatches(member, ref))) violations.push(`最终${format === "double" ? "双打" : "单打"}队伍缺少指定核心 ${ref.name || ref.slug || ref.id}。`);
  }
  if (goalRequiresPassChain(payload)) {
    const passer = team.find((member) => memberActuallyBatonPass(member) && memberActuallySetsUpForPass(member));
    const receiver = team.find((member) => member !== passer && /接收强化终盘/i.test(String(member.role || "")) && memberCanReceivePass(member));
    const safety = team.find((member) => member !== passer && /安全上场\/保护位/i.test(String(member.role || "")) && memberProvidesPassChainSafety(member));
    if (!passer) violations.push("最终队伍没有同一成员实际携带接棒和强化招式。");
    if (!receiver) violations.push("最终队伍没有独立的强化接收者。");
    if (!safety) violations.push("最终队伍没有独立的安全上场/保护位。");
  }
  return [...new Set(violations)];
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
  const text = candidateVerifiedMoveText(mon);
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
    mon.roleProfile,
    mon.supportProfile,
    mon.teamLibrarySets?.map((set) => [set.ability, set.moves]),
    teamLibraryConfigsFor(mon).map((set) => [set.ability, set.moves]),
  ]);
}

function candidateVerifiedMoveText(mon = {}) {
  return pocketAgTextBlob([
    mon.commonMoves,
    mon.moves,
    mon.roleProfile?.common?.moves,
    mon.teamLibrarySets?.map((set) => set.moves),
    teamLibraryConfigsFor(mon).map((set) => set.moves),
  ]);
}

function candidateVerifiedSupportText(mon = {}) {
  return pocketAgTextBlob([
    candidateVerifiedMoveText(mon),
    mon.commonAbilities,
    mon.abilities,
    mon.roleProfile?.common?.abilities,
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
    if (goalRequiresPassChain(payload) && memberActuallyBatonPass(item) && memberActuallySetsUpForPass(item)) score += 700;
    if (goalRequiresPassChain(payload) && /接收强化终盘/i.test(String(item.role || ""))) score += 520;
    if (goalRequiresPassChain(payload) && /安全上场\/保护位/i.test(String(item.role || ""))) score += 460;
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
    if (passChainGoal) team = enforcePassChainTeamStructure(team, payload, format);
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

async function requestAIText(aiConfig, prompt, { timeoutMs = AI_REQUEST_TIMEOUT_MS, maxTokens = 2200, useJsonSchema = false, forceJson = false } = {}) {
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
        response_format: useJsonSchema || forceJson ? { type: "json_object" } : undefined,
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

async function requestAI(aiConfig, payload, useJsonSchema) {
  return requestAIText(aiConfig, buildPrompt(payload), {
    timeoutMs: aiTimeoutMs(payload),
    maxTokens: aiMaxTokens(payload),
    useJsonSchema,
  });
}

function parseTeamCoachJson(text = "") {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [raw, raw.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return {
        plan: String(parsed.plan || "").trim(),
        leads: Array.isArray(parsed.leads) ? parsed.leads.map(String).filter(Boolean).slice(0, 4) : [],
        synergies: Array.isArray(parsed.synergies) ? parsed.synergies.map(String).filter(Boolean).slice(0, 4) : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).filter(Boolean).slice(0, 4) : [],
      };
    } catch {
      // Try the next JSON-shaped fragment.
    }
  }
  return { plan: raw.slice(0, 1800), leads: [], synergies: [], risks: [] };
}

function teamCoachPrompt(payload = {}) {
  const team = Array.isArray(payload.team) ? payload.team : [];
  const teamText = team.map((member, index) => [
    `${index + 1}. ${member.name || member.slug || "成员"}`,
    `道具:${member.item || "未提供"}`,
    `特性:${member.ability || "未提供"}`,
    `招式:${(member.moves || []).join(" / ")}`,
    `职责:${member.role || "未提供"}`,
  ].join("；")).join("\n");
  return `你是宝可梦竞技配队教练。以下六人队已经由本地系统按 ${payload.regulation || payload.rulesetId || "当前规则"}、${payload.format === "double" ? "双打" : "单打"}、可验证招式/道具/特性严格校验。\n\n用户目标：${payload.userGoal || "未额外指定"}\n\n已验证队伍：\n${teamText}\n\n只给战术解读，绝不能替换宝可梦、道具、特性或招式，不能编造配置。请用简体中文严格返回 JSON：\n{"plan":"开局到终盘的可执行路线","leads":["首发或选出建议，须点名现有成员"],"synergies":["基于现有成员、特性或招式的联动"],"risks":["明确威胁和处理顺序"]}\n每个数组 2 到 4 条。`;
}

async function handleTeamCoach(req, res) {
  const input = await readJson(req);
  const format = input.format === "double" ? "double" : "single";
  const snapshot = ruleRegistry.operational({ format, rulesetId: String(input.rulesetId || "").trim() });
  const payload = {
    ...input,
    format,
    rulesetId: snapshot.rulesetId,
    regulation: snapshot.regulation,
    battleHistory: Array.isArray(input.battleHistory) ? input.battleHistory.filter((item) => item?.rulesetId === snapshot.rulesetId) : [],
  };
  const team = Array.isArray(payload.team) ? payload.team : [];
  if (team.length !== 6) {
    sendJson(res, 400, { error: "AI 战术解读需要一支已验证的六人队。" });
    return;
  }
  const aiConfig = resolveRequestAIConfig(payload);
  if (!aiConfig) {
    sendJson(res, 501, { error: "请先填写 AI 服务的 API Key、Base URL 和模型。" });
    return;
  }
  try {
    const response = await requestAIText(aiConfig, teamCoachPrompt(payload), {
      timeoutMs: aiTimeoutMs(payload),
      maxTokens: payload.promptMode === "compare" ? 1800 : 1200,
    });
    const data = await readAIResponse(response);
    if (!response.ok) {
      sendJson(res, response.status, { error: data.error?.message || "AI 战术服务请求失败。" });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      model: aiConfig.model,
      provider: aiConfig.source,
      ...rulesetMetadata(snapshot),
      coach: parseTeamCoachJson(extractOutputText(data)),
    });
  } catch (err) {
    const timeoutSeconds = Math.round(aiTimeoutMs(payload) / 1000);
    sendJson(res, 502, {
      error: err.name === "AbortError" ? `AI 战术服务超过 ${timeoutSeconds} 秒未返回。` : `AI 战术服务连接失败：${err.message || "请检查配置。"}`,
    });
  }
}

function aiDesignCatalogue(format = "single", limit = 96, rulesetId = "") {
  const graph = strictCandidateGraph(format, rulesetId);
  const byFamily = new Map();
  for (const candidate of graph.candidates) {
    const key = strictFamilyKey(candidate.slug);
    const current = byFamily.get(key);
    if (!current || Number(candidate.rank || 9999) < Number(current.rank || 9999)) byFamily.set(key, candidate);
  }
  return [...byFamily.values()]
    .sort((a, b) => Number(a.rank || 9999) - Number(b.rank || 9999))
    .slice(0, limit)
    .map((candidate) => ({
      name: candidate.name,
      slug: candidate.slug,
      roles: [...(candidate.tags || [])].join(",") || "flex",
    }));
}

function aiDesignSlotCandidates(graph = {}, constraints = {}, predicate = () => true, limit = 10) {
  const byFamily = new Map();
  for (const candidate of graph.candidates || []) {
    if (constraints.forbidden?.includes(strictKey(candidate.slug)) || strictConflictsWithThemes(candidate, constraints) || !predicate(candidate)) continue;
    const key = strictFamilyKey(candidate.slug);
    const current = byFamily.get(key);
    if (!current || strictMemberScore(candidate, [], graph.format || "single", constraints) > strictMemberScore(current, [], graph.format || "single", constraints)) byFamily.set(key, candidate);
  }
  return [...byFamily.values()]
    .sort((a, b) => strictMemberScore(b, [], graph.format || "single", constraints) - strictMemberScore(a, [], graph.format || "single", constraints))
    .slice(0, limit)
    .map((candidate) => ({ name: candidate.name, slug: candidate.slug }));
}

function aiDesignSlotContract(graph = {}, constraints = {}, format = "single") {
  const slots = [];
  const add = (id, label, predicate, required = true) => {
    if (slots.length >= 6) return;
    const candidates = aiDesignSlotCandidates(graph, constraints, predicate);
    if (candidates.length) slots.push({ id, label, candidates, required });
  };
  for (const core of constraints.requiredPokemon || []) {
    const key = strictFamilyKey(core.slug || core.name || core.id);
    add(`hard-core-${slots.length + 1}`, `硬性核心：${core.name || core.slug || core.id}`, (member) => strictFamilyKey(member.slug) === key);
  }
  for (const theme of constraints.themes || []) {
    add(`${theme}-setter`, `${strictThemeLabel(theme)}启动者`, (member) => strictThemeInfo(member, theme).source);
    add(`${theme}-payoff`, `${strictThemeLabel(theme)}独立收益位`, (member) => {
      const info = strictThemeInfo(member, theme);
      return info.abuser && (theme === "tailwind" || !info.source);
    });
  }
  if (format === "double") {
    add("safe-turn", "安全回合位", (member) => {
      const tags = member.tags || strictTags(member, format);
      return tags.has("protect") || tags.has("safe-entry");
    });
    if (!(constraints.themes || []).includes("trick-room")) add("speed-plan", "控速或速度收益位", (member) => (member.tags || strictTags(member, format)).has("speed"));
  } else {
    add("safe-entry", "安全上场或转场位", (member) => {
      const tags = member.tags || strictTags(member, format);
      return tags.has("safe-entry") || tags.has("pivot") || tags.has("defensive");
    });
    add("speed-plan", "速度线位", (member) => (member.tags || strictTags(member, format)).has("speed"));
  }
  add("endgame", "突破或终盘位", (member) => {
    const tags = member.tags || strictTags(member, format);
    return tags.has("wincon") || tags.has("wallbreaker");
  });
  while (slots.length < 6) add(`flex-${slots.length + 1}`, "结构补位", () => true);
  return slots.slice(0, 6);
}

function aiDesignContractPrompt(slots = []) {
  return slots.map((slot) => `${slot.id}（${slot.label}）：${slot.candidates.map((candidate) => candidate.slug).join(", ")}`).join("\n");
}

function parseAIDesignJson(text = "", catalogue = []) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const fragment = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  let parsed;
  try {
    parsed = JSON.parse(fragment);
  } catch {
    parsed = { rationale: raw };
  }
  const lookup = (value) => {
    const key = strictKey(value);
    if (!key) return null;
    const exact = catalogue.find((candidate) => strictKey(candidate.slug) === key || strictKey(candidate.name) === key || strictFamilyKey(candidate.slug) === strictFamilyKey(value));
    if (exact) return exact;
    if (key.length < 4) return null;
    return catalogue.find((candidate) => {
      const candidateSlug = strictKey(candidate.slug);
      const candidateName = strictKey(candidate.name);
      return candidateSlug.includes(key) || key.includes(candidateSlug) || candidateName.includes(key) || key.includes(candidateName);
    }) || null;
  };
  const collectValues = (value, key = "", result = []) => {
    if (Array.isArray(value)) {
      for (const item of value) collectValues(item, key, result);
      return result;
    }
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) {
        const isPokemonField = /pokemon|team|member|species|core|阵容|队伍|成员|宝可梦|精灵|核心/i.test(childKey);
        if (isPokemonField && (typeof childValue === "string" || typeof childValue === "number")) result.push(childValue);
        collectValues(childValue, childKey, result);
      }
      return result;
    }
    if ((typeof value === "string" || typeof value === "number") && /pokemon|team|member|species|core|阵容|队伍|成员|宝可梦|精灵|核心/i.test(key)) result.push(value);
    return result;
  };
  const selected = [];
  const listValues = [parsed.pokemon, parsed.team, parsed.members, parsed.draft?.pokemon, parsed.draft?.team, parsed.data?.pokemon, parsed.result?.team];
  const values = [
    ...listValues.flatMap((value) => Array.isArray(value) ? value : typeof value === "string" ? value.split(/[、,，\n/]+/) : []),
    ...collectValues(parsed),
  ];
  for (const value of values) {
    const candidate = lookup(typeof value === "object" ? value.slug || value.name || value.id || value.pokemon || value.species || value.pokemonName || value.speciesName || value.pokemon_name || value.species_name : value);
    if (candidate && !selected.some((item) => strictFamilyKey(item.slug) === strictFamilyKey(candidate.slug))) selected.push(candidate);
  }
  if (!selected.length) {
    for (const candidate of catalogue) {
      if (!raw.toLowerCase().includes(String(candidate.slug).toLowerCase()) && !raw.includes(candidate.name)) continue;
      selected.push(candidate);
      if (selected.length >= 6) break;
    }
  }
  const rawSlots = parsed.slots || parsed.roles || parsed.positions || {};
  const slots = {};
  if (rawSlots && typeof rawSlots === "object" && !Array.isArray(rawSlots)) {
    for (const [slot, value] of Object.entries(rawSlots)) {
      const candidate = lookup(typeof value === "object" ? value.slug || value.name || value.id : value);
      if (!candidate) continue;
      slots[slot] = candidate;
      if (!selected.some((item) => strictFamilyKey(item.slug) === strictFamilyKey(candidate.slug))) selected.push(candidate);
    }
  }
  return { pokemon: selected, slots, rationale: String(parsed.rationale || parsed.summary || "").trim() };
}

function aiAssignDraftSlots(draft = {}, slots = []) {
  const members = [...new Map((draft.pokemon || []).map((member) => [strictFamilyKey(member.slug || member.name || member), member])).values()];
  if (members.length !== 6 || slots.length !== 6) return draft;
  const candidatesFor = (slot) => members.filter((member) => slot.candidates.some((candidate) => strictFamilyKey(candidate.slug) === strictFamilyKey(member.slug || member.name || member)));
  const ordered = slots.map((slot) => ({ slot, members: candidatesFor(slot) })).sort((a, b) => a.members.length - b.members.length);
  const assigned = {};
  const used = new Set();
  const place = (index) => {
    if (index === ordered.length) return true;
    const { slot, members: choices } = ordered[index];
    for (const member of choices) {
      const key = strictFamilyKey(member.slug || member.name || member);
      if (used.has(key)) continue;
      used.add(key);
      assigned[slot.id] = member;
      if (place(index + 1)) return true;
      delete assigned[slot.id];
      used.delete(key);
    }
    return false;
  };
  if (place(0)) draft.slots = { ...(draft.slots || {}), ...assigned };
  return draft;
}

function completeAIDesignDraft(draft = {}, graph = {}, constraints = {}) {
  const byFamily = new Map();
  for (const candidate of graph.candidates || []) {
    const key = strictFamilyKey(candidate.slug);
    const current = byFamily.get(key);
    if (!current || Number(candidate.rank || 9999) < Number(current.rank || 9999)) byFamily.set(key, candidate);
  }
  const selected = [];
  const add = (candidate) => {
    if (!candidate || selected.some((item) => strictFamilyKey(item.slug) === strictFamilyKey(candidate.slug))) return;
    selected.push(candidate);
  };
  for (const item of draft.pokemon || []) add(byFamily.get(strictFamilyKey(item.slug || item.name || item)));
  if (selected.length !== 6) return null;
  return {
    pokemon: selected.map((candidate) => ({ name: candidate.name, slug: candidate.slug })),
    aiSelected: selected.map((candidate) => ({ name: candidate.name, slug: candidate.slug })),
    engineAdded: [],
    slots: Object.fromEntries(Object.entries(draft.slots || {}).map(([slot, candidate]) => [slot, candidate.slug || candidate.name || candidate])),
    variationSeed: String(draft.variationSeed || ""),
    rationale: draft.rationale || `AI 已按职责槽位选择六人，严格引擎只验证当前 ${graph.ruleset?.regulation || "规则"} 配置与结构，不会替换成员。`,
    completionNote: "AI 选择的六只成员会原样进入严格配置验证；结构不通过会要求 AI 重选，而不是自动换成热门样本。",
  };
}

function teamDesignPrompt(payload = {}, slots = []) {
  const constraints = payload.goalConstraints || {};
  const required = (constraints.requiredPokemon || []).map((item) => item.name || item.slug).join("、") || "无";
  const themes = (constraints.themes || []).join("、") || "无";
  const avoided = (Array.isArray(payload.avoidTeam) ? payload.avoidTeam : []).map((item) => typeof item === "object" ? item.name || item.slug || item.id : item).filter(Boolean);
  const requiresSetup = /强化队|强化|setup\s*(team|squad)?|boost(?:ing)?\s*(team|squad)?/i.test(String(payload.userGoal || ""));
  const setupRule = requiresSetup ? "强化队硬要求：至少两名实际携带强化招式的成员，另有保护强化回合的协作位和强化后终盘收割位。" : "";
  const variation = String(payload.variationSeed || "").slice(0, 80);
  const retryRule = avoided.length ? `上一版队伍：${avoided.join("、")}。本次必须至少替换两名非硬性核心成员，不能原样重复。` : "";
  return `你是宝可梦竞技配队设计师。请为当前 ${payload.regulation || payload.rulesetId || "规则"} ${payload.format === "double" ? "双打" : "单打"}设计一支原创六人队。\n用户目标：${payload.userGoal || "平衡/半攻"}\n必须包含：${required}\n体系：${themes}\n${setupRule}\n${retryRule}\n本次构筑变体编号：${variation || "默认"}。\n\n本地严格引擎已根据当前格式和硬性要求生成六个职责槽位。每个槽位只能从自己的 slug 候选中选一只；六个选择不得重复。不要自行添加宝可梦、不要输出道具或招式。\n${aiDesignContractPrompt(slots)}\n\n只需返回严格 JSON：{"pokemon":["slug1","slug2","slug3","slug4","slug5","slug6"],"rationale":"一句说明主胜利路线、联防和速度规划"}。可选地附加 slots；即使不附加，系统也会根据 pokemon 自动匹配职责槽位。`;
}

function aiDraftConstraintViolations(draft = {}, graph = {}, constraints = {}, slots = []) {
  aiAssignDraftSlots(draft, slots);
  const selected = (draft.pokemon || [])
    .map((item) => graph.candidates?.find((candidate) => strictFamilyKey(candidate.slug) === strictFamilyKey(item.slug || item.name || item)))
    .filter(Boolean);
  const violations = [];
  if (selected.length !== 6) violations.push(`必须返回恰好六名当前 ${graph.ruleset?.regulation || "目标"} 格式可验证成员。`);
  const selectedFamilies = new Set(selected.map((member) => strictFamilyKey(member.slug)));
  if (selectedFamilies.size !== 6) violations.push("六个成员必须互不重复。");
  const selectedKeys = new Set(selected.map((member) => strictFamilyKey(member.slug)));
  const repeatedFromPrevious = selected.filter((member) => constraints.avoidTeamFamilies?.has(strictFamilyKey(member.slug))).length;
  if (constraints.avoidTeamFamilies?.size && repeatedFromPrevious > 4) violations.push("本次必须至少替换两名非硬性核心成员，不能原样重复上一队。 ");
  const slotValues = new Set();
  for (const slot of slots) {
    const picked = draft.slots?.[slot.id];
    if (!picked) {
      violations.push(`缺少职责槽位：${slot.label}。`);
      continue;
    }
    const key = strictFamilyKey(picked.slug || picked.name || picked);
    if (!slot.candidates.some((candidate) => strictFamilyKey(candidate.slug) === key)) violations.push(`${slot.label}没有从指定候选中选择。`);
    if (slotValues.has(key)) violations.push(`职责槽位重复选择：${slot.label}。`);
    slotValues.add(key);
  }
  if (slots.length && (slotValues.size !== 6 || [...slotValues].some((key) => !selectedKeys.has(key)) || [...selectedKeys].some((key) => !slotValues.has(key)))) violations.push("pokemon 必须与六个职责槽位的选择完全一致。");
  for (const theme of constraints.themes || []) {
    if (!selected.some((member) => strictThemeInfo(member, theme).source)) violations.push(`${strictThemeLabel(theme)}缺少真实启动者。`);
    if (!selected.some((member) => {
      const info = strictThemeInfo(member, theme);
      return info.abuser && (theme === "tailwind" || !info.source);
    })) violations.push(`${strictThemeLabel(theme)}缺少独立收益位。`);
  }
  const conflicts = selected.filter((member) => strictConflictsWithThemes(member, constraints));
  if (conflicts.length) violations.push(`成员与体系冲突：${conflicts.map((member) => member.name).join("、")}。`);
  return violations;
}

function teamDesignCorrectionPrompt(slots = [], violations = []) {
  return [
    `上一轮草案不合格：${violations.join("；") || "没有给出可验证的队伍成员。"}`,
    "现在只能返回一行 JSON，禁止解释、禁止 Markdown、禁止中文宝可梦名、禁止候选外名字。pokemon 必须恰好是六个不重复 slug，并覆盖每个职责槽位；slots 字段可省略。",
    aiDesignContractPrompt(slots),
    "返回：{\"pokemon\":[\"slug1\",\"slug2\",\"slug3\",\"slug4\",\"slug5\",\"slug6\"],\"rationale\":\"一句简短构筑理由\"}",
  ].join("\n");
}

function engineGuidedAIDraft(payload = {}, format = "single", parsedDraft = {}, reason = "") {
  const fallback = strictBuildTeam({ ...payload, format, buildMethod: "strict", forceGenerated: true, aiDraft: undefined });
  if (!fallback.ok) return null;
  return {
    pokemon: fallback.team.map((member) => ({ name: member.name, slug: member.slug })),
    aiSelected: (parsedDraft.pokemon || []).map((member) => ({ name: member.name, slug: member.slug })),
    engineAdded: fallback.team.map((member) => ({ name: member.name, slug: member.slug })),
    variationSeed: String(payload.variationSeed || ""),
    mode: "engine-guided",
    rationale: parsedDraft.rationale || "AI 已识别用户目标；本地严格引擎据此完成了可用六人队。",
    completionNote: `AI 草案${reason || "未通过当前格式验证"}，已自动采用同一目标下的严格定稿，避免把报错或不完整队伍交给你。`,
  };
}

async function handleTeamDesign(req, res) {
  const input = await readJson(req);
  const format = input.format === "double" ? "double" : "single";
  const snapshot = ruleRegistry.operational({ format, rulesetId: String(input.rulesetId || "").trim() });
  const payload = {
    ...input,
    format,
    rulesetId: snapshot.rulesetId,
    regulation: snapshot.regulation,
    battleHistory: Array.isArray(input.battleHistory) ? input.battleHistory.filter((item) => item?.rulesetId === snapshot.rulesetId) : [],
  };
  const graph = strictCandidateGraph(format, snapshot.rulesetId);
  const constraints = strictGoalConstraints(payload, graph.available);
  if (constraints.unavailable.length) {
    sendJson(res, 422, { error: `用户指定的核心不在当前 ${snapshot.regulation} 目标格式可用池。`, ...rulesetMetadata(snapshot) });
    return;
  }
  const aiConfig = resolveRequestAIConfig(payload);
  if (!aiConfig) {
    sendJson(res, 501, { error: "AI 原创设计需要先填写 API Key、Base URL 和模型。" });
    return;
  }
  const lookupCatalogue = aiDesignCatalogue(format, 2000, snapshot.rulesetId);
  for (const required of constraints.requiredPokemon || []) {
    const candidate = graph.candidates.find((item) => strictFamilyKey(item.slug) === strictFamilyKey(required.slug || required.name || required.id));
    if (!candidate) continue;
    const entry = { name: candidate.name, slug: candidate.slug, roles: [...(candidate.tags || [])].join(",") || "flex" };
    if (!lookupCatalogue.some((item) => strictFamilyKey(item.slug) === strictFamilyKey(candidate.slug))) lookupCatalogue.unshift(entry);
  }
  const slots = aiDesignSlotContract({ ...graph, format }, constraints, format);
  if (slots.length !== 6) {
    sendJson(res, 422, { code: "AI_SLOT_CONTRACT_UNAVAILABLE", error: `当前 ${snapshot.regulation} 目标格式无法为这组硬性要求生成完整的六个职责槽位。`, ...rulesetMetadata(snapshot) });
    return;
  }
  try {
    let response = await requestAIText(aiConfig, teamDesignPrompt(payload, slots), {
      timeoutMs: aiTimeoutMs(payload),
      maxTokens: 1100,
      forceJson: true,
    });
    let data = await readAIResponse(response);
    if (!response.ok && [400, 422].includes(response.status)) {
      response = await requestAIText(aiConfig, teamDesignPrompt(payload, slots), {
        timeoutMs: aiTimeoutMs(payload),
        maxTokens: 1100,
      });
      data = await readAIResponse(response);
    }
    if (!response.ok) {
      sendJson(res, response.status, { error: data.error?.message || "AI 原创设计请求失败。" });
      return;
    }
    let rawText = extractOutputText(data);
    let parsedDraft = parseAIDesignJson(rawText, lookupCatalogue);
    let draftViolations = aiDraftConstraintViolations(parsedDraft, { ...graph, format }, constraints, slots);
    if (draftViolations.length) {
      const correctionResponse = await requestAIText(aiConfig, teamDesignCorrectionPrompt(slots, draftViolations), {
        timeoutMs: aiTimeoutMs(payload),
        maxTokens: 420,
        forceJson: true,
      });
      const correctionData = await readAIResponse(correctionResponse);
      if (correctionResponse.ok) {
        rawText = extractOutputText(correctionData);
        parsedDraft = parseAIDesignJson(rawText, lookupCatalogue);
        draftViolations = aiDraftConstraintViolations(parsedDraft, { ...graph, format }, constraints, slots);
      }
    }
    if (draftViolations.length) {
      const engineDraft = engineGuidedAIDraft(payload, format, parsedDraft, "未形成完整可识别的六人职责结构");
      if (engineDraft) {
        sendJson(res, 200, { ok: true, format, model: aiConfig.model, provider: aiConfig.source, ...rulesetMetadata(snapshot), draft: engineDraft });
        return;
      }
      sendJson(res, 422, {
        code: "AI_DRAFT_CONSTRAINT_VIOLATION",
        error: `AI 原创草案未满足职责槽位或体系要求：${draftViolations.join("；")}。已停止，避免把严格引擎补位误称为 AI 阵容。`,
        diagnostics: draftViolations,
        rawPreview: String(rawText || "").slice(0, 360),
      });
      return;
    }
    let draft = completeAIDesignDraft(
      { ...parsedDraft, variationSeed: String(payload.variationSeed || "") },
      { ...graph, format },
      { ...constraints, aiVariation: String(payload.variationSeed || "") },
    );
    if (!draft) {
      const engineDraft = engineGuidedAIDraft(payload, format, parsedDraft, "没有给出完整的六名不重复成员");
      if (engineDraft) {
        sendJson(res, 200, { ok: true, format, model: aiConfig.model, provider: aiConfig.source, ...rulesetMetadata(snapshot), draft: engineDraft });
        return;
      }
      sendJson(res, 422, { code: "AI_DRAFT_INCOMPLETE", error: "AI 原创草案没有给出完整的六名不重复成员。" });
      return;
    }
    let preflight = strictBuildTeam({ ...payload, format, buildMethod: "ai-designed", aiDraft: draft });
    if (!preflight.ok) {
      // Slot matching proves that the model understood the request. Retry once
      // with configuration-level diagnostics before using the deterministic net.
      const repairResponse = await requestAIText(aiConfig, teamDesignCorrectionPrompt(slots, preflight.diagnostics || []), {
        timeoutMs: aiTimeoutMs(payload),
        maxTokens: 420,
        forceJson: true,
      });
      const repairData = await readAIResponse(repairResponse);
      if (repairResponse.ok) {
        const repairedDraft = parseAIDesignJson(extractOutputText(repairData), lookupCatalogue);
        const repairViolations = aiDraftConstraintViolations(repairedDraft, { ...graph, format }, constraints, slots);
        const completedRepair = repairViolations.length
          ? null
          : completeAIDesignDraft(
            { ...repairedDraft, variationSeed: String(payload.variationSeed || "") },
            { ...graph, format },
            { ...constraints, aiVariation: String(payload.variationSeed || "") },
          );
        const repairedPreflight = completedRepair
          ? strictBuildTeam({ ...payload, format, buildMethod: "ai-designed", aiDraft: completedRepair })
          : null;
        if (repairedPreflight?.ok) {
          draft = completedRepair;
          preflight = repairedPreflight;
        }
      }
    }
    if (!preflight.ok) {
      const engineDraft = engineGuidedAIDraft(payload, format, parsedDraft, "两次未通过配置级结构验证");
      if (!engineDraft) {
        sendJson(res, 422, {
          code: "AI_DRAFT_STRUCTURE_UNSATISFIED",
          error: `AI 草案和本地严格构筑都无法满足这组要求：${(preflight.diagnostics || []).join("；")}`,
          diagnostics: preflight.diagnostics || [],
        });
        return;
      }
      draft = engineDraft;
    }
    sendJson(res, 200, { ok: true, format, model: aiConfig.model, provider: aiConfig.source, ...rulesetMetadata(snapshot), draft });
  } catch (err) {
    const timeoutSeconds = Math.round(aiTimeoutMs(payload) / 1000);
    sendJson(res, 502, { error: err.name === "AbortError" ? `AI 原创设计超过 ${timeoutSeconds} 秒未返回。` : `AI 原创设计连接失败：${err.message || "请检查配置。"}` });
  }
}

async function handleAI(req, res) {
  const input = await readJson(req);
  const format = input.format === "double" ? "double" : "single";
  const snapshot = ruleRegistry.operational({ format, rulesetId: String(input.rulesetId || "").trim() });
  const payload = {
    ...input,
    format,
    rulesetId: snapshot.rulesetId,
    regulation: snapshot.regulation,
    battleHistory: Array.isArray(input.battleHistory) ? input.battleHistory.filter((item) => item?.rulesetId === snapshot.rulesetId) : [],
  };
  const preflightViolations = hardGoalPreflightViolations(payload);
  if (preflightViolations.length) {
    sendJson(res, 422, {
      code: "HARD_CONSTRAINT_UNSATISFIED",
      error: `无法按硬性要求构筑：${preflightViolations.join("；")}`,
      violations: preflightViolations,
    });
    return;
  }
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
  const hardViolations = hardGoalAdviceViolations(advice, payload);
  if (hardViolations.length) {
    sendJson(res, 422, {
      code: "HARD_CONSTRAINT_UNSATISFIED",
      error: `AI 返回的队伍没有满足硬性要求：${hardViolations.join("；")}`,
      violations: hardViolations,
    });
    return;
  }
  sendJson(res, 200, {
    model: aiConfig.model,
    provider: aiConfig.source,
    ...rulesetMetadata(snapshot),
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
  hardGoalAdviceViolations,
  hardGoalPreflightViolations,
  passChainCapability,
  pocketAgFormatPlan,
  pocketAgFormatWatch,
  pocketAgRepairAdvice,
  pocketAgSelectTeam,
  strictBuildTeam,
};

async function startServer() {
  const registryState = await ruleRegistry.initialize();
  await showdownAccount.initialize();
  const ruleSyncTimer = setInterval(() => {
    ruleRegistry.sync().catch((error) => console.error(`Rules registry sync failed: ${error.message}`));
  }, Math.max(60_000, RULE_SYNC_INTERVAL_MS));
  ruleSyncTimer.unref();
  createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS" && req.url?.startsWith("/api/")) {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }
      if (req.method === "GET" && (req.url === "/api/rules/active" || req.url === "/api/rules/history")) {
        await handleRulesApi(req, res);
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/rules/candidates")) {
        await handleRulesCandidatesApi(req, res);
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/rules/pool")) {
        await handleOfficialPoolApi(req, res);
        return;
      }
      if ((req.method === "GET" || req.method === "POST") && req.url?.startsWith("/api/reference/")) {
        if (req.url?.startsWith("/api/reference/status") || req.url?.startsWith("/api/reference/sync")) {
          await handleReferenceApi(req, res);
          return;
        }
      }
      if (req.method === "GET" && req.url?.startsWith("/api/reference/term")) {
        await handleReferenceTermApi(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/api/rules/sync") {
        await handleRulesApi(req, res);
        return;
      }
      if ((req.method === "GET" && req.url === "/api/agent/account/status") || (req.method === "POST" && (req.url === "/api/agent/account/bootstrap" || req.url === "/api/agent/account/continue" || req.url === "/api/agent/account/focus" || req.url === "/api/agent/account/rotate-pending" || req.url === "/api/agent/account/reconcile")) || (req.method === "DELETE" && req.url === "/api/agent/account")) {
        await handleAccountApi(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/api/pokecamp/teams/import") {
        await handlePokecampTeamImport(req, res);
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/pokecamp/teams")) {
        handlePokecampTeamsApi(req, res);
        return;
      }
      if ((req.method === "GET" || req.method === "POST") && req.url?.startsWith("/api/pokecamp/monitor/")) {
        await handlePokecampMonitorApi(req, res);
        return;
      }
      if ((req.method === "GET" || req.method === "POST") && req.url?.startsWith("/api/pokecamp/browser/")) {
        await handlePokecampBrowserApi(req, res);
        return;
      }
      if ((req.method === "GET" && (req.url === "/api/agent/status" || req.url?.startsWith("/api/agent/hot-teams") || req.url?.startsWith("/api/agent/replays") || req.url?.startsWith("/api/agent/replay/") || req.url?.startsWith("/api/agent/models") || req.url?.startsWith("/api/agent/ratings") || req.url?.startsWith("/api/agent/learning"))) || (req.method === "POST" && ["/api/agent/start", "/api/agent/stop", "/api/agent/promote", "/api/agent/analyze", "/api/agent/analyze-replay", "/api/agent/evolve-team", "/api/agent/train", "/api/agent/evaluate"].includes(req.url || ""))) {
        await handleAgentApi(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/api/team-advice") {
        await handleAI(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/api/team-build") {
        await handleStrictTeamBuild(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/api/team-coach") {
        await handleTeamCoach(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/api/team-design") {
        await handleTeamDesign(req, res);
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/team-lab")) {
        await handleTeamLabApi(req, res);
        return;
      }
      if (req.method === "POST" && (req.url === "/api/team-lab/generate" || req.url === "/api/team-lab/promote")) {
        await handleTeamLabApi(req, res);
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
        const format = body.format === "double" ? "double" : "single";
        sendJson(res, 200, validateShowdownTeam(body.text || "", format, String(body.rulesetId || "").trim()));
        return;
      }
      if (req.method === "POST" && req.url === "/api/battle-eval") {
        await handleBattleEval(req, res);
        return;
      }
      if ((req.method === "GET" || req.method === "POST" || req.method === "DELETE") && req.url === "/api/battle-history") {
        await handleBattleHistory(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/api/showdown-replay") {
        await handleShowdownReplay(req, res);
        return;
      }
      if ((req.method === "GET" || req.method === "POST") && req.url?.startsWith("/api/showdown-bridge")) {
        await handleShowdownImportBridge(req, res);
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
      if (err instanceof RuleRegistryError) {
        sendJson(res, err.status || 409, { ok: false, code: err.code, error: err.message, details: err.details || {} });
        return;
      }
      if (err?.status || err?.code) {
        sendJson(res, err.status || 400, { ok: false, code: err.code || "REQUEST_FAILED", error: err.message, details: err.details || {}, candidates: err.candidates || undefined });
        return;
      }
      sendJson(res, 500, { ok: false, error: err.message || "Server error" });
    }
  }).listen(PORT, "127.0.0.1", () => {
    console.log(`Champion Lab AI server running at http://127.0.0.1:${PORT}`);
    console.log(`Rules registry: ${registryState.status}; active formats: ${registryState.active.map((item) => item.showdownFormatId).join(", ") || "none"}`);
    console.log(`AI requests use browser-provided config; default model hint: ${OPENAI_MODEL || "unset"}`);
    ensureInitialData();
    if (pokecampMonitorState.enabled) {
      pokecampMonitorState = { ...pokecampMonitorState, status: "IDLE", nextRunAt: "" };
      schedulePokecampMonitor();
      setTimeout(() => runPokecampMonitor().catch((error) => console.error(`PokéCamp monitor failed: ${error.message}`)), 1500);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.once("SIGINT", () => {
    agentController.shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    agentController.shutdown();
    process.exit(0);
  });
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

