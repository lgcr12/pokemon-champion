import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, ChevronUp, MessageCircle, Sparkles, X, Zap } from "lucide-react";
import { useWorkbench } from "../context/WorkbenchContext";
import { formatRuleName, spriteUrl } from "../lib/api";

const LINES = [
  "今天也来检查一下队伍结构吧。",
  "先看规则，再看招式和速度线。",
  "点击队伍里的成员，我会给出一个小提示。",
  "热门不等于适合，实战反馈才是答案。",
];

export function TacticalCompanion() {
  const { team, registry, agent } = useWorkbench();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [lineIndex, setLineIndex] = useState(0);
  const activeRule = registry.active?.find((item: any) => item.battleType === (agent?.battleType || "double")) || registry.active?.[0];
  const member = team[selected] || team[0];
  const hint = useMemo(() => {
    if (!member) return "还没有队伍成员，可以先去配队工坊添加候选。";
    if (member.role) return `${member.localizedName || member.name} 当前定位：${member.role}。点击其他成员查看不同配置。`;
    return `${member.localizedName || member.name} 已加入当前队伍。`;
  }, [member]);

  return <div className="fixed bottom-5 right-5 z-50">
    <AnimatePresence mode="wait">
      {!open ? <motion.button key="ball" initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.7, opacity: 0 }} whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.95 }} onClick={() => setOpen(true)} aria-label="打开战术伙伴" className="relative flex h-16 w-16 items-center justify-center rounded-full border-4 border-white bg-gradient-to-b from-red-500 via-red-500 to-slate-100 shadow-xl shadow-indigo-950/25"><span className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 bg-slate-900" /><span className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full border-4 border-slate-900 bg-white"><span className="h-2 w-2 rounded-full bg-indigo-500" /></span><span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-white"><Sparkles className="h-3 w-3" /></span></motion.button> : <motion.section key="panel" initial={{ opacity: 0, y: 16, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.94 }} className="w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-indigo-100 bg-white shadow-2xl shadow-indigo-950/20"><div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-cyan-50 px-4 py-3"><div className="flex items-center gap-2"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500 text-white"><Zap className="h-4 w-4" /></div><div><div className="text-sm font-semibold text-slate-800">战术伙伴</div><div className="text-[10px] text-slate-400">{activeRule ? formatRuleName(activeRule.name) : "等待规则"}</div></div></div><button onClick={() => setOpen(false)} aria-label="收起战术伙伴" className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"><X className="h-4 w-4" /></button></div><div className="p-4"><div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3"><div className="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-100"><MessageCircle className="h-5 w-5 text-indigo-500" /></div><div className="min-w-0 flex-1"><div className="text-xs font-semibold text-slate-700">{LINES[lineIndex]}</div><div className="mt-1 truncate text-[10px] text-slate-400">{hint}</div></div><button onClick={() => setLineIndex((value) => (value + 1) % LINES.length)} aria-label="切换提示" className="rounded-md p-1 text-indigo-400 hover:bg-white"><ChevronDown className="h-4 w-4" /></button></div><div className="mt-4 flex items-center justify-between"><span className="text-xs font-semibold text-slate-500">当前队伍</span><span className="text-[10px] text-slate-400">{team.length}/6 成员</span></div><div className="mt-2 grid grid-cols-3 gap-2">{team.slice(0, 6).map((item: any, index: number) => <button key={`${item.id}-${index}`} onClick={() => { setSelected(index); setLineIndex((value) => (value + 1) % LINES.length); }} className={`rounded-xl border p-2 text-center transition ${selected === index ? "border-indigo-400 bg-indigo-50 shadow-sm" : "border-slate-100 bg-slate-50 hover:border-indigo-200"}`}><img src={spriteUrl(item.sprite || item.id || item.name)} alt={item.localizedName || item.name} className="mx-auto h-12 w-12 object-contain" /><div className="mt-1 truncate text-[10px] font-medium text-slate-600">{item.localizedName || item.name}</div></button>)}</div>{!team.length && <div className="py-6 text-center text-xs text-slate-400">暂无队伍成员</div>}</div><div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 text-[10px] text-slate-400"><span>仅前端互动，不改变排位状态</span><button onClick={() => setOpen(false)} className="flex items-center gap-1 text-indigo-500 hover:text-indigo-700"><ChevronUp className="h-3.5 w-3.5" />收起</button></div></motion.section>}
    </AnimatePresence>
  </div>;
}
