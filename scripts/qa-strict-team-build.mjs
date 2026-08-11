import { strictBuildTeam } from "../server.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Dex } = require("pokemon-showdown");

function hasOverstackedType(team = []) {
  const counts = new Map();
  for (const member of team) {
    for (const type of Dex.species.get(member.slug).types || []) counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts.values()].some((count) => count > 2);
}

function baseFamilyKey(slug = "") {
  const species = Dex.species.get(slug);
  return String(species?.baseSpecies || slug).toLowerCase();
}

const cases = [
  { name: "单打默认平衡", body: { format: "single", intent: "new-team", userGoal: "", goalConstraints: {} }, expectOk: true },
  { name: "双打雨天顺风", body: { format: "double", intent: "new-team", userGoal: "雨天顺风", goalConstraints: { themes: ["rain", "tailwind"] } }, expectOk: true },
  { name: "双打雨天铝钢桥龙", body: { format: "double", intent: "new-team", userGoal: "双打雨天铝钢桥龙", goalConstraints: { themes: ["rain"], requiredPokemon: [{ id: 1018, slug: "archaludon", name: "铝钢桥龙" }] } }, expectOk: true, requiredSlug: "archaludon" },
  { name: "双打空间", body: { format: "double", intent: "new-team", userGoal: "空间队", goalConstraints: { themes: ["trick-room"] } }, expectOk: true },
  { name: "单打强化接棒", body: { format: "single", intent: "new-team", userGoal: "强化接棒", goalConstraints: { themes: ["pass-chain"] } }, expectOk: true },
  { name: "无可用核心", body: { format: "single", intent: "new-team", goalConstraints: { unavailablePokemon: [{ name: "不存在的宝可梦" }] } }, expectOk: false },
];

const failures = [];
const reports = cases.map(({ name, body, expectOk }) => {
  const result = strictBuildTeam(body);
  if (result.ok !== expectOk) failures.push(`${name}: 预期 ok=${expectOk}，实际 ok=${result.ok}`);
  if (result.ok) {
    if (result.team.length !== 6) failures.push(`${name}: 没有六只成员`);
    if (!result.team.every((member) => member.evidence?.season === "M-3" && member.evidence?.format === body.format)) failures.push(`${name}: 存在非 M-3 同格式配置证据`);
    if ((result.buildReport?.synergies || []).length < 2) failures.push(`${name}: 少于两条队友联动`);
    if ((result.buildReport?.mega?.secondary ? 2 : result.buildReport?.mega?.primary ? 1 : 0) > 2) failures.push(`${name}: Mega 规划超过两个`);
    if (body.requiredSlug && !result.team.some((member) => member.slug === body.requiredSlug)) failures.push(`${name}: 缺少指定核心 ${body.requiredSlug}`);
  } else if (!(result.diagnostics || []).length) {
    failures.push(`${name}: 缺少失败诊断`);
  }
  return { name, ok: result.ok, diagnostics: result.diagnostics || [], team: result.team?.map((member) => member.slug) || [] };
});

const base = strictBuildTeam({ format: "single", intent: "new-team", userGoal: "", goalConstraints: {} });
if (!base.ok) {
  failures.push("改队模式前置构筑失败");
} else {
  const currentTeam = base.team.map((member) => ({ id: member.id, slug: member.slug, name: member.name }));
  for (const intent of ["current-team", "complete-team", "moveset-only"]) {
    const result = strictBuildTeam({ format: "single", intent, userGoal: "", goalConstraints: {}, currentTeam });
    if (!result.ok || result.team.length !== 6) failures.push(`${intent}: 未能在验证配置下完成队伍处理`);
    reports.push({ name: intent, ok: result.ok, diagnostics: result.diagnostics || [], team: result.team?.map((member) => member.slug) || [] });
  }
}

const aiDesigned = strictBuildTeam({
  format: "double",
  intent: "new-team",
  buildMethod: "ai-designed",
  userGoal: "rain archaludon",
  goalConstraints: { themes: ["rain"], requiredPokemon: [{ slug: "archaludon", name: "Archaludon" }] },
  aiDraft: { pokemon: ["scizor", "basculegion", "archaludon", "sableye", "pelipper", "dragonite"], rationale: "QA AI-designed draft" },
});
if (!aiDesigned.ok || aiDesigned.team?.length !== 6) {
  failures.push("ai-designed: strict validation could not complete the AI draft");
} else if (!aiDesigned.buildReport?.aiDesign || aiDesigned.buildReport?.source) {
  failures.push("ai-designed: result did not preserve the AI-design audit trail");
} else if ((aiDesigned.buildReport.aiDesign.retained || []).length < 4) {
  failures.push("ai-designed: a coherent verified AI draft was unnecessarily replaced instead of being retained");
}
reports.push({ name: "ai-designed", ok: aiDesigned.ok, diagnostics: aiDesigned.diagnostics || [], team: aiDesigned.team?.map((member) => member.slug) || [] });

const reportedAIDraft = strictBuildTeam({
  format: "double",
  intent: "new-team",
  buildMethod: "ai-designed",
  userGoal: "",
  goalConstraints: {},
  aiDraft: { pokemon: ["drampa", "kingambit", "primarina", "mimikyu", "amoonguss", "slowking-galar"], rationale: "Reported AI draft regression" },
});
if (!reportedAIDraft.ok || reportedAIDraft.team?.length !== 6) failures.push("reported-ai-draft: ordinary damaging moves were incorrectly rejected as lacking a win condition");
reports.push({ name: "reported-ai-draft", ok: reportedAIDraft.ok, diagnostics: reportedAIDraft.diagnostics || [], team: reportedAIDraft.team?.map((member) => member.slug) || [] });

const setupTeam = strictBuildTeam({
  format: "double",
  intent: "new-team",
  buildMethod: "ai-designed",
  userGoal: "强化队",
  goalConstraints: {},
  aiDraft: { pokemon: ["scizor", "kingambit", "mimikyu", "kommo-o", "ceruledge", "garchomp"], aiSelected: ["scizor", "kingambit", "mimikyu", "kommo-o", "ceruledge", "garchomp"], variationSeed: "setup-regression" },
});
const setupPattern = /swords-dance|nasty-plot|calm-mind|dragon-dance|bulk-up|iron-defense|belly-drum|focus-energy/;
const setupCount = setupTeam.team?.filter((member) => member.moves?.some((move) => setupPattern.test(move))).length || 0;
if (!setupTeam.ok || setupCount !== 2) failures.push(`setup-team: expected exactly two verified setup cores, got ${setupCount}`);
reports.push({ name: "setup-team", ok: setupTeam.ok, diagnostics: setupTeam.diagnostics || [], team: setupTeam.team?.map((member) => member.slug) || [] });

const blazikenPass = strictBuildTeam({
  format: "double",
  intent: "new-team",
  buildMethod: "ai-designed",
  userGoal: "\u53cc\u6253\u706b\u7130\u9e21\u63a5\u68d2\u961f",
  goalConstraints: {},
  aiDraft: { pokemon: ["espathra", "scizor", "armarouge", "rotom-wash", "talonflame", "rotom-heat"] },
});
const blazikenPasser = blazikenPass.team?.find((member) => member.slug === "blaziken" && member.moves?.includes("baton-pass") && member.moves.some((move) => setupPattern.test(move)));
if (!blazikenPass.ok || !blazikenPasser) {
  failures.push("hard-constraint: M-3 double Blaziken pass-chain did not preserve the required core and its verified baton-pass configuration");
}
if (blazikenPass.team?.some((member) => member.moves?.includes("trick-room"))) {
  failures.push("hard-constraint: unrequested Trick Room leaked into the Blaziken pass-chain team");
}
if (hasOverstackedType(blazikenPass.team)) failures.push("hard-constraint: Blaziken pass-chain overstacked a defensive type");
reports.push({ name: "blaziken-pass", ok: blazikenPass.ok, diagnostics: blazikenPass.diagnostics || [], team: blazikenPass.team?.map((member) => member.slug) || [] });

const passChain = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253\u63a5\u68d2\u961f", goalConstraints: { themes: ["pass-chain"] } });
const passers = passChain.team?.filter((member) => member.moves?.includes("baton-pass") && member.moves.some((move) => setupPattern.test(move))) || [];
const receiver = passChain.team?.find((member) => !passers.includes(member) && member.moves?.some((move) => !setupPattern.test(move) && move !== "baton-pass")) || null;
if (!passChain.ok || passers.length !== 1 || !receiver || !(passChain.buildReport?.synergies || []).some((line) => line.includes("\u5148\u5f3a\u5316\u518d\u63a5\u68d2"))) {
  failures.push("pass-chain: result is missing a verified passer, receiver, or explicit transfer synergy");
}
const transferLine = passChain.buildReport?.synergies?.find((line) => line.includes("\u5148\u5f3a\u5316\u518d\u63a5\u68d2")) || "";
const configuredReceiver = passChain.team?.find((member) => !passers.includes(member) && member.moves?.some((move) => setupPattern.test(move)) && transferLine.includes(member.name));
if (!configuredReceiver) failures.push("pass-chain: the reported receiver is not an actual configured win condition");
reports.push({ name: "pass-chain", ok: passChain.ok, diagnostics: passChain.diagnostics || [], team: passChain.team?.map((member) => member.slug) || [] });

const sunTeam = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253\u6674\u5929\u4e5d\u5c3e", goalConstraints: { themes: ["sun"], requiredPokemon: [{ slug: "ninetales", name: "\u4e5d\u5c3e" }] } });
const sunConflictingPayoff = /swift-swim|thunder|hurricane|electro-shot|sand-rush|sand-force|slush-rush|aurora-veil/;
if (!sunTeam.ok || !sunTeam.team?.some((member) => member.slug === "ninetales") || sunTeam.team?.some((member) => sunConflictingPayoff.test(`${member.ability} ${member.moves?.join(" ")}`))) {
  failures.push("sun-team: selected a weather-conflicting Thunder or Hurricane configuration, or lost Ninetales");
}
if (hasOverstackedType(sunTeam.team)) failures.push("sun-team: overstacked a defensive type instead of preserving switch options");
reports.push({ name: "sun-team", ok: sunTeam.ok, diagnostics: sunTeam.diagnostics || [], team: sunTeam.team?.map((member) => member.slug) || [] });

const trickRoomTeam = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253\u7a7a\u95f4\u961f", goalConstraints: { themes: ["trick-room"] } });
const trickRoomText = trickRoomTeam.team?.map((member) => `${member.ability} ${member.moves?.join(" ")}`).join(" ") || "";
const lowSpeedAttackers = trickRoomTeam.team?.filter((member) => Dex.species.get(member.slug).baseStats?.spe <= 65 && member.moves?.some((move) => {
  const data = Dex.moves.get(move);
  return data.category !== "Status" && Number(data.basePower || 0) >= 70;
})) || [];
if (!trickRoomTeam.ok || !trickRoomTeam.team?.some((member) => member.moves?.includes("trick-room")) || /tailwind|drizzle|rain-dance|drought|sunny-day|sand-stream|sandstorm|snow-warning|snowscape/.test(trickRoomText) || lowSpeedAttackers.length < 2) {
  failures.push("trick-room: leaked a conflicting weather/tailwind axis or lacks two real low-speed attackers");
}
reports.push({ name: "trick-room-structure", ok: trickRoomTeam.ok, diagnostics: trickRoomTeam.diagnostics || [], team: trickRoomTeam.team?.map((member) => member.slug) || [] });

const rainSourcePriority = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253\u96e8\u5929\u94dd\u94a2\u6865\u9f99", goalConstraints: { themes: ["rain"], requiredPokemon: [{ slug: "archaludon", name: "\u94dd\u94a2\u6865\u9f99" }] } });
const hasDrizzleSource = rainSourcePriority.team?.some((member) => member.ability === "drizzle");
const scarfSpeedClaims = (rainSourcePriority.team || [])
  .filter((member) => member.item === "choice-scarf")
  .some((member) => (rainSourcePriority.buildReport?.synergies || []).some((line) => line.includes(`${member.name} \u7684\u63a7\u901f`)));
if (!rainSourcePriority.ok || !hasDrizzleSource || !rainSourcePriority.buildReport?.risks?.some((line) => line.includes("\u5927\u5634\u9e25")) || !rainSourcePriority.buildReport?.plan?.includes("\u5927\u5634\u9e25") || scarfSpeedClaims) {
  failures.push("weather-source: weather report did not prefer the actual ability setter over a secondary move setter");
}
reports.push({ name: "rain-source-priority", ok: rainSourcePriority.ok, diagnostics: rainSourcePriority.diagnostics || [], team: rainSourcePriority.team?.map((member) => member.slug) || [] });

const rainRetry = strictBuildTeam({
  format: "double",
  intent: "new-team",
  userGoal: "\u53cc\u6253\u96e8\u5929\u94dd\u94a2\u6865\u9f99",
  goalConstraints: { themes: ["rain"], requiredPokemon: [{ slug: "archaludon", name: "\u94dd\u94a2\u6865\u9f99" }] },
  avoidTeam: (rainSourcePriority.team || []).map((member) => member.slug),
});
const rainRetryOverlap = rainRetry.team?.filter((member) => (rainSourcePriority.team || []).some((previous) => baseFamilyKey(previous.slug) === baseFamilyKey(member.slug))).length || 0;
if (!rainRetry.ok || rainRetryOverlap > 4 || !rainRetry.team?.some((member) => member.slug === "archaludon")) {
  failures.push("retry-variation: rebuilding a strict rain team repeated too much of the previous team or lost the hard core");
}
reports.push({ name: "rain-retry-variation", ok: rainRetry.ok, diagnostics: rainRetry.diagnostics || [], team: rainRetry.team?.map((member) => member.slug) || [] });

for (const [name, body] of [
  ["variation-default-single", { format: "single", intent: "new-team", userGoal: "单打平衡队", goalConstraints: {} }],
  ["variation-sun", { format: "double", intent: "new-team", userGoal: "双打晴天九尾", goalConstraints: { themes: ["sun"], requiredPokemon: [{ slug: "ninetales", name: "九尾" }] } }],
  ["variation-trick-room", { format: "double", intent: "new-team", userGoal: "双打空间队", goalConstraints: { themes: ["trick-room"] } }],
]) {
  const first = strictBuildTeam({ ...body, variationSeed: `${name}-first` });
  const second = first.ok ? strictBuildTeam({ ...body, variationSeed: `${name}-second`, avoidTeams: [first.team.map((member) => member.slug)] }) : null;
  const third = second?.ok ? strictBuildTeam({ ...body, variationSeed: `${name}-third`, avoidTeams: [first.team.map((member) => member.slug), second.team.map((member) => member.slug)] }) : null;
  const overlap = (left = [], right = []) => left.filter((member) => right.some((other) => baseFamilyKey(member.slug) === baseFamilyKey(other.slug))).length;
  if (!first.ok || !second?.ok || !third?.ok || overlap(first.team, second.team) > 4 || overlap(first.team, third.team) > 4 || overlap(second.team, third.team) > 4) {
    failures.push(`${name}: repeated generation did not produce three independently varied valid teams`);
  }
  reports.push({ name, ok: Boolean(first.ok && second?.ok && third?.ok), diagnostics: [first.diagnostics, second?.diagnostics, third?.diagnostics].filter(Boolean), teams: [first.team, second?.team, third?.team].map((team) => team?.map((member) => member.slug) || []) });
}

for (const [theme, label, sourcePattern, payoffPattern, conflictPattern] of [
  ["sand", "sand-team", /sand-stream|sandstorm/, /sand-rush|sand-force/, /swift-swim|thunder|hurricane|electro-shot|chlorophyll|solar-power|solar-beam|slush-rush|aurora-veil/],
  ["snow", "snow-team", /snow-warning|snowscape/, /slush-rush|aurora-veil|blizzard/, /swift-swim|thunder|hurricane|electro-shot|chlorophyll|solar-power|solar-beam|sand-rush|sand-force/],
]) {
  const result = strictBuildTeam({ format: "double", intent: "new-team", userGoal: `\u53cc\u6253${theme}\u961f`, goalConstraints: { themes: [theme] } });
  const text = result.team?.map((member) => `${member.ability} ${member.moves?.join(" ")}`).join(" ") || "";
  const families = result.team?.map((member) => String(Dex.species.get(member.slug).baseSpecies || member.slug).toLowerCase()) || [];
  if (!result.ok || !sourcePattern.test(text) || !payoffPattern.test(text) || conflictPattern.test(text) || new Set(families).size !== families.length) {
    failures.push(`${label}: lacks a verified system loop, leaked a conflicting payoff, or duplicated a base species`);
  }
  reports.push({ name: label, ok: result.ok, diagnostics: result.diagnostics || [], team: result.team?.map((member) => member.slug) || [] });
}

const balanceTeam = strictBuildTeam({ format: "single", intent: "new-team", userGoal: "\u5355\u6253\u5e73\u8861\u961f", goalConstraints: {} });
const unexpectedWeather = balanceTeam.team?.some((member) => /pelipper|politoed|torkoal|ninetales|tyranitar|hippowdon|gigalith|abomasnow/.test(member.slug || ""));
const weatherDependentAbility = balanceTeam.team?.some((member) => /swift-swim|chlorophyll|sand-rush|sand-force|slush-rush|solar-power/.test(member.ability || ""));
if (!balanceTeam.ok || unexpectedWeather || weatherDependentAbility) failures.push("balance-team: unrequested weather source or weather-only payoff leaked into the default balance construction");
reports.push({ name: "balance-team", ok: balanceTeam.ok, diagnostics: balanceTeam.diagnostics || [], team: balanceTeam.team?.map((member) => member.slug) || [] });

const configuredHardConstraints = strictBuildTeam({
  format: "double",
  intent: "new-team",
  userGoal: "\u53cc\u6253\u706b\u7130\u9e21\u63a5\u68d2\u961f",
  goalConstraints: {
    themes: ["pass-chain"],
    requiredPokemon: [{ slug: "blaziken", name: "\u706b\u7130\u9e21" }],
    requiredMoves: ["baton-pass"],
    requiredItems: ["focus-sash"],
    requiredAbilities: ["speed-boost"],
    forbiddenPokemon: [{ slug: "incineroar", name: "\u70bd\u7130\u54ae\u54ee\u864e" }],
  },
});
const constrainedBlaziken = configuredHardConstraints.team?.find((member) => member.slug === "blaziken");
if (!configuredHardConstraints.ok || !constrainedBlaziken || constrainedBlaziken.item !== "focus-sash" || constrainedBlaziken.ability !== "speed-boost" || !constrainedBlaziken.moves.includes("baton-pass") || configuredHardConstraints.team?.some((member) => member.slug === "incineroar")) {
  failures.push("config-hard-constraints: required move/item/ability or forbidden Pokemon was not respected");
}
reports.push({ name: "config-hard-constraints", ok: configuredHardConstraints.ok, diagnostics: configuredHardConstraints.diagnostics || [], team: configuredHardConstraints.team?.map((member) => member.slug) || [] });

const boundConfigConstraints = strictBuildTeam({
  format: "double",
  intent: "new-team",
  userGoal: "双打火焰鸡接棒队",
  goalConstraints: {
    themes: ["pass-chain"],
    requiredPokemon: [{ slug: "blaziken", name: "火焰鸡" }],
    requiredMoves: [{ pokemonSlug: "blaziken", move: "baton-pass" }],
    requiredItems: [{ pokemonSlug: "blaziken", item: "focus-sash" }],
    requiredAbilities: [{ pokemonSlug: "blaziken", ability: "speed-boost" }],
  },
});
const boundBlaziken = boundConfigConstraints.team?.find((member) => member.slug === "blaziken");
if (!boundConfigConstraints.ok || !boundBlaziken || boundBlaziken.item !== "focus-sash" || boundBlaziken.ability !== "speed-boost" || !boundBlaziken.moves.includes("baton-pass")) {
  failures.push("bound-config-hard-constraints: object-form requirements were rejected or not bound to Blaziken");
}
reports.push({ name: "bound-config-hard-constraints", ok: boundConfigConstraints.ok, diagnostics: boundConfigConstraints.diagnostics || [], team: boundConfigConstraints.team?.map((member) => member.slug) || [] });

const impossibleMove = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253", goalConstraints: { requiredMoves: ["not-a-real-move"] } });
if (impossibleMove.ok || !impossibleMove.diagnostics?.some((line) => line.includes("not-a-real-move"))) failures.push("config-hard-constraints: unavailable required move did not produce a clear diagnostic");
reports.push({ name: "impossible-required-move", ok: impossibleMove.ok, diagnostics: impossibleMove.diagnostics || [], team: impossibleMove.team?.map((member) => member.slug) || [] });

const textForbidden = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253\u63a5\u68d2\u961f\uff0c\u4e0d\u8981\u70bd\u7130\u5486\u54ee\u864e", goalConstraints: { themes: ["pass-chain"] } });
if (!textForbidden.ok || textForbidden.team?.some((member) => member.slug === "incineroar")) failures.push("text-forbidden: a Pokemon named after 不要 was still selected as a core");
reports.push({ name: "text-forbidden", ok: textForbidden.ok, diagnostics: textForbidden.diagnostics || [], team: textForbidden.team?.map((member) => member.slug) || [] });

const contradictoryCore = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253", goalConstraints: { requiredPokemon: [{ slug: "blaziken", name: "\u706b\u7130\u9e21" }], forbiddenPokemon: [{ slug: "blaziken", name: "\u706b\u7130\u9e21" }] } });
if (contradictoryCore.ok || !contradictoryCore.diagnostics?.some((line) => line.includes("\u51b2\u7a81"))) {
  failures.push("contradictory-hard-constraint: required and forbidden Pokemon did not produce a diagnostic");
}
reports.push({ name: "contradictory-hard-constraint", ok: contradictoryCore.ok, diagnostics: contradictoryCore.diagnostics || [], team: contradictoryCore.team?.map((member) => member.slug) || [] });

const fullSampleBan = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253\u96e8\u5929\u94dd\u94a2\u6865\u9f99", goalConstraints: { themes: ["rain"], requiredPokemon: [{ slug: "archaludon", name: "\u94dd\u94a2\u6865\u9f99" }], forbiddenPokemon: [{ slug: "scizor", name: "\u5de8\u94b3\u87b3\u8782" }] } });
if (!fullSampleBan.ok || fullSampleBan.team?.some((member) => member.slug === "scizor") || !fullSampleBan.team?.some((member) => member.slug === "archaludon")) {
  failures.push("forbidden-full-sample: a banned Pokemon leaked through the complete-sample path");
}
reports.push({ name: "forbidden-full-sample", ok: fullSampleBan.ok, diagnostics: fullSampleBan.diagnostics || [], team: fullSampleBan.team?.map((member) => member.slug) || [] });

const exactForm = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253", goalConstraints: { requiredPokemon: [{ slug: "rotom-wash", name: "\u6e05\u6d17\u6d1b\u6258\u59c6" }] } });
if (!exactForm.ok || !exactForm.team?.some((member) => member.slug === "rotom-wash") || exactForm.team?.some((member) => member.slug === "rotom")) {
  failures.push("form-hard-constraint: the exact requested form was not preserved or duplicated with its base species");
}
reports.push({ name: "form-hard-constraint", ok: exactForm.ok, diagnostics: exactForm.diagnostics || [], team: exactForm.team?.map((member) => member.slug) || [] });

const whiteHerbCore = strictBuildTeam({ format: "double", intent: "new-team", userGoal: "\u53cc\u6253", goalConstraints: { requiredPokemon: [{ slug: "sneasler", name: "\u5927\u72c3\u62c9" }] } });
const whiteHerbSneasler = whiteHerbCore.team?.find((member) => member.slug === "sneasler");
if (!whiteHerbCore.ok || whiteHerbSneasler?.item !== "white-herb" || /Mega/.test(whiteHerbSneasler?.note || "") || whiteHerbCore.buildReport?.mega?.primary === whiteHerbSneasler?.name) {
  failures.push("mega-item-detection: white-herb was incorrectly treated as a Mega stone");
}
reports.push({ name: "mega-item-detection", ok: whiteHerbCore.ok, diagnostics: whiteHerbCore.diagnostics || [], team: whiteHerbCore.team?.map((member) => member.slug) || [] });

const evolution = strictBuildTeam({
  format: "double",
  intent: "new-team",
  buildMethod: "evolution",
  variationSeed: "qa-evolution-rain",
  userGoal: "rain archaludon",
  goalConstraints: { themes: ["rain"], requiredPokemon: [{ slug: "archaludon", name: "Archaludon" }] },
});
const evolutionTeams = (evolution.alternatives || []).map((variant) => variant.team?.map((member) => member.slug) || []);
const evolutionMaxShared = evolutionTeams.flatMap((team, index) => evolutionTeams.slice(index + 1).map((other) => team.filter((slug) => other.includes(slug)).length));
if (!evolution.ok || evolution.buildMethod !== "evolution" || evolution.buildReport?.evolution?.generations !== 4 || evolutionTeams.length < 2 || !evolutionTeams.every((team) => team.length === 6 && team.includes("archaludon")) || new Set(evolutionTeams.map((team) => team.join("|"))).size < 2 || evolutionMaxShared.some((shared) => shared > 3)) {
  failures.push("evolution-search: expected four generations and at least two distinct legal rain Archaludon candidates");
}
reports.push({ name: "evolution-search", ok: evolution.ok, diagnostics: evolution.diagnostics || [], team: evolution.team?.map((member) => member.slug) || [] });

console.log(JSON.stringify({ ok: failures.length === 0, failures, reports }, null, 2));
if (failures.length) process.exitCode = 1;
