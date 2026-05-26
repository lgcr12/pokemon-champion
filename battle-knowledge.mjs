const STAT_ALIASES = new Map([
  ["hp", "HP"],
  ["攻击", "Atk"],
  ["attack", "Atk"],
  ["atk", "Atk"],
  ["防御", "Def"],
  ["defense", "Def"],
  ["def", "Def"],
  ["特攻", "SpA"],
  ["special attack", "SpA"],
  ["spa", "SpA"],
  ["特防", "SpD"],
  ["special defense", "SpD"],
  ["spd", "SpD"],
  ["速度", "Spe"],
  ["speed", "Spe"],
  ["spe", "Spe"],
]);

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
        config.level || "",
        "",
        "",
        config.teraType || "",
      ];
      return fields.join("|");
    })
    .join("]");
}

export function buildBattleKnowledge(team = [], helpers = {}) {
  const getConfig = helpers.getConfig || (() => ({}));
  const stat = helpers.stat || (() => 0);
  const effectiveSpeed = helpers.effectiveSpeed || ((mon) => ({ value: stat(mon, "速度") || 0, label: "原速" }));
  const hasMove = helpers.hasMove || (() => false);
  const hasAbility = helpers.hasAbility || (() => false);
  const format = helpers.format || "single";

  const members = team.map((mon) => {
    const config = getConfig(mon);
    const moves = config.moves || [];
    const speed = effectiveSpeed(mon);
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
      level: config.level || "",
      moves,
      speed,
      flags: {
        hazard: moves.some((move) => /隐形岩|撒菱|毒菱|黏黏网/.test(move)),
        removal: moves.some((move) => /高速旋转|清除浓雾/.test(move)),
        setup: moves.some((move) => /剑舞|龙舞|诡计|冥想|健美|蝶舞|破壳/.test(move)),
        speedControl: moves.some((move) => /顺风|电磁波|戏法空间|冰冻之风|岩石封锁|黏黏网/.test(move)),
        pivot: moves.some((move) => /急速折返|伏特替换|抛下狠话|接棒/.test(move)),
        priority: moves.some((move) => /神速|突袭|子弹拳|水流喷射|冰砾|影子偷袭|音速拳|击掌奇袭/.test(move)),
        protect: moves.some((move) => /守住/.test(move)),
        taunt: moves.some((move) => /挑衅/.test(move)),
        intimidate: /威吓/.test(config.ability || "") || hasAbility(mon, /威吓/),
        groundImmune: (mon.types || []).includes("飞行") || hasAbility(mon, /漂浮/),
      },
    };
  });

  const scoreParts = {
    fullTeam: Math.min(12, team.length * 2),
    speedControl: members.some((item) => item.flags.speedControl) ? 14 : 0,
    hazardPlan: format === "single" ? (members.some((item) => item.flags.hazard) ? 10 : 0) : 5,
    removal: format === "single" ? (members.some((item) => item.flags.removal) ? 8 : 0) : 4,
    setupOrPriority: members.some((item) => item.flags.setup || item.flags.priority) ? 12 : 0,
    pivot: members.some((item) => item.flags.pivot) ? 8 : 0,
    doubleSafety: format === "double" ? Math.min(16, members.filter((item) => item.flags.protect).length * 4 + (members.some((item) => item.flags.intimidate) ? 4 : 0)) : 8,
    typeDiversity: Math.min(12, new Set(members.flatMap((item) => item.types)).size * 2),
    meta: Math.min(18, members.filter((item) => Number(item.rank) <= 30).length * 3),
  };
  const score = Math.min(100, Object.values(scoreParts).reduce((sum, value) => sum + value, 0));

  const risks = [];
  if (!members.some((item) => item.flags.speedControl)) risks.push("缺少稳定控速手段");
  if (format === "single" && !members.some((item) => item.flags.hazard)) risks.push("单打缺少撒场压力");
  if (format === "single" && !members.some((item) => item.flags.removal)) risks.push("单打缺少清场手段");
  if (format === "double" && members.filter((item) => item.flags.protect).length < 3) risks.push("双打守住位偏少");
  if (!members.some((item) => item.flags.groundImmune)) risks.push("地面免疫点不足");
  if (!members.some((item) => item.flags.setup || item.flags.priority)) risks.push("终盘收割路线不够明确");

  const strengths = [];
  if (members.some((item) => item.flags.speedControl)) strengths.push("已有控速点");
  if (members.some((item) => item.flags.pivot)) strengths.push("具备轮转入口");
  if (members.some((item) => item.flags.setup)) strengths.push("有强化终盘路线");
  if (members.some((item) => item.flags.priority)) strengths.push("有先制收残能力");
  if (members.some((item) => item.flags.intimidate)) strengths.push("有威吓压制物攻");

  return {
    format,
    score,
    scoreParts,
    risks,
    strengths,
    members,
    stateTags: [...new Set(members.flatMap((item) => Object.entries(item.flags).filter(([, enabled]) => enabled).map(([key]) => key)))],
  };
}
