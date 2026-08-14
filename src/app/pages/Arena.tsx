import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Wifi, WifiOff, AlertTriangle, StopCircle, Sword, Shield, Zap, Cloud, Loader2, Shuffle, Settings2, Sparkles } from "lucide-react";
import { RainbowButton, KillSwitchButton, GhostButton } from "../components/inspira/Buttons";
import { BorderBeam } from "../components/inspira/BorderBeam";
import { useWorkbench } from "../context/WorkbenchContext";
import { apiRequest, displayTeamTitle, formatRuleName, spriteUrl, teamToShowdown } from "../lib/api";

const STATUS_CONFIG: Record<string, { label: string; color: string; pulse: boolean }> = {
  STOPPED: { label: "待机", color: "#94a3b8", pulse: false }, STARTING: { label: "启动中", color: "#f59e0b", pulse: true }, CONNECTING: { label: "连接中", color: "#f59e0b", pulse: true }, AUTHENTICATED: { label: "已认证", color: "#06b6d4", pulse: true }, SEARCHING: { label: "搜索对手", color: "#06b6d4", pulse: true }, BATTLE: { label: "对战中", color: "#4f46e5", pulse: true }, RUNNING: { label: "运行中", color: "#4f46e5", pulse: true }, FAILED: { label: "连接错误", color: "#ef4444", pulse: true }, COMPLETED: { label: "批次完成", color: "#10b981", pulse: false },
};

function BattleMon({ member, fallback }: { member: any; fallback?: any }) {
  const data = { ...fallback, ...member };
  const hp = Math.round(Number(data.hpFraction ?? 1) * 100);
  return <div className="flex-1 bg-indigo-50 rounded-lg p-2.5 border border-indigo-100 min-w-0"><img src={spriteUrl(data.sprite || data.id || data.name)} alt={data.localizedName || data.name} className="w-14 h-14 object-contain mx-auto drop-shadow-sm" /><div className="text-[10px] text-center font-medium text-slate-600 truncate">{data.localizedName || data.name}</div><div className="mt-1"><div className="h-2 rounded-full bg-slate-200 overflow-hidden"><motion.div className="h-full rounded-full" animate={{ width: `${hp}%` }} style={{ background: hp > 50 ? "#10b981" : hp > 25 ? "#f59e0b" : "#ef4444" }} /></div><div className="text-[9px] text-slate-400 mt-.5 text-right">{data.fainted ? "濒死" : `${hp}% ${data.status || ""}`}</div></div></div>;
}

function HotTeamMembers({ team }: { team: any }) {
  return <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">{(team?.members || []).map((member: any) => <div key={`${team.id}-${member.slug || member.name}`} className="rounded-lg bg-slate-50 p-2 text-center"><img src={spriteUrl(member.sprite || member.slug || member.name)} alt={member.name || member.slug} className="w-12 h-12 object-contain mx-auto" /><div className="text-[10px] text-slate-600 truncate mt-1">{member.name || member.slug}</div></div>)}</div>;
}

export function Arena() {
  const { team, registry, agent, account, startAgent, stopAgent } = useWorkbench();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [games, setGames] = useState(1);
  const [policy, setPolicy] = useState("structured");
  const [autoBattle, setAutoBattle] = useState(true);
  const [teamMode, setTeamMode] = useState<"workbench" | "hot">("workbench");
  const [formatId, setFormatId] = useState("");
  const [hotTeams, setHotTeams] = useState<any[]>([]);
  const [hotTeam, setHotTeam] = useState<any>(null);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotError, setHotError] = useState("");
  const status = agent?.status || "STOPPED";
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.STOPPED;
  const running = ["STARTING", "CONNECTING", "AUTHENTICATED", "SEARCHING", "BATTLE", "RUNNING"].includes(status);
  const sessionActive = running || ["STARTING", "CONNECTING", "AUTHENTICATED"].includes(status);
  const formats = registry.active || [];
  const selectedFormat = formats.find((item: any) => item.rulesetId === formatId) || formats.find((item: any) => item.rulesetId === agent?.rulesetId) || formats.find((item: any) => item.battleType === "double") || formats[0];
  const activeRule = formats.find((item: any) => item.rulesetId === agent?.rulesetId) || selectedFormat;
  const snapshot = agent?.battleSnapshot || {};
  const submitted = (running && agent?.submittedTeam?.length ? agent.submittedTeam : team).map((member: any) => ({ ...team.find((item: any) => item.id === member.id || item.name === member.name), ...member }));
  const ownSlots = snapshot.own?.slots?.length ? snapshot.own.slots : submitted;
  const ownActive = snapshot.own?.active?.length ? snapshot.own.active : ownSlots.slice(0, selectedFormat?.battleType === "double" ? 2 : 1);
  const opponentSlots = snapshot.opponent?.slots || [];
  const opponentActive = snapshot.opponent?.active || [];
  const batchFinished = Number(agent?.batchGamesFinished ?? agent?.gamesFinished ?? 0);
  const sessionFinished = Number(agent?.sessionGamesFinished ?? 0);
  const selectedTeamText = teamMode === "hot" ? hotTeam?.teamText || "" : teamToShowdown(team);
  const selectedTeamLabel = teamMode === "hot" ? displayTeamTitle(hotTeam?.title, hotTeam?.id) : "当前配队工坊队伍";
  const loadHotTeams = async () => {
    if (!selectedFormat?.rulesetId) return;
    setHotLoading(true);
    setHotError("");
    try {
      const data = await apiRequest(`/api/agent/hot-teams?format=${selectedFormat.battleType}&rulesetId=${encodeURIComponent(selectedFormat.rulesetId)}&limit=500`);
      const items = data.items || [];
      setHotTeams(items);
      setHotTeam(data.selected || items[Math.floor(Math.random() * items.length)] || null);
    } catch (error: any) {
      setHotTeams([]);
      setHotTeam(null);
      setHotError(error.message);
    } finally {
      setHotLoading(false);
    }
  };
  useEffect(() => {
    if (teamMode === "hot") loadHotTeams();
  }, [teamMode, selectedFormat?.rulesetId]);
  useEffect(() => {
    if (policy === "laplace") {
      const single = formats.find((item: any) => item.battleType === "single");
      if (single) setFormatId(single.rulesetId);
    }
  }, [policy, formats]);
  const rerollHotTeam = () => {
    if (!hotTeams.length) return loadHotTeams();
    const choices = hotTeams.filter((item) => item.id !== hotTeam?.id);
    const pool = choices.length ? choices : hotTeams;
    setHotTeam(pool[Math.floor(Math.random() * pool.length)]);
  };
  const start = async () => {
    if (teamMode === "hot" && !hotTeam) return;
    setBusy("start"); setMessage("");
    try {
      const teamPool = teamMode === "hot" ? hotTeams.map((item) => ({ id: item.id, title: item.title, source: item.source, rate: item.rate, rank: item.rank, teamText: item.teamText })) : [];
      await startAgent({ games, policy, format: selectedFormat?.battleType, rulesetId: selectedFormat?.rulesetId, teamText: selectedTeamText, teamSource: teamMode, teamId: teamMode === "hot" ? hotTeam.id : "", teamTitle: teamMode === "hot" ? hotTeam.title : "", teamPool, continuous: teamMode === "hot" && autoBattle });
      setMessage(`已提交 ${games} 场${selectedFormat?.battleType === "single" ? "BSS 单打" : "VGC 双打"}排位，队伍来源：${selectedTeamLabel}。`);
    } catch (error: any) { setMessage(error.message); }
    finally { setBusy(""); }
  };
  const stop = async () => { setBusy("stop"); try { await stopAgent(); setMessage("Agent 已停止。"); } catch (error: any) { setMessage(error.message); } finally { setBusy(""); } };
  const telemetry = useMemo(() => [["连接", agent?.connectionStatus || "DISCONNECTED"], ["搜索", agent?.queueStatus || "--"], ["请求", String(agent?.requestCount || 0)], ["决策", String(agent?.decisionCount || 0)], ["回退", String(agent?.fallbackCount || 0)], ["健康", agent?.battleHealth || "--"]], [agent]);

  const progressStrip = <div className="rounded-lg border border-indigo-100 bg-white/95 px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600"><span>本批次 {batchFinished}/{agent?.batchGamesRequested || games}</span><span>累计 {sessionFinished} 局</span><span>{agent?.continuous ? "自动连续排位 · 每局随机换队" : "单批次排位"}</span><span>热门池 {agent?.teamPoolSize || hotTeams.length || 0} 支</span><span className="font-medium text-indigo-600">当前：{displayTeamTitle(agent?.currentTeamTitle || selectedTeamLabel, agent?.currentTeamId)}</span><label className="ml-auto inline-flex items-center gap-1.5 cursor-pointer text-slate-600"><input type="checkbox" checked={autoBattle} onChange={(event) => setAutoBattle(event.target.checked)} disabled={sessionActive} />自动开始下一批</label></div>;
  return <div className="space-y-4">{progressStrip}
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Rajdhani, sans-serif" }}>竞技场</h1><p className="text-slate-400 text-sm mt-.5">Arena · Showdown 真实排位与队伍来源控制</p></div><div className="flex items-center gap-3"><div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border ${agent?.connectionStatus === "CONNECTED" ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-slate-500/10 border-slate-500/20 text-slate-400"}`}>{agent?.connectionStatus === "CONNECTED" ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}Showdown {agent?.connectionStatus || "DISCONNECTED"}</div><div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border" style={{ background: config.color + "15", borderColor: config.color + "30", color: config.color }}><span className={`w-1.5 h-1.5 rounded-full ${config.pulse ? "animate-pulse" : ""}`} style={{ background: config.color }} />{config.label}</div></div></motion.div>
    <section className="bg-white rounded-xl p-5 border border-slate-100 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 mb-4"><div className="flex items-center gap-2"><Settings2 className="w-4 h-4 text-indigo-500" /><div><h2 className="text-sm font-semibold text-slate-700">对战设置</h2><p className="text-xs text-slate-400 mt-1">提交后本批次锁定，使用现有规则和 Agent 接口执行</p></div></div><span className="text-xs font-mono text-indigo-500">{selectedFormat?.rulesetId || "等待规则"}</span></div><div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><label className="text-xs text-slate-500"><span className="block mb-1">规则格式</span><select className="w-full h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 bg-white" value={selectedFormat?.rulesetId || ""} onChange={(event) => setFormatId(event.target.value)} disabled={sessionActive}>{formats.map((item: any) => <option key={item.rulesetId} value={item.rulesetId}>{item.battleType === "single" ? "BSS 单打" : "VGC 双打"} · {item.regulation}</option>)}</select></label><label className="text-xs text-slate-500"><span className="block mb-1">对局数量</span><input className="w-full h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700" type="number" min={1} max={10} value={games} onChange={(event) => setGames(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} disabled={sessionActive} /></label><label className="text-xs text-slate-500"><span className="block mb-1">策略引擎</span><select className="w-full h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 bg-white" value={policy} onChange={(event) => setPolicy(event.target.value)} disabled={sessionActive}><option value="structured">结构化策略</option><option value="laplace">Laplace 单打实验</option></select></label></div><div className="mt-4 flex flex-wrap items-center gap-2"><span className="text-xs text-slate-400 mr-1">队伍来源</span><button className={`px-3 py-2 rounded-lg text-xs flex items-center gap-1.5 ${teamMode === "workbench" ? "bg-indigo-500 text-white" : "bg-slate-50 text-slate-600"}`} onClick={() => setTeamMode("workbench")} disabled={sessionActive}><Sword className="w-3.5 h-3.5" />当前配队工坊</button><button className={`px-3 py-2 rounded-lg text-xs flex items-center gap-1.5 ${teamMode === "hot" ? "bg-indigo-500 text-white" : "bg-slate-50 text-slate-600"}`} onClick={() => setTeamMode("hot")} disabled={sessionActive}><Sparkles className="w-3.5 h-3.5" />随机热门队伍</button><span className="ml-auto text-xs text-slate-400">{selectedFormat?.rules?.join(" · ") || "规则加载中"}</span></div>{teamMode === "hot" && <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4"><div className="flex flex-wrap items-start justify-between gap-3 mb-3"><div><div className="text-xs text-indigo-500 font-semibold">当前规则热门队池</div><div className="text-sm font-semibold text-slate-700 mt-1">{hotTeam?.title || (hotLoading ? "正在抽取热门队伍" : "暂无热门队伍")}</div><div className="text-xs text-slate-400 mt-1">{hotTeam ? `${hotTeam.source || "数据源"} · ${hotTeam.sourceSeason || "未知赛季"} · ${hotTeam.rate ? `${hotTeam.rate}% 使用率` : `排名 #${hotTeam.rank || "-"}`}` : hotError || "仅使用通过当前 rulesetId 校验的完整队伍"}</div></div><button className="px-3 py-2 rounded-lg bg-white border border-indigo-100 text-xs text-indigo-600 flex items-center gap-1.5" onClick={rerollHotTeam} disabled={hotLoading || sessionActive}>{hotLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shuffle className="w-3.5 h-3.5" />}重新抽取</button></div>{hotTeam ? <HotTeamMembers team={hotTeam} /> : <div className="py-5 text-center text-xs text-slate-400">{hotLoading ? "正在加载并验证当前规则热门队伍..." : hotError || "没有可用热门队伍"}</div>}<div className="mt-3 text-[10px] text-slate-400">池中可选队伍：{hotTeams.length} 支 · {hotTeam?.seasonMatched ? `数据赛季匹配 ${selectedFormat?.regulation}` : `已按 ${selectedFormat?.regulation || "当前规则"} 重新校验`}</div></div>}<div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-3"><div><div className="text-[10px] text-slate-400">本次实际提交</div><div className="text-sm font-semibold text-slate-700">{selectedTeamLabel}</div></div><div className="text-xs font-mono text-slate-400">{teamMode === "hot" ? hotTeam?.id || "等待选择" : "forge-ui"}</div></div></section>
    <BorderBeam active={running} color="indigo" duration={3}><div className="bg-white rounded-xl overflow-hidden"><div className="bg-indigo-50 px-5 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 text-sm font-semibold text-slate-700"><Sword className="w-4 h-4 text-indigo-500" />{formatRuleName(activeRule?.name || "等待当前规则")} · {status === "BATTLE" ? `回合 ${snapshot.turn || 0}` : config.label}</div><div className="flex items-center gap-2 text-xs text-slate-500"><span className="px-2 py-.5 rounded bg-white font-mono">{activeRule?.showdownFormatId || "--"}</span><span>天气：{snapshot.weather || "无"}</span><span>场地：{snapshot.terrain || "无"}</span></div></div><div className="p-5"><div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-stretch mb-5"><div className="md:col-span-2 space-y-3"><div className="flex items-center gap-2"><div className="w-8 h-8 rounded-full bg-indigo-100 border-2 border-indigo-300 flex items-center justify-center text-indigo-600 font-bold text-sm">我</div><div><div className="text-sm font-semibold text-slate-700">{agent?.username || account?.username || "未连接账号"}</div><div className="text-[10px] text-slate-400">{agent?.policyVersion || "等待策略"}</div></div><div className="ml-auto text-xs text-emerald-500 font-medium">Agent 控制</div></div><div className="flex gap-2">{ownActive.map((member: any, i: number) => <BattleMon key={`${member.id}-${i}`} member={member} fallback={submitted.find((item: any) => item.id === member.id || item.name === member.name)} />)}</div><div className="flex items-center gap-1.5 flex-wrap"><Shield className="w-3.5 h-3.5 text-slate-400" /><span className="text-[10px] text-slate-400">当前排位队伍：</span>{ownSlots.map((member: any, i: number) => <img key={`${member.id}-${i}`} src={spriteUrl(member.sprite || member.id || member.name)} alt={member.name} className="w-7 h-7 object-contain" />)}</div></div><div className="md:col-span-1 flex flex-col items-center justify-center gap-2"><div className="text-2xl font-black text-indigo-600" style={{ fontFamily: "Rajdhani" }}>VS</div>{running && <motion.div animate={{ scale: [1, 1.15, 1] }} transition={{ duration: 1.5, repeat: Infinity }} className="w-2 h-2 rounded-full" style={{ background: config.color }} />}<div className="text-[10px] text-center text-slate-400">{config.label}</div></div><div className="md:col-span-2 space-y-3"><div className="flex items-center gap-2"><div className="w-8 h-8 rounded-full bg-red-100 border-2 border-red-200 flex items-center justify-center text-red-500 font-bold text-sm">敌</div><div><div className="text-sm font-semibold text-slate-700">{agent?.opponentName || (opponentSlots.length ? "当前对手" : "等待对手")}</div><div className="text-[10px] text-slate-400">仅显示已公开信息</div></div></div>{opponentActive.length ? <div className="flex gap-2">{opponentActive.map((member: any, i: number) => <BattleMon key={`${member.id}-${i}`} member={member} />)}</div> : <div className="h-28 flex flex-col items-center justify-center gap-2 bg-slate-50 rounded-lg border border-dashed border-slate-200"><div className="flex gap-3 opacity-30"><div className="w-14 h-14 rounded-full bg-slate-200" /><div className="w-14 h-14 rounded-full bg-slate-200" /></div><div className="text-[10px] text-slate-400">尚无已公开的对手场上信息</div></div>}<div className="flex items-center gap-1.5 flex-wrap"><Zap className="w-3.5 h-3.5 text-slate-400" /><span className="text-[10px] text-slate-400">已公开阵容：</span>{opponentSlots.map((member: any, i: number) => <img key={`${member.id}-${i}`} src={spriteUrl(member.sprite || member.id || member.name)} alt={member.name} className="w-7 h-7 object-contain" />)}{!opponentSlots.length && <span className="text-[10px] text-slate-300">暂无</span>}</div></div></div><div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4"><div className="flex gap-2">{running ? <GhostButton disabled>排位运行中</GhostButton> : <RainbowButton onClick={start} disabled={busy === "start" || !registry.canOperate || account?.status !== "READY" || (teamMode === "hot" && !hotTeam)}>{busy === "start" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sword className="w-4 h-4" />}开始排位</RainbowButton>}<GhostButton>当前批次: {selectedTeamLabel}</GhostButton></div><KillSwitchButton onClick={stop} disabled={!running || busy === "stop"}><StopCircle className="w-4 h-4" />紧急停止</KillSwitchButton></div>{message && <div className={`mt-3 text-xs ${/失败|错误|未/.test(message) ? "text-red-500" : "text-indigo-600"}`}>{message}</div>}</div></div></BorderBeam>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4"><div className="bg-white rounded-xl overflow-hidden border border-slate-100 shadow-sm"><div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2"><Cloud className="w-3.5 h-3.5 text-indigo-400" /><h3 className="text-sm font-semibold text-slate-700">实时事件与决策</h3></div><div className="p-4 space-y-2 bg-slate-50/50 min-h-48">{[["服务端事件", agent?.lastServerEvent], ["请求摘要", agent?.lastRequestSummary], ["最后消息", agent?.lastSentMessage], ["最后决策", agent?.lastDecisionAt ? `回合 ${agent.lastDecisionTurn} · ${new Date(agent.lastDecisionAt).toLocaleTimeString()}` : "尚无决策"], ["决策错误", agent?.lastDecisionError]].filter(([, value]) => value).map(([label, value]) => <div key={label} className="bg-white border border-slate-100 rounded-lg px-3 py-2 text-xs"><span className="text-slate-400 mr-2">{label}</span><span className="font-mono text-slate-700">{value}</span></div>)}{!agent && <div className="h-40 flex items-center justify-center text-slate-300">等待 Agent 状态</div>}</div></div><div className="bg-white rounded-xl p-5 border border-slate-100 shadow-sm"><h3 className="font-semibold text-slate-700 text-sm mb-4">Sidecar 遥测</h3><div className="grid grid-cols-2 sm:grid-cols-3 gap-3">{telemetry.map(([label, value]) => <div key={label} className="bg-slate-50 rounded-lg p-3"><div className="text-[10px] text-slate-400">{label}</div><div className="text-sm font-mono font-semibold text-slate-700 mt-1 truncate" title={value}>{value}</div></div>)}</div><div className="mt-4 p-3 rounded-lg bg-indigo-50 border border-indigo-100 text-xs text-indigo-700"><strong>策略：</strong>{agent?.policyVersion || "--"}<br /><strong>规则：</strong>{agent?.rulesetId || activeRule?.rulesetId || "--"}</div>{agent?.lastError && status === "FAILED" && <div className="mt-3 p-3 bg-red-50 border border-red-100 rounded-lg text-xs text-red-600 flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0" />{agent.lastError}</div>}</div></div>
  </div>;
}
