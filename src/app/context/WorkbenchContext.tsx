import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiRequest, displayTeamTitle, teamToShowdown } from "../lib/api";
import { INITIAL_TEAM, normalizeTeamMember } from "../data/realData";

export type WorkbenchContextValue = {
  team: any[];
  setTeam: React.Dispatch<React.SetStateAction<any[]>>;
  registry: any;
  history: any[];
  agent: any;
  replays: any[];
  models: any[];
  ratings: any[];
  account: any;
  refresh: () => Promise<void>;
  startAgent: (options?: any) => Promise<any>;
  stopAgent: () => Promise<any>;
  syncRules: () => Promise<any>;
};

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [team, setTeamState] = useState<any[]>(() => INITIAL_TEAM.map(normalizeTeamMember));
  const [registry, setRegistry] = useState<any>({ status: "LOADING", active: [], canOperate: false });
  const [history, setHistory] = useState<any[]>([]);
  const [agent, setAgent] = useState<any>(null);
  const [replays, setReplays] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [ratings, setRatings] = useState<any[]>([]);
  const [account, setAccount] = useState<any>(null);

  const setTeam = useCallback<React.Dispatch<React.SetStateAction<any[]>>>((value) => {
    setTeamState((current) => (typeof value === "function" ? value(current) : value).map(normalizeTeamMember));
  }, []);

  const refresh = useCallback(async () => {
    const [nextRegistry, nextHistory, nextAgent, nextReplays, nextModels, nextRatings, nextAccount] = await Promise.all([
      apiRequest("/api/rules/active"),
      apiRequest("/api/rules/history"),
      apiRequest("/api/agent/status"),
      apiRequest("/api/agent/replays"),
      apiRequest("/api/agent/models"),
      apiRequest("/api/agent/ratings").catch(() => ({ items: [] })),
      apiRequest("/api/agent/account/status"),
    ]);
    setRegistry(nextRegistry);
    setHistory(nextHistory.history || []);
    const displayAgent = nextAgent
      ? {
          ...nextAgent,
          currentTeamTitle: displayTeamTitle(nextAgent.currentTeamTitle, nextAgent.currentTeamId, nextAgent.teamSource?.includes("hot") ? "规则内热门队伍" : "当前配队工坊队伍"),
          teamTitle: displayTeamTitle(nextAgent.teamTitle, nextAgent.teamId, nextAgent.teamSource?.includes("hot") ? "规则内热门队伍" : "当前配队工坊队伍"),
        }
      : nextAgent;
    const displayReplays = (nextReplays.items || []).map((item: any) => ({
      ...item,
      teamTitle: displayTeamTitle(item.teamTitle, item.teamId, item.teamSource?.includes("hot") ? "规则内热门队伍" : "当前配队工坊队伍"),
    }));
    setAgent(displayAgent);
    setReplays(displayReplays);
    setModels(nextModels.items || []);
    setRatings(nextRatings.items || []);
    setAccount(nextAccount);
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
    const timer = window.setInterval(() => refresh().catch(() => undefined), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const activeRuleset = registry.active?.find((item: any) => item.battleType === (agent?.battleType || "double")) || registry.active?.[0];
  const startAgent = useCallback(async (options: any = {}) => {
    const format = options.format || activeRuleset?.battleType || "double";
    const rulesetId = options.rulesetId || activeRuleset?.rulesetId;
    return apiRequest("/api/agent/start", {
      method: "POST",
      body: JSON.stringify({
        format,
        rulesetId,
        teamText: options.teamText || teamToShowdown(team),
        games: options.games || 1,
        policy: options.policy || "structured",
        teamVersion: options.teamSource === "hot" ? `hot-${options.teamId || "random"}` : "forge-ui",
        teamSource: options.teamSource || "workbench",
        teamId: options.teamId || "",
        teamTitle: options.teamTitle || "",
        teamPool: options.teamPool || [],
        continuous: options.continuous === true,
        acknowledgeAutomationPolicy: true,
      }),
    });
  }, [activeRuleset, team]);

  const stopAgent = useCallback(() => apiRequest("/api/agent/stop", { method: "POST", body: "{}" }), []);
  const syncRules = useCallback(async () => {
    const next = await apiRequest("/api/rules/sync", { method: "POST" });
    setRegistry(next);
    return next;
  }, []);

  const value = useMemo(() => ({ team, setTeam, registry, history, agent, replays, models, ratings, account, refresh, startAgent, stopAgent, syncRules }), [team, setTeam, registry, history, agent, replays, models, ratings, account, refresh, startAgent, stopAgent, syncRules]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench() {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("useWorkbench must be used inside WorkbenchProvider");
  return value;
}
