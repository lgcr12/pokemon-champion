const STAT_ALIASES = new Map([
  ["hp", "HP"],
  ["attack", "Atk"],
  ["atk", "Atk"],
  ["攻击", "Atk"],
  ["defense", "Def"],
  ["def", "Def"],
  ["防御", "Def"],
  ["special attack", "SpA"],
  ["spa", "SpA"],
  ["特攻", "SpA"],
  ["special defense", "SpD"],
  ["spd", "SpD"],
  ["特防", "SpD"],
  ["speed", "Spe"],
  ["spe", "Spe"],
  ["速度", "Spe"],
]);

const MOVE_TAGS = [
  ["hazard", /隐形岩|撒菱|毒菱|黏黏网|stealth rock|spikes|toxic spikes|sticky web/i],
  ["removal", /高速旋转|清除浓雾|rapid spin|defog/i],
  ["setup", /剑舞|龙舞|诡计|冥想|健美|蝶舞|破壳|腹鼓|swords dance|dragon dance|nasty plot|calm mind|quiver dance|shell smash|belly drum/i],
  ["speedControl", /顺风|电磁波|戏法空间|冰冻之风|岩石封锁|黏黏网|tailwind|thunder wave|trick room|icy wind|rock tomb|sticky web/i],
  ["tailwind", /顺风|tailwind/i],
  ["trickRoom", /戏法空间|trick room/i],
  ["pivot", /急速折返|伏特替换|抛下狠话|接棒|u-turn|volt switch|parting shot|baton pass/i],
  ["priority", /神速|突袭|子弹拳|水流喷射|冰砾|影子偷袭|音速拳|击掌奇袭|extreme speed|sucker punch|bullet punch|aqua jet|ice shard|shadow sneak|mach punch|fake out/i],
  ["protect", /守住|看穿|protect|detect/i],
  ["fakeOut", /击掌奇袭|fake out/i],
  ["redirection", /看我嘛|愤怒粉|follow me|rage powder/i],
  ["wideGuard", /广域防守|wide guard/i],
  ["taunt", /挑衅|taunt/i],
  ["status", /电磁波|鬼火|剧毒|催眠|蘑菇孢子|thunder wave|will-o-wisp|toxic|spore|sleep powder/i],
  ["recovery", /自我再生|羽栖|月光|晨光|光合作用|roost|recover|moonlight|morning sun|synthesis/i],
  ["spreadDamage", /地震|岩崩|热风|魔法闪耀|喷水|喷火|暴风雪|放电|earthquake|rock slide|heat wave|dazzling gleam|water spout|eruption|blizzard|discharge/i],
];

const ABILITY_TAGS = [
  ["intimidate", /威吓|intimidate/i],
  ["prankster", /恶作剧之心|prankster/i],
  ["regenerator", /再生力|regenerator/i],
  ["weatherSetter", /降雨|日照|扬沙|降雪|drizzle|drought|sand stream|snow warning/i],
  ["terrainSetter", /青草制造者|电气制造者|薄雾制造者|精神制造者|grassy surge|electric surge|misty surge|psychic surge/i],
  ["groundImmuneAbility", /漂浮|levitate/i],
  ["speedAbility", /悠游自如|叶绿素|拨沙|拨雪|轻装|加速|swift swim|chlorophyll|sand rush|slush rush|unburden|speed boost/i],
];

const MEGA_ITEM_RE = /mega|进化石|超进化石|mega stone|ナイト/i;

const TYPE_CHART = {
  一般: { weak: ["格斗"], resist: [], immune: ["幽灵"] },
  火: { weak: ["水", "地面", "岩石"], resist: ["火", "草", "冰", "虫", "钢", "妖精"], immune: [] },
  水: { weak: ["电", "草"], resist: ["火", "水", "冰", "钢"], immune: [] },
  电: { weak: ["地面"], resist: ["电", "飞行", "钢"], immune: [] },
  草: { weak: ["火", "冰", "毒", "飞行", "虫"], resist: ["水", "电", "草", "地面"], immune: [] },
  冰: { weak: ["火", "格斗", "岩石", "钢"], resist: ["冰"], immune: [] },
  格斗: { weak: ["飞行", "超能力", "妖精"], resist: ["虫", "岩石", "恶"], immune: [] },
  毒: { weak: ["地面", "超能力"], resist: ["草", "格斗", "毒", "虫", "妖精"], immune: [] },
  地面: { weak: ["水", "草", "冰"], resist: ["毒", "岩石"], immune: ["电"] },
  飞行: { weak: ["电", "冰", "岩石"], resist: ["草", "格斗", "虫"], immune: ["地面"] },
  超能力: { weak: ["虫", "幽灵", "恶"], resist: ["格斗", "超能力"], immune: [] },
  虫: { weak: ["火", "飞行", "岩石"], resist: ["草", "格斗", "地面"], immune: [] },
  岩石: { weak: ["水", "草", "格斗", "地面", "钢"], resist: ["一般", "火", "毒", "飞行"], immune: [] },
  幽灵: { weak: ["幽灵", "恶"], resist: ["毒", "虫"], immune: ["一般", "格斗"] },
  龙: { weak: ["冰", "龙", "妖精"], resist: ["火", "水", "电", "草"], immune: [] },
  恶: { weak: ["格斗", "虫", "妖精"], resist: ["幽灵", "恶"], immune: ["超能力"] },
  钢: { weak: ["火", "格斗", "地面"], resist: ["一般", "草", "冰", "飞行", "超能力", "虫", "岩石", "龙", "钢", "妖精"], immune: ["毒"] },
  妖精: { weak: ["毒", "钢"], resist: ["格斗", "虫", "恶"], immune: ["龙"] },
};

export function toIdStr(value = "") {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

export function normalizeName(value = "") {
  return String(value).trim().replace(/\s+/g, " ");
}

export function statKey(value = "") {
  return STAT_ALIASES.get(String(value).trim().toLowerCase()) || value;
}

export function parseSpread(line = "") {
  const result = {};
  for (const part of String(line).split("/")) {
    const match = part.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    result[statKey(match[2])] = Number(match[1]);
  }
  return result;
}

export function spreadText(spread = {}) {
  return Object.entries(spread)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${value} ${key}`)
    .join(" / ");
}

export function packTeam(team = [], getConfig = () => ({}), speciesName = (mon) => mon?.slug || mon?.name || "") {
  return team
    .map((mon) => {
      const config = getConfig(mon) || {};
      const evs = parseSpread(config.evs);
      const ivs = parseSpread(config.ivs);
      const fields = [
        "",
        speciesName(mon),
        config.item || "",
        config.ability || "",
        (config.moves || []).filter(Boolean).join(","),
        config.nature || "",
        evs.HP || "",
        evs.Atk || "",
        evs.Def || "",
        evs.SpA || "",
        evs.SpD || "",
        evs.Spe || "",
        config.gender || "",
        ivs.HP || "",
        ivs.Atk || "",
        ivs.Def || "",
        ivs.SpA || "",
        ivs.SpD || "",
        ivs.Spe || "",
        config.shiny ? "S" : "",
        config.level || "50",
        "",
        "",
        config.teraType || "",
      ];
      return fields.join("|");
    })
    .join("]");
}

function entriesText(entries = []) {
  return (entries || []).map((item) => (typeof item === "string" ? item : item?.name || "")).filter(Boolean).join(" ");
}

function statValue(mon, key, stat = () => 0) {
  return Number(mon?.stats?.[key] ?? stat(mon, key) ?? 0);
}

function collectTags(text, tagDefs) {
  const tags = new Set();
  for (const [tag, pattern] of tagDefs) {
    if (pattern.test(text)) tags.add(tag);
  }
  return tags;
}

function normalizeItem(value = "") {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function typeMatchup(types = []) {
  const multipliers = new Map();
  for (const type of Object.keys(TYPE_CHART)) multipliers.set(type, 1);
  for (const ownType of types) {
    const chart = TYPE_CHART[ownType];
    if (!chart) continue;
    for (const type of chart.weak) multipliers.set(type, (multipliers.get(type) || 1) * 2);
    for (const type of chart.resist) multipliers.set(type, (multipliers.get(type) || 1) * 0.5);
    for (const type of chart.immune) multipliers.set(type, 0);
  }
  return {
    weak: [...multipliers.entries()].filter(([, value]) => value > 1).map(([type, value]) => `${type}x${value}`),
    resist: [...multipliers.entries()].filter(([, value]) => value > 0 && value < 1).map(([type, value]) => `${type}x${value}`),
    immune: [...multipliers.entries()].filter(([, value]) => value === 0).map(([type]) => type),
  };
}

function memberProfile(mon, helpers) {
  const getConfig = helpers.getConfig || (() => ({}));
  const stat = helpers.stat || (() => 0);
  const effectiveSpeed = helpers.effectiveSpeed || ((item) => ({ value: statValue(item, "速度", stat), label: "原速" }));
  const config = getConfig(mon) || {};
  const moves = (config.moves?.length ? config.moves : mon.moves?.slice(0, 4).map((move) => move.name)) || [];
  const moveText = `${moves.join(" ")} ${entriesText(mon.moves)}`;
  const abilityText = `${config.ability || ""} ${entriesText(mon.abilities)}`;
  const currentItemText = config.item || "";
  const moveTags = collectTags(moveText, MOVE_TAGS);
  const abilityTags = collectTags(abilityText, ABILITY_TAGS);
  const atk = statValue(mon, "攻击", stat);
  const spa = statValue(mon, "特攻", stat);
  const spe = statValue(mon, "速度", stat);
  const bulk = statValue(mon, "HP", stat) + statValue(mon, "防御", stat) + statValue(mon, "特防", stat);
  const flags = Object.fromEntries([...MOVE_TAGS.map(([tag]) => [tag, moveTags.has(tag)]), ...ABILITY_TAGS.map(([tag]) => [tag, abilityTags.has(tag)])]);
  flags.groundImmune = (mon.types || []).includes("飞行") || flags.groundImmuneAbility;
  flags.megaCandidate = MEGA_ITEM_RE.test(currentItemText);
  flags.choiceItem = /讲究|choice/i.test(currentItemText);
  flags.sash = /气势披带|focus sash/i.test(currentItemText);
  flags.lifeOrb = /生命宝珠|life orb/i.test(currentItemText);

  const roles = new Set();
  if (atk >= 115) roles.add("物理突破");
  if (spa >= 115) roles.add("特殊突破");
  if (moveTags.has("setup")) roles.add("强化突破");
  if (spe >= 100 || abilityTags.has("speedAbility")) roles.add("高速压制");
  if (bulk >= 290 || moveTags.has("recovery")) roles.add("耐久中转");
  if (moveTags.has("hazard")) roles.add("撒钉压制");
  if (moveTags.has("removal")) roles.add("清场除钉");
  if (moveTags.has("speedControl")) roles.add("速度控制");
  if (moveTags.has("pivot")) roles.add("轮转枢纽");
  if (moveTags.has("priority")) roles.add("先制收割");
  if (moveTags.has("fakeOut")) roles.add("击掌辅助");
  if (moveTags.has("redirection")) roles.add("掩护辅助");
  if (moveTags.has("wideGuard")) roles.add("广防辅助");
  if (abilityTags.has("intimidate")) roles.add("威吓压制");
  if (abilityTags.has("weatherSetter")) roles.add("天气轴");
  if (abilityTags.has("terrainSetter")) roles.add("场地轴");
  if (!roles.size) roles.add("补位");

  return {
    id: mon.id,
    name: mon.name,
    slug: mon.slug,
    types: mon.types || [],
    rank: mon.rank,
    item: config.item || "",
    ability: config.ability || "",
    nature: config.nature || "",
    evs: parseSpread(config.evs),
    ivs: parseSpread(config.ivs),
    teraType: config.teraType || "",
    level: String(config.level || "50"),
    moves,
    speed: effectiveSpeed(mon),
    roles: [...roles],
    matchup: typeMatchup(mon.types || []),
    flags,
  };
}

function countBy(items, getter) {
  const map = new Map();
  for (const item of items) {
    for (const key of getter(item)) map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function buildTypeProfile(members) {
  const weakCounts = countBy(members, (member) => member.matchup.weak.map((item) => item.split("x")[0]));
  const resistCounts = countBy(members, (member) => [...member.matchup.resist.map((item) => item.split("x")[0]), ...member.matchup.immune]);
  const pressure = [...weakCounts.entries()]
    .map(([type, weak]) => ({ type, weak, cover: resistCounts.get(type) || 0 }))
    .filter((item) => item.weak >= 2 && item.weak > item.cover)
    .sort((a, b) => b.weak - a.weak || a.cover - b.cover);
  return {
    stackedWeaknesses: pressure.slice(0, 5),
    defensiveNotes: pressure.slice(0, 3).map((item) => `${item.type}弱点偏集中：${item.weak} 个弱点，${item.cover} 个抗性/免疫`),
  };
}

function buildLegality(members) {
  const itemMap = new Map();
  const speciesMap = new Map();
  const megaUsers = [];
  const missing = [];

  for (const member of members) {
    const speciesKey = String(member.id || member.slug || member.name).toLowerCase();
    if (speciesKey) speciesMap.set(speciesKey, [...(speciesMap.get(speciesKey) || []), member.name]);
    const itemKey = normalizeItem(member.item);
    if (itemKey) itemMap.set(itemKey, [...(itemMap.get(itemKey) || []), member.name]);
    if (member.flags.megaCandidate) megaUsers.push(member.name);
    if (!member.item) missing.push(`${member.name} 缺少道具`);
    if (!member.ability) missing.push(`${member.name} 缺少特性`);
    if (!member.nature) missing.push(`${member.name} 缺少性格`);
    if (!member.level) missing.push(`${member.name} 缺少等级`);
    if ((member.moves || []).filter(Boolean).length < 4) missing.push(`${member.name} 招式少于 4 个`);
  }

  const duplicateItems = [...itemMap.entries()].filter(([, names]) => names.length > 1).map(([item, names]) => ({ item, members: names }));
  const duplicateSpecies = [...speciesMap.values()].filter((names) => names.length > 1);
  const violations = [
    ...duplicateSpecies.map((names) => `重复宝可梦：${names.join("、")}`),
    ...duplicateItems.map((entry) => `重复道具：${entry.members.join("、")} 都携带 ${entry.item}`),
    ...(megaUsers.length > 1 ? [`Mega 进化限制：同队只允许 1 个 Mega，当前 ${megaUsers.join("、")}`] : []),
    ...missing,
  ];

  return {
    duplicateItems,
    duplicateSpecies,
    megaUsers,
    missing,
    violations,
    isLegalEnough: violations.length === 0,
  };
}

function buildRoleCoverage(members) {
  const has = (flag) => members.some((member) => member.flags[flag]);
  const count = (flag) => members.filter((member) => member.flags[flag]).length;
  const physical = members.filter((member) => member.roles.includes("物理突破")).length;
  const special = members.filter((member) => member.roles.includes("特殊突破")).length;
  return {
    physicalBreakers: physical,
    specialBreakers: special,
    speedControl: has("speedControl"),
    tailwind: has("tailwind"),
    trickRoom: has("trickRoom"),
    hazardSetter: has("hazard"),
    hazardRemoval: has("removal"),
    setup: has("setup"),
    pivot: has("pivot"),
    priority: has("priority"),
    intimidate: has("intimidate"),
    fakeOut: has("fakeOut"),
    redirection: has("redirection"),
    wideGuard: has("wideGuard"),
    protectCount: count("protect"),
    spreadDamage: has("spreadDamage"),
    groundImmune: has("groundImmune"),
    recovery: has("recovery"),
    weatherSetter: has("weatherSetter"),
    terrainSetter: has("terrainSetter"),
  };
}

function buildRecommendations(format, coverage, typeProfile, legality) {
  const risks = [];
  const strengths = [];
  const needs = [];

  if (coverage.speedControl) strengths.push("已有控速手段");
  else {
    risks.push("缺少稳定控速手段");
    needs.push("补顺风、电磁波、岩石封锁、黏黏网或戏法空间");
  }

  if (coverage.pivot) strengths.push("具备轮转入口");
  else needs.push("考虑补急速折返、伏特替换、抛下狠话或耐久中转");

  if (coverage.setup) strengths.push("有强化/终盘路线");
  else if (!coverage.priority) {
    risks.push("终盘收割路线不够明确");
    needs.push("补强化点、高速清场手或先制收割");
  }

  if (!coverage.groundImmune) {
    risks.push("地面免疫点不足");
    needs.push("补飞行系、漂浮特性或地面抗性中转");
  }

  if (coverage.physicalBreakers === 0 || coverage.specialBreakers === 0) {
    risks.push("物攻/特攻压力不均衡");
    needs.push("补另一侧输出，避免被单一防守端卡住");
  }

  if (format === "single") {
    if (coverage.hazardSetter) strengths.push("单打有撒钉压力");
    else {
      risks.push("单打缺少撒钉压力");
      needs.push("补隐形岩、撒菱或黏黏网");
    }
    if (coverage.hazardRemoval) strengths.push("单打有清场/除钉手段");
    else {
      risks.push("单打缺少清场除钉手段");
      needs.push("补高速旋转或清除浓雾");
    }
  } else {
    if (coverage.protectCount >= 3) strengths.push("双打守住位基本足够");
    else {
      risks.push("双打守住位偏少");
      needs.push("双打配置中至少 3 只携带守住/看穿");
    }
    if (!coverage.fakeOut && !coverage.intimidate && !coverage.redirection) {
      risks.push("双打站场辅助不足");
      needs.push("补击掌奇袭、威吓、看我嘛/愤怒粉或广域防守");
    }
    if (!coverage.spreadDamage) needs.push("补岩崩、热风、魔法闪耀等范围压制");
  }

  for (const note of typeProfile.defensiveNotes) risks.push(note);
  for (const violation of legality.violations.slice(0, 4)) risks.push(violation);

  return {
    risks: [...new Set(risks)].slice(0, 10),
    strengths: [...new Set(strengths)].slice(0, 8),
    needs: [...new Set(needs)].slice(0, 10),
  };
}

function scoreTeam(team, format, coverage, legality, typeProfile) {
  const scoreParts = {
    fullTeam: Math.min(12, team.length * 2),
    speedControl: coverage.speedControl ? 14 : 0,
    roleBalance: coverage.physicalBreakers > 0 && coverage.specialBreakers > 0 ? 12 : 4,
    hazardPlan: format === "single" ? (coverage.hazardSetter ? 10 : 0) : 5,
    removal: format === "single" ? (coverage.hazardRemoval ? 8 : 0) : 4,
    setupOrPriority: coverage.setup || coverage.priority ? 12 : 0,
    pivot: coverage.pivot ? 8 : 0,
    doubleSafety: format === "double" ? Math.min(16, coverage.protectCount * 4 + (coverage.intimidate ? 4 : 0) + (coverage.fakeOut ? 3 : 0)) : 8,
    defensiveProfile: Math.max(0, 12 - typeProfile.stackedWeaknesses.length * 3),
    legality: Math.max(0, 12 - legality.violations.length * 3),
  };
  return {
    score: Math.min(100, Object.values(scoreParts).reduce((sum, value) => sum + value, 0)),
    scoreParts,
  };
}

export function buildBattleKnowledge(team = [], helpers = {}) {
  const format = helpers.format || "single";
  const members = team.map((mon) => memberProfile(mon, helpers));
  const roleCoverage = buildRoleCoverage(members);
  const typeProfile = buildTypeProfile(members);
  const legality = buildLegality(members);
  const recommendations = buildRecommendations(format, roleCoverage, typeProfile, legality);
  const { score, scoreParts } = scoreTeam(team, format, roleCoverage, legality, typeProfile);
  const stateTags = [...new Set(members.flatMap((item) => Object.entries(item.flags).filter(([, enabled]) => enabled).map(([key]) => key)))];

  return {
    sourceModel: "Pokemon Showdown rules + Smogon/Pokekipe usage summaries + local battle heuristics",
    format,
    score,
    scoreParts,
    risks: recommendations.risks,
    strengths: recommendations.strengths,
    needs: recommendations.needs,
    roleCoverage,
    typeProfile,
    legality,
    members,
    stateTags,
    formatChecklist:
      format === "double"
        ? ["守住数量", "控速轴", "击掌/威吓/掩护", "范围招式", "站位协作", "重复道具/Mega 限制"]
        : ["撒钉压力", "清场除钉", "强化或收尾点", "轮转中转", "属性弱点集中度", "重复道具/Mega 限制"],
  };
}
