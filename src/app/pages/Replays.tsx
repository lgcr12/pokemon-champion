import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, CheckCircle2, Database, ExternalLink, Loader2, Play, Swords, Trophy, Upload, XCircle } from "lucide-react";
import { RippleButton } from "../components/inspira/Buttons";
import { useWorkbench } from "../context/WorkbenchContext";
import { apiRequest } from "../lib/api";

function qualityTone(label = "LOW") {
  if (label === "HIGH") return "text-emerald-700 bg-emerald-50 border-emerald-100";
  if (label === "MEDIUM") return "text-amber-700 bg-amber-50 border-amber-100";
  return "text-slate-600 bg-slate-50 border-slate-100";
}

export function Replays() {
  const { replays, refresh, registry } = useWorkbench();
  const [selectedId, setSelectedId] = useState("");
  const [file, setFile] = useState("");
  const [replayInput, setReplayInput] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importError, setImportError] = useState("");

  const selected = useMemo(
    () => replays.find((item: any) => item.batchId === selectedId) || replays[0] || null,
    [replays, selectedId],
  );
  const files = selected?.replayFiles || selected?.replays?.map((item: any) => item.fileName) || [];

  useEffect(() => {
    if (selected && !files.includes(file)) setFile(files[0] || "");
  }, [selected, files.join("|"), file]);

  const replayUrl = selected && file
    ? `/api/agent/replay/${encodeURIComponent(selected.rulesetId)}/${encodeURIComponent(file)}`
    : "";
  const totalGames = replays.reduce((sum: number, item: any) => sum + Number(item.games || 0), 0);
  const totalWins = replays.reduce((sum: number, item: any) => sum + Number(item.wins || 0), 0);

  const importReplay = async () => {
    if (!replayInput.trim()) return;
    setImportBusy(true);
    setImportMessage("");
    setImportError("");
    try {
      const format = registry.active?.find((item: any) => item.battleType === "single") || registry.active?.[0];
      const result = await apiRequest("/api/showdown-replay", {
        method: "POST",
        body: JSON.stringify({
          url: replayInput.trim(),
          playerName: playerName.trim(),
          format: format?.battleType || "single",
          rulesetId: format?.rulesetId || "",
        }),
      });
      const quality = result.quality || {};
      setImportMessage(quality.trainingEligible
        ? `已导入高质量样本：${quality.score}/100，提取 ${result.trainingTrace?.sampleCount || 0} 个逐回合动作，已进入策略训练。`
        : `已保存回放，但质量为 ${quality.score || 0}/100（${quality.label || "LOW"}），不会进入策略训练。`);
      setReplayInput("");
      await refresh();
    } catch (error: any) {
      setImportError(error.message || "回放导入失败");
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "Rajdhani, sans-serif" }}>对局与回放</h1>
          <p className="text-slate-400 text-sm mt-1">真实对局、公开回放与策略训练样本</p>
        </div>
        <div className="flex gap-3">
          <span className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">{replays.length} 批次</span>
          <span className="px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs">{totalGames} 对局 · {totalWins} 胜</span>
        </div>
      </motion.div>

      <section className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0"><Upload className="w-5 h-5" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-slate-700">导入公开 Showdown 回放</h2>
            <p className="text-xs text-slate-400 mt-1">读取公开 .log，按当前规则过滤，并根据评级、完整性和逐回合动作数量筛选训练样本。</p>
            <div className="flex flex-wrap gap-3 mt-4">
              <input className="flex-1 min-w-64 h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700" value={replayInput} onChange={(event) => setReplayInput(event.target.value)} placeholder="https://replay.pokemonshowdown.com/..." />
              <input className="w-44 h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700" value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder="你的 Showdown 用户名" />
              <RippleButton onClick={importReplay} disabled={importBusy || !replayInput.trim()}>
                {importBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}导入并筛选
              </RippleButton>
            </div>
            {importMessage && <div className="mt-3 text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 shrink-0" />{importMessage}</div>}
            {importError && <div className="mt-3 text-xs text-rose-700 bg-rose-50 rounded-lg px-3 py-2 flex items-center gap-2"><AlertTriangle className="w-4 h-4 shrink-0" />{importError}</div>}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-5">
        <section className="space-y-3 max-h-[760px] overflow-y-auto pr-1">
          {replays.length ? replays.map((item: any, index: number) => (
            <motion.button key={item.batchId} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(index, 8) * 0.03 }} onClick={() => { setSelectedId(item.batchId); setFile(item.replayFiles?.[0] || item.replays?.[0]?.fileName || ""); }} className={`w-full bg-white rounded-xl p-4 border text-left transition-all ${selected?.batchId === item.batchId ? "border-indigo-400 shadow-lg shadow-indigo-950/20" : "border-slate-100 hover:border-indigo-200"}`}>
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${item.wins >= item.losses ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"}`}>{item.wins >= item.losses ? <Trophy className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}</div>
                <div className="min-w-0 flex-1"><div className="font-semibold text-slate-700 truncate">{item.teamTitle || item.policyVersion || item.batchId}</div><div className="text-xs text-slate-400 mt-1 truncate">{item.rulesetId}</div></div>
                <div className={`font-bold ${item.wins >= item.losses ? "text-emerald-500" : "text-red-500"}`}>{item.wins}-{item.losses}</div>
              </div>
              <div className="flex flex-wrap gap-2 mt-3 text-[10px] text-slate-500"><span className="px-2 py-1 bg-slate-50 rounded">{item.games} 局</span><span className="px-2 py-1 bg-slate-50 rounded">{item.replayCount || item.replayFiles?.length || 0} 回放</span><span className="px-2 py-1 bg-slate-50 rounded">{item.teamSource || item.teamVersion || "真实对局"}</span><span className="ml-auto py-1">{item.finishedAt ? new Date(item.finishedAt).toLocaleString() : "--"}</span></div>
            </motion.button>
          )) : <div className="bg-white rounded-xl p-10 text-center text-slate-400"><Database className="w-7 h-7 mx-auto mb-2" />暂无真实回放</div>}
        </section>

        <section className="bg-white rounded-xl overflow-hidden border border-slate-100 shadow-sm min-h-[560px]">
          {selected ? <>
            <div className="p-5 border-b border-slate-100">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs text-indigo-500 font-semibold">真实对局批次</div><h2 className="text-lg font-bold text-slate-800 mt-1">{selected.teamTitle || selected.policyVersion}</h2><div className="text-xs font-mono text-slate-400 mt-1">{selected.batchId}</div></div><div className="flex gap-2"><div className="bg-indigo-50 rounded-lg px-3 py-2 text-center"><div className="font-bold text-indigo-600">{selected.games}</div><div className="text-[10px] text-slate-400">对局</div></div><div className="bg-emerald-50 rounded-lg px-3 py-2 text-center"><div className="font-bold text-emerald-600">{selected.wins}</div><div className="text-[10px] text-slate-400">胜利</div></div><div className="bg-red-50 rounded-lg px-3 py-2 text-center"><div className="font-bold text-red-500">{selected.losses}</div><div className="text-[10px] text-slate-400">失败</div></div></div></div>
              <div className="mt-4 p-3 rounded-lg bg-slate-50 text-xs text-slate-600"><strong>策略：</strong>{selected.policyVersion || "--"} · <strong>队伍：</strong>{selected.teamVersion || "--"} · <strong>rulesetId：</strong>{selected.rulesetId || "--"}</div>
              {selected.quality && <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${qualityTone(selected.quality.label)}`}>公开样本质量：{selected.quality.score}/100 · {selected.quality.trainingEligible ? "允许策略训练" : "仅用于复盘与配队反馈"}</div>}
            </div>
            {files.length && replayUrl ? <><div className="p-4 flex flex-wrap items-end gap-3 border-b border-slate-100"><label className="flex-1 min-w-56 text-xs text-slate-500">选择对局<select className="block w-full mt-1 h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700" value={file} onChange={(event) => setFile(event.target.value)}>{files.map((name: string) => <option key={name} value={name}>{name}</option>)}</select></label><a href={replayUrl} target="_blank" rel="noreferrer"><RippleButton><ExternalLink className="w-3.5 h-3.5" />新窗口打开</RippleButton></a></div><iframe className="w-full h-[560px] bg-white" title="Showdown 对局回放" src={replayUrl} /></> : <div className="h-96 flex flex-col items-center justify-center text-slate-400"><Play className="w-8 h-8 mb-2" />{files.length ? "正在载入回放" : "该批次没有 HTML 回放文件"}</div>}
          </> : <div className="h-96 flex flex-col items-center justify-center text-slate-400"><Swords className="w-8 h-8 mb-2" />选择真实对局批次</div>}
        </section>
      </div>
    </div>
  );
}
