const TYPES = ["一般", "火", "水", "电", "草", "冰", "格斗", "毒", "地面", "飞行", "超能力", "虫", "岩石", "幽灵", "龙", "恶", "钢", "妖精"];

import { buildBattleKnowledge, packTeam } from "./battle-knowledge.mjs";

const TEAM_FORM_ALIASES = new Map([
  [10061, { id: 670, slug: "floette" }],
  [10008, { id: 479, slug: "rotom-heat" }],
  [10009, { id: 479, slug: "rotom-wash" }],
  [10012, { id: 479, slug: "rotom-mow" }],
  [10104, { id: 38, slug: "ninetales-alola" }],
  [10172, { id: 199, slug: "slowking-galar" }],
  [10230, { id: 59, slug: "arcanine-hisui" }],
  [10233, { id: 157, slug: "typhlosion-hisui" }],
  [10236, { id: 503, slug: "samurott-hisui" }],
]);

const state = {
  rawData: null,
  data: null,
  battleKnowledgeData: null,
  format: "single",
  team: [],
  teamConfigs: {},
  teamLibrary: [],
  selectedTeamId: "",
  importedTeam: null,
  activeEditIndex: null,
  aiBusy: false,
  aiLastAdvice: null,
  aiLastMode: "complete-team",
  showdownValidation: null,
  query: "",
  searchOpen: false,
  rulePrefs: {
    allowDuplicateItems: false,
    ignoreTera: false,
  },
};

const $ = (selector) => document.querySelector(selector);
const DRAFT_KEY = "champion-lab-current-draft-v2";
const AI_CONFIG_KEY = "champion-lab-ai-config-v1";
const AI_MODELS_CACHE_KEY = "champion-lab-ai-models-v1";
const RULE_PREFS_KEY = "champion-lab-rule-prefs-v1";
const TYPE_CN_TO_EN = {
  一般: "Normal",
  火: "Fire",
  水: "Water",
  电: "Electric",
  草: "Grass",
  冰: "Ice",
  格斗: "Fighting",
  毒: "Poison",
  地面: "Ground",
  飞行: "Flying",
  超能力: "Psychic",
  虫: "Bug",
  岩石: "Rock",
  幽灵: "Ghost",
  龙: "Dragon",
  恶: "Dark",
  钢: "Steel",
  妖精: "Fairy",
};
const TYPE_EFFECTIVENESS = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy: { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};
const AI_PROVIDER_PRESETS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    endpoint: "responses",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    endpoint: "chat",
    models: ["deepseek-chat", "deepseek-reasoner", "deepseek-r1", "deepseek-v4-flash"],
  },
  kimi: {
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2-0711-preview",
    endpoint: "chat",
    models: ["kimi-k2-0711-preview", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    endpoint: "chat",
    models: ["qwen-plus", "qwen-turbo", "qwen-max", "qwen-long"],
  },
  minimax: {
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M1",
    endpoint: "chat",
    models: ["MiniMax-M1", "MiniMax-Text-01"],
  },
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    endpoint: "chat",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen3-32B"],
  },
  custom: {
    baseUrl: "",
    model: "",
    endpoint: "chat",
    models: [],
  },
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pct(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return `${Math.round(Number(value) * 10) / 10}%`;
}

function formatLabel(format) {
  return format === "double" ? "双打" : "单打";
}

function names(entries = [], limit = 2) {
  return entries.slice(0, limit).filter((item) => item?.name).map((item) => item.name).join(" / ");
}

function idKey(value = "") {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function topNames(entries = [], limit = 2) {
  return entries
    .slice(0, limit)
    .filter((item) => item?.name)
    .map((item) => `${item.name}${item.percentage ? ` ${pct(item.percentage)}` : ""}`)
    .join(" / ");
}

function stat(pokemon, label) {
  return Number(pokemon?.stats?.[label] || 0);
}

function textOf(pokemon, key) {
  const isTeamMember = state.team.some((mon) => mon.slug === pokemon?.slug || Number(mon.id) === Number(pokemon?.id));
  if (isTeamMember && ["moves", "items", "abilities"].includes(key)) {
    const config = editableConfigFor(pokemon);
    if (key === "moves") return (config.moves || []).join(" ");
    if (key === "items") return config.item || "";
    if (key === "abilities") return config.ability || "";
  }
  return (pokemon?.[key] || []).map((item) => item.name).join(" ");
}

function hasMove(pokemon, pattern) {
  return pattern.test(textOf(pokemon, "moves"));
}

function hasAbility(pokemon, pattern) {
  return pattern.test(textOf(pokemon, "abilities"));
}

function hasItem(pokemon, pattern) {
  return pattern.test(textOf(pokemon, "items"));
}

function effectiveSpeed(pokemon) {
  const base = stat(pokemon, "速度");
  const boosts = [];
  if (hasItem(pokemon, /讲究围巾/)) boosts.push({ label: "围巾", value: Math.floor(base * 1.5) });
  if (hasMove(pokemon, /顺风/)) boosts.push({ label: "顺风", value: base * 2 });
  if (hasAbility(pokemon, /悠游自如|叶绿素|拨沙|拨雪|轻装|加速/)) boosts.push({ label: "特性加速", value: base * 2 });
  return boosts.sort((a, b) => b.value - a.value)[0] || { label: "原速", value: base };
}

function getRoles(pokemon) {
  const roles = new Set();
  const moves = textOf(pokemon, "moves");
  const abilities = textOf(pokemon, "abilities");
  const items = textOf(pokemon, "items");
  if (stat(pokemon, "攻击") >= 115 || /剑舞|龙舞/.test(moves)) roles.add("物理输出");
  if (stat(pokemon, "特攻") >= 115 || /冥想|诡计/.test(moves)) roles.add("特殊输出");
  if (stat(pokemon, "速度") >= 100) roles.add("高速位");
  if (stat(pokemon, "HP") + stat(pokemon, "防御") + stat(pokemon, "特防") >= 290) roles.add("耐久位");
  if (/隐形岩|撒菱|剧毒|电磁波|鬼火|挑衅|顺风|戏法空间|看我嘛|击掌奇袭|广域防守|守住/.test(moves)) roles.add("功能位");
  if (/威吓|再生力|魔法镜|粗糙皮肤|恶作剧之心|友情防守|避雷针/.test(abilities)) roles.add("特性价值");
  if (/气势披带|讲究|生命宝珠|突击背心|吃剩的东西|防尘护目镜/.test(items)) roles.add("标准配置");
  return [...roles];
}

function pokemonSummary(mon) {
  return {
    id: mon.id,
    name: mon.name,
    slug: mon.slug,
    rank: mon.rank,
    types: mon.types,
    stats: mon.stats,
    effectiveSpeed: effectiveSpeed(mon),
    commonMoves: mon.moves?.slice(0, 8),
    commonItems: mon.items?.slice(0, 5),
    commonAbilities: mon.abilities?.slice(0, 5),
    commonNatures: mon.natures?.slice(0, 5),
    roles: getRoles(mon),
    externalKnowledge: externalKnowledgeFor(mon),
    importedConfig: importedConfigFor(mon),
    customConfig: editableConfigFor(mon),
  };
}

function externalKnowledgeFor(mon, format = state.format) {
  const entry = knowledgeEntryFor(mon);
  if (!entry) return null;
  const preferredFormats =
    format === "double"
      ? ["gen9doublesou", "gen9vgc2026", "gen9vgc2025", "gen9ou"]
      : ["gen9ou", "gen9nationaldex", "gen9doublesou"];
  const smogonFormat = preferredFormats.find((item) => entry.smogon?.[item]) || Object.keys(entry.smogon || {})[0] || "";
  const smogon = smogonFormat ? entry.smogon[smogonFormat] : null;
  return {
    source: smogon ? `Smogon ${smogonFormat}` : "Pokemon Showdown",
    showdown: entry.showdown
      ? {
          types: entry.showdown.types,
          baseStats: entry.showdown.baseStats,
          tier: entry.showdown.tier,
          abilities: entry.showdown.abilities,
        }
      : null,
    usage: smogon
      ? {
          format: smogonFormat,
          usage: smogon.usage,
          items: smogon.items?.slice(0, 5),
          abilities: smogon.abilities?.slice(0, 4),
          moves: smogon.moves?.slice(0, 8),
          teammates: smogon.teammates?.slice(0, 6),
          teraTypes: smogon.teraTypes?.slice(0, 5),
          spreads: smogon.spreads?.slice(0, 4),
          counters: smogon.counters?.slice(0, 5),
        }
      : null,
  };
}

function knowledgeEntryFor(mon) {
  const cache = state.battleKnowledgeData;
  if (!cache?.pokemon || !mon) return null;
  const keys = [mon.slug, mon.name, mon.id].map(idKey).filter(Boolean);
  const direct = keys.map((key) => cache.pokemon[key]).find(Boolean);
  if (direct) return direct;
  const numericId = Number(mon.id);
  if (Number.isFinite(numericId)) {
    return Object.values(cache.pokemon).find((entry) => Number(entry?.showdown?.num) === numericId) || null;
  }
  return null;
}

function englishTypesFor(mon) {
  const fromKnowledge = knowledgeEntryFor(mon)?.showdown?.types;
  if (fromKnowledge?.length) return fromKnowledge;
  return (mon.types || []).map((type) => TYPE_CN_TO_EN[type] || type).filter(Boolean);
}

function typeEffectiveness(attackType, defenderTypes = []) {
  return defenderTypes.reduce((value, defenderType) => value * (TYPE_EFFECTIVENESS[attackType]?.[defenderType] ?? 1), 1);
}

function hasOffensiveAnswer(threatTypes = []) {
  return state.team.some((mon) => englishTypesFor(mon).some((type) => typeEffectiveness(type, threatTypes) > 1));
}

function hasDefensiveSwitch(threatTypes = []) {
  return state.team.some((mon) => {
    const ownTypes = englishTypesFor(mon);
    if (!ownTypes.length) return false;
    return threatTypes.some((type) => typeEffectiveness(type, ownTypes) < 1);
  });
}

function showdownNamesForTeam() {
  return new Set(
    state.team
      .map((mon) => knowledgeEntryFor(mon)?.showdown?.name || showdownSpeciesName(mon) || mon.name)
      .map((name) => idKey(name)),
  );
}

function smogonFormatForCurrentMode() {
  if (state.format === "double") return state.battleKnowledgeData?.formats?.find((item) => item === "gen9doublesou") || state.battleKnowledgeData?.formats?.find((item) => item.includes("vgc")) || "gen9doublesou";
  return state.battleKnowledgeData?.formats?.find((item) => item === "gen9ou") || state.battleKnowledgeData?.formats?.[0] || "gen9ou";
}

function getMatchupReport(limit = 10) {
  const cache = state.battleKnowledgeData;
  if (!cache?.pokemon || !state.team.length) return { score: 0, threats: [], summary: "缺少队伍或环境知识数据。" };
  const format = smogonFormatForCurrentMode();
  const ownIds = new Set(state.team.flatMap((mon) => [idKey(mon.slug), idKey(mon.name), idKey(knowledgeEntryFor(mon)?.showdown?.name || "")].filter(Boolean)));
  const ownNames = showdownNamesForTeam();
  const threats = Object.entries(cache.pokemon)
    .map(([id, entry]) => ({ id, entry, usage: entry.smogon?.[format]?.usage || 0 }))
    .filter((item) => item.usage > 0 && !ownIds.has(item.id))
    .sort((a, b) => b.usage - a.usage)
    .slice(0, 40)
    .map(({ entry, usage }) => {
      const smogon = entry.smogon[format];
      const types = entry.showdown?.types || [];
      const defensiveSwitch = hasDefensiveSwitch(types);
      const offensiveAnswer = hasOffensiveAnswer(types);
      const counterHit = (smogon.counters || []).some((counter) => ownNames.has(idKey(counter.name)));
      let risk = 44 + Math.min(20, usage * 80);
      if (!defensiveSwitch) risk += 18;
      if (!offensiveAnswer) risk += 14;
      if (counterHit) risk -= 24;
      risk = Math.max(8, Math.min(96, Math.round(risk)));
      const reasons = [];
      if (!defensiveSwitch) reasons.push("缺少稳定换入");
      if (!offensiveAnswer) reasons.push("缺少属性压制");
      if (counterHit) reasons.push("队内有统计克制点");
      if (!reasons.length) reasons.push("属性应对基本完整");
      return {
        name: entry.showdown?.name || smogon.name,
        usage,
        types,
        risk,
        level: risk >= 72 ? "高" : risk >= 48 ? "中" : "低",
        reasons,
        commonMoves: smogon.moves?.slice(0, 4) || [],
        commonItems: smogon.items?.slice(0, 3) || [],
      };
    })
    .sort((a, b) => b.risk - a.risk || b.usage - a.usage);
  const visible = threats.slice(0, limit);
  const avgRisk = threats.slice(0, 20).reduce((sum, item) => sum + item.risk, 0) / Math.max(1, Math.min(20, threats.length));
  const score = Math.max(0, Math.min(100, Math.round(100 - avgRisk)));
  return {
    format,
    score,
    threats: visible,
    summary: visible.length ? `基于 ${format} 前 ${Math.min(40, threats.length)} 个环境威胁估算，分数 ${score}/100。` : "没有可用环境威胁数据。",
  };
}

function importedConfigFor(mon) {
  return (
    state.importedTeam?.configurations?.find((config) => {
      const alias = TEAM_FORM_ALIASES.get(Number(config.id));
      return alias ? alias.slug === mon.slug : Number(config.id) === Number(mon.id);
    }) || null
  );
}

function configKey(mon) {
  return String(mon?.slug || mon?.id || mon?.name || "").toLowerCase();
}

function defaultConfigFor(mon) {
  const imported = importedConfigFor(mon);
  return {
    item: imported?.item || names(mon.items, 1) || "",
    ability: imported?.ability || names(mon.abilities, 1) || "",
    nature: imported?.nature || names(mon.natures, 1) || "",
    evs: imported?.evs || "",
    ivs: "",
    teraType: "",
    level: "50",
    gender: "",
    shiny: false,
    ball: "",
    language: "",
    moves: imported?.moves?.slice(0, 4) || mon.moves?.slice(0, 4).map((move) => move.name).filter(Boolean) || [],
  };
}

function editableConfigFor(mon) {
  const base = defaultConfigFor(mon);
  const override = state.teamConfigs[configKey(mon)] || {};
  return {
    ...base,
    ...override,
    moves: Array.isArray(override.moves) ? override.moves : base.moves,
  };
}

function setEditableConfig(mon, config) {
  const key = configKey(mon);
  if (!key) return;
  state.teamConfigs[key] = {
    item: config.item || "",
    ability: config.ability || "",
    nature: config.nature || "",
    evs: config.evs || "",
    ivs: config.ivs || "",
    teraType: config.teraType || "",
    level: config.level || "50",
    gender: config.gender || "",
    shiny: Boolean(config.shiny),
    ball: config.ball || "",
    language: config.language || "",
    moves: (config.moves || []).map((move) => move.trim()).filter(Boolean).slice(0, 4),
  };
}

function parseStatTotal(line = "") {
  return String(line)
    .split("/")
    .map((part) => Number(part.trim().match(/^(\d+)/)?.[1] || 0))
    .reduce((sum, value) => sum + value, 0);
}

function parseStatParts(line = "") {
  return String(line)
    .split("/")
    .map((part) => {
      const match = part.trim().match(/^(\d+)\s+(.+)$/);
      return match ? { value: Number(match[1]), stat: match[2].trim() } : null;
    })
    .filter(Boolean);
}

function normalizedItemName(value = "") {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function isMegaStone(item = "") {
  return /mega|进化石|超进化石|mega stone/i.test(String(item));
}

function showdownSpeciesName(mon) {
  if (!mon?.slug) return mon?.name || "";
  return mon.slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

function showdownTeamText() {
  return state.team
    .map((mon) => {
      const config = editableConfigFor(mon);
      const species = showdownSpeciesName(mon);
      const gender = config.gender ? ` (${config.gender})` : "";
      const lines = [`${species || mon.name}${gender}${config.item ? ` @ ${config.item}` : ""}`];
      if (config.ability) lines.push(`Ability: ${config.ability}`);
      if (config.level) lines.push(`Level: ${config.level}`);
      if (config.shiny) lines.push("Shiny: Yes");
      if (config.teraType) lines.push(`Tera Type: ${config.teraType}`);
      if (config.evs) lines.push(`EVs: ${config.evs}`);
      if (config.ivs) lines.push(`IVs: ${config.ivs}`);
      if (config.nature) lines.push(`${config.nature} Nature`);
      if (config.ball) lines.push(`Ball: ${config.ball}`);
      if (config.language) lines.push(`Language: ${config.language}`);
      for (const move of config.moves || []) {
        if (move) lines.push(`- ${move}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function battleKnowledge() {
  return buildBattleKnowledge(state.team, {
    format: state.format,
    getConfig: editableConfigFor,
    stat,
    effectiveSpeed,
    hasMove,
    hasAbility,
  });
}

function packedTeamText() {
  return packTeam(state.team, editableConfigFor, showdownSpeciesName);
}

function renderShowdownExport() {
  const output = $("#showdown-export");
  if (!output) return;
  output.value = showdownTeamText();
  renderValidationHints();
}

function validationHints() {
  const hints = [];
  if (!state.team.length) return ["先选择宝可梦后再导出。"];
  if (state.team.length < 6) hints.push(`队伍未满 6 只：当前 ${state.team.length}/6。`);
  const itemCounts = new Map();
  const speciesCounts = new Map();
  const megaUsers = [];
  for (const mon of state.team) {
    const item = editableConfigFor(mon).item;
    const key = normalizedItemName(item);
    const speciesKey = String(mon.id || mon.slug || mon.name).toLowerCase();
    if (speciesKey) speciesCounts.set(speciesKey, [...(speciesCounts.get(speciesKey) || []), mon.name || mon.slug]);
    if (key && !state.rulePrefs.allowDuplicateItems) itemCounts.set(key, [...(itemCounts.get(key) || []), mon.name || mon.slug]);
    if (isMegaStone(item)) megaUsers.push(mon.name || mon.slug);
  }
  for (const mons of speciesCounts.values()) {
    if (mons.length > 1) hints.push(`重复宝可梦：同一队伍中出现了 ${mons.join("、")}。`);
  }
  for (const [item, mons] of itemCounts.entries()) {
    if (mons.length > 1) hints.push(`重复道具：${mons.join("、")} 都携带 ${item}。`);
  }
  if (megaUsers.length > 1) hints.push(`Mega 进化限制：同队只允许 1 个 Mega，当前 ${megaUsers.join("、")} 都携带 Mega 石。`);
  for (const mon of state.team) {
    const config = editableConfigFor(mon);
    const name = mon.name || mon.slug;
    const championMon = state.data?.pokemon?.find((item) => Number(item.id) === Number(mon.id) || item.slug === mon.slug || item.name === mon.name);
    if (!championMon && !mon.isExternalMember) hints.push(`Champions 当前${formatLabel(state.format)}数据中未找到 ${name}。`);
    if (!config.item) hints.push(`${name} 缺少道具。`);
    else if (championMon?.items?.length && !championMon.items.some((item) => item.name === config.item || item.rawName === config.item)) hints.push(`提示：${name} 的道具 ${config.item} 不在 Champions 当前缓存常见道具中。`);
    if (!config.ability) hints.push(`${name} 缺少特性。`);
    else if (championMon?.abilities?.length && !championMon.abilities.some((item) => item.name === config.ability || item.rawName === config.ability)) hints.push(`提示：${name} 的特性 ${config.ability} 不在 Champions 当前缓存常见特性中。`);
    if (!config.nature) hints.push(`${name} 缺少性格。`);
    if (!config.teraType && !state.rulePrefs.ignoreTera) hints.push(`提示：${name} 未填写太晶属性；如目标规则不使用太晶可忽略。`);
    if (!config.level) hints.push(`${name} 缺少等级。`);
    else if (Number(config.level) < 1 || Number(config.level) > 100) hints.push(`${name} 等级 ${config.level} 超出 1-100 范围。`);
    if ((config.moves || []).length < 4) hints.push(`${name} 招式少于 4 个。`);
    for (const move of config.moves || []) {
      if (move && championMon?.moves?.length && !championMon.moves.some((item) => item.name === move || item.rawName === move)) hints.push(`提示：${name} 的招式 ${move} 不在 Champions 当前缓存常见招式中。`);
    }
    const evTotal = parseStatTotal(config.evs);
    if (evTotal > 510) hints.push(`${name} EV 总和 ${evTotal} 超过 510。`);
    for (const ev of parseStatParts(config.evs)) {
      if (ev.value > 252) hints.push(`${name} ${ev.stat} EV ${ev.value} 超过单项 252。`);
    }
    const ivTotal = parseStatTotal(config.ivs);
    if (config.ivs && ivTotal > 186) hints.push(`${name} IV 总和看起来异常，请检查。`);
    for (const iv of parseStatParts(config.ivs)) {
      if (iv.value > 31) hints.push(`${name} ${iv.stat} IV ${iv.value} 超过单项 31。`);
    }
  }
  if (!hints.length) hints.push("Champions 基础校验通过；仍建议用 PKHeX 或目标平台做最终确认。");
  return hints;
}

function renderValidationHints() {
  const target = $("#export-hints");
  if (!target) return;
  const hints = [...validationHints()];
  const championsOk = hints.length === 1 && hints[0].startsWith("Champions 基础校验通过");
  let referenceFailed = false;
  if (state.showdownValidation?.loading) {
    hints.push("提示：正在调用 Pokemon Showdown 参考校验器。");
  } else if (state.showdownValidation) {
    const result = state.showdownValidation;
    if (result.ok) {
      hints.push(`Showdown 参考校验通过：${result.format}，已解析 ${result.teamSize} 只。`);
    } else {
      referenceFailed = true;
      hints.push(`Showdown 参考校验未通过：${result.format}，${result.problems?.length || 0} 个问题。`);
      for (const problem of (result.problems || []).slice(0, 8)) hints.push(problem);
    }
  }
  target.innerHTML = hints.map((hint) => `<span class="${hint.startsWith("提示：") ? "is-note" : ""}">${escapeHtml(hint)}</span>`).join("");
  target.classList.toggle("is-ok", championsOk && !referenceFailed);
}

async function validateShowdownText() {
  const text = showdownTeamText();
  if (!text) return;
  state.showdownValidation = { loading: true };
  renderValidationHints();
  try {
    const res = await fetch("/api/validate-team", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, format: state.format }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `校验服务错误：${res.status}`);
    state.showdownValidation = data;
  } catch (err) {
    state.showdownValidation = {
      ok: false,
      format: state.format,
      teamSize: state.team.length,
      problems: [`Showdown 参考校验调用失败：${err.message}`],
    };
  }
  renderValidationHints();
}

async function copyShowdownText() {
  const text = showdownTeamText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const output = $("#showdown-export");
    output?.select();
    document.execCommand("copy");
  }
}

async function copyPackedText() {
  const text = packedTeamText();
  if (!text) return;
  await navigator.clipboard?.writeText(text);
}

function downloadShowdownText() {
  const text = showdownTeamText();
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pokemon-${state.format}-team.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadJsonDraft() {
  const blob = new Blob([JSON.stringify(draftPayload(), null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pokemon-${state.format}-team.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importJsonDraft(file) {
  if (!file) return;
  const draft = JSON.parse(await file.text());
  const format = draft.format || state.format;
  if (!state.rawData.formats?.[format]) return;
  state.format = format;
  state.data = state.rawData.formats[format];
  state.team = (draft.team || [])
    .map((item) => state.data.pokemon.find((mon) => mon.slug === item.slug || Number(mon.id) === Number(item.id)))
    .filter(Boolean)
    .slice(0, 6);
  state.teamConfigs = draft.teamConfigs || {};
  state.importedTeam = null;
  updateFormatButtons();
  updateMetaLabel();
  updateEditorOptions();
  renderTeamLibrary();
  render();
  saveDraft();
}

async function loadLocalData() {
  const res = await fetch(`data/champion-data.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("缺少 data/champion-data.json，正在等待启动抓取完成。");
  state.rawData = await res.json();
  try {
    const teamsRes = await fetch(`data/team-data.json?t=${Date.now()}`, { cache: "no-store" });
    if (teamsRes.ok) {
      const teamData = await teamsRes.json();
      state.teamLibrary = teamData.teams || [];
      state.selectedTeamId = state.teamLibrary[0]?.id || "";
    }
  } catch {
    state.teamLibrary = [];
  }
  try {
    const knowledgeRes = await fetch(`data/battle-knowledge.json?t=${Date.now()}`, { cache: "no-store" });
    if (knowledgeRes.ok) state.battleKnowledgeData = await knowledgeRes.json();
  } catch {
    state.battleKnowledgeData = null;
  }
  state.rawData.formats = state.rawData.formats || { [state.rawData.defaultFormat || state.rawData.format || "single"]: state.rawData };
}

async function refreshData() {
  const button = $("#refresh-data");
  const progress = $("#refresh-progress");
  const progressBar = $("#refresh-progress-bar");
  const progressText = $("#refresh-progress-text");
  if (!button) return;
  button.disabled = true;
  button.textContent = "补缺中...";
  if (progress) progress.hidden = false;
  if (progressBar) progressBar.style.setProperty("--refresh-progress", "10%");
  if (progressText) progressText.textContent = "启动中";
  await fetch("/api/refresh-data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "missing-all" }),
  });
  let status = null;
  for (let i = 0; i < 240; i += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    status = await fetch("/api/refresh-data", { cache: "no-store" }).then((res) => res.json());
    const percent = status.running ? Math.min(92, 12 + status.fetched * 8 + status.teamsFetched * 0.2) : status.exitCode === 0 ? 100 : 100;
    if (progressBar) progressBar.style.setProperty("--refresh-progress", `${percent}%`);
    if (progressText) {
      progressText.textContent = status.running
        ? status.stage === "teams"
          ? status.teamsFetched
            ? `热门队伍 ${status.teamsFetched}`
            : "更新热门队伍"
          : status.fetched
            ? `已补 ${status.fetched}`
            : "检查缓存"
        : status.exitCode === 0
          ? `完成 ${status.fetched}`
          : "失败";
    }
    renderDataHealth(status);
    if (!status.running) break;
  }
  if (status?.exitCode === 0) {
    saveDraft();
    await loadLocalData();
    restoreDraft(state.format);
    updateFormatButtons();
    updateMetaLabel();
    updateEditorOptions();
    renderDecorPokemon();
    renderTeamLibrary();
    render();
    renderDataHealth(status);
    button.textContent = "已更新";
    window.setTimeout(() => {
      button.textContent = "补缺数据";
      button.disabled = false;
      if (progress) progress.hidden = true;
    }, 1200);
  } else {
    button.textContent = status?.reason || "补缺失败";
    button.disabled = false;
    if (progressBar) progressBar.style.setProperty("--refresh-progress", "100%");
    renderDataHealth(status);
  }
}

async function waitForInitialData() {
  document.body.innerHTML = `
    <main class="startup-screen">
      <section class="startup-card">
        <h1>PokéForge Lab 正在准备数据</h1>
        <p id="startup-text">首次启动会自动补齐环境数据和热门队伍。</p>
        <div class="startup-progress"><span id="startup-bar"></span></div>
        <pre id="startup-error" hidden></pre>
      </section>
    </main>`;
  const bar = document.querySelector("#startup-bar");
  const text = document.querySelector("#startup-text");
  const error = document.querySelector("#startup-error");
  await fetch("/api/refresh-data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "missing-all" }),
  }).catch(() => {});
  for (let i = 0; i < 300; i += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    const status = await fetch("/api/refresh-data", { cache: "no-store" }).then((res) => res.json()).catch(() => null);
    if (!status) continue;
    const percent = status.running ? Math.min(92, 12 + status.fetched * 8 + status.teamsFetched * 0.2) : status.exitCode === 0 ? 100 : 100;
    if (bar) bar.style.width = `${percent}%`;
    if (text) text.textContent = status.stage === "teams" ? `正在更新热门队伍：${status.teamsFetched || 0}` : `正在补齐环境数据：${status.fetched || 0}`;
    if (!status.running) {
      if (status.exitCode === 0) window.location.reload();
      else {
        if (text) text.textContent = "自动抓取失败";
        if (error) {
          error.hidden = false;
          error.textContent = status.reason || status.error || "请检查网络和数据源。";
        }
      }
      return;
    }
  }
}

function draftPayload() {
  return {
    format: state.format,
    team: state.team.map((mon) => ({ id: mon.id, slug: mon.slug, name: mon.name })),
    teamConfigs: state.teamConfigs,
    savedAt: new Date().toISOString(),
  };
}

function saveDraft() {
  if (!state.data) return;
  const allDrafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
  allDrafts[state.format] = draftPayload();
  allDrafts.lastFormat = state.format;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(allDrafts));
}

function restoreDraft(format = null) {
  try {
    const allDrafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    const targetFormat = format || allDrafts.lastFormat || state.format;
    const draft = allDrafts[targetFormat];
    if (!draft?.team?.length || !state.rawData.formats?.[draft.format]) return false;
    state.format = draft.format;
    state.data = state.rawData.formats[draft.format];
    state.team = draft.team
      .map((item) => state.data.pokemon.find((mon) => mon.slug === item.slug || Number(mon.id) === Number(item.id)))
      .filter(Boolean)
      .slice(0, 6);
    state.teamConfigs = draft.teamConfigs || {};
    return state.team.length > 0;
  } catch {
    return false;
  }
}

function clearDraft() {
  const allDrafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
  delete allDrafts[state.format];
  localStorage.setItem(DRAFT_KEY, JSON.stringify(allDrafts));
}

function pokemonForTeamMember(member, options = {}) {
  if (!member || !state.data?.pokemon) return null;
  const allowFallback = options.allowFallback !== false;
  const alias = TEAM_FORM_ALIASES.get(Number(member.id));
  if (alias?.slug) {
    const bySlug = state.data.pokemon.find((mon) => mon.slug === alias.slug);
    if (bySlug) return bySlug;
  }
  const targetId = Number(alias?.id || member.id);
  return state.data.pokemon.find((mon) => Number(mon.id) === targetId) || (allowFallback ? fallbackPokemonForTeamMember(member) : null);
}

function addPokemonToTeam(mon, options = {}) {
  if (!mon) return false;
  const existing = state.team.find((item) => item.slug === mon.slug || item.id === mon.id);
  if (existing) return false;
  if (state.team.length < 6) {
    state.team.push(mon);
  } else if (options.replaceLast) {
    const replaced = state.team[state.team.length - 1];
    if (replaced) delete state.teamConfigs[configKey(replaced)];
    state.team[state.team.length - 1] = mon;
  } else {
    return false;
  }
  state.importedTeam = null;
  render();
  saveDraft();
  return true;
}

function fallbackPokemonForTeamMember(member) {
  const id = Number(member.id);
  return {
    id: Number.isFinite(id) ? id : String(member.id || member.name),
    name: member.name || `外部成员 ${member.id || ""}`.trim(),
    slug: `external-${member.id || member.name}`,
    rank: 9999,
    sprite: member.sprite || "",
    types: [],
    stats: {},
    moves: [],
    items: [],
    abilities: [],
    natures: [],
    isExternalMember: true,
  };
}

function aiContext(mode) {
  const selectedIds = new Set(state.team.map((mon) => mon.id));
  const knowledge = battleKnowledge();
  return {
    mode,
    promptMode: $("#ai-prompt-mode")?.value || "quick",
    format: state.format,
    formatLabel: formatLabel(state.format),
    sourcePriority: [
      "Pokemon Champions 当前格式数据为主规则和主可用池",
      "Showdown 只做参考校验和英文规则参考",
      "Smogon 只做环境趋势和 matchup 参考",
    ],
    userGoal: $("#ai-user-goal")?.value?.trim() || "",
    battleKnowledge: {
      sourceModel: knowledge.sourceModel,
      score: knowledge.score,
      risks: knowledge.risks,
      strengths: knowledge.strengths,
      needs: knowledge.needs,
      roleCoverage: knowledge.roleCoverage,
      typeProfile: knowledge.typeProfile,
      legality: knowledge.legality,
      formatChecklist: knowledge.formatChecklist,
      stateTags: knowledge.stateTags,
      members: knowledge.members.map((item) => ({
        name: item.name,
        types: item.types,
        roles: item.roles,
        item: item.item,
        ability: item.ability,
        moves: item.moves,
        speed: item.speed,
        matchup: item.matchup,
        flags: item.flags,
      })),
    },
    packedTeam: packedTeamText(),
    selectedPokemon: state.team.map(pokemonSummary),
    importedTeam: state.importedTeam
      ? {
          title: state.importedTeam.title,
          rate: state.importedTeam.rate,
          articleUrl: state.importedTeam.articleUrl,
          configurations: state.importedTeam.configurations,
        }
      : null,
    speedThreats: getSpeedThreats().slice(0, 8).map(({ mon, level, note }) => ({
      name: mon.name,
      rank: mon.rank,
      level,
      speed: stat(mon, "速度"),
      effectiveSpeed: effectiveSpeed(mon),
      note,
    })),
    opponentConfigs: getOpponentConfigs().slice(0, 8),
    matchupReport: getMatchupReport(12),
    metaCandidates: state.data.pokemon
      .filter((mon) => !selectedIds.has(mon.id))
      .slice(0, 40)
      .map((mon) => ({
        id: mon.id,
        name: mon.name,
        slug: mon.slug,
        rank: mon.rank,
        types: mon.types,
        stats: mon.stats,
        effectiveSpeed: effectiveSpeed(mon),
        commonMoves: mon.moves?.slice(0, 5),
        commonItems: mon.items?.slice(0, 3),
        commonAbilities: mon.abilities?.slice(0, 3),
        roles: getRoles(mon),
        externalKnowledge: externalKnowledgeFor(mon),
      })),
  };
}

function loadAIConfig() {
  try {
    return JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || "{}");
  } catch {
    return {};
  }
}

function loadAIModelCache() {
  try {
    return JSON.parse(localStorage.getItem(AI_MODELS_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveAIModelCache(provider, models = []) {
  const cache = loadAIModelCache();
  cache[provider] = [...new Set(models.filter(Boolean))].slice(0, 200);
  localStorage.setItem(AI_MODELS_CACHE_KEY, JSON.stringify(cache));
}

function getAIConfigFromForm() {
  const selectedModel = $("#ai-model-select")?.value || "";
  const customModel = $("#ai-model")?.value?.trim() || "";
  return {
    provider: $("#ai-provider")?.value || "openai",
    endpoint: $("#ai-endpoint")?.value || "responses",
    baseUrl: $("#ai-base-url")?.value?.trim() || "",
    model: selectedModel === "__custom" ? customModel : selectedModel || customModel,
    apiKey: $("#ai-api-key")?.value?.trim() || "",
  };
}

function hasUsableAIConfig(config = loadAIConfig()) {
  return Boolean(config.apiKey && config.baseUrl && config.model);
}

function updateAIConfigStatus() {
  const status = $("#ai-config-status");
  if (!status) return;
  const config = getAIConfigFromForm();
  status.textContent = hasUsableAIConfig(config)
    ? `将使用 ${config.provider} / ${config.model}，配置只保存在当前浏览器。`
    : "未填写时会自动尝试环境变量或 Cockpit 本地访问。";
}

function applyAIProviderPreset(force = false) {
  const provider = $("#ai-provider")?.value || "openai";
  const preset = AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.custom;
  const baseUrl = $("#ai-base-url");
  const endpoint = $("#ai-endpoint");
  if (baseUrl && (force || !baseUrl.value)) baseUrl.value = preset.baseUrl;
  if (endpoint && (force || !endpoint.value)) endpoint.value = preset.endpoint;
  hydrateModelSelect(force ? preset.model : getAIConfigFromForm().model || preset.model);
  updateAIConfigStatus();
}

function hydrateModelSelect(modelValue = "") {
  const provider = $("#ai-provider")?.value || "openai";
  const preset = AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.custom;
  const select = $("#ai-model-select");
  const customInput = $("#ai-model");
  const customField = $("#ai-custom-model-field");
  if (!select || !customInput || !customField) return;
  const cachedModels = loadAIModelCache()[provider] || [];
  const models = [...new Set([...(preset.models || []), ...cachedModels])];
  const model = modelValue || preset.model || "";
  select.innerHTML = [
    ...models.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`),
    `<option value="__custom">自定义模型...</option>`,
  ].join("");
  if (model && models.includes(model)) {
    select.value = model;
    customInput.value = "";
    customField.hidden = true;
  } else {
    select.value = "__custom";
    customInput.value = model;
    customField.hidden = false;
  }
}

function updateModelInputVisibility() {
  const customField = $("#ai-custom-model-field");
  const customInput = $("#ai-model");
  const selected = $("#ai-model-select")?.value || "";
  if (!customField || !customInput) return;
  customField.hidden = selected !== "__custom";
  if (selected !== "__custom") customInput.value = "";
  updateAIConfigStatus();
}

async function refreshAIModels() {
  const status = $("#ai-config-status");
  const button = $("#ai-refresh-models");
  const config = getAIConfigFromForm();
  if (!config.apiKey || !config.baseUrl) {
    if (status) status.textContent = "请先填写 API Key 和 Base URL，再获取模型列表。";
    return;
  }
  if (button) button.disabled = true;
  if (status) status.textContent = "正在从服务商获取模型列表...";
  try {
    const res = await fetch("/api/ai-models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiConfig: config }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `获取失败：${res.status}`);
    if (data.unsupported) {
      if (status) status.textContent = data.message || "当前服务商不开放模型列表接口，请使用预设模型或自定义模型。";
      return;
    }
    saveAIModelCache(config.provider, data.models || []);
    hydrateModelSelect(config.model || data.models?.[0] || "");
    if (status) status.textContent = `已获取 ${data.models?.length || 0} 个模型，可在下拉框选择。`;
  } catch (err) {
    if (status) status.textContent = `${err.message || "获取模型列表失败"}；可以继续使用自定义模型。`;
  } finally {
    if (button) button.disabled = false;
  }
}

function hydrateAIConfigForm() {
  const saved = loadAIConfig();
  const provider = $("#ai-provider");
  const endpoint = $("#ai-endpoint");
  const baseUrl = $("#ai-base-url");
  const apiKey = $("#ai-api-key");
  if (provider) provider.value = saved.provider || "openai";
  if (endpoint) endpoint.value = saved.endpoint || AI_PROVIDER_PRESETS[provider?.value || "openai"]?.endpoint || "responses";
  if (baseUrl) baseUrl.value = saved.baseUrl || AI_PROVIDER_PRESETS[provider?.value || "openai"]?.baseUrl || "";
  hydrateModelSelect(saved.model || AI_PROVIDER_PRESETS[provider?.value || "openai"]?.model || "");
  if (apiKey) apiKey.value = saved.apiKey || "";
  updateAIConfigStatus();
}

function saveAIConfig() {
  const config = getAIConfigFromForm();
  if (hasUsableAIConfig(config)) {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
    updateAIConfigStatus();
    return;
  }
  localStorage.removeItem(AI_CONFIG_KEY);
  updateAIConfigStatus();
}

function clearAIConfig() {
  localStorage.removeItem(AI_CONFIG_KEY);
  const apiKey = $("#ai-api-key");
  if (apiKey) apiKey.value = "";
  applyAIProviderPreset(true);
  updateAIConfigStatus();
}

function loadRulePrefs() {
  try {
    state.rulePrefs = { ...state.rulePrefs, ...JSON.parse(localStorage.getItem(RULE_PREFS_KEY) || "{}") };
  } catch {
    state.rulePrefs = { allowDuplicateItems: false, ignoreTera: false };
  }
}

function hydrateRulePrefs() {
  const duplicate = $("#rule-allow-duplicate-items");
  const tera = $("#rule-ignore-tera");
  if (duplicate) duplicate.checked = Boolean(state.rulePrefs.allowDuplicateItems);
  if (tera) tera.checked = Boolean(state.rulePrefs.ignoreTera);
}

function saveRulePrefs() {
  state.rulePrefs = {
    allowDuplicateItems: Boolean($("#rule-allow-duplicate-items")?.checked),
    ignoreTera: Boolean($("#rule-ignore-tera")?.checked),
  };
  localStorage.setItem(RULE_PREFS_KEY, JSON.stringify(state.rulePrefs));
  renderValidationHints();
}

async function testAIConfig() {
  const status = $("#ai-config-status");
  const button = $("#ai-test-config");
  saveAIConfig();
  const aiConfig = loadAIConfig();
  if (!hasUsableAIConfig(aiConfig)) {
    if (status) status.textContent = "请先填写 API Key、Base URL 和模型。";
    return;
  }
  if (button) button.disabled = true;
  if (status) status.textContent = "正在测试连接...";
  try {
    const res = await fetch("/api/ai-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiConfig }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `测试失败：${res.status}`);
    if (status) status.textContent = `连接成功：${data.provider} / ${data.model}`;
  } catch (err) {
    if (status) status.textContent = err.message || "连接失败，请检查配置。";
  } finally {
    if (button) button.disabled = false;
  }
}

function renderDataHealth(status = null) {
  const target = $("#data-health-grid");
  if (!target) return;
  const pokemonCount = state.data?.pokemon?.length || 0;
  const teamCount = currentLibraryTeams().length || 0;
  const dataMeta = state.rawData?.updatedAt || state.rawData?.generatedAt || "未知";
  const statusLabel = status?.running ? "抓取中" : status?.exitCode === 0 ? "最近成功" : status?.exitCode ? "最近失败" : "待命";
  target.innerHTML = `
    <div class="data-health-card"><strong>${pokemonCount}</strong><span>当前环境宝可梦</span><small>${escapeHtml(formatLabel(state.format))}</small></div>
    <div class="data-health-card"><strong>${teamCount}</strong><span>可导入热门队伍</span><small>${teamCount ? "已缓存" : "暂无缓存"}</small></div>
    <div class="data-health-card"><strong>${escapeHtml(statusLabel)}</strong><span>抓取任务</span><small>${escapeHtml(status?.reason || status?.stage || "无错误")}</small></div>
    <div class="data-health-card"><strong>${escapeHtml(String(dataMeta).slice(0, 16))}</strong><span>数据更新时间</span><small>本地 JSON 缓存</small></div>`;
  const log = $("#refresh-log");
  if (log && status) {
    const text = [status.reason, status.error, status.output].filter(Boolean).join("\n\n").trim();
    log.hidden = !text;
    log.textContent = text.slice(-1800);
  }
}

async function refreshDataHealth() {
  const status = await fetch("/api/refresh-data", { cache: "no-store" }).then((res) => res.json()).catch(() => null);
  renderDataHealth(status);
}

function normalizeAdvice(data) {
  const normalize = (advice) => normalizeAdviceDefaults(advice);
  if (data?.advice) {
    const advice = data.advice;
    if (Array.isArray(advice.team)) {
      return normalize({
        ...advice,
        single: { team: advice.team, ...(advice.single || {}) },
        double: { team: advice.team, ...(advice.double || {}) },
      });
    }
    return normalize(advice);
  }
  if (!data?.text) return null;
  const text = data.text.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const advice = JSON.parse(candidate.slice(start, end + 1));
    if (Array.isArray(advice.team)) {
      return normalize({
        ...advice,
        single: { team: advice.team, ...(advice.single || {}) },
        double: { team: advice.team, ...(advice.double || {}) },
      });
    }
    return normalize(advice);
  } catch {
    return null;
  }
}

function normalizeAdviceDefaults(advice) {
  for (const format of ["single", "double"]) {
    const team = Array.isArray(advice?.[format]?.team) ? advice[format].team : [];
    const used = new Set();
    team.forEach((item, index) => {
      item.level = String(item.level || "50");
      const key = normalizedItemName(item.item);
      if (!key || used.has(key)) {
        const fallback = ["生命宝珠", "气势披带", "讲究围巾", "讲究眼镜", "突击背心", "剩饭"].find((candidate) => !used.has(normalizedItemName(candidate))) || `可替换道具${index + 1}`;
        item.item = fallback;
        used.add(normalizedItemName(fallback));
      } else {
        used.add(key);
      }
    });
  }
  return advice;
}

function renderFormatAdvice(title, format, block = {}) {
  const watch = Array.isArray(block.watch) ? block.watch.filter(Boolean).slice(0, 4) : [];
  const team = Array.isArray(block.team) ? block.team.slice(0, 6) : [];
  const active = (state.aiAdviceView || state.format) === format;
  return `
    <section class="ai-format-card ${active ? "is-active" : ""}" ${active ? "" : "hidden"}>
      <div class="ai-format-head">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(block.plan || "按当前队伍微调配置。")}</p>
        </div>
        <button class="${active ? "btn-primary" : "btn-outline neutral"} compact" type="button" data-ai-apply="${format}">
          应用${escapeHtml(title)}
        </button>
      </div>
      ${watch.length ? `<div class="ai-tags">${watch.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
      <div class="ai-team-grid">${team.map((item, index) => renderAdviceCard(item, index, format)).join("")}</div>
    </section>`;
}

function renderAdviceCard(item = {}, index, format = state.format) {
  const moves = Array.isArray(item.moves) ? item.moves.filter(Boolean).slice(0, 4) : [];
  const meta = [
    item.item ? `道具：${item.item}` : "",
    item.ability ? `特性：${item.ability}` : "",
    item.nature ? `性格：${item.nature}` : "",
    item.evs ? `EV：${item.evs}` : "",
  ].filter(Boolean);
  return `
    <article class="ai-mon-card" data-ai-mon-format="${format}" data-ai-mon-index="${index}">
      <div class="ai-mon-head">
        <span>${index + 1}</span>
        <div>
          <h3>${escapeHtml(item.name || item.id || `Slot ${index + 1}`)}</h3>
          <p>${escapeHtml(item.role || "补位")}</p>
        </div>
      </div>
      ${meta.length ? `<div class="ai-mon-meta">${meta.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
      ${moves.length ? `<div class="ai-moves">${moves.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
      ${item.note ? `<p class="ai-note">${escapeHtml(item.note)}</p>` : ""}
      <div class="ai-card-actions">
        <button class="btn-outline neutral compact" type="button" data-ai-apply-one>只应用这只</button>
        <button class="btn-outline neutral compact" type="button" data-ai-replace-one>替换末位</button>
        <button class="btn-outline neutral compact" type="button" data-ai-copy-one>复制</button>
      </div>
    </article>`;
}

function renderAIAdvice(data) {
  const advice = normalizeAdvice(data);
  state.aiLastAdvice = advice;
  if (!state.aiAdviceView || !advice?.[state.aiAdviceView]) state.aiAdviceView = state.format;
  if (!advice) return `<div class="ai-plain">${escapeHtml(data.text || "AI 没有返回内容。")}</div>`;
  return `
    <div class="ai-result">
      <div class="ai-result-head">
        <p>${escapeHtml(advice.summary || "建议队伍如下。")}</p>
        <div class="ai-result-actions">
          <button class="btn-outline neutral compact" type="button" data-ai-retry>重新生成</button>
        </div>
      </div>
      <div class="ai-view-tabs" role="tablist" aria-label="AI 建议视图">
        <button class="${state.aiAdviceView === "single" ? "is-active" : ""}" type="button" data-ai-view="single">单打方案</button>
        <button class="${state.aiAdviceView === "double" ? "is-active" : ""}" type="button" data-ai-view="double">双打方案</button>
      </div>
      <div class="ai-mode-grid">
        ${renderFormatAdvice("单打", "single", advice.single)}
        ${renderFormatAdvice("双打", "double", advice.double)}
      </div>
    </div>`;
}

function rerenderAIAdvice() {
  const output = $("#ai-output");
  if (!output || !state.aiLastAdvice) return;
  output.innerHTML = renderAIAdvice({ advice: state.aiLastAdvice });
  updateDocumentState();
}

function applyAIAdviceTeam(format = state.format) {
  const formatAdvice = state.aiLastAdvice?.[format] || {};
  const team = Array.isArray(formatAdvice.team) ? formatAdvice.team : [];
  const targetData = state.rawData.formats?.[format] || state.data;
  if (!team.length || !targetData?.pokemon) return;
  const byId = new Map(targetData.pokemon.map((mon) => [String(mon.id).toLowerCase(), mon]));
  const byName = new Map(targetData.pokemon.map((mon) => [String(mon.name).toLowerCase(), mon]));
  const bySlug = new Map(targetData.pokemon.map((mon) => [String(mon.slug).toLowerCase(), mon]));
  const next = [];

  for (const item of team) {
    const keys = [item.id, item.name, item.slug].filter(Boolean).map((value) => String(value).toLowerCase());
    const mon = keys.map((key) => byId.get(key) || byName.get(key) || bySlug.get(key)).find(Boolean);
    if (mon && !next.some((existing) => existing.id === mon.id)) next.push(mon);
    if (next.length === 6) break;
  }

  if (next.length) {
    if (state.rawData.formats?.[format] && state.format !== format) {
      state.format = format;
      state.data = targetData;
      updateFormatButtons();
      updateMetaLabel();
      updateEditorOptions();
      renderTeamLibrary();
    }
    state.team = next;
    state.teamConfigs = {};
    team.forEach((item, index) => {
      if (next[index]) setEditableConfig(next[index], item);
    });
    state.importedTeam = null;
    render();
    saveDraft();
  }
}

function pokemonFromAdvice(item, format = state.format) {
  const targetData = state.rawData.formats?.[format] || state.data;
  const keys = [item?.id, item?.name, item?.slug].filter(Boolean).map((value) => String(value).toLowerCase());
  return targetData?.pokemon?.find((mon) => keys.includes(String(mon.id).toLowerCase()) || keys.includes(String(mon.name).toLowerCase()) || keys.includes(String(mon.slug).toLowerCase())) || null;
}

function adviceItemFromEvent(event) {
  const card = event.target.closest("[data-ai-mon-format]");
  if (!card) return null;
  const format = card.dataset.aiMonFormat || state.format;
  const index = Number(card.dataset.aiMonIndex);
  const item = state.aiLastAdvice?.[format]?.team?.[index];
  return item ? { format, index, item } : null;
}

function applyAdvicePokemon(item, format = state.format, replace = false) {
  const mon = pokemonFromAdvice(item, format);
  if (!mon) return;
  if (state.rawData.formats?.[format] && state.format !== format) {
    state.format = format;
    state.data = state.rawData.formats[format];
    updateFormatButtons();
    updateMetaLabel();
    updateEditorOptions();
  }
  const existingIndex = state.team.findIndex((own) => own.id === mon.id || own.slug === mon.slug);
  if (existingIndex >= 0) {
    state.team[existingIndex] = mon;
  } else if (replace && state.team.length) {
    const replaced = state.team[state.team.length - 1];
    if (replaced) delete state.teamConfigs[configKey(replaced)];
    state.team[state.team.length - 1] = mon;
  } else if (state.team.length < 6) {
    state.team.push(mon);
  }
  setEditableConfig(mon, item);
  state.importedTeam = null;
  render();
  saveDraft();
}

function advicePokemonText(item = {}) {
  const moves = Array.isArray(item.moves) ? item.moves.filter(Boolean) : [];
  return [`${item.name || item.id}${item.item ? ` @ ${item.item}` : ""}`, item.ability ? `Ability: ${item.ability}` : "", `Level: ${item.level || "50"}`, item.evs ? `EVs: ${item.evs}` : "", item.nature ? `${item.nature} Nature` : "", ...moves.map((move) => `- ${move}`)].filter(Boolean).join("\n");
}

async function generateAIAdvice(mode) {
  const output = $("#ai-output");
  if (!output) return;
  if (!state.team.length) {
    output.className = "ai-output is-error";
    output.textContent = "请先至少选择一只宝可梦。";
    return;
  }

  state.aiBusy = true;
  state.aiLastMode = mode;
  output.className = "ai-output is-loading";
  output.textContent = "AI 正在生成简洁配置...";

  try {
    saveAIConfig();
    const aiConfig = loadAIConfig();
    const res = await fetch("/api/team-advice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...aiContext(mode),
        aiConfig: hasUsableAIConfig(aiConfig) ? aiConfig : null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `AI 服务错误：${res.status}`);
    output.className = "ai-output has-structured-result";
    state.aiAdviceView = state.format;
    output.innerHTML = renderAIAdvice(data);
    updateDocumentState();
  } catch (err) {
    output.className = "ai-output is-error";
    output.textContent = `${err.message}\n\n可以在上方“API 设置”里填写 OpenAI 兼容接口，也可以设置 OPENAI_API_KEY，或启用 Cockpit 本地访问。`;
  } finally {
    state.aiBusy = false;
  }
}

function setFormat(format) {
  const nextData = state.rawData.formats?.[format];
  if (!nextData) return;
  saveDraft();
  state.format = format;
  state.data = nextData;
  state.team = [];
  state.teamConfigs = {};
  state.importedTeam = null;
  state.activeEditIndex = null;
  state.query = "";
  closePalette(false);
  const search = $("#search");
  if (search) search.value = "";
  updateFormatButtons();
  updateMetaLabel();
  updateEditorOptions();
  restoreDraft(format);
  renderDecorPokemon();
  renderTeamLibrary();
  render();
}

function updateFormatButtons() {
  document.querySelectorAll("[data-format]").forEach((button) => {
    const available = Boolean(state.rawData.formats?.[button.dataset.format]);
    button.hidden = !available;
    button.classList.toggle("active", button.dataset.format === state.format);
    button.textContent = formatLabel(button.dataset.format);
  });
}

function updateMetaLabel() {
  if (!state.data) return;
  $("#data-meta").textContent = `${state.data.season} · ${formatLabel(state.format)} · ${state.data.pokemon.length} 只 · ${state.data.updatedAt || "已缓存"}`;
}

function fillDatalist(id, values) {
  const list = $(id);
  if (!list) return;
  list.innerHTML = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hans")).slice(0, 240).map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
}

function updateEditorOptions() {
  if (!state.data?.pokemon) return;
  fillDatalist("#move-options", state.data.pokemon.flatMap((mon) => mon.moves || []).map((item) => item.name));
  fillDatalist("#item-options", state.data.pokemon.flatMap((mon) => mon.items || []).map((item) => item.name));
  fillDatalist("#ability-options", state.data.pokemon.flatMap((mon) => mon.abilities || []).map((item) => item.name));
  fillDatalist("#nature-options", state.data.pokemon.flatMap((mon) => mon.natures || []).map((item) => item.name));
  fillDatalist("#type-options", TYPES);
  fillDatalist("#ball-options", ["精灵球", "高级球", "超级球", "大师球", "纪念球", "豪华球", "先机球", "计时球", "重复球", "巢穴球", "潜水球", "黑暗球", "治愈球", "速度球", "等级球", "诱饵球", "沉重球", "甜蜜球", "友友球", "月亮球", "梦境球", "究极球"]);
  fillDatalist("#language-options", ["CHS", "CHT", "ENG", "JPN", "KOR", "FRE", "GER", "ITA", "SPA"]);
}

function renderDecorPokemon() {
  const container = $("#decor-pokemon");
  if (!container || !state.data?.pokemon?.length) return;
  const pool = state.data.pokemon.filter((mon) => mon.sprite).slice(0, 80);
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, 6);
  const positions = [
    { side: "left", top: 18, x: 18, size: 128, facing: 1 },
    { side: "left", top: 48, x: -10, size: 160, facing: 1 },
    { side: "left", top: 78, x: 26, size: 118, facing: 1 },
    { side: "right", top: 24, x: 16, size: 146, facing: -1 },
    { side: "right", top: 56, x: -16, size: 168, facing: -1 },
    { side: "right", top: 84, x: 34, size: 124, facing: -1 },
  ];
  container.innerHTML = shuffled
    .map((mon, index) => {
      const pos = positions[index];
      const depth = 0.5 + index * 0.12;
      const duration = 6 + index * 0.8;
      const delay = -index * 0.7;
      return `
        <button class="decor-mon ${pos.side}" type="button" aria-label="和 ${escapeHtml(mon.name)} 互动" style="top:${pos.top}%;--decor-x:${pos.x}px;--decor-size:${pos.size}px;--decor-facing:${pos.facing};--decor-depth:${depth};--decor-duration:${duration}s;--decor-delay:${delay}s;">
          <span class="decor-action">加入队伍</span>
          <img src="${mon.sprite}" alt="">
          <span class="decor-bubble">${escapeHtml(mon.name)}</span>
        </button>`;
    })
    .join("");
  container.classList.remove("is-shuffling");
  requestAnimationFrame(() => {
    container.classList.add("is-shuffling");
    window.setTimeout(() => container.classList.remove("is-shuffling"), 700);
  });
}

function bindDecorMotion() {
  const container = $("#decor-pokemon");
  if (!container) return;
  let movingTimer = 0;
  container.addEventListener("click", (event) => {
    const mon = event.target.closest(".decor-mon");
    if (!mon) return;
    mon.classList.remove("is-reacting");
    void mon.offsetWidth;
    mon.classList.add("is-reacting");
    const name = mon.querySelector(".decor-bubble")?.textContent?.trim();
    const candidate = state.data?.pokemon?.find((item) => item.name === name);
    if (candidate) addPokemonToTeam(candidate, { replaceLast: state.team.length >= 6 });
    window.setTimeout(() => mon.classList.remove("is-reacting"), 700);
  });
  container.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const mon = event.target.closest(".decor-mon");
    if (!mon) return;
    event.preventDefault();
    mon.click();
  });
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.addEventListener("pointermove", (event) => {
    const x = (event.clientX / window.innerWidth - 0.5) * 52;
    const y = (event.clientY / window.innerHeight - 0.5) * 38;
    container.style.setProperty("--decor-drift-x", `${x.toFixed(2)}px`);
    container.style.setProperty("--decor-drift-y", `${y.toFixed(2)}px`);
    container.classList.add("is-moving");
    window.clearTimeout(movingTimer);
    movingTimer = window.setTimeout(() => container.classList.remove("is-moving"), 260);
  });
  window.addEventListener(
    "scroll",
    () => {
      container.style.setProperty("--decor-scroll-y", `${(window.scrollY * 0.08).toFixed(2)}px`);
    },
    { passive: true },
  );
}

function applyPreferences() {
  const theme = localStorage.getItem("champion-lab-theme") || "aurora";
  const fontScale = localStorage.getItem("champion-lab-font-scale") || "normal";
  document.body.dataset.theme = theme;
  document.body.dataset.fontScale = fontScale;
  const themeSelect = $("#theme-select");
  const fontSelect = $("#font-scale");
  if (themeSelect) themeSelect.value = theme;
  if (fontSelect) fontSelect.value = fontScale;
}

function setPreference(key, value) {
  localStorage.setItem(key, value);
  applyPreferences();
}

function currentLibraryTeams() {
  return state.teamLibrary.filter((team) => team.format === state.format);
}

function renderTeamLibrary() {
  const select = $("#team-library-select");
  const preview = $("#team-library-preview");
  if (!select || !preview) return;
  const teams = currentLibraryTeams();
  if (!teams.length) {
    select.innerHTML = `<option value="">暂无可导入队伍</option>`;
    preview.innerHTML = `<p class="empty">运行 npm run fetch:teams 后会显示公开队伍。</p>`;
    return;
  }
  if (!teams.some((team) => team.id === state.selectedTeamId)) state.selectedTeamId = teams[0].id;
  select.innerHTML = teams
    .map((team) => `<option value="${team.id}" ${team.id === state.selectedTeamId ? "selected" : ""}>${escapeHtml(team.title)} · ${team.formatLabel} · ${team.rate ? `Rate ${team.rate}` : team.season}</option>`)
    .join("");

  const team = teams.find((item) => item.id === state.selectedTeamId) || teams[0];
  const matched = team.members.filter((member) => pokemonForTeamMember(member)).length;
  const fullData = team.members.filter((member) => pokemonForTeamMember(member, { allowFallback: false })).length;
  preview.innerHTML = `
    <div class="team-preview-meta">
      <strong>${escapeHtml(team.title)}</strong>
      <span>${escapeHtml(team.season)}</span>
      <span>${escapeHtml(team.formatLabel)}</span>
      <span>${team.rate ? `Rate ${team.rate}` : "No rate"}</span>
      <span>可导入 ${matched}/${team.members.length}</span>
      ${fullData < team.members.length ? `<span>完整数据 ${fullData}/${team.members.length}</span>` : ""}
      ${team.articleUrl ? `<a class="team-source-link" href="${team.articleUrl}" target="_blank" rel="noopener noreferrer">打开文章</a>` : ""}
      ${team.href ? `<a class="team-source-link secondary" href="${team.href}" target="_blank" rel="noopener noreferrer">打开来源</a>` : ""}
    </div>
    <div class="team-preview-mons">
      ${team.members.map((member) => `<img src="${member.sprite}" alt="${escapeHtml(member.name)}" title="${escapeHtml(member.name)}">`).join("")}
    </div>`;
}

function importSelectedTeam() {
  const team = state.teamLibrary.find((item) => item.id === state.selectedTeamId);
  if (!team || !state.data) return;
  state.team = team.members.map(pokemonForTeamMember).filter(Boolean).slice(0, 6);
  state.teamConfigs = {};
  state.importedTeam = team;
  closePalette();
  render();
  saveDraft();
}

function renderSlots() {
  $("#team-slots").innerHTML = Array.from({ length: 6 }, (_, index) => {
    const mon = state.team[index];
    if (!mon) return `<button class="slot" type="button"><strong>SLOT ${index + 1}</strong></button>`;
    const config = editableConfigFor(mon);
    return `
      <div class="slot filled ${mon.isExternalMember ? "external-member" : ""}" data-edit-index="${index}" role="button" tabindex="0" aria-label="编辑 ${escapeHtml(mon.name)}">
        <button class="slot-remove" type="button" data-remove="${mon.slug}" aria-label="移除 ${escapeHtml(mon.name)}">×</button>
        <img src="${mon.sprite}" alt="${escapeHtml(mon.name)}">
        <strong>${escapeHtml(mon.name)}</strong>
        <small>${escapeHtml(config.item || config.ability || "点击编辑")}</small>
      </div>`;
  }).join("");
}

function updateDocumentState() {
  document.body.dataset.teamCount = String(state.team.length);
  document.body.classList.toggle("has-team", state.team.length > 0);
  document.body.classList.toggle("team-complete", state.team.length === 6);
  document.body.classList.toggle("has-ai-advice", Boolean(state.aiLastAdvice));
  $("#analysis-dashboard")?.classList.toggle("is-empty", state.team.length === 0);
}

function renderList() {
  const listEl = $("#pokemon-list");
  if (!listEl) return;
  if (!state.searchOpen) {
    listEl.innerHTML = "";
    return;
  }
  const q = state.query.trim().toLowerCase();
  const selected = new Set(state.team.map((p) => p.slug));
  const list = state.data.pokemon
    .filter((mon) => !q || mon.name.toLowerCase().includes(q) || mon.slug.toLowerCase().includes(q) || String(mon.id).includes(q))
    .slice(0, 80);
  listEl.innerHTML = list
    .map((mon) => {
      const disabled = selected.has(mon.slug) || state.team.length >= 6;
      return `<button class="pokemon-row" type="button" data-add="${mon.slug}" ${disabled ? "disabled" : ""}><span class="rank">#${mon.rank}</span><img src="${mon.sprite}" alt="${escapeHtml(mon.name)}"><span><strong>${escapeHtml(mon.name)}</strong><small>${escapeHtml(topNames(mon.moves, 2) || "暂无配置")}</small></span><span class="type-pill">${escapeHtml((mon.types || []).join("/"))}</span></button>`;
    })
    .join("");
}

function renderMetrics() {
  if (!state.team.length) {
    $("#avg-rank").textContent = "-";
    $("#meta-score").textContent = "-";
    $("#speed-line").textContent = "-";
    $("#matchup-score").textContent = "-";
    return;
  }
  const rankedTeam = state.team.filter((mon) => !mon.isExternalMember && Number.isFinite(Number(mon.rank)));
  const avgRank = rankedTeam.length ? rankedTeam.reduce((sum, mon) => sum + Number(mon.rank || 0), 0) / rankedTeam.length : null;
  const top20 = rankedTeam.filter((mon) => Number(mon.rank) <= 20).length;
  const speed = Math.max(...state.team.map((mon) => effectiveSpeed(mon).value));
  const knowledge = battleKnowledge();
  $("#avg-rank").textContent = avgRank === null ? "-" : avgRank.toFixed(1);
  $("#meta-score").textContent = knowledge.score >= 76 ? "高" : knowledge.score >= 54 ? "中" : "低";
  $("#meta-score").title = `规则状态评分 ${knowledge.score}/100；风险：${knowledge.risks.join("、") || "暂无明显风险"}`;
  $("#speed-line").textContent = String(speed || "-");
  const matchup = getMatchupReport(8);
  $("#matchup-score").textContent = String(matchup.score || "-");
  $("#matchup-score").title = matchup.summary;
}

function renderRoles() {
  const roles = new Map();
  state.team.forEach((mon) => getRoles(mon).forEach((role) => roles.set(role, (roles.get(role) || 0) + 1)));
  $("#role-tags").innerHTML = roles.size ? [...roles.entries()].map(([role, count]) => `<span class="tag">${escapeHtml(role)} ${count}</span>`).join("") : `<p class="empty">选择宝可梦后显示队伍定位。</p>`;
}

function getSpeedThreats() {
  if (!state.team.length) return [];
  const ownMax = Math.max(...state.team.map((mon) => effectiveSpeed(mon).value));
  return state.data.pokemon
    .filter((mon) => !state.team.some((own) => own.id === mon.id))
    .map((mon) => ({ mon, eff: effectiveSpeed(mon) }))
    .filter(({ eff }) => eff.value > ownMax || eff.label !== "原速")
    .slice(0, 24)
    .map(({ mon, eff }) => ({
      mon,
      level: eff.label,
      note: `有效速度 ${eff.value}，常见配置：${topNames(mon.items, 2) || "暂无"}`,
    }));
}

function renderSpeedThreats() {
  const threats = getSpeedThreats().slice(0, 6);
  $("#speed-threats").innerHTML = threats.length
    ? threats.map(({ mon, level, note }) => `<div class="threat-line"><strong>${escapeHtml(mon.name)}</strong><small>#${mon.rank} · ${escapeHtml(level)} · 原速 ${stat(mon, "速度")}</small><p>${escapeHtml(note)}</p></div>`).join("")
    : `<p class="empty">暂无明显速度威胁。</p>`;
}

function getOpponentConfigs() {
  const matchup = getMatchupReport(8);
  if (matchup.threats.length) {
    return matchup.threats.map((threat) => ({
      title: threat.name,
      risk: threat.level,
      note: `${threat.reasons.join("；")}。常见：${threat.commonMoves.map((item) => item.name).slice(0, 3).join(" / ") || "暂无"}。`,
      usage: threat.usage,
      show: true,
    }));
  }
  const ownTaunt = state.team.some((mon) => hasMove(mon, /挑衅/));
  const ownSpeedControl = state.team.some((mon) => hasMove(mon, /顺风|电磁波|戏法空间|冰冻之风/));
  const ownFakeOut = state.team.some((mon) => hasMove(mon, /击掌奇袭/));
  const ownGroundImmune = state.team.some((mon) => mon.types?.includes("飞行") || hasAbility(mon, /漂浮/));
  return [
    { title: "戏法空间", risk: ownTaunt ? "中" : "高", note: ownTaunt ? "有挑衅点，注意保护使用时机。" : "缺少直接阻止空间的手段。", show: true },
    { title: "顺风高速", risk: ownSpeedControl ? "中" : "高", note: ownSpeedControl ? "有控速手段，注意别被先手压制。" : "缺少控速时会被连续抢节奏。", show: true },
    { title: "威吓击掌", risk: state.format === "double" && !ownFakeOut ? "高" : "中", note: state.format === "double" ? "双打首回合要防节奏被拆。" : "单打主要关注威吓削弱物攻核心。", show: true },
    { title: "地面高压", risk: ownGroundImmune ? "中" : "高", note: ownGroundImmune ? "有地面免疫点，注意保护它。" : "缺少地面免疫，换人空间会受压。", show: true },
  ];
}

function renderOpponentConfigs() {
  const configs = getOpponentConfigs().slice(0, 6);
  $("#opponent-configs").innerHTML = configs.length
    ? configs.map((config) => `<div class="threat-line ${config.risk === "高" ? "danger" : ""}"><strong>${escapeHtml(config.title)}</strong><small>风险 ${escapeHtml(config.risk)}</small><p>${escapeHtml(config.note)}</p></div>`).join("")
    : `<p class="empty">选择队伍后显示风险。</p>`;
}

function renderTypeMap() {
  const counts = new Map(TYPES.map((type) => [type, 0]));
  state.team.forEach((mon) => (mon.types || []).forEach((type) => counts.set(type, (counts.get(type) || 0) + 1)));
  $("#type-map").innerHTML = state.team.length ? [...counts.entries()].map(([type, count]) => `<span class="tag ${count ? "active" : ""}">${type} ${count}</span>`).join("") : `<p class="empty">选择队伍后显示属性分布。</p>`;
}

function renderSets() {
  $("#sets").innerHTML = state.team.length
    ? state.team.map((mon) => {
        const config = editableConfigFor(mon);
        const role = mon.isExternalMember ? "外部队伍成员" : getRoles(mon).join(" / ") || "待定位";
        return `<div class="set-line set-line-real"><strong>${escapeHtml(mon.name)}</strong><small>${escapeHtml(role)}</small><dl><div><dt>道具</dt><dd>${escapeHtml(config.item || "暂无")}</dd></div><div><dt>特性</dt><dd>${escapeHtml(config.ability || "暂无")}</dd></div><div><dt>太晶/等级</dt><dd>${escapeHtml([config.teraType, config.level ? `Lv.${config.level}` : ""].filter(Boolean).join(" / ") || "暂无")}</dd></div><div><dt>招式</dt><dd>${escapeHtml(config.moves?.join(" / ") || "暂无")}</dd></div></dl></div>`;
      }).join("")
    : `<p class="empty">选择队伍后显示常见配置。</p>`;
}

function renderPlan() {
  const team = state.team;
  if (!team.length) {
    $("#game-plan").innerHTML = `<li>先选择 3 到 6 只宝可梦，再生成对局准备建议。</li>`;
    return;
  }
  const byRank = [...team].filter((mon) => Number.isFinite(Number(mon.rank))).sort((a, b) => a.rank - b.rank);
  const anchors = byRank.length ? byRank.slice(0, 2) : team.slice(0, 2);
  const fastest = [...team].sort((a, b) => effectiveSpeed(b).value - effectiveSpeed(a).value)[0];
  const hazard = team.find((mon) => hasMove(mon, /隐形岩|撒菱|毒菱|黏黏网/));
  const removal = team.find((mon) => hasMove(mon, /高速旋转|清除浓雾/));
  const setup = team.find((mon) => hasMove(mon, /剑舞|龙舞|诡计|冥想|健美|蝶舞|破壳/));
  const speedControl = team.find((mon) => hasMove(mon, /顺风|电磁波|戏法空间|冰冻之风|岩石封锁|黏黏网/));
  const pivot = team.find((mon) => hasMove(mon, /急速折返|伏特替换|抛下狠话|接棒/));
  const priority = team.find((mon) => hasMove(mon, /神速|突袭|子弹拳|水流喷射|冰砾|影子偷袭|音速拳|击掌奇袭/));
  const protect = team.filter((mon) => hasMove(mon, /守住/));
  const plans = [];
  plans.push(`核心路线：优先围绕 ${anchors.map((m) => m.name).join("、")} 建立输出或换入节奏。`);
  if (hazard) plans.push(`开局压力：${hazard.name} 可以铺场；${removal ? `${removal.name} 负责清场防止被反压。` : "队伍缺少清场手段，注意别被对面撒场滚雪球。"}`);
  else plans.push(state.format === "single" ? "单打缺少撒场点，主要依赖直接对攻、强化或轮转制造突破。" : "双打不依赖撒场，优先处理首回合站位、控速和集火目标。");
  if (speedControl) plans.push(`速度控制：${speedControl.name} 是主要控速点；让 ${fastest.name} 在控速后承担压制或收尾。`);
  else plans.push(`${fastest.name} 是当前最快有效速度点；没有稳定控速时，避免让它过早被消耗。`);
  if (setup) plans.push(`终盘路线：为 ${setup.name} 保留强化窗口，先削弱其常见换入点再尝试清场。`);
  else if (priority) plans.push(`终盘路线：${priority.name} 的先制招式适合收残，前中期重点压低对手血线。`);
  else plans.push("终盘路线不明显：建议补强化、先制或更明确的围巾/高速收尾位。");
  if (state.format === "double") {
    plans.push(protect.length >= 3 ? `双打节奏：已有 ${protect.length} 个守住位，可以围绕保护、换位和集火拆对面核心。` : `双打风险：守住数量偏少，容易被首回合集火或控速节奏惩罚。`);
  } else if (pivot) {
    plans.push(`轮转路线：${pivot.name} 可以用转场招式带核心安全上场，优先保留它的血量。`);
  } else {
    plans.push("单打换入链偏少，选出时要提前确认谁负责吃关键属性攻击。");
  }
  const plan = plans.slice(0, 5);
  $("#game-plan").innerHTML = plan.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function render() {
  updateDocumentState();
  renderSlots();
  renderList();
  renderTeamLibrary();
  renderDataHealth();
  renderMetrics();
  renderRoles();
  renderSpeedThreats();
  renderOpponentConfigs();
  renderTypeMap();
  renderSets();
  renderPlan();
  renderShowdownExport();
}

function openTeamEditor(index) {
  const mon = state.team[index];
  const modal = $("#team-editor-backdrop");
  if (!mon || !modal) return;
  const config = editableConfigFor(mon);
  state.activeEditIndex = index;
  $("#team-editor-title").textContent = `编辑 ${mon.name}`;
  $("#edit-item").value = config.item || "";
  $("#edit-ability").value = config.ability || "";
  $("#edit-nature").value = config.nature || "";
  $("#edit-evs").value = config.evs || "";
  $("#edit-ivs").value = config.ivs || "";
  $("#edit-tera").value = config.teraType || "";
  $("#edit-level").value = config.level || "";
  $("#edit-gender").value = config.gender || "";
  $("#edit-ball").value = config.ball || "";
  $("#edit-language").value = config.language || "";
  $("#edit-shiny").checked = Boolean(config.shiny);
  [1, 2, 3, 4].forEach((moveIndex) => {
    const input = $(`#edit-move-${moveIndex}`);
    if (input) input.value = config.moves?.[moveIndex - 1] || "";
  });
  modal.hidden = false;
  document.body.classList.add("editor-open");
}

function closeTeamEditor() {
  $("#team-editor-backdrop")?.setAttribute("hidden", "");
  document.body.classList.remove("editor-open");
  state.activeEditIndex = null;
}

function saveTeamEditor() {
  const mon = state.team[state.activeEditIndex];
  if (!mon) return;
  setEditableConfig(mon, {
    item: $("#edit-item")?.value.trim(),
    ability: $("#edit-ability")?.value.trim(),
    nature: $("#edit-nature")?.value.trim(),
    evs: $("#edit-evs")?.value.trim(),
    ivs: $("#edit-ivs")?.value.trim(),
    teraType: $("#edit-tera")?.value.trim(),
    level: $("#edit-level")?.value.trim(),
    gender: $("#edit-gender")?.value,
    ball: $("#edit-ball")?.value.trim(),
    language: $("#edit-language")?.value.trim(),
    shiny: $("#edit-shiny")?.checked,
    moves: [1, 2, 3, 4].map((index) => $(`#edit-move-${index}`)?.value.trim() || ""),
  });
  state.showdownValidation = null;
  closeTeamEditor();
  render();
  saveDraft();
}

function openPalette() {
  const palette = $("#command-palette-backdrop");
  if (!palette) return;
  palette.hidden = false;
  document.body.classList.add("palette-open");
  state.searchOpen = true;
  renderList();
  window.setTimeout(() => $("#search")?.focus(), 0);
}

function closePalette(clearSearch = true) {
  const palette = $("#command-palette-backdrop");
  if (palette) palette.hidden = true;
  document.body.classList.remove("palette-open");
  state.searchOpen = false;
  if (clearSearch) {
    state.query = "";
    const input = $("#search");
    if (input) input.value = "";
  }
  renderList();
}

function bindEvents() {
  $("#search")?.addEventListener("input", (event) => {
    state.query = event.target.value;
    state.searchOpen = true;
    renderList();
  });
  $("#clear-team")?.addEventListener("click", () => {
    state.team = [];
    state.teamConfigs = {};
    state.importedTeam = null;
    clearDraft();
    closeTeamEditor();
    closePalette(false);
    render();
  });
  $("#theme-select")?.addEventListener("change", (event) => setPreference("champion-lab-theme", event.target.value));
  $("#font-scale")?.addEventListener("change", (event) => setPreference("champion-lab-font-scale", event.target.value));
  $("#team-library-select")?.addEventListener("change", (event) => {
    state.selectedTeamId = event.target.value;
    renderTeamLibrary();
  });
  $("#refresh-data")?.addEventListener("click", refreshData);
  $("#import-team-btn")?.addEventListener("click", importSelectedTeam);
  $("#copy-showdown")?.addEventListener("click", copyShowdownText);
  $("#copy-packed")?.addEventListener("click", copyPackedText);
  $("#validate-showdown")?.addEventListener("click", validateShowdownText);
  $("#download-showdown")?.addEventListener("click", downloadShowdownText);
  $("#download-json")?.addEventListener("click", downloadJsonDraft);
  $("#import-json-btn")?.addEventListener("click", () => $("#import-json")?.click());
  $("#import-json")?.addEventListener("change", (event) => importJsonDraft(event.target.files?.[0]));
  $("#ai-settings-toggle")?.addEventListener("click", () => {
    const panel = $("#ai-settings-panel");
    if (panel) panel.hidden = !panel.hidden;
  });
  $("#ai-provider")?.addEventListener("change", () => applyAIProviderPreset(true));
  $("#ai-model-select")?.addEventListener("change", updateModelInputVisibility);
  $("#ai-refresh-models")?.addEventListener("click", refreshAIModels);
  ["#ai-endpoint", "#ai-base-url", "#ai-model", "#ai-api-key"].forEach((selector) => {
    $(selector)?.addEventListener("input", updateAIConfigStatus);
    $(selector)?.addEventListener("change", updateAIConfigStatus);
  });
  $("#ai-save-config")?.addEventListener("click", saveAIConfig);
  $("#ai-test-config")?.addEventListener("click", testAIConfig);
  $("#ai-clear-config")?.addEventListener("click", clearAIConfig);
  $("#ai-build-config")?.addEventListener("click", () => generateAIAdvice("config"));
  $("#ai-complete-team")?.addEventListener("click", () => generateAIAdvice("complete-team"));
  $("#rule-allow-duplicate-items")?.addEventListener("change", saveRulePrefs);
  $("#rule-ignore-tera")?.addEventListener("change", saveRulePrefs);
  $("#refresh-status")?.addEventListener("click", refreshDataHealth);
  document.querySelectorAll("[data-format]").forEach((button) => button.addEventListener("click", () => setFormat(button.dataset.format)));
  $("#open-palette-btn")?.addEventListener("click", () => openPalette());
  $("#close-palette-btn")?.addEventListener("click", () => closePalette());
  $("#close-team-editor")?.addEventListener("click", closeTeamEditor);
  $("#cancel-team-editor")?.addEventListener("click", closeTeamEditor);
  $("#save-team-editor")?.addEventListener("click", saveTeamEditor);
  $("#team-editor-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "team-editor-backdrop") closeTeamEditor();
  });
  $("#command-palette-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "command-palette-backdrop") closePalette();
  });
  $("#team-slots")?.addEventListener("click", (event) => {
    if (event.target.closest(".slot:not(.filled)")) openPalette();
    const editTarget = event.target.closest("[data-edit-index]");
    if (editTarget && !event.target.closest("[data-remove]")) openTeamEditor(Number(editTarget.dataset.editIndex));
  });
  $("#team-slots")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const editTarget = event.target.closest("[data-edit-index]");
    if (!editTarget) return;
    event.preventDefault();
    openTeamEditor(Number(editTarget.dataset.editIndex));
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
    }
    if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "r" && !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
      renderDecorPokemon();
    }
    if (event.key === "Escape" && !$("#team-editor-backdrop")?.hidden) closeTeamEditor();
    else if (event.key === "Escape" && !$("#command-palette-backdrop")?.hidden) closePalette();
  });
  document.addEventListener("click", (event) => {
    const add = event.target.closest("[data-add]")?.dataset.add;
    if (add && state.team.length < 6) {
      const mon = state.data.pokemon.find((p) => p.slug === add);
      if (addPokemonToTeam(mon)) {
        closePalette();
      }
    }
    const remove = event.target.closest("[data-remove]")?.dataset.remove;
    if (remove) {
      const mon = state.team.find((p) => p.slug === remove);
      if (mon) delete state.teamConfigs[configKey(mon)];
      state.team = state.team.filter((p) => p.slug !== remove);
      state.importedTeam = null;
      render();
      saveDraft();
    }
    const applyFormat = event.target.closest("[data-ai-apply]")?.dataset.aiApply;
    if (applyFormat) applyAIAdviceTeam(applyFormat);
    const viewFormat = event.target.closest("[data-ai-view]")?.dataset.aiView;
    if (viewFormat) {
      state.aiAdviceView = viewFormat;
      rerenderAIAdvice();
    }
    const adviceRef = adviceItemFromEvent(event);
    if (adviceRef && event.target.closest("[data-ai-apply-one]")) applyAdvicePokemon(adviceRef.item, adviceRef.format, false);
    if (adviceRef && event.target.closest("[data-ai-replace-one]")) applyAdvicePokemon(adviceRef.item, adviceRef.format, true);
    if (adviceRef && event.target.closest("[data-ai-copy-one]")) navigator.clipboard?.writeText(advicePokemonText(adviceRef.item));
    if (event.target.closest("[data-ai-retry]")) generateAIAdvice(state.aiLastMode || "complete-team");
  });
}

async function init() {
  applyPreferences();
  loadRulePrefs();
  hydrateAIConfigForm();
  hydrateRulePrefs();
  await loadLocalData();
  const defaultFormat = state.rawData.defaultFormat || (state.rawData.formats.single ? "single" : Object.keys(state.rawData.formats)[0]);
  state.format = defaultFormat;
  state.data = state.rawData.formats[defaultFormat];
  restoreDraft();
  updateFormatButtons();
  updateMetaLabel();
  updateEditorOptions();
  renderDecorPokemon();
  bindEvents();
  bindDecorMotion();
  render();
}

init().catch((err) => {
  if (/正在等待启动抓取完成|champion-data/.test(err.message || "")) {
    waitForInitialData();
    return;
  }
  document.body.innerHTML = `<main class="topbar"><div><h1>数据未准备好</h1><p>${escapeHtml(err.message)}</p></div></main>`;
});
