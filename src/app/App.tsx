import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { VortexBackground } from "./components/inspira/VortexBackground";
import { Sidebar, type PageId } from "./layout/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { TeamForge } from "./pages/TeamForge";
import { TeamLab } from "./pages/TeamLab";
import { Arena } from "./pages/Arena";
import { Replays } from "./pages/Replays";
import { Rules } from "./pages/Rules";
import { Knowledge } from "./pages/Knowledge";
import { Models } from "./pages/Models";
import { Settings } from "./pages/Settings";
import { DataCenter } from "./pages/DataCenter";
import { TacticalCompanion } from "./components/TacticalCompanion";
import { WorkbenchProvider, useWorkbench } from "./context/WorkbenchContext";

const PAGE_MAP: Record<PageId, React.ComponentType> = {
  dashboard: Dashboard,
  "team-forge": TeamForge,
  "team-lab": TeamLab,
  arena: Arena,
  replays: Replays,
  rules: Rules,
  knowledge: Knowledge,
  "data-center": DataCenter,
  models: Models,
  settings: Settings,
};

type PageBoundaryProps = { children: ReactNode; page: PageId; onBack: () => void };
type PageBoundaryState = { error: Error | null };

class PageBoundary extends Component<PageBoundaryProps, PageBoundaryState> {
  state: PageBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PageBoundaryState {
    return { error };
  }

  componentDidUpdate(previousProps: PageBoundaryProps) {
    if (previousProps.page !== this.props.page && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Failed to render ${this.props.page}`, error, info);
  }

  render() {
    if (this.state.error) {
      return <section className="mx-auto mt-8 max-w-2xl rounded-2xl border border-rose-300/25 bg-slate-950/85 p-6 text-slate-100 shadow-2xl shadow-rose-950/20">
        <p className="text-sm font-semibold text-rose-200">当前页面未能加载</p>
        <p className="mt-2 text-sm leading-6 text-slate-400">其他页面和导航仍可使用。返回总览后可以再次进入此页面。</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" onClick={() => this.setState({ error: null })} className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400">重试</button>
          <button type="button" onClick={this.props.onBack} className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-white/10">返回总览</button>
        </div>
      </section>;
    }
    return this.props.children;
  }
}

function WorkbenchApp() {
  const [page, setPage] = useState<PageId>("dashboard");
  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const next = (event as CustomEvent).detail;
      if (next && next in PAGE_MAP) setPage(next as PageId);
    };
    window.addEventListener("champion-forge:navigate", handleNavigate);
    return () => window.removeEventListener("champion-forge:navigate", handleNavigate);
  }, []);
  const PageComponent = PAGE_MAP[page];
  const { agent, registry } = useWorkbench();
  const agentOnline = ["STARTING", "CONNECTING", "AUTHENTICATED", "SEARCHING", "BATTLE", "RUNNING"].includes(agent?.status);
  const activeRule = registry.active?.find((item: any) => item.battleType === (agent?.battleType || "double")) || registry.active?.[0];

  return (
    <div className="min-h-screen w-full relative" style={{ background: "#060818" }}>
      {/* Vortex particle background — always visible */}
      <VortexBackground />

      {/* Layout */}
      <div className="relative flex" style={{ zIndex: 1 }}>
        {/* Sidebar */}
        <Sidebar current={page} onChange={setPage} agentOnline={agentOnline} activeRule={activeRule} />

        {/* Main content */}
        <main
          className="flex-1 min-h-screen md:ml-60 overflow-y-auto"
          style={{ minHeight: "100vh" }}
        >
          {/* Top stripe — visible Vortex bleed area */}
          <div className="h-4 md:h-6" />

          {/* Page content area with padding that exposes Vortex */}
          <div className="px-4 md:px-6 pb-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={page}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              >
                <PageBoundary page={page} onBack={() => setPage("dashboard")}>
                  <PageComponent />
                </PageBoundary>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Bottom spacing */}
          <div className="h-6" />
        </main>
      </div>

      {/* Vortex edge glow overlays — purely decorative, non-blocking */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-y-0 left-0 w-60 md:w-72"
        style={{
          zIndex: 0,
          background: "linear-gradient(90deg, rgba(79,70,229,0.06) 0%, transparent 100%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-y-0 right-0 w-16 md:w-24"
        style={{
          zIndex: 0,
          background: "linear-gradient(270deg, rgba(124,58,237,0.06) 0%, transparent 100%)",
        }}
      />
      <TacticalCompanion />
    </div>
  );
}

export default function App() {
  return <WorkbenchProvider><WorkbenchApp /></WorkbenchProvider>;
}
