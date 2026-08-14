import { createHash } from "node:crypto";

import { readFileSync } from "node:fs";

export const POKECAMP_TEAM_URL = "https://pokecamp.cc/zh/champions/vgc-teams";
export const POKECAMP_BUILD_URL = "https://pokecamp.cc/zh/champions/team-builds";

const ZH = {
  single: "\u5355\u6253",
  double: "\u53cc\u6253",
  moves: "\u62db\u5f0f",
  item: "\u9053\u5177",
  ability: "\u7279\u6027",
  nature: "\u6027\u683c",
  tera: "\u592a\u6676\u5c5e\u6027",
  role: "\u529f\u80fd\u5b9a\u4f4d",
  notes: "\u8bf4\u660e",
  playstyle: "\u73a9\u6cd5",
  team: "\u961f\u4f0d",
  pokemon: "\u5b9d\u53ef\u68a6",
  intro: "\u961f\u4f0d\u4ecb\u7ecd",
  leads: "\u9996\u53d1",
  core: "\u6838\u5fc3",
  matchup: "\u5bf9\u5c40\u601d\u8def",
  remarks: "\u5907\u6ce8",
  strategy: "\u5bf9\u6218\u601d\u8def",
};

const text = (value) => String(value ?? "").trim();
const first = (...values) => values.map(text).find(Boolean) || "";
const array = (value) => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
const valueOf = (object, ...keys) => keys.map((key) => object?.[key]).find((value) => value !== undefined && value !== null && value !== "") ?? "";

function compact(value) {
  return text(value).replace(/[\s\u00a0]+/g, "");
}

function loadKnownMoveNames() {
  const names = new Set();
  try {
    const dictionary = JSON.parse(readFileSync(new URL("../data/zh-hans-terms.json", import.meta.url), "utf8")).moves || {};
    Object.values(dictionary).forEach((name) => { if (name) names.add(compact(name)); });
  } catch { /* 本地词典不存在时仍使用结构化行解析 */ }
  return names;
}

const KNOWN_MOVE_NAMES = loadKnownMoveNames();

function sectionAfter(label, value = "") {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => line === label || line.startsWith(`${label}:`));
  if (index < 0) return "";
  const sameLine = lines[index].slice(label.length).replace(/^\s*[:：]\s*/, "").trim();
  const stop = lines.slice(index + 1).findIndex((line) => /^(道具|性格|特性|能力点数|努力值|推荐能力点数|能力点数推荐|招式|太晶属性|等级)$/.test(line));
  const values = lines.slice(index + 1, stop < 0 ? index + 2 : index + 1 + stop);
  return sameLine || values.join(" ");
}

function splitAbilityChain(value = "") {
  return String(value || "")
    .replace(/推荐(?:的)?(?:能力点数|努力值|配点)|能力点数推荐/g, "")
    .split(/\s*(?:→|->|=>)\s*/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function lineAfter(label, value = "") {
  const result = sectionAfter(label, value);
  return result.split(" ")[0] || "";
}

function parseStats(value = "") {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => line === "能力点数" || line === "努力值");
  const end = lines.findIndex((line, index) => index > start && line === "招式");
  if (start < 0) return "";
  const values = lines.slice(start + 1, end < 0 ? lines.length : end);
  const inlinePairs = [...values.join(" ").matchAll(/(HP|攻击|防御|特攻|特防|速度)\s*[:：]?\s*(\d+)/g)]
    .map((match) => `${match[1]} ${match[2]}`);
  if (inlinePairs.length) return inlinePairs.join(" / ");
  const pairs = [];
  for (let index = 0; index < values.length - 1; index += 1) {
    if (/^\d+$/.test(values[index + 1])) pairs.push(`${values[index]} ${values[index + 1]}`);
  }
  return pairs.join(" / ");
}

function parseActualStats(value = "") {
  const match = String(value || "").match(/实数值\s*([0-9]+(?:\s*-\s*[0-9]+){5})/s);
  return match?.[1]?.replace(/\s+/g, "") || "";
}

function moveNamesFromHtml(html = "") {
  return [...String(html || "").matchAll(/href=["'][^"']+\/zh\/moves\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => compact(String(match[1] || "").replace(/<[^>]+>/g, "")))
    .filter(Boolean)
    .slice(0, 4);
}

function parseMoves(value = {}) {
  const fromHtml = moveNamesFromHtml(value.html || "");
  if (fromHtml.length) return fromHtml;
  const lines = String(value.text || value.detailText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const moveStart = lines.findIndex((line) => line === "招式");
  if (moveStart < 0) return [];
  const moves = [];
  for (const line of lines.slice(moveStart + 1)) {
    if (/^(能力点数|努力值|实数值|道具|性格|特性|太晶属性|等级)$/.test(line)) break;
    if (KNOWN_MOVE_NAMES.has(compact(line))) {
      moves.push(line);
      if (moves.length >= 4) break;
      continue;
    }
    if (/[。！？；，：:]/.test(line) || line.length > 18 || /^(调整|以前|这个队伍|至少|连败|只要|不需要|被|和|剩下|负责|本构筑)/.test(line)) break;
    moves.push(line);
    if (moves.length >= 4) break;
  }
  return moves.slice(0, 4);
}

function parseDetailConfiguration(value = {}) {
  const raw = text(value.text || value.detailText || value.html || "");
  const item = sectionAfter("道具", raw);
  const nature = sectionAfter("性格", raw);
  const abilities = splitAbilityChain(sectionAfter("特性", raw));
  const ability = abilities.join(" → ");
  const stats = parseStats(raw);
  const actualStats = parseActualStats(raw);
  const moves = parseMoves({ ...value, text: raw });
  return {
    ...value,
    name: first(value.name, value.species, value.localizedName),
    item,
    ability,
    abilities,
    abilityTransition: abilities.length > 1,
    nature,
    stats,
    actualStats,
    moves,
    notes: raw ? [raw] : [],
  };
}

function parseDetailText(value = {}, members = []) {
  const raw = text(value.detailText || value.strategy || "");
  if (!raw || !/道具|性格|特性|招式/.test(raw)) return [];
  const names = members.map((member) => text(member.name || member.localizedName)).filter(Boolean);
  if (!names.length) return [];

  // The article introduction mentions team members many times. A real set
  // header is the occurrence whose next label is 道具 within the same block.
  // This avoids treating an introductory mention as the start of a set.
  const candidates = [];
  for (const name of names) {
    let offset = 0;
    while (offset < raw.length) {
      const index = raw.indexOf(name, offset);
      if (index < 0) break;
      const afterName = raw.slice(index + name.length, index + name.length + 180);
      const itemOffset = afterName.search(/(?:\r?\n\s*)?道具(?:\s*[:：])?/);
      const labels = afterName.match(/道具|性格|特性|能力点数|招式/g) || [];
      if (itemOffset >= 0 && itemOffset < 130 && labels.length >= 2) {
        candidates.push({ name, index, score: labels.length * 10 - itemOffset });
      }
      offset = index + Math.max(1, name.length);
    }
  }
  const selected = names.map((name) => candidates
    .filter((candidate) => candidate.name === name)
    .sort((left, right) => right.score - left.score || right.index - left.index)[0]).filter(Boolean);
  const unique = [...new Map(selected.map((candidate) => [candidate.name, candidate])).values()]
    .sort((left, right) => left.index - right.index);
  return unique.map((candidate, index) => {
    const next = unique[index + 1]?.index ?? raw.length;
    return parseDetailConfiguration({
      name: candidate.name,
      text: raw.slice(candidate.index, next),
    });
  }).filter((item) => item.name && (item.item || item.ability || item.nature || item.moves.length));
}

function slug(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function identityKey(value) {
  const raw = compact(value).toLowerCase();
  return slug(raw) || raw;
}

function formatOf(value = {}) {
  const raw = first(valueOf(value, "format", "battleType", "mode", "formatLabel", "type")).toLowerCase();
  if (/double|vgc/.test(raw) || raw.includes(ZH.double)) return "double";
  if (/single|bss|singles/.test(raw) || raw.includes(ZH.single)) return "single";
  return "";
}

function normalizeMember(value = {}) {
  if (typeof value === "string") return { id: 0, slug: value, name: value };
  const memberSlug = valueOf(value, "slug", "speciesId", "pokemonId", "species", "name", "id");
  return {
    id: Number(valueOf(value, "dex", "nationalDex", "num", "pokedexNumber")) || 0,
    slug: memberSlug,
    name: first(valueOf(value, "name", "species", "localizedName"), memberSlug),
    localizedName: valueOf(value, "localizedName", "nameZh", "chineseName"),
    sprite: valueOf(value, "sprite", "spriteUrl", "image", "imageUrl"),
    item: valueOf(value, "item", "heldItem"),
  };
}

function normalizeConfiguration(value = {}, fallbackMember = {}, index = 0) {
  const rawMoves = valueOf(value, "moves", "moveSet", "skills", ZH.moves);
  const moves = array(rawMoves).map((move) => typeof move === "string" ? move : valueOf(move, "name", "id", "move", "localizedName")).filter(Boolean).slice(0, 4);
  const rawEvs = value?.evs;
  const evs = rawEvs && typeof rawEvs === "object" && !Array.isArray(rawEvs) ? rawEvs : {};
  const stats = first(valueOf(value, "stats", "statSpread", "evsText", "effortValues"), typeof rawEvs === "string" ? rawEvs : "");
  const configSlug = first(valueOf(value, "slug", "speciesId", "pokemonId", "species", "name"), fallbackMember.slug, fallbackMember.name);
  const notes = array(valueOf(value, "notes", "usage", "strategy", "playstyle", ZH.playstyle, ZH.notes)).map(text).filter(Boolean).slice(0, 8);
  const abilities = splitAbilityChain(valueOf(value, "ability", "abilityId", ZH.ability));
  return {
    id: first(valueOf(value, "id", "configurationId", "setId"), `${slug(configSlug)}-${index + 1}`),
    slug: configSlug,
    name: first(valueOf(value, "name", "species"), fallbackMember.name, configSlug),
    item: valueOf(value, "item", "heldItem", "itemId", ZH.item),
    ability: abilities.join(" → "),
    abilities,
    abilityTransition: abilities.length > 1,
    nature: valueOf(value, "nature", "natureId", ZH.nature),
    stats: stats || (Object.keys(evs).length ? evs : ""),
    actualStats: first(valueOf(value, "actualStats", "realStats", "actualValues"), parseActualStats(value.text || value.detailText || "")),
    evs: Object.keys(evs).length ? evs : undefined,
    ivs: value?.ivs && typeof value.ivs === "object" ? value.ivs : undefined,
    level: Number(value?.level || 50),
    teraType: valueOf(value, "teraType", "terastalType", ZH.tera),
    role: valueOf(value, "role", "position", "function", ZH.role),
    notes,
    moves,
  };
}

function rawMembers(value = {}) {
  return array(valueOf(value, "members", "pokemon", "pokemons", "slots", "team", ZH.team, ZH.pokemon));
}

function rawConfigurations(value = {}) {
  const explicit = array(valueOf(value, "configurations", "sets", "builds", "pokemonBuilds", "configs", "config", ZH.playstyle))
    .filter((item) => item && (valueOf(item, "item", "ability", "nature", "moves", "evs", "stats", "detailText") || (Array.isArray(item.moves) && item.moves.length)));
  const detail = array(valueOf(value, "detailConfigurations", "detailConfigs"));
  const uniqueDetail = [...new Map(detail.map((item) => [valueOf(item, "href", "url", "name", "species"), item])).values()];
  return explicit.length ? explicit : uniqueDetail.map(parseDetailConfiguration);
}

function alignConfigurations(configurations = [], members = []) {
  const remaining = [...configurations];
  const ordered = [];
  for (const member of members) {
    const memberKey = identityKey(member.name || member.localizedName || member.slug);
    const index = remaining.findIndex((configuration) => {
      const configKey = identityKey(configuration.name || configuration.species || configuration.slug);
      return configKey && (configKey === memberKey || configKey.includes(memberKey) || memberKey.includes(configKey));
    });
    if (index >= 0) ordered.push(remaining.splice(index, 1)[0]);
  }
  return [...ordered, ...remaining];
}

function stableTeamId(team) {
  return createHash("sha1").update(JSON.stringify({
    sourceUrl: team.sourceUrl,
    sourcePageType: team.sourcePageType,
    title: team.title,
    format: team.format,
    regulation: team.regulation,
    season: team.season,
    rentalCode: team.rentalCode,
    members: team.members.map((item) => slug(item.slug || item.name)),
  })).digest("hex").slice(0, 12);
}

function canonicalSourceKey(team = {}) {
  const pageType = team.sourcePageType === "team-builds-single" ? "team-builds" : team.sourcePageType || "";
  return [
    String(team.source || "").toLowerCase(),
    pageType,
    String(team.season || team.regulation || ""),
    String(team.title || ""),
  ].join("::");
}

function memberSignature(team = {}) {
  return (team.members || []).map((member) => identityKey(member.name || member.localizedName || member.slug)).join("|");
}

function isGeneratedPokecampTitle(value = "") {
  return /^PokéCamp\s+.+\s+p\d+-\d+$/i.test(text(value));
}

function normalizedPageType(value = "") {
  return value === "team-builds-single" ? "team-builds" : value;
}

function configurationQuality(team = {}) {
  return (team.configurations || []).reduce((score, configuration) => score + [
    configuration.item,
    configuration.ability,
    configuration.nature,
    configuration.stats,
    configuration.moves?.length,
    configuration.evs && Object.keys(configuration.evs).length,
  ].filter(Boolean).length, 0);
}

function mergeConfigurationFields(previous = {}, imported = {}) {
  const merged = { ...previous, ...imported };
  for (const field of ["item", "ability", "nature", "stats", "actualStats", "teraType", "role", "evs", "ivs", "level"]) {
    if (imported[field] === undefined || imported[field] === null || imported[field] === "" || (typeof imported[field] === "object" && !Object.keys(imported[field]).length)) merged[field] = previous[field] ?? imported[field];
  }
  for (const field of ["moves", "notes", "noteLinks", "moveLabels"]) {
    if (!Array.isArray(imported[field]) || imported[field].length === 0) merged[field] = previous[field] || imported[field] || [];
  }
  return merged;
}

function mergeConfigurationSets(previous = [], imported = []) {
  const previousByKey = new Map(previous.map((configuration) => [identityKey(configuration.name || configuration.localizedName || configuration.slug), configuration]));
  return imported.map((configuration) => {
    const key = identityKey(configuration.name || configuration.localizedName || configuration.slug);
    return mergeConfigurationFields(previousByKey.get(key), configuration);
  });
}

export function normalizePokecampTeam(input = {}, options = {}) {
  const value = input && typeof input === "object" ? input : {};
  const members = rawMembers(value).map(normalizeMember).filter((item) => item.slug || item.name).slice(0, 6);
  const rawConfigs = rawConfigurations(value);
  const textConfigs = rawConfigs.length ? rawConfigs : parseDetailText(value, members);
  const configurations = alignConfigurations(textConfigs.length ? textConfigs : members, members)
    .map((item, index) => {
      const fallback = members[index] || {};
      const matched = members.find((member) => {
        const itemHref = text(valueOf(item, "href", "url"));
        const memberHref = text(valueOf(member, "href", "url"));
        return (itemHref && memberHref && itemHref === memberHref) || slug(item.name || item.species) === slug(member.name || member.localizedName);
      });
      return normalizeConfiguration(item, matched || fallback, index);
    })
    .filter((item) => item.slug || item.name).slice(0, 6);
  const format = options.format || formatOf(value) || "";
  const sourcePageType = first(options.sourcePageType, valueOf(value, "sourcePageType"), "vgc-teams");
  const sourcePage = /build/i.test(sourcePageType) ? POKECAMP_BUILD_URL : POKECAMP_TEAM_URL;
  const team = {
    title: first(valueOf(value, "title", "name", "teamName", "teamTitle"), `Pokecamp ${format || "team"}`),
    href: first(valueOf(value, "href", "url", "link", "sourceUrl"), sourcePage),
    sourceUrl: first(valueOf(value, "sourceUrl", "url", "link"), sourcePage),
    sourcePage,
    sourcePageType,
    source: "Pokecamp",
    sourceVersion: "pokecamp-import-v1",
    // COMPLETE is set only after the browser crawler has verified that the
    // detail dialog contains a full set of configuration cards. Keep this
    // separate from a genuinely unpublished field on the source site.
    detailStatus: first(valueOf(value, "detailStatus"), "UNKNOWN"),
    season: first(valueOf(value, "season", "regulation", "regulationName"), options.season),
    regulation: first(valueOf(value, "regulation", "regulationName"), options.regulation),
    rulesetId: first(valueOf(value, "rulesetId"), options.rulesetId),
    format,
    formatLabel: format === "double" ? "Double / VGC" : format === "single" ? "Single / BSS" : valueOf(value, "formatLabel", "format"),
    rate: Number(valueOf(value, "rate", "usageRate", "usage")) || 0,
    rank: Number(valueOf(value, "rank", "position")) || 0,
    rentalCode: valueOf(value, "rentalCode", "teamCode", "rental", "code"),
    author: valueOf(value, "author", "player", "creator"),
    description: first(valueOf(value, "description", "summary", "introduction"), valueOf(value, ZH.intro)),
    strategy: first(valueOf(value, "strategy", "gameplan", "playstyle"), valueOf(value, ZH.strategy), valueOf(value, ZH.playstyle), valueOf(value, "detailText")),
    members,
    configurations,
    details: {
      leadPlans: [...array(valueOf(value, "leadPlans", "leads")), ...array(valueOf(value, ZH.leads))].map(text).filter(Boolean),
      core: [...array(valueOf(value, "core", "synergy")), ...array(valueOf(value, ZH.core))].map(text).filter(Boolean),
      matchup: [...array(valueOf(value, "matchup", "matchups")), ...array(valueOf(value, ZH.matchup))].map(text).filter(Boolean),
      notes: [...array(valueOf(value, "notes", "notesZh")), ...array(valueOf(value, ZH.remarks))].map(text).filter(Boolean),
    },
    articleUrl: first(valueOf(value, "articleUrl", "detailUrl", "url"), sourcePage),
    importedAt: new Date().toISOString(),
  };
  team.id = first(valueOf(value, "id", "teamId"), stableTeamId(team));
  return team;
}

export function repairPokecampTeam(team = {}) {
  if (!team || !String(team.source || "").toLowerCase().includes("pokecamp")) return team;
  const members = Array.isArray(team.members) ? team.members : [];
  const configurations = parseDetailText({ strategy: team.strategy || "" }, members);
  if (!configurations.length) return team;
  const existing = Array.isArray(team.configurations) ? team.configurations : [];
  const findByName = (list, member) => list.find((item) => identityKey(item.name || item.localizedName || item.slug) === identityKey(member.name || member.localizedName || member.slug));
  const ordered = members.map((member, index) => {
    const parsed = findByName(configurations, member);
    const previous = findByName(existing, member) || existing[index];
    if (!parsed) return previous || { name: member.name, slug: member.slug };
    return {
      ...(previous || {}),
      ...parsed,
      notes: parsed.notes?.length ? parsed.notes : previous?.notes || [],
      moves: parsed.moves?.length ? parsed.moves : previous?.moves || [],
    };
  }).filter((item) => item && (item.name || item.slug));
  return {
    ...team,
    configurations: ordered.map((item, index) => normalizeConfiguration(item, members.find((member) => slug(member.name || member.localizedName) === slug(item.name)) || members[index] || {}, index)),
    sourceVersion: "pokecamp-import-v2-detail",
  };
}

export function normalizePokecampPayload(payload = {}, options = {}) {
  const root = typeof payload === "string" ? JSON.parse(payload) : payload;
  const source = Array.isArray(root) ? root : rawMembers(root).length ? [root] : array(valueOf(root, "teams", "items", "data", "results", "entries", "records"));
  const defaults = { ...options, format: options.format || formatOf(root), season: options.season || first(valueOf(root, "season", "regulation")), regulation: options.regulation || valueOf(root, "regulation", "regulationName") };
  const teams = source.map((item) => normalizePokecampTeam(item, defaults)).filter((team) => team.members.length >= 3 && team.format);
  return { source: "Pokecamp", sourcePages: [POKECAMP_TEAM_URL, POKECAMP_BUILD_URL], fetchedAt: new Date().toISOString(), teams };
}

export function mergePokecampTeams(document = {}, imported = {}) {
  const existing = Array.isArray(document.teams) ? document.teams : [];
  const byId = new Map(existing.map((team) => [String(team.id), team]));
  const bySourceKey = new Map(existing.map((team) => [canonicalSourceKey(team), team]));
  let added = 0;
  let updated = 0;
  for (const team of imported.teams || []) {
    const generatedPrevious = existing.find((candidate) =>
      String(candidate.source || "").toLowerCase().includes("pokecamp") &&
      isGeneratedPokecampTitle(candidate.title) &&
      normalizedPageType(candidate.sourcePageType) === normalizedPageType(team.sourcePageType) &&
      candidate.format === team.format &&
      String(candidate.season || candidate.regulation || "") === String(team.season || team.regulation || "") &&
      memberSignature(candidate) === memberSignature(team));
    const previous = byId.get(String(team.id)) || bySourceKey.get(canonicalSourceKey(team)) || generatedPrevious;
    if (previous) {
      const useImportedConfigurations = configurationQuality(team) >= configurationQuality(previous);
      const merged = {
        ...previous,
        ...team,
        id: previous.id || team.id,
        configurations: useImportedConfigurations
          ? mergeConfigurationSets(previous.configurations || [], team.configurations || [])
          : previous.configurations,
        detailStatus: useImportedConfigurations || previous.detailStatus !== "COMPLETE" ? team.detailStatus : previous.detailStatus,
      };
      byId.delete(String(previous.id));
      byId.set(String(merged.id), merged);
      bySourceKey.set(canonicalSourceKey(merged), merged);
      updated += 1;
    } else {
      byId.set(String(team.id), team);
      bySourceKey.set(canonicalSourceKey(team), team);
      added += 1;
    }
  }
  const teams = [...byId.values()];
  return { ...document, source: [document.source, POKECAMP_TEAM_URL, POKECAMP_BUILD_URL].filter(Boolean).filter((item, index, list) => list.indexOf(item) === index).join(" / "), fetchedAt: new Date().toISOString(), availableSeasons: [...new Set(teams.map((item) => item.season).filter(Boolean))].sort().reverse(), total: teams.length, teams, imported: { added, updated, total: imported.teams?.length || 0 } };
}
