import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Edit2, Save, Plus, Trash2, ChevronUp, Tag, Search, Loader2, CheckCircle, AlertTriangle } from "lucide-react";
import { Card3D } from "../components/inspira/Card3D";
import { ShimmerButton } from "../components/inspira/Buttons";
import { GlowInput } from "../components/inspira/GlowInput";
import { BorderBeam } from "../components/inspira/BorderBeam";
import { useWorkbench } from "../context/WorkbenchContext";
import { apiRequest, formatRuleName, spriteUrl, teamToShowdown } from "../lib/api";
import { normalizeTeamMember } from "../data/realData";

const TYPE_COLORS: Record<string, string> = { 水: "#6390F0", 飞行: "#A98FF3", 草: "#7AC74C", 幽灵: "#735797", 钢: "#B7B7CE", 龙: "#6F35FC", 火: "#EE8130", 恶: "#705746", 毒: "#A33EA1" };

function ForgeSprite({ member, className = "w-full h-full" }: { member: any; className?: string }) {
  const candidates = [member?.sprite, ...(Array.isArray(member?.spriteCandidates) ? member.spriteCandidates : []), member?.species, member?.slug, member?.dex].filter(Boolean).map((value) => spriteUrl(value)).filter((value, index, all) => all.indexOf(value) === index);
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [candidates.join("|")]);
  return <img src={candidates[index] || spriteUrl(member?.species || member?.name || "unknown")} onError={() => setIndex((value) => Math.min(value + 1, candidates.length))} alt={member?.localizedName || member?.name || member?.species || "宝可梦"} className={`${className} object-contain drop-shadow-md`} />;
}

export function TeamForge() {
  const { team, setTeam, registry } = useWorkbench();
  const [selectedPoke, setSelectedPoke] = useState<number | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [teamName, setTeamName] = useState("当前工作台队伍");
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<any>({ items: [], loading: false, total: 0, configurationTotal: 0, rulesetId: "", error: "" });
  const [expanded, setExpanded] = useState("");
  const [validation, setValidation] = useState<any>(null);
  const [forgeFormat, setForgeFormat] = useState<"single" | "double">("double");
  const activeRule = registry.active?.find((item: any) => item.battleType === forgeFormat) || registry.active?.[0];
  const selected = selectedPoke !== null ? team[selectedPoke] : null;

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setCandidates((value: any) => ({ ...value, loading: true, error: "" }));
      try {
        const params = new URLSearchParams({ format: forgeFormat, rulesetId: activeRule?.rulesetId || "", query, category: "all", offset: "0", limit: "24" });
        const data = await apiRequest(`/api/rules/candidates?${params}`);
        setCandidates({ ...data, items: data.items || [], loading: false, error: "" });
      } catch (error: any) {
        setCandidates((value: any) => ({ ...value, loading: false, error: error.message }));
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, forgeFormat, activeRule?.rulesetId]);

  useEffect(() => {
    setValidation(null);
    setExpanded("");
  }, [forgeFormat, activeRule?.rulesetId]);

  const updateSelected = (field: string, value: any) => {
    if (selectedPoke === null) return;
    setTeam((current) => current.map((member, index) => index === selectedPoke ? { ...member, [field]: value } : member));
  };
  const validate = async () => {
    setValidation({ loading: true });
    try {
      const data = await apiRequest("/api/validate-team", { method: "POST", body: JSON.stringify({ format: forgeFormat, rulesetId: activeRule?.rulesetId, text: teamToShowdown(team) }) });
      setValidation(data);
    } catch (error: any) {
      setValidation({ ok: false, error: error.message, problems: error.data?.problems || error.data?.details?.problems || [] });
    }
  };
  const addCandidate = (candidate: any, config: any) => {
    const next = normalizeTeamMember({ id: candidate.id, name: candidate.name, species: candidate.teamSpecies || candidate.name, localizedName: candidate.localizedName, dex: candidate.dex, sprite: candidate.sprite, role: config.role, item: config.item, itemLabel: config.itemLabel, ability: config.ability, abilityLabel: config.abilityLabel, nature: config.nature, natureLabel: config.natureLabel, stats: config.stats, types: candidate.typeLabels || candidate.types || [], moves: config.moves || [], moveLabels: config.moveLabels || config.moves || [] });
    setTeam((current) => {
      const target = selectedPoke ?? current.findIndex((member) => !member.locked);
      if (target < 0) return current;
      return current.map((member, index) => index === target ? next : member);
    });
    setSelectedPoke(selectedPoke ?? 0);
  };
  const moveIds = useMemo(() => team.flatMap((member: any) => member.moves || []).map((move: string) => move.toLowerCase().replace(/[^a-z0-9]/g, "")), [team]);
  const metric = (names: string[], base = 35) => Math.min(100, base + moveIds.filter((move: string) => names.includes(move)).length * 16);
  const analyses = [{ label: "输出能力", v: metric(["electroshot", "wavecrash", "earthpower", "sludgebomb"]) }, { label: "保护能力", v: metric(["protect", "ragepowder", "leechseed"]) }, { label: "速度控制", v: metric(["tailwind", "trickroom", "aquajet"]) }, { label: "轮转能力", v: metric(["fakeout", "partingshot", "flipturn"]) }];

  return <div className="space-y-5">
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 p-2"><span className="px-2 text-xs font-semibold text-indigo-700">当前配队赛制</span>{([["single", "BSS 单打"], ["double", "VGC 双打"]] as const).map(([value, label]) => <button key={value} onClick={() => setForgeFormat(value)} className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${forgeFormat === value ? "bg-indigo-500 text-white shadow-sm" : "bg-white text-slate-500 hover:bg-indigo-100"}`}>{label}</button>)}<span className="ml-auto text-xs text-indigo-500">官方可用池 {candidates.officialPoolCount || "--"} 条</span></div>
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Rajdhani, sans-serif" }}>配队工坊</h1><p className="text-slate-400 text-sm mt-0.5">Team Forge · 当前规则下的真实队伍配置</p></div><div className="flex items-center gap-3"><ShimmerButton onClick={() => setShowAnalysis(!showAnalysis)}>{showAnalysis ? "隐藏分析" : "队伍分析"}</ShimmerButton><ShimmerButton onClick={() => setEditMode(!editMode)}><Edit2 className="w-3.5 h-3.5" />{editMode ? "退出编辑" : "编辑队伍"}</ShimmerButton><ShimmerButton onClick={validate} disabled={validation?.loading}><Save className="w-3.5 h-3.5" />{validation?.loading ? "校验中" : "校验并保存"}</ShimmerButton></div></motion.div>
    <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm"><div className="flex flex-wrap items-center gap-3">{editMode ? <GlowInput className="flex-1 min-w-48" value={teamName} onChange={(e) => setTeamName(e.target.value)} /> : <span className="font-semibold text-slate-800">{teamName}</span>}<div className="flex flex-wrap gap-2">{[activeRule?.battleType === "double" ? "VGC" : "BSS", activeRule?.regulation || "等待规则", formatRuleName(activeRule?.name || "当前规则")].map((tag) => <span key={tag} className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs bg-indigo-50 text-indigo-600 border border-indigo-100"><Tag className="w-3 h-3" />{tag}</span>)}</div><div className={`ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium ${validation?.ok ? "bg-emerald-50 border-emerald-100 text-emerald-600" : validation?.ok === false ? "bg-red-50 border-red-100 text-red-600" : "bg-slate-50 border-slate-100 text-slate-500"}`}>{validation?.ok ? <CheckCircle className="w-3.5 h-3.5" /> : validation?.ok === false ? <AlertTriangle className="w-3.5 h-3.5" /> : null}{validation?.ok ? "合法队伍" : validation?.ok === false ? "校验失败" : "尚未校验"}</div></div>{validation?.ok === false && <div className="mt-3 text-xs text-red-600">{validation.error || validation.problems?.join("；")}</div>}{validation?.ok && <div className="mt-3 text-xs text-emerald-600">已通过 {validation.showdownFormatId}，rulesetId: {validation.rulesetId}</div>}</div>
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">{team.map((poke: any, idx: number) => <Card3D key={`${poke.id}-${idx}`} intensity={10}><motion.button initial={{ opacity: 0, scale: .92 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: idx * .05 }} onClick={() => setSelectedPoke(selectedPoke === idx ? null : idx)} className={`relative w-full text-left rounded-xl p-3 transition-all ${selectedPoke === idx ? "bg-indigo-50 border-2 border-indigo-400 shadow-lg shadow-indigo-100" : "bg-white border border-slate-100 hover:border-indigo-200 hover:shadow-md"}`}><div className="w-20 h-20 mx-auto"><ForgeSprite member={poke} /></div><div className="mt-2 text-center"><div className="font-semibold text-slate-800 text-sm leading-tight">{poke.localizedName || poke.name}</div><div className="flex flex-wrap gap-1 justify-center mt-1.5">{(poke.types || []).map((t: string) => <span key={t} className="text-[9px] px-1.5 py-.5 rounded-full text-white font-medium" style={{ background: TYPE_COLORS[t] || "#6b7280" }}>{t}</span>)}</div><div className="mt-1.5"><span className="text-[10px] px-2 py-.5 rounded-full font-medium bg-indigo-500 text-white">{poke.role || "未标注"}</span></div></div>{editMode && <button className="absolute top-2 right-2 w-7 h-7 rounded-full bg-red-50 border border-red-100 flex items-center justify-center" onClick={(e) => { e.stopPropagation(); setTeam((current) => current.filter((_, index) => index !== idx)); }} aria-label="删除成员"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>}</motion.button></Card3D>)}</div>
    <AnimatePresence>{selected && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden"><BorderBeam active color="violet" duration={4}><div className="bg-white rounded-xl p-5"><div className="grid grid-cols-1 lg:grid-cols-3 gap-6"><div className="flex flex-col items-center justify-center bg-indigo-50 rounded-xl p-6"><ForgeSprite member={selected} className="w-36 h-36" /><div className="text-lg font-bold text-slate-800 mt-3">{selected.localizedName || selected.name}</div><div className="text-xs text-slate-400 mt-1">{selected.name}</div></div><div className="space-y-3"><h3 className="font-semibold text-slate-700 text-sm border-b border-slate-100 pb-2">基本配置</h3><div className="grid grid-cols-2 gap-3">{editMode ? <><GlowInput label="道具" value={selected.item || ""} onChange={(e) => updateSelected("item", e.target.value)} /><GlowInput label="特性" value={selected.ability || ""} onChange={(e) => updateSelected("ability", e.target.value)} /><GlowInput label="性格" value={selected.nature || ""} onChange={(e) => updateSelected("nature", e.target.value)} /><GlowInput label="功能定位" value={selected.role || ""} onChange={(e) => updateSelected("role", e.target.value)} /></> : [["道具", selected.itemLabel || selected.item], ["特性", selected.abilityLabel || selected.ability], ["性格", selected.natureLabel || selected.nature || "未指定"], ["努力值", selected.stats || "未记录"]].map(([k, v]) => <div key={k}><div className="text-[10px] text-slate-400 mb-1">{k}</div><div className="text-sm font-medium text-slate-700">{v}</div></div>)}</div></div><div className="space-y-3"><h3 className="font-semibold text-slate-700 text-sm border-b border-slate-100 pb-2">技能配置</h3><div className="space-y-2">{(selected.moves || []).map((move: string, i: number) => <div key={`${move}-${i}`} className="flex items-center gap-2"><span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[10px] flex items-center justify-center font-bold">{i + 1}</span>{editMode ? <GlowInput value={move} className="flex-1" onChange={(e) => updateSelected("moves", selected.moves.map((item: string, index: number) => index === i ? e.target.value : item))} /> : <div className="flex-1 px-3 py-2 rounded-lg bg-slate-50 border border-slate-100 text-sm text-slate-700">{selected.moveLabels?.[i] || move}<span className="ml-2 text-xs text-slate-400">{selected.moveLabels?.[i] && selected.moveLabels[i] !== move ? move : ""}</span></div>}</div>)}</div></div></div></div></BorderBeam></motion.div>}</AnimatePresence>
    <div className="bg-white rounded-xl p-5 border border-slate-100 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 mb-4"><div><h3 className="font-semibold text-slate-700">当前规则候选配置库</h3><p className="text-xs text-slate-400 mt-1">{candidates.total || 0} 种宝可梦 · {candidates.configurationTotal || candidates.matchedConfigurationTotal || 0} 套配置 · {candidates.rulesetId || activeRule?.rulesetId}</p></div><div className="relative min-w-64"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><input className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-200 text-sm outline-none focus:border-indigo-400" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索宝可梦、技能、特性、道具" /></div></div>{candidates.loading ? <div className="py-8 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin mr-2" />读取候选库</div> : candidates.error ? <div className="py-8 text-center text-red-500">{candidates.error}</div> : <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">{candidates.items.map((candidate: any) => <div key={candidate.id} className="border border-slate-100 rounded-lg overflow-hidden"><button className="w-full flex items-center gap-3 p-3 text-left hover:bg-indigo-50/40" onClick={() => setExpanded(expanded === candidate.id ? "" : candidate.id)}><img src={spriteUrl(candidate.sprite || candidate.dex || candidate.id)} alt={candidate.localizedName} className="w-12 h-12 object-contain" /><div className="flex-1 min-w-0"><div className="font-medium text-slate-700">{candidate.localizedName || candidate.name}</div><div className="text-xs text-slate-400">{candidate.sets?.length || 0} 套玩法</div></div><Plus className="w-4 h-4 text-indigo-400" /></button>{expanded === candidate.id && <div className="border-t border-slate-100 p-2 space-y-2">{(candidate.sets || []).map((config: any) => <button key={config.id} className="w-full text-left p-3 rounded-lg bg-slate-50 hover:bg-indigo-50" onClick={() => addCandidate(candidate, config)}><div className="flex justify-between gap-2"><strong className="text-sm text-slate-700">{config.role}</strong><Plus className="w-4 h-4 text-indigo-500" /></div><div className="text-xs text-slate-500 mt-1">{config.abilityLabel} · {config.itemLabel} · {config.natureLabel || "未记录"}</div><div className="text-xs text-indigo-500 mt-1 line-clamp-2">{(config.moveLabels || config.moves || []).join(" / ")}</div></button>)}</div>}</div>)}</div>}</div>
    <AnimatePresence>{showAnalysis && <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}><div className="bg-white rounded-xl p-5 border border-slate-100 shadow-sm"><div className="flex items-center justify-between mb-4"><h3 className="font-semibold text-slate-700">基于当前配置的结构指标</h3><button onClick={() => setShowAnalysis(false)} className="text-slate-400"><ChevronUp className="w-4 h-4" /></button></div><div className="grid grid-cols-2 sm:grid-cols-4 gap-4">{analyses.map((s) => <div key={s.label}><div className="flex justify-between text-xs mb-1"><span className="text-slate-500">{s.label}</span><span className="font-mono font-bold text-indigo-600">{s.v}%</span></div><div className="h-2 rounded-full bg-slate-100"><motion.div className="h-full rounded-full bg-indigo-500" initial={{ width: 0 }} animate={{ width: `${s.v}%` }} /></div></div>)}</div></div></motion.div>}</AnimatePresence>
  </div>;
}
