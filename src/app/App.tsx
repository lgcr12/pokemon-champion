import { useEffect, useState } from "react";
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
                <PageComponent />
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
