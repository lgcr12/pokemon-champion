import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Award, BarChart3, Brain, CheckCircle2, Clock3, Database, GitBranch, Loader2, RefreshCw, ShieldCheck, Sparkles, ChevronUp, Swords, FlaskConical, LockKeyhole } from "lucide-react";
import { RippleButton, GhostButton } from "../components/inspira/Buttons";
import { BorderBeam } from "../components/inspira/BorderBeam";
import { useWorkbench } from "../context/WorkbenchContext";
import { apiRequest } from "../lib/api";

const strategyFallback = {
  "structured-visible-state-v1": {
    label: "结构化可见状态策略",
    description: "规则约束、合法动作掩码与数值启发式",
    availability: "ladder",
  },
  "laplace-engine-v1": {
    label: "Laplace 单打策略",
    description: "Laplace / poke-engine 单打决策策略",
    availability: "ladder-single",
  },
  "replay-import": {
    label: "历史回放导入",
    description: "从本地 Showdown 回放提取训练与配队反馈",
    availability: "analysis-only",
  },
};

function formatStrategyStatus(value: string) {
  if (value === "analysis-only") return "仅分析";
  if (value === "ladder-single") return "单打可排位";
  if (value === "ladder") return "可排位";
  return "已发现";
}

function formatTime(value: string) {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "暂无记录" : date.toLocaleString("zh-CN", { hour12: false });
}

export function Models() {
  const { models, registry, refresh } = useWorkbench();
  const [rulesetId, setRulesetId] = useState("");
  const [learning, setLearning] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const selectedId = rulesetId
    || models.find((item: any) => item.challengers?.length || item.evaluations?.length)?.rulesetId
    || models[0]?.rulesetId
    || registry.active?.[0]?.rulesetId
    || "";
  const activeRule = registry.active?.find((item: any) => item.rulesetId === selectedId) || registry.history?.find((item: any) => item.rulesetId === selectedId);
  const format = activeRule?.battleType || (selectedId.includes("single") ? "single" : "double");
  const model = models.find((item: any) => item.rulesetId === selectedId);

  const loadLearning = useCallback(async () => {
    if (!selectedId) return;
    try {
      setLearning(await apiRequest(`/api/agent/learning?format=${format}&rulesetId=${encodeURIComponent(selectedId)}&t=${Date.now()}`));
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [selectedId, format]);

  useEffect(() => {
    loadLearning();
    const timer = window.setInterval(loadLearning, 2500);
    return () => window.clearInterval(timer);
  }, [loadLearning]);

  const run = async (path: string) => {
    setBusy(path);
    try {
      setLearning(await apiRequest(path, { method: "POST", body: JSON.stringify({ format, rulesetId: selectedId }) }));
      await Promise.all([refresh(), loadLearning()]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const promote = async (version: string) => {
    setBusy(version);
    try {
      await apiRequest("/api/agent/promote", { method: "POST", body: JSON.stringify({ rulesetId: selectedId, version }) });
      await refresh();
      await loadLearning();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const train = async () => {
    setBusy("train");
    try {
      const result = await apiRequest("/api/agent/train", { method: "POST", body: JSON.stringify({ format, rulesetId: selectedId, baseVersion: model?.champion?.version || "structured-visible-state-v1" }) });
      setNotice(result.status === "no_new_data" ? result.message : `已生成 Challenger：${result.policy?.version || "新版本"}`);
      setError("");
      await refresh();
      await loadLearning();
    } catch (e: any) { setError(e.message); setNotice(""); } finally { setBusy(""); }
  };

  const evaluate = async (version: string) => {
    setSelectedCandidate(version);
    setBusy(`evaluate:${version}`);
    try {
      await apiRequest("/api/agent/evaluate", { method: "POST", body: JSON.stringify({ format, rulesetId: selectedId, challengerVersion: version, games: 20 }) });
      await refresh();
      await loadLearning();
    } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  };

  const summary = learning?.summary || {};
  const trainingProgress = learning?.trainingProgress || {};
  const games = Number(summary.games || 0);
  const wins = Number(summary.wins || 0);
  const losses = Number(summary.losses || 0);
  const ties = Number(summary.ties || 0);
  const strategies = useMemo(() => {
    const source = Array.isArray(model?.strategies) ? model.strategies : [];
    const map = new Map(source.map((item: any) => [item.id || item.version, item]));
    if (format === "single") map.set("laplace-engine-v1", map.get("laplace-engine-v1") || { id: "laplace-engine-v1", version: "laplace-engine-v1", ...strategyFallback["laplace-engine-v1"], games: 0, wins: 0, losses: 0, ties: 0, winRate: 0 });
    map.set("structured-visible-state-v1", map.get("structured-visible-state-v1") || { id: "structured-visible-state-v1", version: "structured-visible-state-v1", ...strategyFallback["structured-visible-state-v1"], games: 0, wins: 0, losses: 0, ties: 0, winRate: 0 });
    if (format === "single") map.set("replay-import", map.get("replay-import") || { id: "replay-import", version: "replay-import", ...strategyFallback["replay-import"], games: 0, wins: 0, losses: 0, ties: 0, winRate: 0 });
    return [...map.values()].map((item: any) => ({ ...strategyFallback[item.id || item.version], ...item })).sort((a: any, b: any) => Number(b.games || 0) - Number(a.games || 0));
  }, [model, format]);
  const candidates = model?.challengers || [];
  const latestEvaluated = [...candidates].filter((item: any) => item.evaluation?.games).sort((a: any, b: any) => String(b.evaluation?.createdAt || b.createdAt || "").localeCompare(String(a.evaluation?.createdAt || a.createdAt || "")))[0];
  const latestMetrics = latestEvaluated?.evaluation || {};
  const latestFixed = latestMetrics.fixedTestSet || {};
  const promotionGaps = [
    { label: "对抗胜率", value: Number(latestMetrics.challengerWinRate ?? latestMetrics.winRate ?? 0), target: 55, suffix: "%" },
    { label: "Wilson 下限", value: Number(latestMetrics.wilsonLowerBound || 0), target: 45, suffix: "%" },
    { label: "固定测试集", value: Number(latestFixed.winRate || 0), target: 52, suffix: "%" },
    { label: "非法动作", value: Number(latestMetrics.illegalActions || 0), target: 0, suffix: " 次", inverted: true },
  ];
  const latestFailures = latestEvaluated ? [
    Number(latestMetrics.challengerWinRate ?? latestMetrics.winRate) < 55 && "对抗胜率尚未达到 55%",
    Number(latestMetrics.wilsonLowerBound) < 45 && "Wilson 下限尚未达到 45%",
    Number(latestFixed.winRate) < 52 && "固定测试集尚未达到 52%",
    (Number(latestMetrics.illegalActions) > 0 || Number(latestFixed.illegalActions) > 0) && "存在非法动作",
  ].filter(Boolean) : [];

  return <div className="space-y-5">
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Rajdhani, sans-serif" }}>模型实验室</h1><p className="text-slate-400 text-sm mt-1">按 rulesetId 隔离训练数据，实时观察 Champion、策略与 Challenger</p></div>
      <div className="flex flex-wrap gap-3"><GhostButton onClick={loadLearning}><RefreshCw className="w-3.5 h-3.5" />刷新学习状态</GhostButton><GhostButton onClick={train} disabled={Boolean(busy) || !selectedId}><Brain className="w-3.5 h-3.5" />{busy === "train" ? "训练中" : "训练 Challenger"}</GhostButton><RippleButton onClick={() => run("/api/agent/analyze")} disabled={Boolean(busy) || !selectedId}>{busy === "/api/agent/analyze" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}分析真实对局</RippleButton></div>
    </motion.div>

    <div className="bg-white rounded-xl p-3 border border-slate-100 flex flex-wrap gap-2">{models.map((item: any) => <button key={item.rulesetId} onClick={() => setRulesetId(item.rulesetId)} className={`px-3 py-2 rounded-lg text-xs font-mono transition-colors ${selectedId === item.rulesetId ? "bg-indigo-500 text-white" : "bg-slate-50 text-slate-500 hover:bg-indigo-50"}`}>{item.rulesetId}</button>)}{!models.length && <span className="text-sm text-slate-400">暂无模型注册表</span>}</div>
    {error && <div className="bg-red-50 rounded-xl p-4 border border-red-100 text-sm text-red-600 flex gap-2"><AlertTriangle className="w-4 h-4" />{error}</div>}
    {notice && <div className="bg-indigo-50 rounded-xl p-4 border border-indigo-100 text-sm text-indigo-700 flex gap-2"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />{notice}</div>}

    <div className="bg-white rounded-xl p-4 border border-slate-100 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="font-semibold text-slate-700">下一次有效训练</div><div className="text-xs text-slate-400 mt-1">只统计当前 rulesetId 的真实已完成对局，回放导入不参与策略训练</div></div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="px-3 py-2 rounded-lg bg-slate-50 text-slate-600">有效对局 <b className="text-slate-800">{trainingProgress.eligibleGames ?? games}</b></span>
          <span className="px-3 py-2 rounded-lg bg-slate-50 text-slate-600">上次训练 <b className="text-slate-800">{trainingProgress.lastTrainingGames ?? 0}</b></span>
          <span className="px-3 py-2 rounded-lg bg-indigo-50 text-indigo-600">新增 <b>{trainingProgress.newEligibleGames ?? 0}</b></span>
          <span className="px-3 py-2 rounded-lg bg-amber-50 text-amber-700">还需 <b>{trainingProgress.gamesUntilManualTraining ?? 0}</b> 局</span>
        </div>
      </div>
    </div>

    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-stretch">
      <BorderBeam active color="violet" duration={5}><div className="bg-white rounded-xl p-5 h-full min-h-64"><div className="flex items-start justify-between mb-4"><div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center"><Award className="w-5 h-5 text-violet-500" /></div><div><div className="font-bold text-slate-800">{model?.champion?.version || "structured-visible-state-v1"}</div><div className="text-xs text-slate-400 mt-1">当前 Champion · {model?.champion?.status || "active"}</div></div></div><ShieldCheck className="w-5 h-5 text-emerald-500" /></div><div className="grid grid-cols-2 gap-3">{[["绑定规则", selectedId || "--"], ["训练对局", String(games)], ["真实胜率", games ? `${((wins / games) * 100).toFixed(1)}%` : "--"], ["失败类型", String(summary.failures?.length || 0)]].map(([label, value]) => <div key={label} className="bg-slate-50 rounded-lg p-3 min-w-0"><div className="text-[10px] text-slate-400">{label}</div><div className="text-sm font-bold text-violet-600 mt-1 truncate" title={value}>{value}</div></div>)}</div><div className="mt-5 rounded-lg border border-violet-100 bg-violet-50/60 p-3"><div className="text-[10px] uppercase tracking-wide text-violet-500">当前模型定位</div><div className="mt-1 text-xs leading-5 text-slate-600">Champion 负责稳定基线；新 Challenger 必须在同一规则和同一私服测试集上证明提升。</div></div></div></BorderBeam>
      <section className="lg:col-span-2 bg-white rounded-xl border border-slate-100 shadow-sm p-5"><div className="flex items-center justify-between gap-3 mb-4"><div><h3 className="font-semibold text-slate-700 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-indigo-500" />晋级差距</h3><p className="text-xs text-slate-400 mt-1">最近一次已完成评测 · 仅使用当前 rulesetId 数据</p></div><span className={`text-xs font-medium ${latestEvaluated?.status === "ready_to_promote" ? "text-emerald-600" : "text-amber-600"}`}>{latestEvaluated ? (latestEvaluated.status === "ready_to_promote" ? "已达到条件" : "尚未达到条件") : "等待评测"}</span></div><div className="grid grid-cols-2 md:grid-cols-4 gap-4">{promotionGaps.map((gap) => { const passed = gap.inverted ? gap.value === gap.target : gap.value >= gap.target; const percent = gap.inverted ? (gap.value === 0 ? 100 : Math.max(0, 100 - gap.value * 20)) : Math.min(100, gap.value / gap.target * 100); return <div key={gap.label} className="rounded-lg bg-slate-50 p-3"><div className="flex items-center justify-between text-[11px] text-slate-500"><span>{gap.label}</span><span className={passed ? "text-emerald-600" : "text-amber-600"}>{gap.value}{gap.suffix}</span></div><div className="mt-2 h-2 rounded-full bg-slate-200 overflow-hidden"><div className={`h-full rounded-full ${passed ? "bg-emerald-500" : "bg-amber-400"}`} style={{ width: `${percent}%` }} /></div><div className="mt-2 text-[10px] text-slate-400">目标 {gap.target}{gap.suffix}</div></div>; })}</div><div className="mt-4 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2.5 text-xs text-amber-700">{latestFailures.length ? `当前主要缺口：${latestFailures.join("、")}` : latestEvaluated ? "最近一次评测已满足所有晋级指标。" : "先训练并完成 Challenger 私服评测，这里会显示距离晋级还差多少。"}</div></section>
    </div>

    <section className="bg-white rounded-xl border border-slate-100 shadow-sm p-5"><div className="flex flex-wrap items-center justify-between gap-3 mb-4"><div><h3 className="font-semibold text-slate-700 flex items-center gap-2"><GitBranch className="w-4 h-4 text-indigo-500" />Challenger 演进队列</h3><p className="text-xs text-slate-400 mt-1">每个版本保留独立训练样本与私服评测结果，历史记录不会被覆盖</p></div><span className="text-xs text-slate-400">{candidates.length} 个唯一版本</span></div>{candidates.length ? <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{candidates.map((item: any) => { const evaluation = item.evaluation || {}; const fixed = evaluation.fixedTestSet || {}; const ready = item.status === "ready_to_promote"; const failedChecks = evaluation.games ? [Number(evaluation.games) < 20 && "对抗不足 20 局", Number(evaluation.challengerWinRate ?? evaluation.winRate) < 55 && "对抗胜率低于 55%", Number(evaluation.wilsonLowerBound) < 45 && "Wilson 下限低于 45%", Number(fixed.winRate) < 52 && "固定集低于 52%", (Number(evaluation.illegalActions) > 0 || Number(fixed.illegalActions) > 0) && "存在非法动作"].filter(Boolean) : []; return <div key={item.version} className="rounded-lg border border-slate-100 bg-slate-50 p-4"><div className="flex items-center gap-3"><div className="flex-1 min-w-0"><div className="font-medium text-slate-700 truncate" title={item.version}>{item.version}</div><div className="text-xs text-slate-400 mt-1">有效 {item.trainingGames || 0} 局 · 训练 {item.trainingSamples ?? Math.floor(Number(item.trainingGames || 0) * 0.7)} 局 · {item.status === "rejected" ? "评测未胜过 Champion" : item.status}</div></div><GhostButton onClick={() => evaluate(item.version)} disabled={Boolean(busy)}><FlaskConical className="w-3.5 h-3.5" />{busy === `evaluate:${item.version}` ? "评测中" : "私服评测"}</GhostButton><RippleButton onClick={() => promote(item.version)} disabled={Boolean(busy) || !ready}><ChevronUp className="w-3.5 h-3.5" />{ready ? "晋级" : "未通过"}</RippleButton></div>{evaluation.games ? <><div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-[11px] text-slate-500"><span>对抗 {evaluation.challengerWinRate ?? evaluation.winRate}%</span><span>固定集 {fixed.winRate ?? "--"}%</span><span>Wilson 下限 {evaluation.wilsonLowerBound ?? "--"}%</span><span>Elo {Number(evaluation.eloDelta || 0) >= 0 ? "+" : ""}{evaluation.eloDelta ?? 0}</span><span>泛化 {evaluation.generalization ?? "--"}%</span><span>综合分 {evaluation.compositeScore ?? "--"}</span><span>非法动作 {evaluation.illegalActions ?? 0}</span><span className={ready ? "text-emerald-600" : "text-amber-600"}>{ready ? "达到晋级条件" : "未达到晋级门槛"}</span></div>{failedChecks.length > 0 && <div className="mt-3 text-[11px] text-amber-700 bg-amber-50 rounded-md px-3 py-2">未达标：{failedChecks.join("、")}</div>}</> : <div className="mt-3 text-[11px] text-slate-400 flex items-center gap-1"><LockKeyhole className="w-3 h-3" />未完成 20 局私服对抗评测，不能晋级</div>}</div>; })}</div> : <div className="rounded-lg border border-dashed border-slate-200 px-4 py-12 text-center text-slate-400 text-sm">至少 4 局真实行为样本可手动训练；每 50 局自动冻结一个 Challenger</div>}</section>

    <div className="bg-white rounded-xl p-5 border border-slate-100 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 mb-4"><div><h3 className="font-semibold text-slate-700 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-indigo-500" />策略列表</h3><p className="text-xs text-slate-400 mt-1">统计来自当前 rulesetId 的真实 trace，数据会自动刷新</p></div><div className="text-xs text-slate-500">总计 {games} 局 · 胜 {wins} · 负 {losses} · 平 {ties}</div></div><div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">{strategies.map((item: any) => <div key={item.id || item.version} className="rounded-lg border border-slate-100 bg-slate-50 p-4"><div className="flex items-start justify-between gap-3"><div><div className="font-semibold text-slate-700">{item.label || item.version}</div><div className="text-[11px] text-slate-400 mt-1 font-mono">{item.version}</div></div>{item.id === model?.champion?.version ? <span className="text-[10px] text-violet-600 bg-violet-100 px-2 py-1 rounded-full">Champion</span> : <span className="text-[10px] text-slate-500 bg-white px-2 py-1 rounded-full">{formatStrategyStatus(item.availability)}</span>}</div><p className="text-xs text-slate-500 mt-3 min-h-8">{item.description}</p><div className="grid grid-cols-4 gap-2 mt-3 text-center"><div><div className="text-sm font-bold text-slate-700">{item.games || 0}</div><div className="text-[10px] text-slate-400">对局</div></div><div><div className="text-sm font-bold text-emerald-600">{item.wins || 0}</div><div className="text-[10px] text-slate-400">胜</div></div><div><div className="text-sm font-bold text-rose-500">{item.losses || 0}</div><div className="text-[10px] text-slate-400">负</div></div><div><div className="text-sm font-bold text-indigo-600">{item.games ? `${Number(item.winRate || 0).toFixed(1)}%` : "--"}</div><div className="text-[10px] text-slate-400">胜率</div></div></div><div className="text-[10px] text-slate-400 mt-3 flex items-center gap-1"><Clock3 className="w-3 h-3" />{formatTime(item.lastPlayedAt)}</div></div>)}</div></div>

    <div className="bg-white rounded-xl p-5 border border-slate-100 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 mb-4"><div><h3 className="font-semibold text-slate-700 flex items-center gap-2"><Brain className="w-4 h-4 text-indigo-500" />学习与配队迭代</h3><p className="text-xs text-slate-400 mt-1">失败归因只更新对应能力，不跨 rulesetId 污染模型</p></div><RippleButton onClick={() => run("/api/agent/evolve-team")} disabled={Boolean(busy) || !selectedId}>{busy === "/api/agent/evolve-team" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}迭代配队先验</RippleButton></div><div className="mt-4 space-y-2">{(summary.failures || []).slice(0, 5).map((item: any, index: number) => <div key={item.id || item.code || index} className="p-3 bg-slate-50 rounded-lg text-xs text-slate-600 flex items-start gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-amber-500 mt-0.5" />{item.label || item.reason || JSON.stringify(item)}</div>)}{!summary.failures?.length && <div className="p-4 text-center text-slate-400 text-sm">当前 rulesetId 尚无可归因失败数据</div>}</div></div>
  </div>;
}
