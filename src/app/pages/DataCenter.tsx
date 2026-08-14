import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { AlertTriangle, ArrowDownToLine, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Database, ExternalLink, Filter, Play, RefreshCw, Search, ShieldCheck, Square, Users, X } from "lucide-react";
import { apiRequest, resolveShowdownTerm } from "../lib/api";
import { useWorkbench } from "../context/WorkbenchContext";

const REFERENCE_SOURCES = [
  { id: "pokemon", label: "宝可梦", url: "https://pokecamp.cc/zh/pokemon" },
  { id: "moves", label: "招式", url: "https://pokecamp.cc/zh/moves" },
  { id: "abilities", label: "特性", url: "https://pokecamp.cc/zh/abilities" },
  { id: "items", label: "道具", url: "https://pokecamp.cc/zh/items" },
] as const;
type Team = { id: string; title: string; source?: string; sourcePageType?: string; format?: "single" | "double"; season?: string; regulation?: string; href?: string; description?: string; detailStatus?: "COMPLETE" | "PENDING" | "RETRY_REQUIRED" | "UNKNOWN"; strategyText?: string; strategyTitle?: string; strategyPublished?: string; strategyAuthor?: string; strategyBlocks?: Array<{ type: "heading" | "paragraph"; text: string }>; strategyLinks?: Array<{ text: string; kind: string; href: string }>; strategyComplete?: boolean; strategyAvailable?: boolean; details?: Record<string, string[]>; members?: any[]; configurations?: any[] };
function TeamSprite({ member }: { member: any }) {
  const [imageIndex, setImageIndex] = useState(0);
  const label = member?.localizedName || member?.name || member?.slug || "?";
  const images = [member?.sprite, ...(Array.isArray(member?.spriteCandidates) ? member.spriteCandidates : [])].filter(Boolean).filter((image, index, all) => all.indexOf(image) === index);
  useEffect(() => { setImageIndex(0); }, [label, images.join("|")]);
  if (!images.length || imageIndex >= images.length) return <div className="flex h-14 w-14 items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 text-center text-[11px] font-semibold leading-tight text-indigo-600">{label.slice(0, 4)}</div>;
  return <img src={images[imageIndex]} alt={label} onError={() => setImageIndex((value) => value + 1)} className="h-14 w-14 object-contain drop-shadow-md" />;
}

const TYPE_COLORS: Record<string, string> = { 一般: "#9ca3af", 火: "#f97316", 水: "#3b82f6", 电: "#eab308", 草: "#22c55e", 冰: "#06b6d4", 格斗: "#dc2626", 毒: "#a855f7", 地面: "#b45309", 飞行: "#818cf8", 超能力: "#ec4899", 虫: "#84cc16", 岩石: "#78716c", 幽灵: "#7c3aed", 龙: "#4f46e5", 恶: "#57534e", 钢: "#64748b", 妖精: "#f472b6" };

type ReferenceCategory = "pokemon" | "move" | "item" | "ability";

const REFERENCE_STYLES: Record<ReferenceCategory, { label: string; accent: string; soft: string; border: string }> = {
  pokemon: { label: "宝可梦资料", accent: "#4f46e5", soft: "#eef2ff", border: "#c7d2fe" },
  move: { label: "招式资料", accent: "#0891b2", soft: "#ecfeff", border: "#a5f3fc" },
  item: { label: "道具资料", accent: "#d97706", soft: "#fffbeb", border: "#fde68a" },
  ability: { label: "特性资料", accent: "#059669", soft: "#ecfdf5", border: "#a7f3d0" },
};

function ReferenceStats({ stats }: { stats?: Record<string, number> }) {
  if (!stats) return null;
  const labels: Record<string, string> = { hp: "HP", atk: "攻击", def: "防御", spa: "特攻", spd: "特防", spe: "速度" };
  return <div className="mt-3 grid grid-cols-3 gap-1.5">{Object.entries(stats).map(([key, value]) => <div key={key} className="rounded-md bg-slate-50 px-2 py-1.5 text-center"><div className="text-[10px] text-slate-400">{labels[key] || key}</div><div className="mt-0.5 font-mono text-sm font-bold text-slate-700">{value}</div></div>)}</div>;
}

const LOCAL_REFERENCE_DESCRIPTIONS: Record<ReferenceCategory, Record<string, string>> = {
  move: {
    变小: "蜷缩身体显得很小，从而大幅提高自己的闪避率。\n令使用者的闪避率提升2级。同时令使用者进入变小状态。",
    水流裂破: "用水之力撞向对手进行攻击。有时会降低对手的防御。",
    汲取: "吸取对手的养分进行攻击。回复与对手所受伤害相应的体力。",
    可怕面孔: "用恐怖的脸瞪着对手，使其害怕，从而大幅降低对手的速度。",
    剑舞: "激烈地跳起战舞提高气势，大幅提高自己的攻击。",
    替身: "削减少量HP制造替身，替自己承受攻击。",
  },
  ability: {
    水泡: "降低自己受到的火属性招式的威力，不会灼伤。\n拥有该特性的宝可梦受到火属性招式造成的伤害降低50%，不会陷入灼伤状态，并且水属性招式的威力变为原来的两倍。",
    威吓: "出场时威吓对手，使对手的攻击降低。",
    诅咒之躯: "受到攻击时，有时会让对手刚才使用的招式无法使用。",
    厚脂肪: "受到的火属性和冰属性招式伤害减半。",
    变身者: "出场时变身为眼前的对手。",
  },
  item: {
    文柚果: "宝可梦的HP低于一半时，会食用文柚果，回复最大HP的1/4。",
    吃剩的东西: "每回合结束时，持有者回复最大HP的1/16。",
    气势披带: "HP全满时，即使受到会导致濒死的攻击，也会保留1点HP。使用一次后消失。",
    先制之爪: "有时可以比同优先度的对手更早行动。",
  },
  pokemon: {},
};

function itemIconCandidates(value = "") {
  const raw = String(value || "").trim();
  const known: Record<string, string> = { "Focus Sash": "focus-sash", focussash: "focus-sash", "Sitrus Berry": "sitrus-berry", sitrusberry: "sitrus-berry", "Leftovers": "leftovers", leftovers: "leftovers", "Quick Claw": "quick-claw", quickclaw: "quick-claw" };
  const slug = known[raw] || raw.toLowerCase().replace(/([a-z])([A-Z])/g, "$1-$2").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug ? [`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/${slug}.png`, `https://play.pokemonshowdown.com/sprites/itemicons/${slug}.png`] : [];
}

function ReferenceIcon({ urls, alt, fallback, size = "large" }: { urls?: string[]; alt: string; fallback: string; size?: "small" | "large" }) {
  const candidates = (urls || []).filter(Boolean).filter((url, index, all) => all.indexOf(url) === index);
  const [index, setIndex] = useState(0);
  useEffect(() => { setIndex(0); }, [candidates.join("|")]);
  if (!candidates.length || index >= candidates.length) return <span className="text-xl font-black" style={{ color: "currentColor" }}>{fallback}</span>;
  return <img src={candidates[index]} alt={alt} onError={() => setIndex((value) => value + 1)} className={`${size === "small" ? "h-5 w-5" : "h-11 w-11"} object-contain drop-shadow-sm`} />;
}

let activeInfoTermClose: (() => void) | null = null;
const referenceInfoCache = new Map<string, any>();
const referenceInfoRequests = new Map<string, Promise<any>>();

function InfoTerm({ label, info, href, icon, iconUrl, iconUrls = [], category = "move" }: { label: string; info?: any; href?: string; icon?: string; iconUrl?: string; iconUrls?: string[]; category?: ReferenceCategory }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [remoteInfo, setRemoteInfo] = useState<any>(null);
  const [position, setPosition] = useState({ left: 16, top: 16, above: false });
  const style = REFERENCE_STYLES[category];
  const reference = remoteInfo || info || {};
  const rawDescription = String(reference.description || "").trim();
  const description = LOCAL_REFERENCE_DESCRIPTIONS[category][label] || (/[一-鿿]/.test(rawDescription) ? rawDescription : "暂无中文资料，悬停时将从 PokéCamp 获取。");
  const target = remoteInfo?.href || remoteInfo?.sourceUrl || href || reference.href || reference.sourceUrl;
  const closeCard = () => {
    setOpen(false);
    if (activeInfoTermClose === closeCard) activeInfoTermClose = null;
  };
  const clearClose = () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); };
  const scheduleClose = () => { clearClose(); closeTimer.current = window.setTimeout(closeCard, 120); };
  const loadReference = async () => {
    if (remoteInfo || loading) return;
    const cacheKey = `${category}:${compactLabel(label)}`;
    if (referenceInfoCache.has(cacheKey)) { setRemoteInfo(referenceInfoCache.get(cacheKey)); return; }
    setLoading(true);
    try {
      const request = referenceInfoRequests.get(cacheKey) || apiRequest<any>(`/api/reference/term?category=${category}&name=${encodeURIComponent(label)}`);
      referenceInfoRequests.set(cacheKey, request);
      const result = await request;
      referenceInfoCache.set(cacheKey, result);
      if (result?.ok) setRemoteInfo(result);
    } catch { /* 原网页仍可直接打开 */ }
    finally { referenceInfoRequests.delete(cacheKey); setLoading(false); }
  };
  const showCard = () => {
    clearClose();
    if (activeInfoTermClose && activeInfoTermClose !== closeCard) activeInfoTermClose();
    activeInfoTermClose = closeCard;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const above = rect.bottom + 340 > window.innerHeight;
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 356)), top: above ? Math.max(12, rect.top - 8) : rect.bottom + 8, above });
    }
    setOpen(true);
    loadReference();
  };
  useEffect(() => () => {
    clearClose();
    if (activeInfoTermClose === closeCard) activeInfoTermClose = null;
  }, []);
  const allIconUrls = [iconUrl, ...iconUrls, reference.spriteUrl, ...(Array.isArray(reference.spriteCandidates) ? reference.spriteCandidates : [])].filter(Boolean);
  const content = <><span className="inline-flex items-center gap-1">{allIconUrls.length ? <ReferenceIcon size="small" urls={allIconUrls} alt="" fallback={category === "move" ? "技" : category === "item" ? "道" : category === "ability" ? "特" : "宝"} /> : icon && <span>{icon}</span>}{label}</span><sup className="ml-0.5 text-[9px] font-bold leading-none" style={{ color: style.accent }}>?</sup></>;
  const card = <div className="fixed z-[120] w-[min(382px,calc(100vw-24px))] overflow-y-auto rounded-lg border border-t-2 bg-white p-3 text-left shadow-[0_16px_42px_rgba(15,23,42,.18)]" style={{ left: position.left, top: position.top, maxHeight: "min(430px, calc(100vh - 24px))", transform: position.above ? "translateY(-100%)" : undefined, borderColor: style.border, borderTopColor: style.accent }} onMouseEnter={clearClose} onMouseLeave={scheduleClose}>
      <div className="flex items-start gap-3"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl" style={{ background: style.soft, color: style.accent }}><ReferenceIcon urls={allIconUrls} alt={label} fallback={category === "move" ? "技" : category === "item" ? "道" : category === "ability" ? "特" : "宝"} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h4 className="text-[15px] font-bold text-slate-900">{label}</h4><span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: style.accent, background: style.soft }}>{style.label}</span></div><div className="mt-1 text-[11px] text-slate-400">{reference.englishName || reference.name || "PokéCamp"}</div></div></div>
      {loading && !LOCAL_REFERENCE_DESCRIPTIONS[category][label] && <div className="mt-2 text-xs text-slate-400">正在读取中文资料…</div>}
      <p className="mt-3 whitespace-pre-line text-[14px] leading-6 text-slate-600">{description}</p>
      {category === "pokemon" && <><div className="mt-3 flex flex-wrap gap-1.5">{(reference.types || []).map((type: string) => <span key={type} className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: TYPE_COLORS[type] || style.accent }}>{type}</span>)}</div><ReferenceStats stats={reference.baseStats} />{reference.abilities?.length > 0 && <div className="mt-3 text-xs text-slate-500"><span className="font-semibold text-slate-700">特性：</span>{reference.abilities.map((ability: any) => ability.name).join("、")}</div>}</>}
      {(category === "move" && (reference.basePower || reference.accuracy || reference.pp || reference.priority)) && <div className="mt-3 grid grid-cols-4 divide-x divide-slate-200 border-y border-slate-200 py-2 text-center text-[10px] text-slate-400"><span>威力<strong className="block text-sm text-slate-700">{reference.basePower || "—"}</strong></span><span>命中<strong className="block text-sm text-slate-700">{reference.accuracy || "—"}</strong></span><span>PP<strong className="block text-sm text-slate-700">{reference.pp || "—"}</strong></span><span>优先度<strong className="block text-sm text-slate-700">{reference.priority || 0}</strong></span></div>}
      {target && <a href={target} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold" style={{ color: style.accent }}>查看 PokéCamp 原网页 <ExternalLink className="h-3.5 w-3.5" /></a>}
    </div>;
  return <span ref={triggerRef} className="inline-flex max-w-full items-center align-baseline" onMouseEnter={showCard} onMouseLeave={scheduleClose}>
    <span className="inline-flex cursor-help items-center rounded-sm border-b border-dotted px-0.5 py-0.5 text-[15px] text-slate-700 transition hover:bg-slate-50 hover:text-indigo-700" style={{ borderColor: style.border }} onFocus={showCard} onBlur={scheduleClose} title={description}>
      {target ? <a href={target} target="_blank" rel="noreferrer" onClick={(event) => { if (!open) { event.preventDefault(); showCard(); } }}>{content}</a> : <span role="button" tabIndex={0} onClick={() => showCard()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") showCard(); }}>{content}</span>}
    </span>
    {open && typeof document !== "undefined" ? createPortal(card, document.body) : null}
  </span>;
}

function TypeChips({ types = [] }: { types?: string[] }) {
  return <div className="flex flex-wrap gap-1">{types.map((type) => <span key={type} className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: TYPE_COLORS[type] || "#64748b" }}>{type}</span>)}</div>;
}

function NatureValue({ value }: { value?: string }) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const nature = raw.split(/\s*[+＋\-−]/)[0] || raw;
  const boosts = [...raw.matchAll(/[+＋]\s*([^+＋\-−]+)/g)].map((match) => match[1].trim()).filter(Boolean);
  const drops = [...raw.matchAll(/[-−]\s*([^+＋\-−]+)/g)].map((match) => match[1].trim()).filter(Boolean);
  return <div className="flex flex-wrap items-center gap-2 text-[15px] text-slate-700"><span className="font-semibold">{nature}</span>{boosts.map((stat) => <span key={`up-${stat}`} className="rounded-md bg-blue-50 px-2 py-1 font-semibold text-blue-600">+{stat}</span>)}{drops.map((stat) => <span key={`down-${stat}`} className="rounded-md bg-rose-50 px-2 py-1 font-semibold text-rose-600">-{stat}</span>)}</div>;
}

function compactLabel(value: string) { return String(value || "").replace(/\s+/g, "").trim(); }

function splitAbilityLabels(value: string) {
  return String(value || "")
    .replace(/推荐(?:的)?(?:能力点数|努力值|配点)|能力点数推荐/g, "")
    .split(/\s*(?:→|->|=>)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sentenceGroups(text: string) {
  const sentences = String(text || "").replace(/\s+/g, " ").trim().split(/(?<=[。！？；])/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length <= 2) return sentences;
  const groups: string[] = [];
  for (let index = 0; index < sentences.length; index += 2) groups.push(sentences.slice(index, index + 2).join(""));
  return groups;
}

function RichStrategyParagraph({ text, links = [], members = [], seenPokemon }: { text: string; links?: Team["strategyLinks"]; members?: any[]; seenPokemon?: Set<string> }) {
  const references = [...(links || [])].sort((left, right) => right.text.length - left.text.length);
  if (!references.length) return <p>{text}</p>;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(${references.map((reference) => reference.text.split("").map((character) => escape(character)).join("\\s*")).join("|")})`, "g");
  return <p>{text.split(pattern).map((part, index) => { const reference = references.find((candidate) => compactLabel(candidate.text) === compactLabel(part)); if (!reference) return <span key={`${part}-${index}`}>{part}</span>; const member = members.find((item) => compactLabel(String(item.name || item.localizedName || item.slug)) === compactLabel(part)); const category = (["pokemon", "move", "item", "ability"] as string[]).includes(reference.kind) ? reference.kind as ReferenceCategory : "move"; const showSprite = Boolean(member?.sprite && category === "pokemon" && !seenPokemon?.has(compactLabel(reference.text))); if (showSprite) seenPokemon?.add(compactLabel(reference.text)); return <span key={`${part}-${index}`} className="inline-flex items-center"><InfoTerm label={part} category={category} href={reference.href} info={member ? { description: `${part} · 点击查看 PokéCamp 资料` } : undefined} iconUrl={showSprite ? member.sprite : undefined} /></span>; })}</p>;
}

function ReadableText({ text, links, members, seenPokemon, className = "" }: { text: string; links?: Team["strategyLinks"]; members?: any[]; seenPokemon?: Set<string>; className?: string }) {
  return <div className={`space-y-2 ${className}`}>{sentenceGroups(text).map((part, index) => <RichStrategyParagraph key={`${index}-${part.slice(0, 18)}`} text={part} links={links} members={members} seenPokemon={seenPokemon} />)}</div>;
}

function TeamCard({ team, onOpen }: { team: Team; onOpen: (team: Team) => void }) {
  const members = (team.members || []).slice(0, 6);
  return <motion.button type="button" whileHover={{ y: -3 }} transition={{ duration: 0.16 }} onClick={() => onOpen(team)} className="group w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-bold text-slate-800">{team.title || "未命名队伍"}</h3><div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500"><span className={`rounded-full px-2 py-0.5 font-semibold ${team.format === "single" ? "bg-amber-50 text-amber-700" : "bg-cyan-50 text-cyan-700"}`}>{team.format === "single" ? "单打 / BSS" : "双打 / VGC"}</span><span>{sourceLabel(team)}</span><span>{team.regulation || team.season || "当前赛制"}</span></div></div><span className="shrink-0 text-xs font-medium text-indigo-500 opacity-0 transition group-hover:opacity-100">查看详情</span></div>
    <div className="mt-4 grid grid-cols-6 gap-1 border-t border-slate-100 pt-3">{members.map((member, index) => <div key={`${team.id}-${member.id || member.slug || member.name || index}`} className="flex min-w-0 flex-col items-center"><TeamSprite member={member} /><span className="mt-1 w-full truncate text-center text-[10px] text-slate-600">{member.localizedName || member.name || member.slug}</span></div>)}</div>
    <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400"><span>{team.source || "PokéCamp"}</span><span>{team.configurations?.length || members.length || 0} 个配置</span></div>
  </motion.button>;
}

function StrategyPanel({ team }: { team: Team }) {
  const blocks = Array.isArray(team.strategyBlocks) && team.strategyBlocks.length ? team.strategyBlocks : String(team.strategyText || "").split(/\n{2,}/).map((text) => ({ type: "paragraph" as const, text: text.trim() })).filter((block) => block.text);
  const badge = team.strategyComplete ? "已抓取完整文章" : team.strategyAvailable ? "已保留可用说明" : "正文待同步";
  const seenPokemon = new Set<string>();
  return <section className={`rounded-xl border p-5 ${team.strategyAvailable ? "border-slate-200 bg-white" : "border-amber-200 bg-amber-50/70"}`}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-bold text-slate-900">战术与解说</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${team.strategyAvailable ? "bg-emerald-50 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{badge}</span></div>{blocks.length ? <div className="mt-4 space-y-4 text-[13px] leading-7 text-slate-700">{blocks.map((block, index) => block.type === "heading" ? <h4 key={`${block.text}-${index}`} className="border-l-4 border-indigo-400 pl-3 font-bold text-slate-900">{block.text}</h4> : <ReadableText key={`${block.text.slice(0, 24)}-${index}`} text={block.text} links={team.strategyLinks} members={team.members} seenPokemon={seenPokemon} />)}</div> : <p className="mt-4 text-sm text-amber-800">当前队伍的独立正文尚未同步；已保留的逐只配置说明会显示在下方。</p>}</section>;
}

function ConfigurationCard({ team, configuration, index, compact = false }: { team: Team; configuration: any; index: number; compact?: boolean }) {
  const member = team.members?.[index] || configuration;
  const name = configuration.name || member.name || member.slug || `宝可梦 ${index + 1}`;
  const refs = configuration.references || {};
  const types = member.types || [];
  const moves = (configuration.moves || []).filter(Boolean);
  const itemLabel = configuration.itemLabel || refs.item?.localizedName || configuration.item || member.item || "";
  const abilityLabels = (Array.isArray(configuration.abilities) && configuration.abilities.length ? configuration.abilities : splitAbilityLabels(configuration.abilityLabel || configuration.ability || refs.ability?.localizedName || ""));
  const abilityLabel = abilityLabels.join(" → ");
  const missingFields = [
    !itemLabel && "道具",
    !abilityLabel && "特性",
    !configuration.nature && "性格",
    !moves.length && "招式",
    !(configuration.stats || configuration.actualStats) && "能力值",
  ].filter(Boolean) as string[];
  return <article className={`rounded-xl border border-slate-200 bg-white p-5 ${compact ? "shadow-sm" : "shadow-[0_1px_6px_rgba(15,23,42,.04)]"}`}>
    <div className="flex items-start gap-3 border-b border-slate-200 pb-4"><div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white"><TeamSprite member={member} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><InfoTerm label={name} category="pokemon" iconUrls={member.spriteCandidates} iconUrl={member.sprite} info={{ ...(member.reference || {}), description: member.reference?.description || `${name} · 悬停查看属性、种族值与特性` }} href={`https://pokecamp.cc/zh/pokemon/${encodeURIComponent(member.slug || member.name || name)}`} /></div><div className="mt-2"><TypeChips types={types} /></div></div></div>
    <div className={`mt-4 grid gap-x-6 gap-y-4 text-sm ${compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}>
      {itemLabel && <div><div className="text-xs font-semibold text-slate-400">道具</div><div className="mt-1"><InfoTerm category="item" label={itemLabel} info={refs.item} iconUrls={itemIconCandidates(refs.item?.name || refs.item?.id || configuration.item || itemLabel)} iconUrl={refs.item?.id ? `https://play.pokemonshowdown.com/sprites/itemicons/${refs.item.id}.png` : undefined} href={refs.item?.href || `https://pokecamp.cc/zh/items/${encodeURIComponent(refs.item?.id || configuration.item || itemLabel)}`} /></div></div>}
      {abilityLabels.length > 0 && <div><div className="text-xs font-semibold text-slate-400">特性</div><div className="mt-1 flex flex-wrap items-center gap-1.5">{abilityLabels.map((ability: string, abilityIndex: number) => <span key={`${ability}-${abilityIndex}`} className="inline-flex items-center gap-1.5">{abilityIndex > 0 && <span className="text-xs text-slate-300" aria-hidden="true">→</span>}<InfoTerm category="ability" label={ability} info={refs.abilities?.[abilityIndex] || (abilityIndex === 0 ? refs.ability : undefined)} href={refs.abilities?.[abilityIndex]?.href || (abilityIndex === 0 ? refs.ability?.href : undefined) || `https://pokecamp.cc/zh/abilities/${encodeURIComponent(refs.abilities?.[abilityIndex]?.id || refs.ability?.id || configuration.ability || ability)}`} /></span>)}</div></div>}
      {configuration.nature && <div><div className="text-xs font-semibold text-slate-400">性格</div><div className="mt-1"><NatureValue value={configuration.nature} /></div></div>}
      {configuration.teraType && <div><div className="text-xs font-semibold text-slate-400">太晶属性</div><div className="mt-1 text-[15px] font-semibold text-slate-700">{configuration.teraType}</div></div>}
    </div>
    {(configuration.stats || configuration.actualStats) && <div className="mt-4 grid gap-4 border-t border-slate-200 pt-4 text-sm md:grid-cols-2">{configuration.stats && <div><div className="text-xs font-semibold text-slate-400">能力点数</div><div className="mt-1 font-mono text-[14px] leading-7 text-slate-800">{configuration.stats}</div></div>}{configuration.actualStats && <div><div className="text-xs font-semibold text-slate-400">实数值</div><div className="mt-1 font-mono text-[14px] leading-7 text-slate-800">{configuration.actualStats}</div></div>}</div>}
    {moves.length > 0 && <div className="mt-4 border-t border-slate-200 pt-4"><div className="text-xs font-semibold text-slate-400">招式</div><div className={`mt-2 grid gap-x-5 gap-y-3 ${compact ? "grid-cols-2" : "flex flex-wrap"}`}>{moves.map((move: string, moveIndex: number) => <InfoTerm key={`${move}-${moveIndex}`} category="move" label={configuration.moveLabels?.[moveIndex] || refs.moves?.[moveIndex]?.localizedName || move} info={refs.moves?.[moveIndex]} href={refs.moves?.[moveIndex]?.href || `https://pokecamp.cc/zh/moves/${encodeURIComponent(refs.moves?.[moveIndex]?.id || move)}`} />)}</div></div>}
    {missingFields.length > 0 && <div className="mt-4 border-t border-dashed border-amber-200 pt-3 text-xs leading-5 text-amber-700"><span className="font-semibold">{team.detailStatus === "COMPLETE" ? "原站未提供此项配置" : "本地详情待补全"}</span><span className="mx-1 text-amber-400">·</span>{team.detailStatus === "COMPLETE" ? `缺少：${missingFields.join("、")}` : "抓取未取得完整详情；可打开原始页面核对，下一次同步会自动重试。"}</div>}
    {!compact && configuration.notes?.length > 0 && <div className="mt-4 border-t border-slate-200 pt-4 text-[15px] leading-7 text-slate-600"><ReadableText text={configuration.notes.join(" ")} links={configuration.noteLinks} members={team.members} seenPokemon={new Set<string>()} /></div>}
  </article>;
}

function TeamDetails({ team, onClose, onApplyToForge }: { team: Team; onClose: () => void; onApplyToForge: (team: Team) => void }) {
  const isBuild = String(team.sourcePageType || "").startsWith("team-builds");
  const articleTitle = isBuild ? team.strategyTitle || team.title : team.title;
  const published = team.strategyPublished || "";
  const share = () => { if (navigator.share) navigator.share({ title: articleTitle || team.title, url: team.href || window.location.href }).catch(() => undefined); else navigator.clipboard?.writeText(team.href || window.location.href); };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><motion.section initial={{ opacity: 0, scale: 0.97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} className="forge-scrollbar max-h-[92vh] w-full max-w-6xl overflow-y-auto rounded-2xl bg-slate-50 p-4 shadow-2xl sm:p-6">
    <header className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4"><div className="min-w-0"><h2 className="text-xl font-bold text-slate-900">{articleTitle || "未命名队伍"}</h2><p className="mt-1 text-sm text-slate-500">{published || team.author || team.source || "PokéCamp"}{team.strategyAuthor ? ` · ${team.strategyAuthor}` : ""} · {team.regulation || team.season || "当前赛制"}</p></div><div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => onApplyToForge(team)} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700" title="应用到配队工坊"><ArrowDownToLine className="h-4 w-4" />应用到配队工坊</button><button type="button" onClick={share} aria-label="分享队伍" className="rounded-lg p-2 text-slate-500 hover:bg-white hover:text-slate-900">↗</button><button type="button" aria-label="关闭详情" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-white hover:text-slate-900"><X className="h-5 w-5" /></button></div></header>
    {isBuild ? <div className="mt-4 space-y-4"><StrategyPanel team={team} /><div className="flex items-center gap-1 overflow-x-auto rounded-full border border-slate-200 bg-white p-1">{(team.members || []).map((member, index) => <a key={`${member.name}-${index}`} href={`#team-${team.id}-${index}`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white hover:border-indigo-400"><TeamSprite member={member} /></a>)}</div><div className="space-y-4">{(team.configurations || team.members || []).slice(0, 6).map((configuration: any, index: number) => <div id={`team-${team.id}-${index}`} key={`${team.id}-detail-${index}`}><ConfigurationCard team={team} configuration={configuration} index={index} /></div>)}</div></div> : <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{(team.configurations || team.members || []).slice(0, 6).map((configuration: any, index: number) => <ConfigurationCard key={`${team.id}-detail-${index}`} team={team} configuration={configuration} index={index} compact />)}</div>}
    {team.href && <a href={team.href} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-600 hover:text-indigo-800">打开原始页面 <ExternalLink className="h-4 w-4" /></a>}
  </motion.section></div>;
}

export function DataCenter() {
  const { setTeam } = useWorkbench();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [format, setFormat] = useState("all");
  const [pageType, setPageType] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [teamPages, setTeamPages] = useState({ total: 0, totalAll: 0, totalPages: 1, formatCounts: { all: 0, single: 0, double: 0 }, pageTypeCounts: { all: 0, vgc: 0, builds: 0 } });
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [referenceStatus, setReferenceStatus] = useState<any>({ counts: {} });
  const [monitor, setMonitor] = useState<any>({ enabled: false, bypassCf: true, status: "STOPPED", intervalMinutes: 360, pages: 3, running: false, lastResult: null });
  const teamsRequestId = useRef(0);

  const loadTeams = async (nextPage = page, nextFormat = format, nextSearch = search, nextPageType = pageType) => { const requestId = ++teamsRequestId.current; try { const params = new URLSearchParams({ page: String(nextPage), pageSize: "24", format: nextFormat, pageType: nextPageType, source: "pokecamp" }); if (nextSearch.trim()) params.set("search", nextSearch.trim()); const data = await apiRequest<any>(`/api/pokecamp/teams?${params.toString()}`); if (requestId !== teamsRequestId.current) return; setTeams(data.teams || []); setTeamPages({ total: data.total || 0, totalAll: data.totalAll || 0, totalPages: data.totalPages || 1, formatCounts: data.formatCounts || { all: 0, single: 0, double: 0 }, pageTypeCounts: data.pageTypeCounts || { all: 0, vgc: 0, builds: 0 } }); } catch (error: any) { if (requestId === teamsRequestId.current) setMessage(`队伍数据读取失败：${error.message}`); } };
  const refreshMonitor = async () => { try { setMonitor(await apiRequest("/api/pokecamp/monitor/status")); } catch { /* 旧服务没有监听接口时不阻断数据中心 */ } };
  const refreshReferenceStatus = async () => { try { setReferenceStatus(await apiRequest("/api/reference/status")); } catch { /* 旧服务无需阻断队伍浏览 */ } };
  useEffect(() => { refreshMonitor(); const timer = window.setInterval(() => { refreshMonitor(); }, 2500); return () => window.clearInterval(timer); }, []);
  useEffect(() => { refreshReferenceStatus(); }, []);
  useEffect(() => { loadTeams(page, format, search, pageType); }, [page, format, pageType]);
  const startMonitor = async () => { setBusy("monitor-start"); setMessage(""); try { const result = await apiRequest<any>("/api/pokecamp/monitor/start", { method: "POST", body: JSON.stringify({ intervalMinutes: monitor.intervalMinutes || 360, pages: monitor.pages || 3 }) }); setMonitor(result); setMessage("已启动 PokéCamp 自动监听；首次检查会在后台开始，并复用已验证的浏览器会话。"); } catch (error: any) { setMessage(`自动监听启动失败：${error.message}`); } finally { setBusy(""); } };
  const stopMonitor = async () => { setBusy("monitor-stop"); try { setMonitor(await apiRequest<any>("/api/pokecamp/monitor/stop", { method: "POST", body: "{}" })); setMessage("已停止 PokéCamp 自动监听。"); } catch (error: any) { setMessage(`自动监听停止失败：${error.message}`); } finally { setBusy(""); } };
  const runMonitorNow = async () => { setBusy("monitor-run"); setMessage(""); try { const accepted = await apiRequest<any>("/api/pokecamp/monitor/run", { method: "POST", body: "{}" }); setMonitor(accepted); setMessage("已开始立即检查，完成后队伍库会自动更新。"); } catch (error: any) { setMessage(`立即检查失败：${error.message}`); } finally { setBusy(""); } };
  const toggleBypass = async (enabled: boolean) => { setBusy("bypass"); try { setMonitor(await apiRequest<any>("/api/pokecamp/monitor/bypass", { method: "POST", body: JSON.stringify({ enabled }) })); setMessage(enabled ? "已切换为 HTTP 直取：监听与抓取直接读取站方公开静态数据，无需浏览器或人工验证。" : "已切换为浏览器抓取：需要先在原站完成一次人工验证。"); } catch (error: any) { setMessage(`抓取模式切换失败：${error.message}`); } finally { setBusy(""); } };
  const syncReferenceData = async () => { setBusy("reference"); setMessage(""); try { await apiRequest<any>("/api/pokecamp/browser/open", { method: "POST", body: JSON.stringify({ url: REFERENCE_SOURCES[0].url }) }); const result = await apiRequest<any>("/api/reference/sync", { method: "POST", body: JSON.stringify({ categories: REFERENCE_SOURCES.map((item) => item.id) }) }); if (!result.ok) throw new Error(result.error || "请先完成 PokéCamp 验证"); setReferenceStatus(result); setMessage(`已同步 PokéCamp 资料：${(result.summary || []).map((item: any) => `${item.category} ${item.total}`).join(" · ")}`); } catch (error: any) { setMessage(`资料同步失败：${error.message}`); } finally { setBusy(""); } };
  const applyTeamToForge = (team: Team) => {
    const natureNames: Record<string, string> = { 勤奋: "Hardy", 怕寂寞: "Lonely", 勇敢: "Brave", 固执: "Adamant", 顽皮: "Naughty", 大胆: "Bold", 坦率: "Docile", 悠闲: "Relaxed", 淘气: "Impish", 乐天: "Lax", 胆小: "Timid", 急躁: "Hasty", 认真: "Serious", 爽朗: "Jolly", 天真: "Naive", 内敛: "Modest", 慢吞吞: "Mild", 冷静: "Quiet", 害羞: "Bashful", 马虎: "Rash", 温和: "Calm", 温顺: "Gentle", 自大: "Sassy", 慎重: "Careful", 浮躁: "Quirky", がんばりや: "Hardy", さみしがり: "Lonely", ゆうかん: "Brave", いじっぱり: "Adamant", やんちゃ: "Naughty", ずぶとい: "Bold", すなお: "Docile", わんぱく: "Impish", のうてんき: "Lax", のんき: "Relaxed", せっかち: "Hasty", ようき: "Jolly", むじゃき: "Naive", ひかえめ: "Modest", おっとり: "Mild", れいせい: "Quiet", てれや: "Bashful", うっかりや: "Rash", おだやか: "Calm", おとなしい: "Gentle", なまいき: "Sassy", しんちょう: "Careful", きまぐれ: "Quirky" };
    const members = team.members || [];
    const configurations = team.configurations || members;
    setTeam(configurations.slice(0, 6).map((configuration: any, index: number) => {
      const member = members[index] || {};
      const refs = configuration.references || {};
      const speciesSlug = member.slug || member.species || configuration.slug || configuration.species || configuration.name || member.name || member.localizedName || "";
      const species = speciesSlug.replace(/-mega(?:-[xy])?$/i, "");
      const megaBaseAbilities: Record<string, string> = { "mawile-mega": "Hyper Cutter", "skarmory-mega": "Keen Eye" };
      const displayName = member.localizedName || member.name || configuration.localizedName || configuration.name || member.slug || configuration.slug || `成员 ${index + 1}`;
      const natureLabel = String(configuration.nature || "").split(/\s*[+＋\-−]/)[0];
      const abilityChain = String(configuration.ability || member.ability || "").split(/\s*(?:→|->|=>)\s*/).filter(Boolean);
      const ability = configuration.preMegaAbility || abilityChain[0] || refs.ability?.name || member.ability || "";
      const resolvedAbility = /-mega(?:-[xy])?$/i.test(String(speciesSlug))
        ? resolveShowdownTerm(megaBaseAbilities[String(speciesSlug).toLowerCase()] || configuration.preMegaAbility || ability, "", "abilities")
        : resolveShowdownTerm(configuration.ability || member.ability, ability, "abilities");
      return {
        id: member.id || member.slug || configuration.slug || displayName || `slot-${index}`,
        name: displayName,
        species,
        localizedName: displayName,
        slug: speciesSlug,
        dex: member.dex,
        sprite: member.sprite || member.spriteCandidates?.[0] || configuration.sprite || configuration.dex || member.dex || member.slug || species,
        spriteCandidates: member.spriteCandidates || [],
        types: member.types || [],
        role: configuration.role || member.role || "",
        item: resolveShowdownTerm(configuration.item || member.item, refs.item?.name, "items"),
        itemLabel: configuration.itemLabel || configuration.item || member.item || "",
        ability: resolvedAbility,
        abilityLabel: configuration.abilityLabel || (abilityChain.length > 1 ? abilityChain.join(" → ") : configuration.ability || member.ability || ability),
        nature: natureNames[natureLabel] || natureNames[String(configuration.nature || "").trim()] || natureLabel,
        natureLabel: configuration.nature || "",
        stats: configuration.stats || "",
        actualStats: configuration.actualStats || "",
        moves: (configuration.moves || []).map((move: string, moveIndex: number) => resolveShowdownTerm(move, refs.moves?.[moveIndex]?.name, "moves")),
        moveLabels: configuration.moveLabels || configuration.moves || [],
      };
    }));
    setSelectedTeam(null);
    window.dispatchEvent(new CustomEvent("champion-forge:navigate", { detail: "team-forge" }));
    setMessage(`已将「${team.title || "当前队伍"}」应用到配队工坊`);
  };
  const stats = useMemo(() => [{ label: "PokéCamp 队伍", value: teamPages.totalAll }, { label: "VGC 队伍页", value: teamPages.pageTypeCounts.vgc }, { label: "队伍构筑页", value: teamPages.pageTypeCounts.builds }], [teamPages]);
  const monitorPanel = <section className="rounded-2xl border border-cyan-300/20 bg-slate-950/70 p-5 shadow-2xl shadow-cyan-950/10"><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-300"><Clock3 className="h-5 w-5" /></div><div><h2 className="text-lg font-semibold text-white">原站阵容自动监听</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">定时检查 PokéCamp 三类队伍页面，发现新阵容或详情变化后自动合并到本地队伍库。{monitor.bypassCf ? "当前为 HTTP 直取模式：直接拉取站方静态数据，无需浏览器或人工验证。" : "需要先完成一次原站验证，监听不会绕过验证码或 Cloudflare。"}</p></div></div><div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300"><span className={`h-2 w-2 rounded-full ${monitor.running ? "animate-pulse bg-cyan-300" : monitor.enabled ? "bg-emerald-400" : "bg-slate-500"}`} />{monitor.running ? "检查中" : monitor.enabled ? "监听中" : "已停止"}</div></div><div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"><button type="button" onClick={() => toggleBypass(!monitor.bypassCf)} disabled={!!busy || monitor.running} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:opacity-50 ${monitor.bypassCf ? "border-emerald-300/30 bg-emerald-400/15 text-emerald-200" : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"}`}><ShieldCheck className="h-4 w-4" />绕过 CF 验证 · HTTP 直取{monitor.bypassCf ? "（开）" : "（关）"}</button><span className="text-xs leading-5 text-slate-500">{monitor.bypassCf ? "监听与抓取直接拉取站方静态 JSON，不打开浏览器、无需人工验证。" : "监听与抓取使用浏览器会话，需要先在原站完成一次人工验证。"}</span></div><div className="mt-4 flex flex-wrap items-end gap-3"><label className="text-sm text-slate-300">检查间隔<select value={monitor.intervalMinutes || 360} onChange={(event) => setMonitor((value: any) => ({ ...value, intervalMinutes: Number(event.target.value) }))} style={{ colorScheme: "dark" }} className="ml-2 rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-sm text-white outline-none"><option value="60" className="bg-slate-900 text-white">每 1 小时</option><option value="180" className="bg-slate-900 text-white">每 3 小时</option><option value="360" className="bg-slate-900 text-white">每 6 小时</option><option value="720" className="bg-slate-900 text-white">每 12 小时</option><option value="1440" className="bg-slate-900 text-white">每天</option></select></label><label className="text-sm text-slate-300">检查页数<input type="number" min="1" max="30" disabled={monitor.bypassCf} title={monitor.bypassCf ? "HTTP 直取模式下页数不适用" : undefined} value={monitor.pages || 3} onChange={(event) => setMonitor((value: any) => ({ ...value, pages: Math.max(1, Math.min(30, Number(event.target.value) || 3)) }))} className="ml-2 w-20 rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-sm text-white outline-none" /></label><button type="button" onClick={startMonitor} disabled={!!busy || monitor.running} className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-400 disabled:opacity-50"><Play className="h-4 w-4" />启动监听</button><button type="button" onClick={runMonitorNow} disabled={!!busy || monitor.running} className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-4 py-2.5 text-sm font-semibold text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${busy === "monitor-run" ? "animate-spin" : ""}`} />立即检查</button><button type="button" onClick={stopMonitor} disabled={!!busy || (!monitor.enabled && !monitor.running)} className="inline-flex items-center gap-2 rounded-lg border border-rose-300/25 bg-rose-300/10 px-4 py-2.5 text-sm font-semibold text-rose-100 hover:bg-rose-300/20 disabled:opacity-50"><Square className="h-3.5 w-3.5" />停止监听</button></div>{monitor.lastResult && <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-400"><span>本次扫描 {monitor.lastResult.scanned || 0} 支</span><span className="text-emerald-300">新增 {monitor.lastResult.added || 0}</span><span className="text-cyan-300">更新 {monitor.lastResult.updated || 0}</span><span>详情 {monitor.lastResult.details || 0}</span>{monitor.lastCompletedAt && <span>完成于 {new Date(monitor.lastCompletedAt).toLocaleString("zh-CN", { hour12: false })}</span>}</div>}{monitor.lastError && <div className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs leading-5 text-amber-100">{monitor.lastError}</div>}</section>;

  return <div className="space-y-6"><motion.header initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-end justify-between gap-4"><div><div className="flex items-center gap-2 text-indigo-300 text-xs font-semibold uppercase tracking-[0.18em]"><Database className="h-4 w-4" /> Data pipeline</div><h1 className="mt-2 text-3xl font-bold text-white">数据中心</h1><p className="mt-1 text-sm text-slate-400">浏览已抓取的 PokéCamp 队伍，并管理后续数据同步</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={syncReferenceData} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${busy === "reference" ? "animate-spin" : ""}`} />同步 PokéCamp 资料</button><a href="https://pokecamp.cc/zh/champions/vgc-teams" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 hover:bg-white/10">PokéCamp 原站 <ExternalLink className="h-3.5 w-3.5" /></a></div></motion.header>
    {monitorPanel}{message && <div className="flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800"><CheckCircle2 className="h-4 w-4" />{message}</div>}<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">{stats.map((item) => <div key={item.label} className="rounded-xl border border-white/10 bg-white/[0.06] p-4"><div className="text-xs text-slate-400">{item.label}</div><div className="mt-1 text-2xl font-bold text-white">{item.value}</div></div>)}</div>
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="flex items-center gap-2 text-lg font-bold text-slate-900"><Users className="h-5 w-5 text-indigo-600" />已导入队伍库</div><p className="mt-1 text-sm text-slate-500">共 {teamPages.totalAll} 支 PokéCamp 队伍，按来源页面和赛制独立筛选</p></div><button type="button" onClick={() => loadTeams(page, format, search, pageType)} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"><RefreshCw className="h-4 w-4" />刷新队伍</button></div><div className="mt-5 space-y-3"><div className="flex flex-wrap items-center gap-2 text-sm text-slate-500"><span className="mr-1 font-semibold text-slate-700">来源页面</span><button onClick={() => { setPageType("all"); setPage(1); }} className={`rounded-lg px-3 py-2 ${pageType === "all" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>全部 {teamPages.pageTypeCounts.all}</button><button onClick={() => { setPageType("vgc-teams"); setPage(1); }} className={`rounded-lg px-3 py-2 ${pageType === "vgc-teams" ? "bg-cyan-600 text-white" : "bg-slate-100 text-slate-600"}`}>VGC 队伍页 {teamPages.pageTypeCounts.vgc}</button><button onClick={() => { setPageType("team-builds"); setPage(1); }} className={`rounded-lg px-3 py-2 ${pageType === "team-builds" ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-600"}`}>队伍构筑页 {teamPages.pageTypeCounts.builds}</button></div><div className="flex flex-wrap items-center gap-2"><div className="relative min-w-[220px] flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setPage(1); loadTeams(1, format, search, pageType); } }} placeholder="搜索队伍名或宝可梦" className="h-10 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-sm text-slate-700 outline-none focus:border-indigo-400" /></div><div className="flex items-center gap-2 text-sm text-slate-500"><Filter className="h-4 w-4" /><button onClick={() => { setFormat("all"); setPage(1); }} className={`rounded-lg px-3 py-2 ${format === "all" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>全部赛制</button><button onClick={() => { setFormat("single"); setPage(1); }} className={`rounded-lg px-3 py-2 ${format === "single" ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-600"}`}>单打 {teamPages.formatCounts.single}</button><button onClick={() => { setFormat("double"); setPage(1); }} className={`rounded-lg px-3 py-2 ${format === "double" ? "bg-cyan-600 text-white" : "bg-slate-100 text-slate-600"}`}>双打 {teamPages.formatCounts.double}</button></div></div></div>{teams.length ? <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">{teams.map((team) => <TeamCard key={team.id} team={team} onOpen={setSelectedTeam} />)}</div> : <div className="mt-5 flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-slate-500"><Database className="mb-2 h-8 w-8 text-slate-300" /><p>当前筛选没有队伍</p></div>}<div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4 text-sm text-slate-500"><span>显示 {teams.length} 支 · 第 {teamPages.total ? page : 0} / {teamPages.totalPages} 页</span><div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-slate-200 p-2 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button><button disabled={page >= teamPages.totalPages} onClick={() => setPage((value) => Math.min(teamPages.totalPages, value + 1))} className="rounded-lg border border-slate-200 p-2 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button></div></div></section>
    {selectedTeam && <TeamDetails team={selectedTeam} onClose={() => setSelectedTeam(null)} onApplyToForge={applyTeamToForge} />}
  </div>;
}
