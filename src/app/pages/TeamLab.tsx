import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Search, Loader2, CheckCircle, XCircle, Award, Clock, ShieldCheck, AlertTriangle, LockKeyhole, RotateCcw } from "lucide-react";
import { ShimmerButton, GhostButton } from "../components/inspira/Buttons";
import { BorderBeam } from "../components/inspira/BorderBeam";
import { useWorkbench } from "../context/WorkbenchContext";
import { apiRequest, formatRuleName, spriteUrl } from "../lib/api";
import { normalizeTeamMember } from "../data/realData";

const STATUS: Record<string, any> = {
  promoted: { label: "已晋级", color: "text-violet-500", bg: "bg-violet-50", icon: Award },
  failed: { label: "失败", color: "text-red-500", bg: "bg-red-50", icon: XCircle },
  evaluating: { label: "评估中", color: "text-amber-500", bg: "bg-amber-50", icon: Loader2 },
  passed: { label: "通过", color: "text-emerald-500", bg: "bg-emerald-50", icon: CheckCircle },
  candidate: { label: "候选", color: "text-indigo-500", bg: "bg-indigo-50", icon: Search },
};

export function TeamLab() {
  const { team, setTeam, registry } = useWorkbench();
  const [format, setFormat] = useState<"single" | "double">("single");
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [corePokemon, setCorePokemon] = useState<any[]>([]);
  const [coreQuery, setCoreQuery] = useState("");
  const [coreOptions, setCoreOptions] = useState<any[]>([]);
  const activeRule = registry.active?.find((item: any) => item.battleType === format);
  const load = async () => {
    try {
      const next = await apiRequest(`/api/team-lab?format=${format}`);
      setData(next);
      setSelectedCandidateId((current) => next.experiments?.some((item: any) => item.id === current) ? current : next.experiments?.[0]?.id || "");
      setError("");
    }
    catch (requestError: any) { setError(requestError.message); }
  };
  useEffect(() => {
    setSelectedCandidateId("");
    setCorePokemon([]);
    setCoreQuery("");
    setCoreOptions([]);
    load();
  }, [format]);
  useEffect(() => {
    if (!coreQuery.trim()) { setCoreOptions([]); return; }
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ format, query: coreQuery, category: "all", offset: "0", limit: "12" });
        const result = await apiRequest(`/api/rules/candidates?${params}`);
        setCoreOptions(result.items || []);
      } catch { setCoreOptions([]); }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [coreQuery, format]);
  const generate = async () => {
    setBusy("generate"); setError("");
    try {
      const next = await apiRequest("/api/team-lab/generate", { method: "POST", body: JSON.stringify({ format, count: 4, gamesPerOpponent: 1, evaluate: true, corePokemon }) });
      if (!next.experiments?.length) throw new Error(corePokemon.length ? "当前核心与历史候选的多样性约束下没有找到新队伍，请减少核心或继续补充配置池。" : "当前配置池没有找到区别足够大的新队伍。");
      setData((current: any) => ({ ...current, ...next, experiments: [...(next.experiments || []), ...(current?.experiments || [])] }));
      if (next.experiments?.[0]?.id) setSelectedCandidateId(next.experiments[0].id);
    } catch (requestError: any) { setError(requestError.message); }
    finally { setBusy(""); }
  };
  const promote = async (candidateId: string) => {
    setBusy(candidateId);
    try {
      const next = await apiRequest("/api/team-lab/promote", { method: "POST", body: JSON.stringify({ format, candidateId, rulesetId: data?.rulesetId }) });
      setData((current: any) => ({ ...current, champion: next.champion, experiments: current.experiments.map((item: any) => item.id === candidateId ? { ...item, status: "promoted" } : item) }));
    } catch (requestError: any) { setError(requestError.message); }
    finally { setBusy(""); }
  };
  const loadCandidate = (candidate: any) => {
    const next = (candidate.team || []).map((member: any, index: number) => normalizeTeamMember({ id: member.slug || member.id || member.name, name: member.slug || member.name, localizedName: member.localizedName || member.name || member.slug, sprite: member.sprite || member.slug || member.name, role: member.role || "结构成员", item: member.item || "", ability: member.ability || "", nature: member.nature || "", stats: member.evs || member.stats || "", moves: member.moves || [] }, index));
    if (next.length) setTeam(next);
  };
  const experiments = data?.experiments || [];
  const selectedCandidate = experiments.find((candidate: any) => candidate.id === selectedCandidateId) || experiments[0] || null;
  const toggleCorePokemon = (member: any) => {
    const id = String(member.id || member.slug || member.name);
    setError("");
    setCorePokemon((current) => {
      if (current.some((item) => String(item.id || item.slug || item.name) === id)) return current.filter((item) => String(item.id || item.slug || item.name) !== id);
      if (current.length >= 3) {
        setError("最多选择 3 只核心，剩余位置需要留给搜索器补足联防和战术结构。");
        return current;
      }
      return [...current, {
        id,
        slug: member.id || member.slug || member.name,
        name: member.showdownSpecies || member.name || member.slug,
        localizedName: member.localizedName || member.name,
        sprite: member.sprite || member.dex || member.id,
      }];
    });
  };

  return <div className="space-y-5">
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Rajdhani, sans-serif" }}>配队实验室</h1><p className="text-slate-400 text-sm mt-.5">规则搜索、Showdown 精确评估与队伍晋级</p></div><div className="flex items-center gap-3"><GhostButton onClick={load}>刷新</GhostButton><ShimmerButton onClick={generate} disabled={busy === "generate" || !activeRule}>{busy === "generate" ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />搜索评估中</> : <><Search className="w-3.5 h-3.5" />启动搜索</>}</ShimmerButton></div></motion.div>
    <div className="bg-white rounded-xl p-2 border border-slate-100 shadow-sm flex flex-wrap items-center gap-2"><button className={`px-4 py-2 rounded-lg text-sm ${format === "single" ? "bg-indigo-500 text-white" : "text-slate-500"}`} onClick={() => setFormat("single")}>BSS 单打</button><button className={`px-4 py-2 rounded-lg text-sm ${format === "double" ? "bg-indigo-500 text-white" : "text-slate-500"}`} onClick={() => setFormat("double")}>VGC 双打</button><span className="ml-auto px-3 text-xs font-mono text-slate-400">{activeRule ? `${formatRuleName(activeRule.name)} · ${activeRule.rulesetId}` : "当前规则不可用"}</span></div>
    <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 mb-3"><div><h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2"><LockKeyhole className="w-4 h-4 text-indigo-500" />自选核心</h3><p className="text-xs text-slate-400 mt-1">选择 0–3 只；不选择时进行自由搜索</p></div><GhostButton onClick={() => setCorePokemon([])} disabled={!corePokemon.length}><RotateCcw className="w-3.5 h-3.5" />清空核心</GhostButton></div><div className="relative mb-3"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><input value={coreQuery} onChange={(event) => setCoreQuery(event.target.value)} placeholder="搜索当前规则可用宝可梦" className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-200 text-sm outline-none focus:border-indigo-400" /></div>{coreOptions.length > 0 && <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">{coreOptions.map((member: any) => { const id = String(member.id || member.slug || member.name); const selected = corePokemon.some((item) => String(item.id || item.slug || item.name) === id); return <button key={id} type="button" onClick={() => toggleCorePokemon(member)} className={`relative min-h-20 rounded-lg border p-2 text-center ${selected ? "border-indigo-500 bg-indigo-50" : "border-slate-100 bg-slate-50 hover:border-indigo-300"}`}><img src={spriteUrl(member.sprite || member.dex || member.id)} alt={member.localizedName || member.name} className="w-10 h-10 object-contain mx-auto" /><div className="text-[11px] font-medium text-slate-700 truncate">{member.localizedName || member.name}</div></button>; })}</div>}<div className="grid grid-cols-3 sm:grid-cols-6 gap-2">{team.map((member: any) => { const id = String(member.id || member.slug || member.name); const selected = corePokemon.some((item) => String(item.id || item.slug || item.name) === id); return <button key={id} type="button" aria-pressed={selected} onClick={() => toggleCorePokemon(member)} className={`relative min-h-24 rounded-lg border p-2 text-center transition-all ${selected ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-100" : "border-slate-100 bg-slate-50 hover:border-indigo-300"}`}><img src={spriteUrl(member.sprite || member.id || member.name)} alt={member.localizedName || member.name} className="w-12 h-12 object-contain mx-auto" /><div className="text-xs font-medium text-slate-700 truncate mt-1">{member.localizedName || member.name}</div>{selected && <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-indigo-500 text-white flex items-center justify-center"><CheckCircle className="w-3 h-3" /></span>}</button>; })}</div>{corePokemon.length > 0 && <div className="flex flex-wrap gap-2 mt-3">{corePokemon.map((member) => <button key={member.id} type="button" onClick={() => toggleCorePokemon(member)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-indigo-50 border border-indigo-100 text-xs text-indigo-700"><img src={spriteUrl(member.sprite || member.id)} className="w-5 h-5 object-contain" alt="" />{member.localizedName || member.name}</button>)}</div>}<div className="mt-3 text-xs text-slate-500">已选择 {corePokemon.length}/3 · 新候选会保留核心，并重新搜索其合法配置和其余成员</div></div>
    {error && <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-sm text-red-600 flex gap-2"><AlertTriangle className="w-4 h-4" />{error}</div>}
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[["排位反馈", `${data?.summary?.games || 0} 场`], ["当前胜率", `${data?.summary?.winRate || 0}%`], ["候选数量", String(experiments.length)], ["晋级队伍", data?.champion ? "1" : "0"]].map(([label, value]) => <div key={label} className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm"><div className="text-2xl font-bold text-indigo-600">{value}</div><div className="text-xs text-slate-500 mt-1">{label}</div></div>)}</div>
    <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5"><div className="space-y-3"><h3 className="text-sm font-semibold text-white">候选队伍</h3>{experiments.length ? experiments.map((candidate: any) => { const state = candidate.status === "promoted" ? "promoted" : candidate.validation?.ok ? (candidate.evaluation?.ok ? "passed" : "candidate") : "failed"; const cfg = STATUS[state]; const Icon = cfg.icon; const selected = candidate.id === selectedCandidate?.id; return <button key={candidate.id} type="button" aria-pressed={selected} onClick={() => setSelectedCandidateId(candidate.id)} className={`w-full bg-white rounded-xl p-4 border text-left transition-all ${selected ? "border-indigo-500 ring-2 ring-indigo-200 shadow-md" : "border-slate-100 hover:border-indigo-300"}`}><div className="flex items-center justify-between"><span className={`${cfg.bg} ${cfg.color} px-2 py-1 rounded-full text-xs flex items-center gap-1`}><Icon className={`w-3 h-3 ${state === "evaluating" ? "animate-spin" : ""}`} />{selected ? "已选择" : cfg.label}</span><span className="text-sm font-bold text-slate-600">{Number(candidate.score || 0).toFixed(1)}<span className="text-[10px] font-medium text-slate-400"> / 100</span></span></div><div className="flex gap-1 mt-3">{(candidate.team || []).slice(0, 6).map((member: any, i: number) => <img key={`${member.slug}-${i}`} src={spriteUrl(member.sprite || member.slug || member.name)} className="w-9 h-9 object-contain" alt={member.name || member.slug} />)}</div><div className="flex items-center gap-3 mt-2 text-xs text-slate-400"><span>{candidate.evaluation?.wins || 0}胜</span><span>{candidate.evaluation?.losses || 0}负</span><span>{candidate.evaluation?.games ? `${candidate.evaluation.winRate}%` : "未评估"}</span></div></button>; }) : <div className="bg-white rounded-xl p-8 text-center text-slate-400"><Clock className="w-6 h-6 mx-auto mb-2" />还没有真实候选，点击启动搜索</div>}</div>
      <div>{selectedCandidate ? <BorderBeam active color="indigo" duration={5}><div className="bg-white rounded-xl p-5"><div className="flex items-start justify-between gap-3"><div><div className="text-xs text-indigo-500 font-semibold">当前选择</div><h2 className="text-lg font-bold text-slate-800 mt-1">{selectedCandidate.id}</h2></div><div className="text-right"><div className="text-2xl font-bold text-indigo-600">{Number(selectedCandidate.score || 0).toFixed(1)}<span className="text-sm text-slate-400"> / 100</span></div><div className="text-xs text-slate-400">综合评分</div></div></div><div className="grid grid-cols-3 sm:grid-cols-6 gap-4 my-7">{(selectedCandidate.team || []).map((member: any) => <div key={`${member.slug}-${member.item}`} className="text-center"><img src={spriteUrl(member.sprite || member.slug || member.name)} className="w-16 h-16 object-contain mx-auto" alt={member.name || member.slug} /><div className="text-xs font-medium text-slate-700 truncate">{member.name || member.slug}</div><div className="text-[10px] text-slate-400 truncate">{member.role || "结构成员"}</div></div>)}</div><div className="grid grid-cols-3 gap-3">{[["本地胜率", selectedCandidate.evaluation?.games ? `${selectedCandidate.evaluation.winRate}%` : "未评估"], ["规则校验", selectedCandidate.validation?.ok ? "通过" : "未通过"], ["稳定性", selectedCandidate.evaluation?.games >= 4 ? "可评估" : "样本不足"]].map(([label, value]) => <div key={label} className="bg-slate-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-indigo-600">{value}</div><div className="text-xs text-slate-400 mt-1">{label}</div></div>)}</div><div className="mt-4 p-3 bg-indigo-50 rounded-lg text-xs text-indigo-700">{selectedCandidate.buildReport?.plan || "候选队伍由当前规则配置池、搜索和本地 Showdown 评估产生。"}</div><div className="mt-4 flex gap-3"><GhostButton onClick={() => loadCandidate(selectedCandidate)}>加载到工坊</GhostButton>{selectedCandidate.evaluation?.ok && selectedCandidate.evaluation?.games >= 4 && selectedCandidate.status !== "promoted" && <ShimmerButton onClick={() => promote(selectedCandidate.id)} disabled={Boolean(busy)}><Award className="w-3.5 h-3.5" />晋级 Champion</ShimmerButton>}{selectedCandidate.status === "promoted" && <span className="text-sm text-emerald-600 flex items-center gap-2"><ShieldCheck className="w-4 h-4" />已绑定当前 rulesetId</span>}</div></div></BorderBeam> : <div className="bg-white rounded-xl min-h-80 flex items-center justify-center text-slate-400">候选详情将在真实搜索后显示</div>}</div></div>
  </div>;
}
