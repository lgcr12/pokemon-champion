import { motion, AnimatePresence } from "motion/react";
import {
  LayoutDashboard, Sword, FlaskConical, Trophy, Play, BookOpen, Brain, LibraryBig,
  Settings, ChevronRight, Wifi, WifiOff, Bot, Zap, Menu, X, Database,
} from "lucide-react";
import { cn } from "../components/ui/utils";
import { useState } from "react";

export type PageId =
  | "dashboard" | "team-forge" | "team-lab" | "arena"
  | "replays" | "rules" | "knowledge" | "data-center" | "models" | "settings";

const NAV_ITEMS: Array<{ id: PageId; label: string; icon: typeof LayoutDashboard; badge?: string }> = [
  { id: "dashboard", label: "\u603b\u89c8", icon: LayoutDashboard },
  { id: "team-forge", label: "\u914d\u961f\u5de5\u574a", icon: Sword },
  { id: "team-lab", label: "\u914d\u961f\u5b9e\u9a8c\u5ba4", icon: FlaskConical },
  { id: "arena", label: "\u7ade\u6280\u573a", icon: Trophy },
  { id: "replays", label: "\u5bf9\u5c40\u4e0e\u56de\u653e", icon: Play },
  { id: "rules", label: "\u89c4\u5219\u4e0e\u73af\u5883", icon: BookOpen },
  { id: "knowledge", label: "\u6218\u672f\u8d44\u6599", icon: LibraryBig },
  { id: "data-center", label: "\u6570\u636e\u4e2d\u5fc3", icon: Database, badge: "NEW" },
  { id: "models", label: "\u6a21\u578b\u5b9e\u9a8c\u5ba4", icon: Brain },
  { id: "settings", label: "\u8d26\u53f7\u4e0e\u8bbe\u7f6e", icon: Settings },
];

type SidebarProps = { current: PageId; onChange: (id: PageId) => void; agentOnline: boolean; activeRule?: any };

export function Sidebar({ current, onChange, agentOnline, activeRule }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return <>
    <button className="fixed top-4 left-4 z-50 md:hidden rounded-lg p-2 bg-[rgba(8,10,30,0.9)] border border-indigo-500/20 text-indigo-300" onClick={() => setMobileOpen((value) => !value)} aria-label="\u5207\u6362\u83dc\u5355">
      {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
    </button>
    <AnimatePresence>{mobileOpen && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={() => setMobileOpen(false)} />}</AnimatePresence>
    <motion.aside initial={false} animate={{ x: mobileOpen ? 0 : undefined }} className={cn("fixed left-0 top-0 h-screen w-60 z-40 flex flex-col", "border-r border-indigo-500/15", "transition-transform duration-300", "-translate-x-full md:translate-x-0", mobileOpen && "translate-x-0")} style={{ background: "rgba(8, 10, 30, 0.92)", backdropFilter: "blur(20px)" }}>
      <div className="px-5 py-5 border-b border-indigo-500/10"><div className="flex items-center gap-2.5"><div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, #4f46e5, #7c3aed)" }}><Zap className="w-4 h-4 text-white" /></div><div><div className="text-sm font-bold text-white tracking-wide" style={{ fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.05em" }}>CHAMPION FORGE</div><div className="text-[10px] text-indigo-400 tracking-widest">\u7ade\u6280\u6218\u672f\u5de5\u4f5c\u53f0</div></div></div></div>
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">{NAV_ITEMS.map((item) => { const Icon = item.icon; const active = current === item.id; return <button key={item.id} onClick={() => { onChange(item.id); setMobileOpen(false); }} className={cn("w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 text-left group", active ? "bg-indigo-600/20 text-indigo-200 border border-indigo-500/30" : "text-slate-400 hover:text-slate-200 hover:bg-white/5")}><Icon className={cn("w-4 h-4 shrink-0", active ? "text-indigo-400" : "text-slate-500 group-hover:text-slate-300")} /><span className="flex-1">{item.label}</span>{item.badge && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">{item.badge}</span>}{active && <ChevronRight className="w-3.5 h-3.5 text-indigo-400" />}</button>; })}</nav>
      <div className="px-4 py-4 border-t border-indigo-500/10 space-y-2"><div className="flex items-center gap-2.5"><div className={cn("relative w-2 h-2 rounded-full", agentOnline ? "bg-emerald-400" : "bg-slate-500")}>{agentOnline && <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />}</div><Bot className="w-3.5 h-3.5 text-slate-500" /><span className="text-xs text-slate-400">{agentOnline ? "Agent \u5728\u7ebf" : "Agent \u79bb\u7ebf"}</span></div><div className="flex items-center gap-2.5">{agentOnline ? <Wifi className="w-3.5 h-3.5 text-emerald-400" /> : <WifiOff className="w-3.5 h-3.5 text-slate-500" />}<span className="text-xs text-slate-500">{agentOnline ? "Showdown \u5df2\u8fde\u63a5" : "\u672a\u8fde\u63a5"}</span></div><div className="mt-2 px-2.5 py-2 rounded-lg bg-indigo-500/8 border border-indigo-500/15"><div className="text-[10px] text-indigo-400 uppercase tracking-wider">\u5f53\u524d\u8d5b\u5b63</div><div className="text-xs text-slate-300 mt-0.5">{activeRule ? `${activeRule.battleType === "double" ? "VGC" : "BSS"} / ${activeRule.regulation || "--"}` : "\u7b49\u5f85\u89c4\u5219\u540c\u6b65"}</div></div></div>
    </motion.aside>
  </>;
}
