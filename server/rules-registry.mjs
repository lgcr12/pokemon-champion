import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { Dex } = require("pokemon-showdown");

const DEFAULT_SOURCE = "https://cdn.jsdelivr.net/gh/smogon/pokemon-showdown@master/config/formats.ts";
const SOURCE_FALLBACKS = [
  DEFAULT_SOURCE,
  "https://raw.githubusercontent.com/smogon/pokemon-showdown/master/config/formats.ts",
];
const SNAPSHOT_DIR = "data/rules";
const SNAPSHOT_PATH = "data/rules/registry.json";
const OFFICIAL_NAME = /^\[Gen \d+ Champions\] (BSS Reg ([A-Z0-9-]+)|VGC \d{4} Reg ([A-Z0-9-]+))$/i;

export class RuleRegistryError extends Error {
  constructor(code, message, status = 409, details = {}) {
    super(message);
    this.name = "RuleRegistryError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function toId(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function stringList(block, key) {
  const match = block.match(new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) return [];
  return [...match[1].matchAll(/(['"])(.*?)\1/g)].map((item) => item[2]);
}

function stringField(block, key) {
  const match = block.match(new RegExp(`${key}\\s*:\\s*(['"])(.*?)\\1`));
  return match?.[2] || "";
}

function booleanField(block, key, fallback) {
  const match = block.match(new RegExp(`${key}\\s*:\\s*(true|false)`));
  return match ? match[1] === "true" : fallback;
}

function extractOnlineFormats(source) {
  const formats = [];
  const objectPattern = /^\s*\{\s*\n?\s*name:\s*(['"])(\[Gen\s+\d+\s+Champions\][^'"]+)\1([\s\S]*?)^\s*\},/gm;
  for (const match of source.matchAll(objectPattern)) {
    const block = `name: "${match[2]}"${match[3]}`;
    const name = match[2];
    const parsedName = OFFICIAL_NAME.exec(name);
    if (!parsedName) continue;
    const battleType = name.includes(" VGC ") ? "double" : "single";
    const regulation = parsedName[2] || parsedName[3] || "";
    formats.push({
      id: toId(name),
      name,
      battleType,
      regulation,
      mod: stringField(block, "mod") || "base",
      gameType: battleType === "double" ? "doubles" : "singles",
      rated: booleanField(block, "rated", true),
      searchShow: booleanField(block, "searchShow", true),
      ruleset: stringList(block, "ruleset"),
      banlist: stringList(block, "banlist"),
      source: "online",
    });
  }
  return formats.filter((format) => format.searchShow !== false && format.rated !== false);
}

function isEligibleName(name = "") {
  return OFFICIAL_NAME.test(name) && !/\(Bo3\)$/i.test(name);
}

function formatKind(format = "") {
  const value = String(format || "").toLowerCase();
  return value.includes("double") || value.includes("vgc") ? "double" : "single";
}

function localFormatSnapshot(format) {
  const battleType = format.gameType === "doubles" ? "double" : "single";
  const nameMatch = OFFICIAL_NAME.exec(format.name || "");
  const regulation = nameMatch?.[2] || nameMatch?.[3] || "unknown";
  return {
    id: format.id,
    name: format.name,
    battleType,
    regulation,
    mod: format.mod || "base",
    gameType: format.gameType || (battleType === "double" ? "doubles" : "singles"),
    rated: format.rated !== false,
    searchShow: format.searchShow !== false,
    ruleset: [...(format.ruleset || [])],
    banlist: [...(format.banlist || [])],
    source: "local",
  };
}

function discoverLocalFormats() {
  return Dex.formats.all().filter((format) => isEligibleName(format.name) && format.rated !== false && format.searchShow !== false).map(localFormatSnapshot);
}

function legalPoolDigest(format) {
  let modDex = Dex;
  try { modDex = Dex.mod(format.mod || "base"); } catch {}
  const collections = {};
  for (const category of ["species", "items", "moves", "abilities", "conditions"]) {
    try { collections[category] = modDex[category].all().filter((item) => item?.exists).map((item) => item.id).sort(); } catch { collections[category] = []; }
  }
  let rules = [];
  try {
    const data = Dex.formats.get(format.id);
    rules = [...(data?.ruleTable || [])].map(([key, value]) => [key, value]);
  } catch {}
  return digest({ mod: format.mod, rules, collections });
}

function showdownCommit(root) {
  try {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const resolved = lock.packages?.["node_modules/pokemon-showdown"]?.resolved || "";
    return resolved.split("#").at(-1) || "unknown";
  } catch { return "unknown"; }
}

function comparable(format) {
  return {
    id: format.id,
    name: format.name,
    battleType: format.battleType,
    regulation: format.regulation,
    mod: format.mod,
    gameType: format.gameType,
    rated: format.rated !== false,
    searchShow: format.searchShow !== false,
    ruleset: [...(format.ruleset || [])],
    banlist: [...(format.banlist || [])],
  };
}

function diffFormat(local, online) {
  const differences = [];
  for (const key of ["name", "battleType", "regulation", "mod", "gameType", "rated", "searchShow", "ruleset", "banlist"]) {
    if (JSON.stringify(local?.[key]) !== JSON.stringify(online?.[key])) differences.push({ field: key, local: local?.[key], online: online?.[key] });
  }
  return differences;
}

export class RuleRegistry {
  constructor({ root = resolve("."), sourceUrl = process.env.SHOWDOWN_FORMATS_SOURCE || DEFAULT_SOURCE } = {}) {
    this.root = root;
    this.sourceUrl = sourceUrl;
    this.state = {
      schemaVersion: 1,
      status: "UNINITIALIZED",
      canOperate: false,
      active: [],
      history: [],
      differences: [],
      lastSyncAt: null,
      sourceUrl,
      showdownCommit: showdownCommit(root),
    };
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(join(this.root, SNAPSHOT_PATH), "utf8"));
      this.state = { ...this.state, ...saved, sourceUrl: this.sourceUrl };
    } catch {}
    return this.state;
  }

  async persist() {
    await mkdir(join(this.root, SNAPSHOT_DIR), { recursive: true });
    await writeFile(join(this.root, SNAPSHOT_PATH), `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  async initialize() {
    await this.load();
    try { await this.sync(); } catch (error) {
      this.state = { ...this.state, status: "ONLINE_UNAVAILABLE", canOperate: process.env.RULE_REGISTRY_ALLOW_OFFLINE === "true", lastError: error.message };
      await this.persist();
    }
    return this.state;
  }

  async sync() {
    let source = "";
    let resolvedSource = "";
    let lastError;
    for (const url of [...new Set([this.sourceUrl, ...SOURCE_FALLBACKS])]) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "user-agent": "ChampionForge/0.1" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        source = await response.text();
        resolvedSource = url;
        break;
      } catch (error) { lastError = error; }
    }
    if (!source) {
      const error = new Error(`Showdown format sources unavailable: ${lastError?.message || "unknown error"}`);
      this.state = {
        ...this.state,
        status: "ONLINE_UNAVAILABLE",
        canOperate: process.env.RULE_REGISTRY_ALLOW_OFFLINE === "true",
        lastSyncAt: new Date().toISOString(),
        lastError: error.message,
      };
      await this.persist();
      throw error;
    }
    const online = extractOnlineFormats(source);
    const local = discoverLocalFormats();
    const onlineById = new Map(online.map((format) => [format.id, format]));
    const localById = new Map(local.map((format) => [format.id, format]));
    const differences = [];
    const active = [];
    for (const localFormat of local) {
      const onlineFormat = onlineById.get(localFormat.id);
      if (!onlineFormat) {
        differences.push({ formatId: localFormat.id, type: "MISSING_ONLINE", local: comparable(localFormat) });
        continue;
      }
      const fields = diffFormat(localFormat, onlineFormat);
      if (fields.length) differences.push({ formatId: localFormat.id, type: "FORMAT_MISMATCH", fields });
      const formatHash = digest(comparable(localFormat));
      const legalPoolHash = legalPoolDigest(localFormat);
      active.push({
        rulesetId: `champions-${localFormat.battleType}-${toId(localFormat.regulation)}-${digest({ formatHash, legalPoolHash, showdownCommit: this.state.showdownCommit }).slice(0, 12)}`,
        showdownFormatId: localFormat.id,
        battleType: localFormat.battleType,
        regulation: localFormat.regulation,
        name: localFormat.name,
        rated: true,
        searchShow: true,
        rules: localFormat.ruleset,
        banlist: localFormat.banlist,
        formatHash,
        legalPoolHash,
        showdownCommit: this.state.showdownCommit,
        sourceUrl: resolvedSource,
        status: fields.length ? "drift" : "active",
        discoveredAt: new Date().toISOString(),
      });
    }
    for (const onlineFormat of online) {
      if (!localById.has(onlineFormat.id)) differences.push({ formatId: onlineFormat.id, type: "MISSING_LOCAL", online: comparable(onlineFormat) });
    }
    const now = new Date().toISOString();
    const status = differences.length || !active.length ? "RULE_DRIFT" : "ACTIVE";
    const canOperate = status === "ACTIVE";
    const historical = [...this.state.history];
    for (const snapshot of active) {
      const existing = historical.find((item) => item.rulesetId === snapshot.rulesetId);
      if (existing) Object.assign(existing, snapshot, { firstSeenAt: existing.firstSeenAt || snapshot.discoveredAt });
      else historical.push({ ...snapshot, firstSeenAt: now });
    }
    this.state = { ...this.state, status, canOperate, active: active.map((item) => ({ ...item, status: canOperate ? "active" : "drift" })), history: historical.slice(-100), differences, lastSyncAt: now, lastError: "", sourceUrl: resolvedSource };
    await this.persist();
    return this.state;
  }

  activeFor(value = "") {
    const kind = formatKind(value);
    return this.state.active.find((snapshot) => snapshot.battleType === kind && snapshot.status === "active") || null;
  }

  get(rulesetId) {
    return this.state.active.find((snapshot) => snapshot.rulesetId === rulesetId) || this.state.history.find((snapshot) => snapshot.rulesetId === rulesetId) || null;
  }

  operational({ format = "single", rulesetId = "" } = {}) {
    if (!this.state.canOperate) throw new RuleRegistryError("RULE_REGISTRY_NOT_ACTIVE", `规则注册中心当前状态为 ${this.state.status}，已禁止配队和校验。`, 503, { status: this.state.status, differences: this.state.differences });
    const snapshot = rulesetId ? this.get(rulesetId) : this.activeFor(format);
    if (!snapshot || snapshot.status !== "active" || !this.state.active.some((item) => item.rulesetId === snapshot.rulesetId)) throw new RuleRegistryError("RULESET_MISMATCH", "请求的 rulesetId 不是当前激活规则，已拒绝继续操作。", 409, { rulesetId, active: this.state.active.map((item) => item.rulesetId) });
    if (formatKind(format) !== snapshot.battleType) throw new RuleRegistryError("FORMAT_RULESET_MISMATCH", "format 与 rulesetId 的单打/双打类型不一致。", 409, { format, rulesetId });
    return snapshot;
  }

  publicState() {
    return { ...this.state, history: this.state.history.map((item) => ({ ...item })), active: this.state.active.map((item) => ({ ...item })) };
  }
}

export const ruleRegistry = new RuleRegistry({ root: process.env.RULE_REGISTRY_ROOT || resolve(".") });
