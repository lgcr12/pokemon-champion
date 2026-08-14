import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  BookOpenCheck,
  Calculator,
  Check,
  ChevronRight,
  CircleHelp,
  CloudSun,
  FlaskConical,
  LibraryBig,
  Search,
  Shield,
  Sparkles,
  Swords,
  X,
  Zap,
} from "lucide-react";
import { BorderBeam } from "../components/inspira/BorderBeam";
import { useWorkbench } from "../context/WorkbenchContext";
import { apiRequest, formatRuleName, spriteUrl } from "../lib/api";

type TabId = "seasons" | "items" | "types" | "mechanics" | "damage";
type StatKey = "hp" | "atk" | "def" | "spa" | "spd" | "spe";

const TYPE_COLORS: Record<string, string> = {
  一般: "#9ca3af", 火: "#f97316", 水: "#3b82f6", 电: "#eab308", 草: "#22c55e", 冰: "#06b6d4",
  格斗: "#dc2626", 毒: "#a855f7", 地面: "#b45309", 飞行: "#818cf8", 超能力: "#ec4899", 虫: "#84cc16",
  岩石: "#78716c", 幽灵: "#7c3aed", 龙: "#4f46e5", 恶: "#57534e", 钢: "#64748b", 妖精: "#f472b6",
};
const ENGLISH_TYPES: Record<string, string> = { Normal: "一般", Fire: "火", Water: "水", Electric: "电", Grass: "草", Ice: "冰", Fighting: "格斗", Poison: "毒", Ground: "地面", Flying: "飞行", Psychic: "超能力", Bug: "虫", Rock: "岩石", Ghost: "幽灵", Dragon: "龙", Dark: "恶", Steel: "钢", Fairy: "妖精" };
const TYPES = Object.keys(TYPE_COLORS);
const TYPE_CHART: Record<string, Record<string, number>> = {
  一般: { 岩石: .5, 幽灵: 0, 钢: .5 }, 火: { 火: .5, 水: .5, 草: 2, 冰: 2, 虫: 2, 岩石: .5, 龙: .5, 钢: 2 }, 水: { 火: 2, 水: .5, 草: .5, 地面: 2, 岩石: 2, 龙: .5 }, 电: { 水: 2, 电: .5, 草: .5, 地面: 0, 飞行: 2, 龙: .5 },
  草: { 火: .5, 水: 2, 草: .5, 毒: .5, 地面: 2, 飞行: .5, 虫: .5, 岩石: 2, 龙: .5, 钢: .5 }, 冰: { 火: .5, 水: .5, 草: 2, 冰: .5, 地面: 2, 飞行: 2, 龙: 2, 钢: .5 },
  格斗: { 一般: 2, 冰: 2, 毒: .5, 飞行: .5, 超能力: .5, 虫: .5, 岩石: 2, 幽灵: 0, 恶: 2, 妖精: .5, 钢: 2 }, 毒: { 草: 2, 毒: .5, 地面: .5, 岩石: .5, 幽灵: .5, 钢: 0, 妖精: 2 },
  地面: { 火: 2, 电: 2, 草: .5, 毒: 2, 飞行: 0, 虫: .5, 岩石: 2, 钢: 2 }, 飞行: { 电: .5, 草: 2, 格斗: 2, 虫: 2, 岩石: .5, 钢: .5 },
  超能力: { 格斗: 2, 毒: 2, 超能力: .5, 钢: .5, 恶: 0 }, 虫: { 火: .5, 草: 2, 格斗: .5, 毒: .5, 飞行: .5, 超能力: 2, 幽灵: .5, 钢: .5, 妖精: .5 },
  岩石: { 火: 2, 冰: 2, 格斗: .5, 地面: .5, 飞行: 2, 虫: 2, 钢: .5 }, 幽灵: { 一般: 0, 超能力: 2, 幽灵: 2, 恶: .5 }, 龙: { 龙: 2, 钢: .5, 妖精: 0 },
  恶: { 格斗: .5, 超能力: 2, 幽灵: 2, 恶: .5, 妖精: .5 }, 钢: { 火: .5, 水: .5, 电: .5, 冰: 2, 岩石: 2, 妖精: 2, 钢: .5 }, 妖精: { 火: .5, 格斗: 2, 毒: .5, 龙: 2, 恶: 2, 钢: .5 },
};

const NATURES: Array<[string, StatKey | "", StatKey | ""]> = [
  ["勤奋", "", ""], ["怕寂寞", "atk", "def"], ["固执", "atk", "spa"], ["顽皮", "atk", "spd"], ["勇敢", "atk", "spe"],
  ["大胆", "def", "atk"], ["淘气", "def", "spa"], ["乐天", "def", "spd"], ["悠闲", "def", "spe"], ["内敛", "spa", "atk"],
  ["慢吞吞", "spa", "def"], ["马虎", "spa", "spd"], ["冷静", "spa", "spe"], ["温和", "spd", "atk"], ["温顺", "spd", "def"],
  ["慎重", "spd", "spa"], ["自大", "spd", "spe"], ["胆小", "spe", "atk"], ["急躁", "spe", "def"], ["爽朗", "spe", "spa"],
  ["天真", "spe", "spd"], ["认真", "", ""], ["害羞", "", ""], ["浮躁", "", ""], ["坦率", "", ""],
];
const STAT_LABELS: Record<StatKey, string> = { hp: "HP", atk: "攻击", def: "防御", spa: "特攻", spd: "特防", spe: "速度" };
const DEFAULT_STATS: Record<StatKey, number> = { hp: 0, atk: 252, def: 0, spa: 252, spd: 0, spe: 4 };
const WEATHER_OPTIONS = [["clear", "无天气"], ["rain", "雨天"], ["sun", "晴天"], ["sand", "沙暴"], ["snow", "雪天"]];
const TERRAIN_OPTIONS = [["none", "无场地"], ["electric", "电气场地"], ["grassy", "青草场地"], ["psychic", "精神场地"], ["misty", "薄雾场地"]];
const STATUS_OPTIONS = [["none", "无异常"], ["burn", "灼伤"], ["paralysis", "麻痹"], ["poison", "中毒"], ["toxic", "剧毒"], ["sleep", "睡眠"], ["freeze", "冰冻"]];

const ITEM_CATEGORIES = ["全部", "输出", "生存", "回复", "场地", "进化", "属性", "特殊"];
const ITEM_EFFECTS_ZH: Record<string, string> = {
  leftovers: "持有者每回合结束时回复最大 HP 的 1/16。",
  lifeorb: "招式威力提升 30%，但每次造成伤害后损失最大 HP 的 10%。",
  focussash: "满 HP 时受到致命伤害会保留 1 HP，一次性道具。",
  focusband: "受到致命伤害时有 10% 几率保留 1 HP。",
  choiceband: "攻击提升 50%，但只能使用首次选择的招式。",
  choicescarf: "速度提升 50%，但只能使用首次选择的招式。",
  choicespecs: "特攻提升 50%，但只能使用首次选择的招式。",
  assaultvest: "特防提升 50%，但不能选择变化招式。",
  heavydutyboots: "不受隐形岩、撒菱、毒菱和黏黏网等场地陷阱影响。",
  safetygoggles: "免疫天气伤害，并免疫粉末类招式和孢子类招式。",
  covertcloak: "免受对手招式的追加效果影响。",
  clearamulet: "防止攻击、防御、特攻、特防或速度被对手降低。",
  whiteherb: "能力被降低时自动恢复被降低的能力，一次性道具。",
  mentalherb: "解除挑衅、再来一次、无理取闹或着迷等精神控制，一次性道具。",
  mirrorherb: "复制对手本回合发生的能力提升，一次性道具。",
  weaknesspolicy: "受到效果拔群的攻击时，攻击和特攻各提升 2 级，一次性道具。",
  ejectbutton: "受到招式攻击后强制换下，一次性道具。",
  ejectpack: "能力被降低后立即换下，一次性道具。",
  redcard: "受到攻击后强制对手随机换下，一次性道具。",
  rockyhelmet: "接触类招式攻击持有者的宝可梦会损失最大 HP 的 1/6。",
  eviolite: "未进化到最终形态的宝可梦防御和特防提升 50%。",
  sitrusberry: "HP 低于一半时回复最大 HP 的 1/4，一次性道具。",
  lumberry: "治愈灼伤、麻痹、中毒、睡眠、冰冻或混乱，一次性道具。",
  aguavberry: "HP 低于四分之一时回复最大 HP 的 1/3；不合适的性格可能引起混乱。",
  figyberry: "HP 低于四分之一时回复最大 HP 的 1/3；不合适的性格可能引起混乱。",
  iapapaberry: "HP 低于四分之一时回复最大 HP 的 1/3；不合适的性格可能引起混乱。",
  magoberry: "HP 低于四分之一时回复最大 HP 的 1/3；不合适的性格可能引起混乱。",
  wikiberry: "HP 低于四分之一时回复最大 HP 的 1/3；不合适的性格可能引起混乱。",
  terrainextender: "电气、青草、精神或薄雾场地的持续时间延长至 8 回合。",
  lightclay: "光墙、反射壁和极光幕的持续时间延长至 8 回合。",
  heatrock: "大晴天的持续时间延长至 8 回合。",
  damprock: "雨天的持续时间延长至 8 回合。",
  icyrock: "雪天的持续时间延长至 8 回合。",
  smoothrock: "沙暴的持续时间延长至 8 回合。",
  widelens: "招式命中率提升 10%。",
  wiseglasses: "特殊招式威力提升 10%。",
  muscletband: "物理招式威力提升 10%。",
  expertbelt: "效果拔群的招式威力提升 20%。",
  metronome: "连续使用同一招式时威力逐渐提升，最高提升至 2 倍。",
  loadeddice: "持有者使用的 2～5 次连续攻击招式会固定命中 4～5 次；群体招式的具体命中范围以当前规则为准。",
  boosterenergy: "拥有夸克充能或古代活性特性的宝可梦入场时提升最高能力；一次性道具。",
  throatspray: "使用声音类招式后特攻提升 1 级，一次性道具。",
  cellbattery: "受到电属性攻击后攻击提升 1 级，一次性道具。",
  absorbbulb: "受到水属性攻击后特攻提升 1 级，一次性道具。",
  airballoon: "免疫地面属性攻击；受到攻击后道具失效。",
  ironball: "速度降低 50%，并使持有者受到地面属性影响。",
  laggingtail: "几乎总是最后行动。",
  quickclaw: "有 20% 几率在同优先度下先于对手行动。",
  choice: "讲究系列道具会锁定首次选择的招式。",
};

type RegulationArchive = { period: string; special: string; held: string; totalTime: string; availableTime: string; turnTime: string; previewTime: string; pool: string; note: string; sourceUrl: string };
type RankedSeason = { id: string; period: string; regulation: string; sourceUrl: string };
const REGULATION_ORDER = ["M-B", "M-A"];
const RANKED_SEASONS: RankedSeason[] = [
  { id: "M-5", period: "2026年8月5日 - 2026年9月9日 9:59", regulation: "M-B", sourceUrl: "https://news.pokemon-home.com/sc/page/803.html" },
  { id: "M-4", period: "2026年7月8日 - 2026年8月5日 9:59", regulation: "M-B", sourceUrl: "https://news.pokemon-home.com/sc/page/795.html" },
  { id: "M-3", period: "2026年6月17日 - 2026年7月8日 9:59", regulation: "M-B", sourceUrl: "https://news.pokemon-home.com/sc/page/778.html" },
  { id: "M-2", period: "2026年5月13日 16:00 - 2026年6月17日 9:59", regulation: "M-A", sourceUrl: "https://news.pokemon-home.com/sc/page/760.html" },
  { id: "M-1", period: "2026年4月8日 - 2026年5月13日 9:59", regulation: "M-A", sourceUrl: "https://news.pokemon-home.com/sc/page/746.html" },
];
const REGULATION_ARCHIVE: Record<string, RegulationArchive> = {
  "M-A": {
    period: "2026年4月8日 - 2026年6月17日 9:59",
    special: "超级进化",
    held: "无法让 2 只以上的宝可梦携带相同的持有物",
    totalTime: "20 分钟",
    availableTime: "7 分钟",
    turnTime: "45 秒",
    previewTime: "90 秒",
    pool: "以该赛季官方公布的可用宝可梦名单为准",
    note: "适用于级别对战赛季 M-1 与 M-2。具体合法池仍需与对应 rulesetId 校验。",
    sourceUrl: "https://news.pokemon-home.com/sc/page/751.html",
  },
  "M-B": {
    period: "2026年6月17日 - 2026年9月9日 9:59",
    special: "超级进化；每场对战最多 1 次",
    held: "无法让 2 只以上的宝可梦携带相同的持有物",
    totalTime: "20 分钟",
    availableTime: "7 分钟",
    turnTime: "45 秒",
    previewTime: "90 秒",
    pool: "以该赛制官方“可参加的宝可梦”名单为准；M-B 在 M-A 基础上追加了部分宝可梦与可超级进化的宝可梦。",
    note: "适用于级别对战赛季 M-3、M-4 与 M-5；原定 9 月 2 日结束，官方已更新为 9 月 9 日结束。",
    sourceUrl: "https://news.pokemon-home.com/sc/page/776.html",
  },
};
const ARCHIVED_REGULATION_RULES = Object.entries(REGULATION_ARCHIVE)
  .filter(([regulation]) => regulation !== "M-B")
  .flatMap(([regulation, archive]) => (["single", "double"] as const).map((battleType) => ({
    rulesetId: `official-season-${regulation.toLowerCase()}-${battleType}-archive`,
    showdownFormatId: "官方赛季规则档案",
    battleType,
    regulation,
    name: `Pokémon Champions 赛季 ${regulation}`,
    rated: false,
    searchShow: false,
    rules: ["官方赛季档案"],
    status: "archive",
    archive,
  })));
const MECHANICS = [
  { id: "tera", title: "太晶化", short: "改变属性并强化对应属性招式", accent: "#4f46e5", icon: "◈", details: ["每方每场最多使用一次，持续到战斗结束。", "太晶属性与招式属性一致时，普通 STAB 通常为 2.0×；若原本也属于该属性，仍以当前世代规则的 STAB 计算。", "太晶化会改变防守属性和属性弱点，伤害计算必须重新计算防守端相性。", "太晶爆发、太晶化招式的具体可用性和倍率以当前 rulesetId 的 Showdown 规则为准。"] },
  { id: "mega", title: "Mega 进化", short: "进化石、特性与能力值改变", accent: "#db2777", icon: "✦", details: ["通常由对应的 Mega 进化石触发，进化后会改变种族值、属性、特性和外观。", "Mega 进化没有统一的全局伤害倍率；伤害变化来自新的攻击/特攻、属性 STAB、特性和招式组合。", "部分形态的速度、耐久或攻击会大幅改变，配队时要单独评估进化前后的行动顺序。", "是否可用、进化时机和进化石合法性必须以当前赛季 rulesetId 为准。"] },
  { id: "dynamax", title: "极巨化", short: "HP、极巨招式与场地效果改变", accent: "#dc2626", icon: "⬢", details: ["极巨化通常将最大 HP 提升至原来的 2 倍，并持续有限回合。", "普通招式会转化为极巨招式，威力由原招式类别和基础威力决定；极巨招式通常还会改变天气、场地或能力。", "极巨化期间不能使用普通道具效果以外的部分招式交互，也不能被部分招式效果影响。", "极巨化不是当前所有 Champions 规则的默认机制；页面只展示机制资料，排位能否使用由规则注册中心决定。"] },
  { id: "zmove", title: "Z 招式", short: "一次性高威力招式或强化效果", accent: "#0891b2", icon: "Z", details: ["每方每场通常最多使用一次，需要匹配的 Z 纯晶和招式属性。", "攻击型 Z 招式根据原招式基础威力映射到固定的高威力区间；不同原威力对应不同最终威力。", "变化招式的 Z 效果通常会额外强化能力或提供辅助效果，不能简单当作伤害技能。", "守住通常不能完全无伤挡住 Z 招式，具体减伤和合法性由当前规则与 Showdown 规则决定。"] },
];

function keyOf(value: unknown) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function englishType(value: string) { return ENGLISH_TYPES[value] || value; }
function localized(category: "items" | "moves" | "pokemon", id: string, fallback: string, termsData: any) { return termsData?.[category]?.[id] || termsData?.[category]?.[keyOf(id)] || fallback; }
function TypeBadge({ type }: { type: string }) { return <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-white" style={{ background: TYPE_COLORS[type] || "#64748b" }}>{type}</span>; }
function Multiplier({ value }: { value: number }) { const label = value === 0 ? "免疫" : `${value}×`; const tone = value === 0 ? "text-slate-400 bg-slate-100" : value < 1 ? "text-rose-600 bg-rose-50" : value > 1 ? "text-emerald-600 bg-emerald-50" : "text-slate-500 bg-slate-50"; return <span className={`inline-flex h-7 min-w-10 items-center justify-center rounded-md text-[11px] font-bold ${tone}`}>{label}</span>; }
function calculateTypeMultiplier(moveType: string, defenderTypes: string[]) { return defenderTypes.reduce((total, defenderType) => total * (TYPE_CHART[moveType]?.[defenderType] ?? 1), 1); }

function translateShowdownItemDesc(value: string) {
  let text = String(value || "");
  const exactPatterns: Array<[RegExp, string]> = [
    [/^If held by an? ([^,]+), its ([A-Za-z]+)- and ([A-Za-z]+)-type attacks have ([\d.]+)x power\.?$/i, "若由$1携带，其$2属性和$3属性招式威力提升至$4倍。"],
    [/^If held by an? ([^,]+), its ([A-Za-z]+)-type attacks have ([\d.]+)x power\.?$/i, "若由$1携带，其$2属性招式威力提升至$3倍。"],
    [/^If held by an? ([^,]+), this item allows it to Mega Evolve into ([^.]+) in battle\.?$/i, "若由$1携带，可在战斗中超级进化为$2。"],
    [/^If held by an? ([^,]+), this item allows it to Mega Evolve in battle\.?$/i, "若由$1携带，可在战斗中进行超级进化。"],
    [/^If held by an? ([^,]+), this item triggers its Primal Reversion in battle\.?$/i, "若由$1携带，可在战斗中触发原始回归。"],
    [/^If held by an? ([^,]+) with ([^,]+), it can use (.+)\.?$/i, "若由$1携带且拥有$2，可使用$3。"],
    [/^Holder's ([A-Za-z]+)-type attacks have ([\d.]+)x power\.?$/i, "持有者的$1属性招式威力提升至$2倍。"],
    [/^Holder's ([A-Za-z]+)- and ([A-Za-z]+)-type attacks have ([\d.]+)x power\.?$/i, "持有者的$1属性和$2属性招式威力提升至$3倍。"],
    [/^Holder's Multi-Attack is ([A-Za-z]+) type\.?$/i, "持有者的多属性攻击变为$1属性。"],
    [/^Holder's Techno Blast is ([A-Za-z]+) type\.?$/i, "持有者的高科技光炮变为$1属性。"],
    [/^Holder's use of (.+) lasts (\d+) turns instead of (\d+)\.?$/i, "持有者使用$1时，持续$2回合而不是$3回合。"],
  ];
  for (const [pattern, replacement] of exactPatterns) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  const replacements: Array<[RegExp, string]> = [
    [/Holder's/g, "持有者的"], [/holder's/g, "持有者的"], [/holder/g, "持有者"],
    [/Sp\. Atk/g, "特攻"], [/Sp\. Def/g, "特防"], [/Attack/g, "攻击"], [/Defense/g, "防御"], [/Speed/g, "速度"],
    [/raises ([^.;]+) by (\d+) stage\(s\)/gi, "使$1提升$2级"], [/raises ([^.;]+) by (\d+)/gi, "使$1提升$2"],
    [/is (\d+(?:\.\d+)?)x/gi, "为$1倍"], [/have (\d+(?:\.\d+)?)x power/gi, "威力为$1倍"], [/has (\d+(?:\.\d+)?)x power/gi, "威力为$1倍"],
    [/Single use\.?/gi, "一次性道具。"], [/supereffective/gi, "效果拔群"], [/max HP/gi, "最大HP"],
    [/Ground-type/g, "地面属性"], [/Fire-type/g, "火属性"], [/Water-type/g, "水属性"], [/Electric-type/g, "电属性"],
    [/Grass-type/g, "草属性"], [/Ice-type/g, "冰属性"], [/Fighting-type/g, "格斗属性"], [/Poison-type/g, "毒属性"],
    [/Flying-type/g, "飞行属性"], [/Psychic-type/g, "超能力属性"], [/Bug-type/g, "虫属性"], [/Rock-type/g, "岩石属性"],
    [/Ghost-type/g, "幽灵属性"], [/Dragon-type/g, "龙属性"], [/Dark-type/g, "恶属性"], [/Steel-type/g, "钢属性"], [/Fairy-type/g, "妖精属性"],
    [/attacks?/gi, "攻击"], [/moves?/gi, "招式"], [/damage/gi, "伤害"], [/turns?/gi, "回合"], [/when hit/gi, "受到攻击时"],
    [/If /gi, "若"], [/When /gi, "当"], [/ and /gi, "和"], [/ or /gi, "或"], [/ its /gi, "其"], [/ the /gi, "该"], [/ with /gi, "并拥有"],
    [/can use/gi, "可使用"], [/allows it to/gi, "使其能够"], [/in battle/gi, "在战斗中"], [/instead of/gi, "而不是"], [/from/gi, "从"],
    [/If held by an? ([^,]+), this item allows it to Mega Evolve(?: into ([^.]+))? in battle\.?/gi, "若由$1携带，可在战斗中超级进化$2。"],
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, " ").trim();
}

function genericItemEffectZh(item: any) {
  const id = keyOf(item?.id || item?.name);
  const name = item?.name || "该道具";
  const typeNames: Record<string, string> = { fire: "火", water: "水", electric: "电", grass: "草", ice: "冰", fighting: "格斗", poison: "毒", ground: "地面", flying: "飞行", psychic: "超能力", bug: "虫", rock: "岩石", ghost: "幽灵", dragon: "龙", dark: "恶", steel: "钢", fairy: "妖精", normal: "一般" };
  const type = Object.entries(typeNames).find(([key]) => id.includes(key))?.[1];
  if (id.endsWith("ite") || id.endsWith("itez")) return "对应宝可梦的超级进化石；携带后可在战斗中进行超级进化，具体形态由道具和规则决定。";
  if (id.endsWith("iumz") || id.endsWith("z")) return "对应属性的 Z 纯晶；满足宝可梦与招式条件时，可在战斗中使用一次 Z 招式。";
  if (id.endsWith("memory")) return `改变多属性攻击的属性为${type || "对应"}属性。`;
  if (id.endsWith("plate") || id.endsWith("gem")) return `${type || "对应"}属性招式强化道具；具体倍率和消耗条件以招式与规则为准。`;
  if (id.endsWith("berry")) return "树果类道具：在满足特定 HP、异常状态或受击条件时自动消耗并触发恢复、减伤或能力变化。";
  if (id.includes("fossil")) return "化石类道具：用于复原对应的远古宝可梦。";
  if (id.includes("ball")) return "捕获类道具：用于捕捉宝可梦，具体捕获加成取决于球种和使用条件。";
  if (id.endsWith("stone") || id.includes("armor") || id.includes("disc") || id.includes("coat")) return "进化或形态变化道具：满足对应宝可梦和使用条件时触发进化或形态变化。";
  return `${name}的具体战斗效果请以当前 Showdown 规则数据为准；本条目已保留原始说明供核对。`;
}

function itemEffectZh(item: any) {
  const id = keyOf(item?.id || item?.name);
  if (ITEM_EFFECTS_ZH[id]) return ITEM_EFFECTS_ZH[id];
  if (item?.megaStone || item?.megaEvolves) return "让对应的宝可梦在战斗中进行超级进化；具体进化形态和合法性由当前赛季规则决定。";
  if (item?.zMove) return "让符合条件的招式变为 Z 招式；具体招式和使用限制由当前赛季规则决定。";
  if (item?.onPlate) return "强化对应属性的招式，并可能改变多属性招式的属性；具体倍率以当前规则为准。";
  const translated = translateShowdownItemDesc(item?.shortDesc || "");
  if (/[\u4e00-\u9fff]/.test(translated) && !/[A-Za-z]{3,}/.test(translated.replace(/HP|Z/g, ""))) return translated;
  return genericItemEffectZh(item);
}

function ItemLibrary({ cache, termsData }: { cache: any; termsData: any }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [selected, setSelected] = useState<any>(null);
  const items = useMemo(() => Object.values(cache?.items || {}).map((item: any) => ({ ...item, localizedName: localized("items", item.id, item.name, termsData), localizedDesc: itemEffectZh(item) })).filter((item: any) => {
    const text = `${item.id} ${item.name} ${item.localizedName} ${item.localizedDesc}`.toLowerCase();
    const matchedCategory = category === "全部" || (category === "进化" && (item.megaStone || item.megaEvolves || item.zMove)) || (category === "属性" && item.onPlate) || (category === "特殊" && item.isNonstandard);
    return matchedCategory && text.includes(query.toLowerCase());
  }).sort((a: any, b: any) => a.localizedName.localeCompare(b.localizedName, "zh-CN")), [cache, category, query, termsData]);
  return <section className="rounded-xl border border-slate-100 bg-white p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-semibold text-slate-700"><Shield className="h-4 w-4 text-indigo-500" />全量道具资料</h2><p className="mt-1 text-xs text-slate-400">当前 Showdown 知识缓存共 {Object.keys(cache?.items || {}).length} 个道具，中文名称与中文效果优先展示，点击条目查看完整说明。</p></div><div className="relative"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索中文、英文或效果" className="h-9 w-64 rounded-lg border border-slate-200 pl-9 pr-3 text-xs outline-none focus:border-indigo-400" /></div></div><div className="mb-4 flex flex-wrap gap-1.5">{ITEM_CATEGORIES.map((item) => <button key={item} onClick={() => setCategory(item)} className={`rounded-full px-3 py-1.5 text-[11px] font-semibold ${category === item ? "bg-indigo-500 text-white" : "bg-slate-50 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600"}`}>{item}</button>)}</div><div className="mb-3 text-xs text-slate-400">显示 {items.length} 个道具</div><div className="grid max-h-[620px] grid-cols-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">{items.map((item: any) => <button key={item.id} onClick={() => setSelected(item)} className="group rounded-xl border border-slate-100 bg-slate-50 p-4 text-left transition hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-indigo-50/50"><div className="flex items-start justify-between gap-2"><div><div className="font-semibold text-slate-700">{item.localizedName}</div><div className="mt-0.5 text-[10px] text-slate-400">{item.name}</div></div><ChevronRight className="h-4 w-4 shrink-0 text-indigo-400 opacity-0 transition group-hover:opacity-100" /></div><p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">{item.localizedDesc}</p></button>)}</div>{!items.length && <div className="py-12 text-center text-sm text-slate-400">{Object.keys(cache?.items || {}).length ? "没有匹配的道具。" : "正在读取完整道具缓存..."}</div>}<InfoModal open={selected} onClose={() => setSelected(null)} title={selected?.localizedName || "道具详情"}><div className="space-y-4"><div className="rounded-xl bg-indigo-50 p-4"><div className="text-sm font-semibold text-indigo-700">{selected?.localizedName}</div><div className="mt-1 text-[11px] text-indigo-400">{selected?.name}</div><div className="mt-3 text-sm leading-6 text-slate-600">{selected?.localizedDesc}</div><details className="mt-3 rounded-lg bg-white/70 p-3"><summary className="cursor-pointer text-xs font-semibold text-indigo-600">查看 Showdown 原始说明</summary><p className="mt-2 text-xs leading-5 text-slate-500">{selected?.shortDesc || "暂无"}</p></details></div><div className="grid grid-cols-2 gap-3">{[["Showdown ID", selected?.id], ["Mega 进化", selected?.megaEvolves || "无"], ["Z 招式", selected?.zMove || "无"], ["非标准标签", selected?.isNonstandard || "当前标准"]].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><div className="text-[10px] text-slate-400">{label}</div><div className="mt-1 break-words text-xs font-medium text-slate-700">{value || "无"}</div></div>)}</div><p className="text-xs leading-5 text-slate-400">资料来自项目现有 Showdown 知识缓存；具体能否在排位使用仍以当前规则注册中心和 TeamValidator 为准。</p></div></InfoModal></section>;
}

function InfoModal({ open, onClose, title, children }: { open: any; onClose: () => void; title: string; children: React.ReactNode }) {
  const [officialPoolRule, setOfficialPoolRule] = useState<any>(null);
  useEffect(() => { if (!open) setOfficialPoolRule(null); }, [open]);
  return <AnimatePresence>{open && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><motion.div initial={{ opacity: 0, y: 18, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 18, scale: .96 }} className="max-h-[min(720px,calc(100vh-32px))] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"><div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-xl font-bold text-slate-800">{title}</h2><button onClick={onClose} aria-label="关闭详情" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button></div>{open?.regulation && <button onClick={() => setOfficialPoolRule(open)} className="mb-5 flex w-full items-center justify-between rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-left transition hover:border-indigo-300 hover:bg-indigo-50"><span><span className="block text-sm font-semibold text-indigo-700">查看 {open.regulation} 全部可用宝可梦</span><span className="mt-1 block text-xs text-indigo-500">打开独立浮现卡片，查看官方数量、形态、图标并搜索</span></span><ChevronRight className="h-5 w-5 text-indigo-500" /></button>}{children}</motion.div></motion.div>}{officialPoolRule && <OfficialPoolModal rule={officialPoolRule} onClose={() => setOfficialPoolRule(null)} />}</AnimatePresence>;
}

function OfficialPoolModal({ rule, onClose }: { rule: any; onClose: () => void }) {
  const [pool, setPool] = useState<any>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedPokemon, setSelectedPokemon] = useState<any>(null);

  useEffect(() => {
    if (!rule) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setQuery("");
    setSelectedPokemon(null);
    apiRequest(`/api/rules/pool?regulation=${encodeURIComponent(rule.regulation || "")}&rulesetId=${encodeURIComponent(rule.rulesetId || "")}`)
      .then((data) => { if (!cancelled) setPool(data); })
      .catch((reason: any) => { if (!cancelled) setError(reason.message || "读取官方名单失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [rule]);

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (pool?.entries || []).filter((entry: any) => {
      if (!needle) return true;
      return [entry.name, entry.homeId, entry.dex, entry.forme, ...(entry.showdownIds || [])].join(" ").toLowerCase().includes(needle);
    });
  }, [pool, query]);

  return <AnimatePresence>{rule && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <motion.div initial={{ opacity: 0, y: 22, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 22, scale: .97 }} className="flex max-h-[min(820px,calc(100vh-32px))] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
        <div><div className="text-xs font-semibold uppercase tracking-[.12em] text-indigo-500">官方合法池 · {rule.regulation}</div><h2 className="mt-1 text-xl font-bold text-slate-800">{rule.regulation} 可用宝可梦</h2><p className="mt-1 text-xs text-slate-500">按官方形态条目展示；配队、校验和排位均以这份名单为硬约束。</p></div>
        <button onClick={onClose} aria-label="关闭官方可用名单" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-5 w-5" /></button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50/70 px-5 py-3"><div className="rounded-lg bg-indigo-50 px-3 py-2 text-sm font-bold text-indigo-600">{pool?.count || 0} 个形态条目</div><div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索中文名、图鉴编号、形态或 Showdown ID" className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-400" /></div><span className="text-xs text-slate-400">当前显示 {entries.length} 条</span></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">{loading && <div className="py-16 text-center text-sm text-slate-400">正在读取 Pokémon HOME 官方名单...</div>}{error && <div className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-600">{error}</div>}{!loading && !error && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{entries.map((entry: any) => <button type="button" key={entry.homeId} onClick={() => setSelectedPokemon(entry)} className="group rounded-xl border border-slate-100 bg-white p-3 text-left transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"><div className="flex h-24 items-center justify-center rounded-lg bg-gradient-to-b from-indigo-50 to-white"><img src={spriteUrl(entry.spriteId || entry.showdownIds?.[0] || entry.sprite)} alt={entry.name} className="h-20 w-20 object-contain drop-shadow-sm" loading="lazy" onError={(event) => { const image = event.currentTarget; if (image.dataset.fallback) return; image.dataset.fallback = "1"; image.src = spriteUrl(entry.sprite); }} /></div><div className="mt-2 truncate text-sm font-semibold text-slate-700" title={entry.name}>{entry.name}</div><div className="mt-1 text-[10px] text-slate-400">#{String(entry.dex).padStart(4, "0")} · {entry.homeId}</div>{entry.forme && <div className="mt-1 truncate text-[10px] text-indigo-500">形态：{entry.forme}</div>}<div className="mt-1 truncate font-mono text-[9px] text-slate-400">{(entry.showdownIds || []).join(" / ")}</div><div className="mt-2 text-[10px] font-semibold text-indigo-500">点击查看种族值与特性</div></button>)}</div>}{!loading && !error && !entries.length && <div className="py-16 text-center text-sm text-slate-400">没有匹配的宝可梦。</div>}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400"><span>来源：Pokémon HOME 官方赛制名单</span><a href={pool?.sourceUrl || rule?.archive?.sourceUrl} target="_blank" rel="noreferrer" className="font-semibold text-indigo-600 hover:text-indigo-800">打开官方名单页</a></div>
      {selectedPokemon && <PokemonDetailModal pokemon={selectedPokemon} onClose={() => setSelectedPokemon(null)} />}
    </motion.div>
  </motion.div>}</AnimatePresence>;
}

function PokemonDetailModal({ pokemon, onClose }: { pokemon: any; onClose: () => void }) {
  const stats = [["HP", "hp", "#84cc16"], ["攻击", "atk", "#ef4444"], ["防御", "def", "#f59e0b"], ["特攻", "spa", "#06b6d4"], ["特防", "spd", "#3b82f6"], ["速度", "spe", "#a855f7"]] as const;
  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><motion.div initial={{ opacity: 0, scale: .96, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} className="max-h-[min(720px,calc(100vh-32px))] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl"><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-semibold uppercase tracking-[.12em] text-indigo-500">宝可梦详细资料</div><h2 className="mt-1 text-2xl font-bold text-slate-800">{pokemon.name}</h2><p className="mt-1 text-xs text-slate-400">全国图鉴 #{String(pokemon.dex).padStart(4, "0")} · {pokemon.homeId} · {pokemon.englishName || pokemon.showdownIds?.[0]}</p></div><button onClick={onClose} aria-label="关闭宝可梦详情" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button></div><div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-[180px_1fr]"><div className="flex min-h-44 items-center justify-center rounded-xl bg-gradient-to-b from-indigo-50 to-white"><img src={spriteUrl(pokemon.spriteId || pokemon.showdownIds?.[0] || pokemon.sprite)} alt={pokemon.name} className="h-40 w-40 object-contain drop-shadow-lg" onError={(event) => { const image = event.currentTarget; if (image.dataset.fallback) return; image.dataset.fallback = "1"; image.src = spriteUrl(pokemon.sprite); }} /></div><div className="space-y-4"><div><h3 className="mb-2 text-sm font-bold text-slate-700">属性</h3><div className="flex flex-wrap gap-2">{(pokemon.types || []).map((type: any) => <span key={type.id} className="rounded-full bg-indigo-100 px-3 py-1.5 text-xs font-semibold text-indigo-700">{type.name}</span>)}</div></div><div><h3 className="mb-2 text-sm font-bold text-slate-700">特性</h3><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{(pokemon.abilities || []).map((ability: any) => <div key={`${ability.id}-${ability.hidden}`} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"><div className="text-sm font-semibold text-slate-700">{ability.localizedName || ability.name}</div><div className="mt-1 text-[10px] text-slate-400">{ability.hidden ? "隐藏特性" : "普通特性"}</div></div>)}</div></div></div></div><div className="mt-5"><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-bold text-slate-700">种族值</h3><span className="text-xs font-semibold text-indigo-500">总和 {pokemon.baseStatTotal || 0}</span></div><div className="space-y-2">{stats.map(([label, key, color]) => <div key={key} className="grid grid-cols-[42px_36px_1fr] items-center gap-2 text-xs"><span className="font-semibold text-slate-600">{label}</span><span className="font-mono font-bold text-slate-700">{pokemon.baseStats?.[key] || 0}</span><div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${Math.min(100, ((pokemon.baseStats?.[key] || 0) / 180) * 100)}%`, background: color }} /></div></div>)}</div></div><div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4 text-[11px] text-slate-400"><span>资料参考：Showdown Dex · 52Poké 宝可梦列表</span><a href="https://wiki.52poke.com/wiki/宝可梦列表（按全国图鉴编号）" target="_blank" rel="noreferrer" className="font-semibold text-indigo-600 hover:text-indigo-800">打开资料来源</a></div></motion.div></motion.div>;
}

function MechanicsLibrary() {
  const [selected, setSelected] = useState<any>(null);
  return <section className="grid grid-cols-1 gap-4 md:grid-cols-2">{MECHANICS.map((mechanic, index) => <motion.button key={mechanic.id} onClick={() => setSelected(mechanic)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .04 }} className="rounded-xl border border-slate-100 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold text-white" style={{ background: mechanic.accent }}>{mechanic.icon}</div><div><h2 className="font-semibold text-slate-700">{mechanic.title}</h2><p className="mt-1 text-xs text-slate-400">{mechanic.short}</p></div><ChevronRight className="ml-auto h-4 w-4 text-slate-300" /></div><div className="mt-4 flex items-center gap-2 text-[10px] font-semibold text-indigo-500"><Sparkles className="h-3.5 w-3.5" />点击查看详细机制、数值变化与规则注意事项</div></motion.button>)}<InfoModal open={selected} onClose={() => setSelected(null)} title={selected?.title || "机制详情"}><div className="space-y-3">{(selected?.details || []).map((detail: string, index: number) => <div key={detail} className="flex gap-3 rounded-xl bg-slate-50 p-4"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: selected.accent }}>{index + 1}</span><p className="text-sm leading-6 text-slate-600">{detail}</p></div>)}<div className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-xs leading-5 text-amber-700">上面的数值是通用世代机制参考，不代替当前 Champions 规则快照。排位和配队操作仍由 Showdown 当前格式严格校验。</div></div></InfoModal></section>;
}

function statValue(base: number, ev: number, level: number, nature: number, hp = false) { return hp ? Math.floor(((2 * base + 31 + Math.floor(ev / 4)) * level) / 100) + level + 10 : Math.floor((Math.floor(((2 * base + 31 + Math.floor(ev / 4)) * level) / 100) + 5) * nature); }
function resolvePokemon(member: any, cache: any) { const id = keyOf(member?.id || member?.name); const direct = cache?.pokemon?.[id]; if (direct) return direct.showdown; return Object.values(cache?.pokemon || {}).map((entry: any) => entry.showdown).find((entry: any) => keyOf(entry.name) === id || keyOf(entry.id) === id); }
function makeStats(member: any, cache: any, evs: Record<StatKey, number>, level: number, natureUp: StatKey | "", natureDown: StatKey | "") { const base = resolvePokemon(member, cache)?.baseStats || { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 }; return (Object.keys(STAT_LABELS) as StatKey[]).reduce((result, stat) => { const nature = stat === natureUp ? 1.1 : stat === natureDown ? .9 : 1; result[stat] = statValue(base[stat], evs[stat], level, nature, stat === "hp"); return result; }, {} as Record<StatKey, number>); }

function DamageCalculator({ team, cache, termsData }: { team: any[]; cache: any; termsData: any }) {
  const allMoves = useMemo(() => Object.values(cache?.moves || {}).filter((move: any) => move.basePower).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))), [cache]);
  const [attackerId, setAttackerId] = useState(team[0]?.id || "");
  const [defenderId, setDefenderId] = useState(team[1]?.id || team[0]?.id || "");
  const [moveId, setMoveId] = useState("hydropump");
  const [level, setLevel] = useState(50);
  const [attackerNature, setAttackerNature] = useState("内敛");
  const [defenderNature, setDefenderNature] = useState("大胆");
  const [weather, setWeather] = useState("clear");
  const [terrain, setTerrain] = useState("none");
  const [attackerStatus, setAttackerStatus] = useState("none");
  const [defenderStatus, setDefenderStatus] = useState("none");
  const [attackerEvs, setAttackerEvs] = useState<Record<StatKey, number>>(DEFAULT_STATS);
  const [defenderEvs, setDefenderEvs] = useState<Record<StatKey, number>>({ hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 });
  const [attackerType, setAttackerType] = useState("");
  const [defenderType1, setDefenderType1] = useState("火");
  const [defenderType2, setDefenderType2] = useState("无");
  const [customPower, setCustomPower] = useState(0);
  const attacker = team.find((item) => item.id === attackerId) || team[0];
  const defender = team.find((item) => item.id === defenderId) || team[1] || team[0];
  const move: any = cache?.moves?.[moveId] || allMoves.find((item: any) => item.id === moveId) || allMoves[0] || { type: "Water", category: "Special", basePower: 90, name: "自定义招式" };
  const selectedAttackerNature = NATURES.find((nature) => nature[0] === attackerNature) || NATURES[0];
  const selectedDefenderNature = NATURES.find((nature) => nature[0] === defenderNature) || NATURES[0];
  const attackStats = makeStats(attacker, cache, attackerEvs, level, selectedAttackerNature[1], selectedAttackerNature[2]);
  const defenseStats = makeStats(defender, cache, defenderEvs, level, selectedDefenderNature[1], selectedDefenderNature[2]);
  const moveType = attackerType || englishType(move.type || "Normal");
  const category = move.category === "Physical" ? "物理" : "特殊";
  const attackStat = category === "物理" ? attackStats.atk : attackStats.spa;
  const defenseStat = category === "物理" ? defenseStats.def : defenseStats.spd;
  const defenderTypes = [defenderType1, defenderType2].filter((value) => value !== "无");
  const stab = (attacker?.types || []).map(englishType).includes(moveType) ? 1.5 : 1;
  const typeMultiplier = calculateTypeMultiplier(moveType, defenderTypes);
  const weatherMultiplier = weather === "rain" ? moveType === "水" ? 1.5 : moveType === "火" ? .5 : 1 : weather === "sun" ? moveType === "火" ? 1.5 : moveType === "水" ? .5 : 1 : 1;
  const terrainMultiplier = terrain === "electric" && moveType === "电" ? 1.3 : terrain === "grassy" && moveType === "草" ? 1.3 : terrain === "psychic" && moveType === "超能力" ? 1.3 : terrain === "misty" && moveType === "龙" ? .5 : 1;
  const statusMultiplier = attackerStatus === "burn" && category === "物理" ? .5 : 1;
  const moveStatusMultiplier = move.id === "facade" && attackerStatus !== "none" ? 2 : move.id === "hex" && defenderStatus !== "none" ? 2 : 1;
  const power = customPower || Number(move.basePower) || 1;
  const base = Math.floor(Math.floor(Math.floor(2 * level / 5 + 2) * power * attackStat / Math.max(1, defenseStat)) / 50 + 2);
  const finalMultiplier = stab * typeMultiplier * weatherMultiplier * terrainMultiplier * statusMultiplier * moveStatusMultiplier;
  const min = Math.floor(base * finalMultiplier * .85);
  const max = Math.floor(base * finalMultiplier);
  const setEv = (side: "attacker" | "defender", stat: StatKey, value: number) => { const setter = side === "attacker" ? setAttackerEvs : setDefenderEvs; setter((current) => ({ ...current, [stat]: Math.max(0, Math.min(252, value || 0)) })); };
  if (!team.length) return <div className="rounded-xl border border-dashed border-slate-200 px-5 py-12 text-center text-sm text-slate-400">当前队伍为空，先在配队工坊选择攻击方和受攻击方。</div>;
  return <div className="space-y-5"><div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.05fr_.95fr]"><div className="space-y-4"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="攻击方"><select value={attackerId} onChange={(e) => setAttackerId(e.target.value)}>{team.map((item) => <option key={item.id} value={item.id}>{item.localizedName || item.name}</option>)}</select></Field><Field label="受攻击方"><select value={defenderId} onChange={(e) => setDefenderId(e.target.value)}>{team.map((item) => <option key={item.id} value={item.id}>{item.localizedName || item.name}</option>)}</select></Field><Field label="招式"><select value={moveId} onChange={(e) => setMoveId(e.target.value)}>{allMoves.slice(0, 950).map((item: any) => <option key={item.id} value={item.id}>{localized("moves", item.id, item.name, termsData)} · {item.basePower} 威力</option>)}</select></Field><Field label="招式威力（覆盖资料）"><input type="number" min={0} max={300} value={customPower} onChange={(e) => setCustomPower(Math.max(0, Number(e.target.value) || 0))} placeholder={`使用招式资料：${move.basePower}`} /></Field><Field label="攻击方性格"><select value={attackerNature} onChange={(e) => setAttackerNature(e.target.value)}>{NATURES.map((item) => <option key={item[0]}>{item[0]}</option>)}</select></Field><Field label="防守方性格"><select value={defenderNature} onChange={(e) => setDefenderNature(e.target.value)}>{NATURES.map((item) => <option key={item[0]}>{item[0]}</option>)}</select></Field><Field label="等级"><input type="number" min={1} max={100} value={level} onChange={(e) => setLevel(Math.max(1, Math.min(100, Number(e.target.value) || 50)))} /></Field><Field label="攻击类别"><div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700">{category} · {localized("moves", move.id, move.name, termsData)}</div></Field></div><div className="rounded-xl border border-slate-100 bg-slate-50 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><Zap className="h-4 w-4 text-indigo-500" />战斗环境</div><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Field label="天气"><select value={weather} onChange={(e) => setWeather(e.target.value)}>{WEATHER_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><Field label="场地"><select value={terrain} onChange={(e) => setTerrain(e.target.value)}>{TERRAIN_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><Field label="等级"><input type="number" min={1} max={100} value={level} onChange={(e) => setLevel(Math.max(1, Math.min(100, Number(e.target.value) || 50)))} /></Field></div><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="攻击方异常"><select value={attackerStatus} onChange={(e) => setAttackerStatus(e.target.value)}>{STATUS_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><Field label="防守方异常"><select value={defenderStatus} onChange={(e) => setDefenderStatus(e.target.value)}>{STATUS_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field></div></div></div><div className="rounded-xl bg-slate-950 p-5 text-white"><div className="flex items-center justify-between"><span className="text-xs text-slate-400">精确度量模型结果</span><TypeBadge type={moveType} /></div><div className="mt-4 text-4xl font-bold" style={{ fontFamily: "Rajdhani, sans-serif" }}>{Math.max(0, min)} - {Math.max(0, max)}</div><div className="mt-1 text-xs text-slate-400">预计伤害 · {level} 级 · 随机范围 85%~100%</div><div className="mt-5 grid grid-cols-3 gap-2 text-center"><ResultMetric label="攻击值" value={attackStat} /><ResultMetric label="防御值" value={defenseStat} /><ResultMetric label="相性" value={`${typeMultiplier}×`} /></div><div className="mt-4 space-y-2 rounded-xl bg-white/5 p-3 text-xs"><div className="text-slate-400">修正项明细</div>{[["STAB", `${stab}×`], ["天气", `${weatherMultiplier}×`], ["场地", `${terrainMultiplier}×`], ["异常/招式", `${statusMultiplier * moveStatusMultiplier}×`]].map(([label, value]) => <div key={label} className="flex justify-between"><span className="text-slate-400">{label}</span><b>{value}</b></div>)}</div><div className="mt-4 flex items-center gap-2 text-[10px] leading-4 text-slate-400"><CircleHelp className="h-3.5 w-3.5 shrink-0" />包含等级、性格、努力值、招式类别、天气、场地、属性相性和异常状态；特性、道具、暴击、能力阶段和保护类减伤未纳入。</div></div></div><div className="grid grid-cols-1 gap-4 lg:grid-cols-2"><EvPanel title="攻击方努力值" values={attackerEvs} onChange={(stat, value) => setEv("attacker", stat, value)} /><EvPanel title="受攻击方努力值" values={defenderEvs} onChange={(stat, value) => setEv("defender", stat, value)} /></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Field label="招式属性覆盖"><select value={attackerType} onChange={(e) => setAttackerType(e.target.value)}><option value="">使用招式资料属性（{englishType(move.type || "Normal")}）</option>{TYPES.map((type) => <option key={type} value={type}>覆盖为 {type}</option>)}</select></Field><Field label="受攻击方第一属性"><select value={defenderType1} onChange={(e) => setDefenderType1(e.target.value)}>{TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field><Field label="受攻击方第二属性"><select value={defenderType2} onChange={(e) => setDefenderType2(e.target.value)}><option>无</option>{TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field></div></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="text-xs text-slate-500"><span className="mb-1 block">{label}</span><div className="[&_input]:h-10 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-slate-200 [&_input]:bg-white [&_input]:px-3 [&_input]:text-sm [&_select]:h-10 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:bg-white [&_select]:px-3 [&_select]:text-sm">{children}</div></label>; }
function ResultMetric({ label, value }: { label: string; value: string | number }) { return <div className="rounded-lg bg-white/10 p-2"><div className="text-sm font-semibold">{value}</div><div className="text-[10px] text-slate-400">{label}</div></div>; }
function EvPanel({ title, values, onChange }: { title: string; values: Record<StatKey, number>; onChange: (stat: StatKey, value: number) => void }) { return <div className="rounded-xl border border-slate-100 bg-white p-4"><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-700">{title}</h3><span className="text-[10px] text-slate-400">每项 0~252 · 总和建议 ≤510</span></div><div className="grid grid-cols-3 gap-3 sm:grid-cols-6">{(Object.keys(STAT_LABELS) as StatKey[]).map((stat) => <label key={stat} className="text-[10px] text-slate-400">{STAT_LABELS[stat]}<input type="number" min={0} max={252} value={values[stat]} onChange={(e) => onChange(stat, Number(e.target.value))} className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-2 text-xs text-slate-700" /></label>)}</div></div>; }

function TypeChart() { const [selectedType, setSelectedType] = useState("火"); return <section className="rounded-xl border border-slate-100 bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-slate-700">属性克制表</h2><p className="mt-1 text-xs text-slate-400">点击攻击属性，查看对所有防守属性的倍率。</p></div><div className="flex flex-wrap gap-1.5">{TYPES.map((type) => <button key={type} onClick={() => setSelectedType(type)} className={`rounded-full px-2.5 py-1 text-[10px] font-semibold text-white transition ${selectedType === type ? "ring-2 ring-indigo-200" : "opacity-60 hover:opacity-100"}`} style={{ background: TYPE_COLORS[type] }}>{type}</button>)}</div></div><div className="mt-5 grid grid-cols-3 gap-3 sm:grid-cols-6 lg:grid-cols-9">{TYPES.map((type) => <button key={type} onClick={() => setSelectedType(type)} className={`rounded-xl border p-3 text-center transition ${selectedType === type ? "border-indigo-400 bg-indigo-50 shadow-md" : "border-slate-100 bg-slate-50 hover:border-indigo-200"}`}><TypeBadge type={type} /><div className="mt-2"><Multiplier value={TYPE_CHART[selectedType]?.[type] ?? 1} /></div></button>)}</div><div className="mt-5 rounded-xl bg-slate-950 p-5 text-white"><div className="flex items-center gap-3"><div className="h-10 w-10 rounded-full p-1" style={{ background: TYPE_COLORS[selectedType] }}><div className="flex h-full items-center justify-center rounded-full bg-slate-950 text-xs font-bold">{selectedType}</div></div><div><div className="text-xs text-slate-400">当前攻击属性</div><div className="text-lg font-bold">{selectedType} 属性招式</div></div></div><div className="mt-4 flex flex-wrap gap-2">{TYPES.filter((type) => (TYPE_CHART[selectedType]?.[type] || 1) > 1).map((type) => <span key={type} className="rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs text-emerald-300">克制 {type}</span>)}{TYPES.filter((type) => (TYPE_CHART[selectedType]?.[type] || 1) === 0).map((type) => <span key={type} className="rounded-full bg-slate-400/15 px-2.5 py-1 text-xs text-slate-400">免疫 {type}</span>)}</div></div></section>; }

export function Knowledge() {
  const { registry, history, team } = useWorkbench();
  const [cache, setCache] = useState<any>({ items: {}, moves: {}, pokemon: {} });
  const [termsData, setTermsData] = useState<any>({ items: {}, moves: {}, pokemon: {} });
  const [tab, setTab] = useState<TabId>("seasons");
  useEffect(() => { let cancelled = false; Promise.all([fetch("/data/battle-knowledge.json").then((response) => response.ok ? response.json() : null), fetch("/data/zh-hans-terms.json").then((response) => response.ok ? response.json() : null)]).then(([nextCache, nextTerms]) => { if (!cancelled) { if (nextCache) setCache(nextCache); if (nextTerms) setTermsData(nextTerms); } }).catch(() => undefined); return () => { cancelled = true; }; }, []);
  const seasonData = useMemo(() => {
    const activeRules = dedupeSeasonRules(registry.active || []);
    const historicalRules = dedupeSeasonRules([
      ...(history || []),
      ...ARCHIVED_REGULATION_RULES,
    ]).filter((rule) => rule.regulation !== activeRules[0]?.regulation);

    return {
      current: activeRules.sort(compareSeasonRules),
      historical: historicalRules.sort(compareSeasonRules),
    };
  }, [registry.active, history]);
  const tabs: Array<{ id: TabId; label: string; icon: typeof LibraryBig }> = [{ id: "seasons", label: "赛季规则", icon: BookOpenCheck }, { id: "items", label: "道具效果", icon: Shield }, { id: "types", label: "类型相性", icon: Sparkles }, { id: "mechanics", label: "战斗系统", icon: Swords }, { id: "damage", label: "伤害计算", icon: Calculator }];
  return <div className="space-y-5"><motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-end justify-between gap-3"><div><div className="flex items-center gap-2"><LibraryBig className="h-5 w-5 text-violet-400" /><h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Rajdhani, sans-serif" }}>战术资料中心</h1></div><p className="mt-1 text-sm text-slate-400">按赛季规则、机制资料与真实缓存数据建立的前端参考工具。</p></div><div className="flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3 py-1.5 text-xs text-indigo-200"><CloudSun className="h-3.5 w-3.5" />当前规则驱动</div></motion.div><div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-100 bg-white p-2 sm:grid-cols-5">{tabs.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setTab(id)} className={`flex items-center justify-center gap-2 rounded-lg px-3 py-3 text-xs font-semibold transition ${tab === id ? "bg-indigo-500 text-white shadow-md shadow-indigo-200" : "text-slate-500 hover:bg-indigo-50 hover:text-indigo-600"}`}><Icon className="h-4 w-4" />{label}</button>)}</div>{tab === "seasons" && <SeasonLibrary currentRules={seasonData.current} historicalRules={seasonData.historical} />}{tab === "items" && <ItemLibrary cache={cache} termsData={termsData} />}{tab === "types" && <TypeChart />}{tab === "mechanics" && <MechanicsLibrary />}{tab === "damage" && <section className="rounded-xl border border-slate-100 bg-white p-5"><div className="mb-5 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-500"><Calculator className="h-5 w-5" /></div><div><h2 className="font-semibold text-slate-700">伤害计算器</h2><p className="mt-1 text-xs text-slate-400">攻击方、受攻击方、性格、天气、场地、异常状态、努力值和招式均可独立调整。</p></div></div><DamageCalculator team={team} cache={cache} termsData={termsData} /></section>}</div>;
}

function seasonArchive(rule: any) { return rule?.archive || REGULATION_ARCHIVE[rule?.regulation] || null; }
function seasonRank(regulation: string) {
  const rank = REGULATION_ORDER.indexOf(regulation);
  return rank === -1 ? REGULATION_ORDER.length : rank;
}
function compareSeasonRules(left: any, right: any) {
  const seasonDifference = seasonRank(left?.regulation) - seasonRank(right?.regulation);
  if (seasonDifference) return seasonDifference;
  return String(left?.battleType) === "single" ? -1 : 1;
}
function dedupeSeasonRules(rules: any[]) {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule?.regulation || "unknown"}:${rule?.battleType || "unknown"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function RuleTable({ rule }: { rule: any }) {
  const archive = seasonArchive(rule);
  const rows = [
    ["期间", archive?.period || "当前规则快照未提供赛季起止时间"],
    ["特殊要素", archive?.special || (rule?.rules || []).filter((item: string) => /太晶|Mega|极巨|Z/i.test(item)).join("、") || "当前快照未声明"],
    ["持有物", archive?.held || (rule?.rules || []).some((item: string) => /item|持有物|重复/i.test(item)) ? "按当前规则标签执行" : "当前快照未提供持有物限制"],
    ["总时间", archive?.totalTime || "当前规则快照未提供"],
    ["可用时间", archive?.availableTime || "当前规则快照未提供"],
    ["每回合选择时间", archive?.turnTime || "当前规则快照未提供"],
    ["选出上场宝可梦时间", archive?.previewTime || "当前规则快照未提供"],
    ["可用宝可梦", archive?.pool || "由当前 rulesetId 的合法池哈希和 TeamValidator 确定"],
  ];
  return <div className="overflow-hidden rounded-xl border border-blue-200 bg-white shadow-sm"><div className="bg-[#5b8ee8] px-4 py-2 text-center text-base font-bold text-slate-950">赛制 {rule?.regulation || "未知"}</div>{rows.map(([label, value]) => <div key={label} className="grid grid-cols-[112px_1fr] border-t border-blue-200"><div className="bg-blue-50 px-3 py-3 text-center text-sm font-bold text-slate-800">{label}</div><div className="px-4 py-3 text-sm leading-6 text-slate-700">{value}</div></div>)}</div>;
}
function SeasonRuleCard({ rule, onSelect }: { rule: any; onSelect: (rule: any) => void }) {
  const modeName = rule.battleType === "double" ? "VGC 双打" : "BSS 单打";
  const statusName = rule.status === "active" ? "当前生效" : "历史赛季";
  return <button onClick={() => onSelect(rule)} className="w-full text-left"><BorderBeam active={rule.status === "active"} color={rule.battleType === "double" ? "indigo" : "cyan"} duration={4}><div className="rounded-xl bg-white p-5 transition hover:bg-indigo-50/30"><RuleTable rule={rule} /><div className="mt-4 flex items-center justify-between gap-3"><div className="min-w-0"><div className="text-xs font-semibold text-indigo-500">{modeName} · {formatRuleName(rule.name)}</div><div className="mt-1 truncate font-mono text-[10px] text-slate-400">{rule.rulesetId}</div></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold ${rule.status === "active" ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>{statusName}</span></div><div className="mt-3 flex items-center gap-1 text-[10px] text-indigo-500"><BookOpenCheck className="h-3.5 w-3.5" />点击查看完整规则快照和校验信息</div></div></BorderBeam></button>;
}
function SeasonColumn({ title, mode, rules, onSelect }: { title: string; mode: "single" | "double"; rules: any[]; onSelect: (rule: any) => void }) {
  const modeRules = rules.filter((rule) => rule.battleType === mode);
  return <section className="space-y-3"><div className="flex items-center gap-2 border-b border-slate-200 pb-3"><span className={`h-2.5 w-2.5 rounded-full ${mode === "double" ? "bg-indigo-500" : "bg-cyan-500"}`} /><h3 className="text-base font-bold text-slate-700">{title}</h3><span className="text-xs text-slate-400">{modeRules.length} 个赛季</span></div><div className="space-y-4">{modeRules.map((rule) => <SeasonRuleCard key={rule.rulesetId} rule={rule} onSelect={onSelect} />)}{!modeRules.length && <div className="rounded-xl border border-dashed border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-400">暂无已归档的{title}规则。</div>}</div></section>;
}
function RankedSeasonCard({ season, mode, onSelect }: { season: RankedSeason; mode: "single" | "double"; onSelect: (rule: any) => void }) {
  const regulation = REGULATION_ARCHIVE[season.regulation];
  const modeName = mode === "double" ? "VGC 双打" : "BSS 单打";
  const archiveRule = {
    rulesetId: `official-ranked-${season.id.toLowerCase()}-${mode}-archive`,
    showdownFormatId: "Pokémon Champions 级别对战",
    battleType: mode,
    regulation: season.regulation,
    name: `级别对战赛季 ${season.id} · ${modeName}`,
    rated: true,
    searchShow: true,
    rules: [`级别对战赛季 ${season.id}`, `使用赛制 ${season.regulation}`, "单打 / 双打分别排名"],
    status: "archive",
    archive: { ...regulation, period: season.period, note: `级别对战赛季 ${season.id} 使用赛制 ${season.regulation}。${regulation?.note || ""}`, sourceUrl: season.sourceUrl },
  };
  return <button onClick={() => onSelect(archiveRule)} className="w-full rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md"><div className="flex items-start justify-between gap-3"><div><div className="text-lg font-bold text-slate-800">级别对战赛季 {season.id}</div><div className="mt-1 text-sm font-semibold text-indigo-600">{modeName} · 使用赛制 {season.regulation}</div></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-500">历史赛季</span></div><div className="mt-4 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500"><div>开放期间：{season.period}</div><div className="mt-1">规则：{regulation?.special || "以官方详情为准"}</div></div><div className="mt-3 flex items-center gap-1 text-[10px] text-indigo-500"><BookOpenCheck className="h-3.5 w-3.5" />点击查看该级别对战赛季与赛制详情</div></button>;
}
function RankedSeasonColumn({ title, mode, onSelect }: { title: string; mode: "single" | "double"; onSelect: (rule: any) => void }) {
  return <section className="space-y-3"><div className="flex items-center gap-2 border-b border-slate-200 pb-3"><span className={`h-2.5 w-2.5 rounded-full ${mode === "double" ? "bg-indigo-500" : "bg-cyan-500"}`} /><h3 className="text-base font-bold text-slate-700">{title}</h3><span className="text-xs text-slate-400">{RANKED_SEASONS.length} 个赛季</span></div><div className="space-y-3">{RANKED_SEASONS.map((season) => <RankedSeasonCard key={`${season.id}-${mode}`} season={season} mode={mode} onSelect={onSelect} />)}</div></section>;
}
function SeasonLibrary({ currentRules, historicalRules }: { currentRules: any[]; historicalRules: any[] }) {
  const [selected, setSelected] = useState<any>(null);
  const [selectedPool, setSelectedPool] = useState<any>(null);
  const currentRegulation = currentRules[0]?.regulation || "未同步";
  return <div className="space-y-7"><div className="rounded-xl border border-indigo-100 bg-indigo-50/70 p-4 text-sm leading-6 text-indigo-800"><div className="font-semibold">Pokémon Champions 官方赛制与级别对战档案</div><div className="mt-1 text-xs leading-5 text-indigo-600">赛制（M-A、M-B）定义可用宝可梦与战斗规则；级别对战赛季（M-1、M-2……）定义开放期间并引用一套赛制。资料来自 Pokémon HOME 官方公告。</div></div><section><div className="mb-3 flex flex-wrap items-end justify-between gap-2"><div><div className="text-xs font-semibold text-indigo-500">当前级别对战</div><h2 className="mt-1 text-xl font-bold text-slate-800">赛季 M-5 · 使用赛制 {currentRegulation}</h2></div><span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-600">实时规则注册中心</span></div><p className="mb-4 text-xs text-slate-500">M-5 开放至 2026年9月9日 9:59；单打与双打在同一赛季下分别进行排名。</p><div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{currentRules.map((rule) => <SeasonRuleCard key={rule.rulesetId} rule={rule} onSelect={setSelected} />)}</div>{!currentRules.length && <div className="rounded-xl border border-dashed border-slate-200 bg-white px-5 py-12 text-center text-sm text-slate-400">尚未同步当前赛制规则，请先在“规则与环境”执行同步。</div>}</section><section className="border-t border-slate-200 pt-6"><div className="mb-5"><div className="text-xs font-semibold text-slate-500">历史级别对战</div><h2 className="mt-1 text-xl font-bold text-slate-800">同一赛季，单双打分别排名</h2><p className="mt-1 text-xs text-slate-400">按时间倒序：M-5 使用 M-B，M-4 使用 M-B，M-3 使用 M-B，M-2 使用 M-A，M-1 使用 M-A。</p></div><div className="grid grid-cols-1 gap-8 xl:grid-cols-2"><RankedSeasonColumn title="BSS 单打" mode="single" onSelect={setSelected} /><RankedSeasonColumn title="VGC 双打" mode="double" onSelect={setSelected} /></div>{historicalRules.length > 0 && <details className="mt-6 rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer text-sm font-semibold text-slate-600">查看本地历史赛制快照</summary><div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">{historicalRules.map((rule) => <SeasonRuleCard key={rule.rulesetId} rule={rule} onSelect={setSelected} />)}</div></details>}</section><InfoModal open={selected} onClose={() => setSelected(null)} title={`${selected?.name || selected?.regulation || "赛季"} · 规则详情`}><div className="space-y-5"><RuleTable rule={selected} /><div className="grid grid-cols-2 gap-3">{[["rulesetId", selected?.rulesetId], ["Showdown 格式", selected?.showdownFormatId], ["Rated", selected?.rated ? "开放" : "关闭"], ["搜索开放", selected?.searchShow ? "是" : "否"], ["规则哈希", selected?.formatHash], ["合法池哈希", selected?.legalPoolHash], ["Showdown Commit", selected?.showdownCommit], ["快照状态", selected?.status]].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><div className="text-[10px] text-slate-400">{label}</div><div className="mt-1 break-all text-xs font-medium text-slate-700">{value || "--"}</div></div>)}</div><div><h3 className="mb-2 text-sm font-semibold text-slate-700">规则标签</h3><div className="flex flex-wrap gap-2">{(selected?.rules || []).map((item: string) => <span key={item} className="rounded-full bg-indigo-50 px-3 py-1.5 text-xs text-indigo-600">{item}</span>)}</div></div><a href={selected?.archive?.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex text-xs font-semibold text-indigo-600 hover:text-indigo-800">打开 Pokémon HOME 官方公告</a></div></InfoModal></div>;
}
