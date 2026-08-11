import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Bot,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleStop,
  CloudRain,
  Database,
  ExternalLink,
  Gauge,
  GitBranch,
  History,
  LayoutDashboard,
  Lock,
  Menu,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Swords,
  Target,
  Trophy,
  Users,
  X,
  Zap,
} from "lucide-react";
import "./styles.css";

const SPRITE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork";

const initialTeam = [
  { id: "pelipper", name: "Pelipper", dex: "279", role: "天气启动", item: "Damp Rock", ability: "Drizzle", types: ["水", "飞行"], sprite: 279, locked: true, tone: "water", moves: ["Hurricane", "Tailwind", "Wide Guard", "Protect"] },
  { id: "archaludon", name: "Archaludon", dex: "1018", role: "主输出", item: "Assault Vest", ability: "Stamina", types: ["钢", "龙"], sprite: 1018, locked: false, tone: "steel", moves: ["Electro Shot", "Flash Cannon", "Draco Meteor", "Body Press"] },
  { id: "whimsicott", name: "Whimsicott", dex: "547", role: "速度控制", item: "Focus Sash", ability: "Prankster", types: ["草", "妖精"], sprite: 547, locked: false, tone: "grass", moves: ["Tailwind", "Encore", "Moonblast", "Protect"] },
  { id: "flutter-mane", name: "Flutter Mane", dex: "987", role: "高速收割", item: "Booster Energy", ability: "Protosynthesis", types: ["幽灵", "妖精"], sprite: 987, locked: false, tone: "ghost", moves: ["Moonblast", "Shadow Ball", "Icy Wind", "Protect"] },
  { id: "incineroar", name: "Incineroar", dex: "727", role: "安全中转", item: "Safety Goggles", ability: "Intimidate", types: ["火", "恶"], sprite: 727, locked: false, tone: "fire", moves: ["Fake Out", "Flare Blitz", "Parting Shot", "Protect"] },
  { id: "rillaboom", name: "Rillaboom", dex: "812", role: "备用路线", item: "Miracle Seed", ability: "Grassy Surge", types: ["草"], sprite: 812, locked: false, tone: "grass", moves: ["Fake Out", "Grassy Glide", "Wood Hammer", "Protect"] },
];

const candidates = [
  { id: "pelipper", name: "Pelipper", role: "天气启动", meta: "高使用率", sprite: 279, tone: "water" },
  { id: "archaludon", name: "Archaludon", role: "电光炮台", meta: "体系收益", sprite: 1018, tone: "steel" },
  { id: "flutter-mane", name: "Flutter Mane", role: "高速特攻", meta: "速度线", sprite: 987, tone: "ghost" },
  { id: "incineroar", name: "Incineroar", role: "击掌 / 威吓", meta: "安全回合", sprite: 727, tone: "fire" },
  { id: "amoonguss", name: "Amoonguss", role: "掩护辅助", meta: "空间收益", sprite: 591, tone: "grass" },
  { id: "dragonite", name: "Dragonite", role: "先制终盘", meta: "备用胜点", sprite: 149, tone: "dragon" },
  { id: "sneasler", name: "Sneasler", role: "高速压制", meta: "首发威胁", sprite: 903, tone: "poison" },
  { id: "kingambit", name: "Kingambit", role: "残局收割", meta: "终盘价值", sprite: 983, tone: "dark" },
];

const navItems = [
  ["dashboard", "总览", LayoutDashboard],
  ["forge", "配队工坊", Swords],
  ["arena", "Agent 竞技场", Zap],
  ["replays", "对局与回放", History],
  ["rules", "规则与环境", BookOpen],
  ["models", "模型实验室", BrainCircuit],
];

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `请求失败 (${response.status})`), { data, status: response.status });
  return data;
}

function teamToShowdown(team = []) {
  return team.map((member) => [
    `${member.name} @ ${member.item}`,
    `Ability: ${member.ability}`,
    "Level: 50",
    ...(member.moves || []).map((move) => `- ${move}`),
  ].join("\n")).join("\n\n");
}

function Sprite({ id, size = "md", muted = false }) {
  return <img className={`sprite sprite-${size}${muted ? " is-muted" : ""}`} src={`${SPRITE}/${id}.png`} alt="" loading="lazy" />;
}

function StatusPill({ tone = "green", children, icon: Icon }) {
  return <span className={`status-pill status-${tone}`}>{Icon && <Icon size={13} strokeWidth={2.5} />}{children}</span>;
}

function Metric({ label, value, detail, tone = "blue", icon: Icon }) {
  return <div className="metric-row"><div className={`metric-icon metric-${tone}`}>{Icon && <Icon size={16} />}</div><div className="metric-copy"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div></div>;
}

function SectionHeader({ eyebrow, title, action }) {
  return <div className="section-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{action}</div>;
}

function TeamPreview({ team, onSelect }) {
  return <div className="team-preview-grid">{team.map((member) => <button className="preview-member" key={member.id} onClick={() => onSelect?.(member)}><div className={`preview-sprite tone-${member.tone}`}><Sprite id={member.sprite} /></div><span>{member.name}</span><small>{member.role}</small></button>)}</div>;
}

function Dashboard({ team, onNavigate, agentState, onToggleAgent, onOpenAccount, registry }) {
  const [overview, setOverview] = useState({ agent: null, replays: [], models: [] });
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const [agent, replayData, modelData] = await Promise.all([
          apiRequest("/api/agent/status"),
          apiRequest("/api/agent/replays"),
          apiRequest("/api/agent/models"),
        ]);
        if (mounted) setOverview({ agent, replays: replayData.items || [], models: modelData.items || [] });
      } catch (requestError) {
        if (mounted) setError(requestError.message);
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  const activeRuleset = registry.active?.find((item) => item.battleType === "double") || registry.active?.[0];
  const replays = activeRuleset ? overview.replays.filter((item) => item.rulesetId === activeRuleset.rulesetId) : overview.replays;
  const totalGames = replays.reduce((sum, item) => sum + Number(item.games || 0), 0);
  const checkpointProgress = totalGames % 50;
  const modelRegistry = overview.models.find((item) => item.rulesetId === activeRuleset?.rulesetId);
  const champion = modelRegistry?.champion?.version || overview.agent?.policyVersion || "尚未建立";
  const challengers = modelRegistry?.challengers || [];
  const moveIds = team.flatMap((member) => member.moves || []).map((move) => move.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const countMoves = (names) => moveIds.filter((move) => names.includes(move)).length;
  const speedControl = countMoves(["tailwind", "icywind", "trickroom", "electroweb", "thunderwave"]);
  const protection = countMoves(["protect", "detect", "wideguard", "quickguard"]);
  const positioning = countMoves(["fakeout", "partingshot", "uturn", "voltswitch"]);
  const typeCount = new Set(team.flatMap((member) => member.types || [])).size;
  const running = ["RUNNING", "STARTING"].includes(overview.agent?.status) || agentState === "active";
  return <div className="page page-dashboard motion-fade-in">
    <div className="hero-strip stagger-item" style={{ "--stagger-idx": 0 }}><div><span className="eyebrow">ACTIVE WORKSPACE</span><h1>Champion Forge</h1><p>让每一次配队都能被验证，让每一场对战都能推动下一版。</p></div><div className="hero-rule"><span>当前规则快照</span><strong>{activeRuleset?.name?.replace(/^\[Gen \d+ Champions\]\s*/, "") || "等待规则同步"}</strong><StatusPill icon={ShieldCheck} tone={registry.canOperate ? "green" : "yellow"}>{registry.canOperate ? "LOCAL / ONLINE SYNCED" : registry.status}</StatusPill></div></div>
    <div className="dashboard-grid">
      <section className="panel team-panel"><SectionHeader eyebrow="CURRENT TEAM" title="Rain Electro Burst" action={<button className="ghost-button" onClick={() => onNavigate("forge")}>打开工坊 <ChevronRight size={15} /></button>} /><TeamPreview team={team} onSelect={() => onNavigate("forge")} /><div className="team-route"><div className="route-head"><span>主胜利路线</span><strong>Drizzle <ChevronRight size={14} /> Electro Shot <ChevronRight size={14} /> 终盘收割</strong></div><div className="route-track"><span className="route-node node-water"><CloudRain size={15} /></span><span className="route-line line-water" /><span className="route-node node-blue"><Zap size={15} /></span><span className="route-line line-blue" /><span className="route-node node-red"><Target size={15} /></span></div><div className="route-foot"><span>备用路线：Fake Out + Tailwind</span><span className="mono">{activeRuleset?.rulesetId || "NO RULESET"}</span></div></div></section>
      <aside className="stack-column">
        <section className="panel agent-panel"><SectionHeader eyebrow="AGENT ENGINE" title={champion} action={<StatusPill tone={running ? "green" : "muted"} icon={Bot}>{running ? <span className="agent-breath">LADDERING</span> : overview.agent?.status || "IDLE"}</StatusPill>} /><div className="rating-line"><div><span>当前会话</span><strong className="tabular-num">{overview.agent?.gamesFinished || 0} <small>/ {overview.agent?.gamesRequested || 0}</small></strong></div><div className="rating-up">{totalGames} <small>total</small></div></div><div className="progress-label"><span>下一个训练检查点</span><b className="tabular-num">{checkpointProgress} / 50</b></div><div className="progress"><span style={{ width: `${checkpointProgress * 2}%` }} /></div><div className="agent-actions"><button className="primary-button" onClick={onToggleAgent}>{running ? <><Pause size={16} />停止 Agent</> : <><Play size={16} />开始排位</>}</button><button className="icon-button" title="账号设置" aria-label="账号设置" onClick={onOpenAccount}><Lock size={17} /></button></div></section>
        <section className="panel compact-panel"><SectionHeader eyebrow="RECENT BATCHES" title="最近真实对局" action={<button className="icon-button" title="查看全部" aria-label="查看全部" onClick={() => onNavigate("replays")}><ChevronRight size={17} /></button>} /><div className="match-list">{replays.length ? replays.slice(0, 3).map((item, index) => <BatchRow item={item} key={`${item.finishedAt}-${index}`} />) : <div className="empty-state compact">{error || "尚无真实排位记录"}</div>}</div></section>
      </aside>
      <section className="panel metrics-panel"><SectionHeader eyebrow="LIVE COVERAGE" title="当前队伍可验证指标" action={<span className="mono muted">FROM TEAM SETS</span>} /><div className="metric-grid"><Metric label="控速招式" value={speedControl} detail="Tailwind / Icy Wind / TR" tone="yellow" icon={Gauge} /><Metric label="保护手段" value={protection} detail="Protect / Guard" tone="blue" icon={ShieldCheck} /><Metric label="转场工具" value={positioning} detail="Fake Out / pivot" tone="green" icon={Users} /><Metric label="属性数量" value={typeCount} detail={`${team.length} members`} tone="red" icon={Target} /></div></section>
      <section className="panel evolution-panel"><SectionHeader eyebrow="MODEL EVOLUTION" title="规则隔离训练状态" action={<button className="ghost-button" onClick={() => onNavigate("models")}>模型实验室 <ChevronRight size={15} /></button>} /><div className="evolution-body"><div className="model-state-summary"><span>Champion</span><strong>{champion}</strong><small>{activeRuleset?.rulesetId || "尚无激活规则"}</small></div><div className="learning-notes">{challengers.length ? challengers.slice(-3).reverse().map((item) => <div key={item.version}><span className={`dot ${item.status === "active" ? "dot-green" : "dot-yellow"}`} />{item.version}：{item.status}</div>) : <div><span className="dot dot-blue" />累计 50 场真实对局后创建 Challenger</div>}<div><span className={`dot ${overview.agent?.account?.status === "READY" ? "dot-green" : "dot-yellow"}`} />账号：{overview.agent?.account?.status || "UNKNOWN"}</div></div></div></section>
    </div>
  </div>;
}

function BatchRow({ item }) { const won = Number(item.wins || 0) >= Number(item.losses || 0); return <div className="match-row"><span className={`result ${won ? "result-w" : "result-l"}`}>{won ? "W" : "L"}</span><div><strong>{item.policyVersion || "unknown policy"}</strong><small>{item.finishedAt ? new Date(item.finishedAt).toLocaleString() : item.rulesetId}</small></div><b className={won ? "positive" : "negative"}>{item.wins || 0}-{item.losses || 0}</b></div>; }

function Forge({ team, setTeam, onNavigate }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(team[0]?.id);
  const [saveState, setSaveState] = useState("idle");
  const [validationMessage, setValidationMessage] = useState("");
  const searchRef = useRef(null);
  const shown = candidates.filter((item) => `${item.name} ${item.role} ${item.meta}`.toLowerCase().includes(query.toLowerCase()));
  const toggleLock = (id) => setTeam((current) => current.map((member) => member.id === id ? { ...member, locked: !member.locked } : member));
  const validateAndSave = async () => {
    setSaveState("validating");
    setValidationMessage("");
    try {
      const validation = await apiRequest("/api/validate-team", { method: "POST", body: JSON.stringify({ format: "double", text: teamToShowdown(team) }) });
      if (!validation.ok) throw new Error((validation.problems || []).join("；") || "队伍未通过当前规则校验。");
      setSaveState("saved");
      setValidationMessage(`已通过 ${validation.showdownFormatId} 校验，rulesetId: ${validation.rulesetId}`);
    } catch (error) {
      setSaveState("invalid");
      setValidationMessage(error.message);
    }
    window.setTimeout(() => setSaveState("idle"), 2400);
  };
  useEffect(() => {
    const handler = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        validateAndSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [team]);
  const addCandidate = (candidate) => {
    const next = { ...candidate, item: "待配置", ability: "待验证", types: [], locked: false, moves: ["待配置", "待配置", "待配置", "待配置"] };
    setTeam((current) => {
      if (current.some((item) => item.id === candidate.id)) return current;
      const selectedIndex = current.findIndex((item) => item.id === selected && !item.locked);
      const fallbackIndex = current.findLastIndex((item) => !item.locked);
      const targetIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;
      if (targetIndex < 0) return current;
      return current.map((item, index) => index === targetIndex ? next : item);
    });
    setSelected(candidate.id);
  };
  return <div className="page forge-page"><div className="page-title-row"><div><span className="eyebrow">TEAM FORGE</span><h1>配队工坊</h1><p>从体系和职责开始构筑，而不是从六个单体开始拼接。</p></div><div className="toolbar-actions"><button className="secondary-button"><RefreshCw size={16} />重新分析</button><button className="primary-button" onClick={validateAndSave} disabled={saveState === "validating"}><Check size={16} />{saveState === "validating" ? "校验中" : saveState === "saved" ? "已通过" : saveState === "invalid" ? "校验失败" : "校验并保存"}</button></div></div><div className="sr-only" role="status" aria-live="polite">{validationMessage}</div>{validationMessage && <div className={`boundary-note ${saveState === "invalid" ? "is-error" : ""}`}>{saveState === "invalid" ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}{validationMessage}</div>}<div className="forge-layout">
    <aside className="panel candidate-panel"><SectionHeader eyebrow="CANDIDATE POOL" title="候选库" action={<StatusPill tone="blue">227 available</StatusPill>} /><label className="search-field"><Search size={16} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索宝可梦、职责或体系" /></label><div className="filter-row"><button className="filter-chip is-active">全部</button><button className="filter-chip">天气</button><button className="filter-chip">控速</button><button className="filter-chip">终盘</button></div><div className="candidate-list">{shown.map((candidate) => <button className="candidate-row" key={candidate.id} onClick={() => addCandidate(candidate)}><div className={`candidate-avatar tone-${candidate.tone}`}><Sprite id={candidate.sprite} size="sm" /></div><div><strong>{candidate.name}</strong><span>{candidate.role}</span></div><small>{candidate.meta}</small><Plus size={15} /></button>)}</div></aside>
    <main className="forge-main"><section className="panel workspace-panel"><SectionHeader eyebrow="TEAM WORKSPACE" title="Rain Electro Burst" action={<div className="team-health"><span className="dot dot-green" />结构健康 <b>86</b></div>} /><div className="slot-grid">{team.map((member, index) => <button key={`${member.id}-${index}`} className={`team-slot ${selected === member.id ? "is-selected" : ""}`} onClick={() => setSelected(member.id)} onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setSelected(member.id); toggleLock(member.id); } }} aria-pressed={member.locked} aria-label={`${member.name}，槽位 ${index + 1}，${member.locked ? "已锁定" : "未锁定"}`}><div className="slot-top"><span>SLOT {String(index + 1).padStart(2, "0")}</span>{member.locked ? <Lock size={13} /> : <span className="ai-badge">AI</span>}</div><div className={`slot-art tone-${member.tone}`}><Sprite id={member.sprite} /></div><div className="slot-body"><strong>{member.name}</strong><span>{member.role}</span><small>{member.ability} · {member.item}</small></div><div className="move-pills">{member.moves.map((move, moveIndex) => <span key={`${move}-${moveIndex}`}>{move}</span>)}</div></button>)}</div></section><TacticalFlow team={team} /></main>
    <aside className="panel analysis-panel"><SectionHeader eyebrow="STRUCTURAL ENGINE" title="实时分析" action={<Activity size={17} className="text-green" />} /><div className="analysis-block"><span className="analysis-label">主胜利路线</span><strong>天气启动 → 电光炮台</strong><p>Pelipper 创造雨天，Archaludon 用 Electro Shot 把天气回合转成输出压力。</p></div><div className="analysis-block"><span className="analysis-label">速度阶梯</span><div className="speed-ladder"><span><b>277</b> Flutter Mane</span><span><b>205</b> Archaludon</span><span><b>136</b> Pelipper</span></div></div><div className="analysis-block"><span className="analysis-label">防守覆盖</span><div className="coverage-grid">{["火", "水", "草", "电", "地面", "冰", "格斗", "妖精"].map((type, index) => <div key={type}><span>{type}</span><i className={index % 3 === 0 ? "weak" : index % 2 === 0 ? "resist" : "neutral"} /></div>)}</div></div><div className="warning-note"><AlertTriangle size={15} /><span>对手控速时保留 Whimsicott，不要过早暴露 Flutter Mane。</span></div></aside>
  </div></div>;
}

function TacticalFlow({ team }) { return <section className="panel flow-panel"><SectionHeader eyebrow="TACTICAL FLOW" title="队友联动" action={<span className="mono muted">LIVE ENGINE ANALYSIS</span>} /><div className="flow-canvas"><svg viewBox="0 0 900 180" preserveAspectRatio="none" aria-label="队伍联动关系"><path d="M110 90 C230 10 310 10 430 90" className="flow-line flow-water-line" /><path d="M430 90 C545 168 650 168 780 90" className="flow-line flow-yellow-line" /><path d="M110 90 C310 150 550 150 780 90" className="flow-line flow-green-line" /></svg><div className="flow-nodes">{team.slice(0, 4).map((member, index) => <div className="flow-node" key={member.id}><div className={`flow-avatar tone-${member.tone}`}><Sprite id={member.sprite} size="sm" /></div><span>{member.name}</span><small>{index === 0 ? "RAIN" : index === 1 ? "PAYOFF" : index === 2 ? "SPEED" : "CLOSER"}</small></div>)}</div></div><div className="flow-legend"><span><i className="legend-water" />天气</span><span><i className="legend-yellow" />速度</span><span><i className="legend-green" />安全上场</span></div></section>; }

function Arena({ agentState, onToggleAgent, onStop }) {
  const [status, setStatus] = useState({ status: "IDLE", gamesFinished: 0, gamesRequested: 0 });
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => apiRequest("/api/agent/status").then(setStatus).catch((requestError) => setError(requestError.message));
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const running = status.status === "RUNNING" || agentState === "active";
  return <div className="page arena-page"><div className="page-title-row"><div><span className="eyebrow">AGENT ARENA</span><h1>Agent 控制台</h1><p>这里只显示 sidecar 的真实连接与对局状态。</p></div><div className="toolbar-actions"><StatusPill tone={running ? "green" : status.status === "FAILED" ? "yellow" : "muted"} icon={running ? Activity : Pause}>{status.status}</StatusPill><button className="danger-button" onClick={onStop}><CircleStop size={16} />紧急停止</button></div></div><div className="arena-layout"><section className="panel battle-panel"><SectionHeader eyebrow="LADDER SESSION" title={status.username || "尚未启动"} action={<span className="mono muted">{status.showdownFormatId || "NO CONNECTION"}</span>} /><div className="metric-grid"><Metric label="计划对局" value={status.gamesRequested || 0} tone="blue" icon={Swords} /><Metric label="已完成" value={status.gamesFinished || 0} tone="green" icon={Check} /><Metric label="胜利" value={status.wins || 0} tone="green" icon={Trophy} /><Metric label="失败" value={status.losses || 0} tone="red" icon={Target} /></div><div className="battle-actions"><button className="primary-button" onClick={onToggleAgent}>{running ? <><Pause size={16} />停止 Agent</> : <><Play size={16} />开始 1 场排位</>}</button></div>{(status.lastError || error) && <div className="boundary-note"><AlertTriangle size={15} />{status.lastError || error}</div>}</section><section className="panel decision-panel"><SectionHeader eyebrow="POLICY BOUNDARY" title={status.policyVersion || "策略未加载"} action={<StatusPill tone="blue">VISIBLE STATE ONLY</StatusPill>} /><div className="guardrail-box"><div><ShieldCheck size={16} /><strong>运行约束</strong></div><span>账号连接 <b>{status.account?.status || "UNKNOWN"}</b></span><span>规则状态 <b>{status.rules || "UNKNOWN"}</b></span><span>并发上限 <b>1</b></span><span>批次上限 <b>10</b></span></div><div className="boundary-note"><ShieldCheck size={15} />未运行对局时不会生成虚构决策树；真实 replay 在对局完成后保存。</div></section></div></div>;
}

function Replays() {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { apiRequest("/api/agent/replays").then((data) => { setItems(data.items || []); setSelected(data.items?.[0] || null); }).catch((requestError) => setError(requestError.message)); }, []);
  return <div className="page"><div className="page-title-row"><div><span className="eyebrow">MATCHES & REPLAYS</span><h1>对局与回放</h1><p>只展示 sidecar 实际完成并保存的对局批次。</p></div><StatusPill icon={Database} tone={items.length ? "green" : "muted"}>{items.length} BATCHES</StatusPill></div><div className="replay-layout"><section className="panel replay-list-panel">{items.length ? items.map((item, index) => <button className={`replay-item ${selected === item ? "is-selected" : ""}`} key={`${item.rulesetId}-${item.finishedAt}-${index}`} onClick={() => setSelected(item)}><span className={`result ${item.wins >= item.losses ? "result-w" : "result-l"}`}>{item.wins >= item.losses ? "W" : "L"}</span><div><strong>{item.policyVersion}</strong><small>{new Date(item.finishedAt).toLocaleString()} · {item.rulesetId}</small></div><span className={item.wins >= item.losses ? "positive" : "negative"}>{item.wins}-{item.losses}</span><span className="replay-tag">{item.games} games</span></button>) : <div className="empty-state">{error || "还没有真实排位批次。账号、规则和合法队伍就绪后才能产生记录。"}</div>}</section><section className="panel replay-detail">{selected ? <><div className="replay-detail-head"><div><span className="eyebrow">BATCH RESULT</span><h2>{selected.policyVersion} <StatusPill tone={selected.wins >= selected.losses ? "green" : "yellow"}>{selected.wins}W {selected.losses}L</StatusPill></h2></div><span className="mono muted">{selected.teamVersion}</span></div><div className="metric-grid"><Metric label="对局" value={selected.games} tone="blue" icon={Swords} /><Metric label="胜利" value={selected.wins} tone="green" icon={Trophy} /><Metric label="失败" value={selected.losses} tone="red" icon={Target} /><Metric label="平局" value={selected.ties} tone="yellow" icon={History} /></div><div className="boundary-note"><ShieldCheck size={15} />记录绑定 {selected.rulesetId}，不会进入其他规则版本的训练反馈。</div></> : <div className="empty-state">选择一个真实对局批次查看详情。</div>}</section></div></div>;
}

function Rules() {
  const [registry, setRegistry] = useState({ status: "LOADING", active: [], differences: [] });
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const load = async (sync = false) => {
    setSyncing(sync);
    setError("");
    try { setRegistry(await apiRequest(sync ? "/api/rules/sync" : "/api/rules/active", sync ? { method: "POST" } : {})); }
    catch (requestError) { setError(requestError.message); }
    finally { setSyncing(false); }
  };
  useEffect(() => { load(); }, []);
  const drift = registry.status !== "ACTIVE";
  return <div className="page"><div className="page-title-row"><div><span className="eyebrow">RULES & META</span><h1>规则与环境</h1><p>规则先于模型，当前快照先于历史经验。</p></div><button className="secondary-button" onClick={() => load(true)} disabled={syncing}><RefreshCw size={16} className={syncing ? "spin" : ""} />{syncing ? "同步中" : "同步规则"}</button></div><section className={`drift-banner ${drift ? "is-drift" : ""}`}><div className="drift-icon">{drift ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}</div><div><strong>{drift ? registry.status : "规则快照已同步"}</strong><p>{error || (drift ? "本地引擎与官方格式存在差异，配队与排位已暂停。" : "本地 Showdown 引擎与在线格式一致。")}</p></div><StatusPill tone={drift ? "yellow" : "green"}>{registry.canOperate ? "OPERATIONAL" : "BLOCKED"}</StatusPill></section><div className="rules-grid"><section className="panel"><SectionHeader eyebrow="ACTIVE SNAPSHOTS" title="当前官方排位" />{registry.active?.length ? registry.active.map((snapshot) => <div className="rule-card" key={snapshot.rulesetId}><div className="rule-heading"><div className="rule-badge">{snapshot.battleType === "double" ? "VGC" : "BSS"}</div><div><strong>{snapshot.name?.replace(/^\[Gen \d+ Champions\]\s*/, "")}</strong><span>{snapshot.showdownFormatId}</span></div><StatusPill icon={snapshot.status === "active" ? Check : AlertTriangle} tone={snapshot.status === "active" ? "green" : "yellow"}>{snapshot.status.toUpperCase()}</StatusPill></div><div className="rule-tags">{snapshot.rules?.map((rule) => <span key={rule}>{rule}</span>)}</div><div className="rule-meta"><span>rulesetId <b>{snapshot.rulesetId}</b></span><span>Reg <b>{snapshot.regulation}</b></span></div></div>) : <div className="empty-state">没有可用的官方 Champions 排位快照。</div>}</section><section className="panel"><SectionHeader eyebrow="DRIFT REPORT" title="规则差异" action={<span className="mono muted">{registry.lastSyncAt ? new Date(registry.lastSyncAt).toLocaleString() : "NOT SYNCED"}</span>} />{registry.differences?.length ? <div className="difference-list">{registry.differences.map((item, index) => <div className="boundary-note" key={`${item.formatId}-${index}`}><AlertTriangle size={15} />{item.formatId}: {item.type}</div>)}</div> : <div className="boundary-note"><ShieldCheck size={15} />在线格式、本地规则与合法池校验通过。</div>}</section></div></div>;
}

function Models() {
  const [registries, setRegistries] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => { apiRequest("/api/agent/models").then((data) => setRegistries(data.items || [])).catch((requestError) => setError(requestError.message)); }, []);
  return <div className="page"><div className="page-title-row"><div><span className="eyebrow">MODEL LAB</span><h1>模型实验室</h1><p>每个 rulesetId 独立保存 Champion、Challenger 与评测状态。</p></div><StatusPill icon={GitBranch} tone={registries.length ? "green" : "muted"}>{registries.length} REGISTRIES</StatusPill></div>{registries.length ? registries.map((registry) => <section className="panel training-panel" key={registry.rulesetId}><SectionHeader eyebrow={registry.rulesetId} title="Champion / Challenger" action={<StatusPill icon={ShieldCheck}>{registry.champion?.status?.toUpperCase()}</StatusPill>} /><div className="model-grid"><div className="model-card"><span className="eyebrow">CHAMPION</span><h2>{registry.champion?.version}</h2><div className="model-stat"><span>状态</span><b>{registry.champion?.status}</b></div></div>{registry.challengers?.length ? registry.challengers.map((item) => <div className="model-card challenger" key={item.version}><span className="eyebrow">CHALLENGER</span><h2>{item.version}</h2><div className="model-stat"><span>训练对局</span><b>{item.trainingGames}</b></div><div className="model-stat"><span>评测</span><StatusPill tone={item.status === "active" ? "green" : "yellow"}>{item.status}</StatusPill></div></div>) : <div className="empty-state">累计满 50 场后才会创建待评测 Challenger。</div>}</div></section>) : <section className="panel"><div className="empty-state">{error || "尚无模型注册表。完成真实对局批次后系统才会建立规则独立模型记录。"}</div></section>}</div>;
}

function AccountWizard({ onClose }) {
  const [account, setAccount] = useState({ status: "UNCONFIGURED", message: "正在读取账号状态。" });
  const [prefix, setPrefix] = useState("ChampionForge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    try { setAccount(await apiRequest("/api/agent/account/status")); }
    catch (requestError) { setError(requestError.message); }
  };
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const perform = async (path, options = {}) => {
    setBusy(true);
    setError("");
    try { setAccount(await apiRequest(path, options)); }
    catch (requestError) {
      setError(requestError.message);
      if (requestError.data?.candidates) setAccount((value) => ({ ...value, candidates: requestError.data.candidates }));
    } finally {
      setBusy(false);
    }
  };
  const statusIndex = { UNCONFIGURED: 1, CHECKING_NAME: 1, REGISTERING: 3, WAITING_FOR_HUMAN_VERIFICATION: 4, VERIFYING_ACCOUNT: 4, READY: 5, LOCKED: 5, FAILED: 3 }[account.status] || 1;
  const steps = ["Identity", "Encryption", "Register", "Verification", "Auth"];
  const waitingForHuman = account.status === "WAITING_FOR_HUMAN_VERIFICATION";
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <button className="modal-close icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <span className="eyebrow">SHOWDOWN ACCOUNT</span>
        <h2 id="account-title">连接专用竞技账号</h2>
        <p className="modal-intro">单工作区只配置一个账号；官方验证必须在 Showdown 页面由你本人完成。</p>
        <div className="wizard-steps">
          {steps.map((item, index) => <div className={`wizard-step ${index + 1 <= statusIndex ? "is-done" : ""}`} key={item}><span>{index + 1 < statusIndex ? <Check size={13} /> : index + 1}</span><small>{item}</small></div>)}
        </div>
        <div className="wizard-body">
          {account.status === "UNCONFIGURED" ? (
            <>
              <label>用户名偏好<input value={prefix} onChange={(event) => setPrefix(event.target.value)} maxLength={12} placeholder="例如 ChampionForge" /></label>
              <div className="security-state"><Lock size={22} /><strong>Windows DPAPI 加密保存</strong><p>明文密码不会返回前端、写入日志或进入 Git 文件。</p></div>
            </>
          ) : (
            <div className={`security-state ${account.status === "READY" ? "success" : ""}`}>
              {account.status === "READY" ? <Check size={22} /> : ["WAITING_FOR_HUMAN_VERIFICATION", "LOCKED", "FAILED"].includes(account.status) ? <AlertTriangle size={22} /> : <Bot size={22} />}
              <strong>{account.username || account.status}</strong>
              <p>{account.message}</p>
              {waitingForHuman && <div className="verification-hint"><span>1</span><p>在 Showdown 窗口完成当前宝可梦识别题</p><span>2</span><p>回到这里点击“已完成，验证并继续”</p></div>}
              <StatusPill tone={account.status === "READY" ? "green" : ["FAILED", "LOCKED"].includes(account.status) ? "yellow" : "blue"}>{account.status}</StatusPill>
            </div>
          )}
          {error && <div className="boundary-note"><AlertTriangle size={15} />{error}</div>}
        </div>
        <div className="modal-actions">
          <button className="ghost-button" onClick={onClose}>关闭</button>
          {account.status === "UNCONFIGURED" && <button className="primary-button" disabled={busy} onClick={() => perform("/api/agent/account/bootstrap", { method: "POST", body: JSON.stringify({ prefix }) })}><Bot size={15} />{busy ? "准备中" : "自动注册"}</button>}
          {waitingForHuman && <button className="secondary-button" disabled={busy} onClick={() => perform("/api/agent/account/focus", { method: "POST", body: "{}" })}><ExternalLink size={15} />打开验证窗口</button>}
          {["WAITING_FOR_HUMAN_VERIFICATION", "FAILED"].includes(account.status) && <button className="primary-button" disabled={busy} onClick={() => perform("/api/agent/account/continue", { method: "POST", body: "{}" })}><RefreshCw size={15} />已完成，验证并继续</button>}
          {account.status !== "UNCONFIGURED" && <button className="danger-button" disabled={busy} onClick={() => perform("/api/agent/account", { method: "DELETE" })}><X size={15} />删除本地凭据</button>}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [page, setPage] = useState("dashboard");
  const [team, setTeam] = useState(initialTeam);
  const [agentState, setAgentState] = useState("paused");
  const [registry, setRegistry] = useState({ status: "LOADING", active: [] });
  const [accountOpen, setAccountOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [isKilled, setIsKilled] = useState(false);
  const activeRuleset = registry.active?.find((item) => item.battleType === "double") || registry.active?.[0];
  const stopAgent = async () => {
    await apiRequest("/api/agent/stop", { method: "POST", body: "{}" }).catch(() => {});
    setAgentState("paused");
    setAnnouncement("Agent 已紧急停止");
    setIsKilled(true);
    window.setTimeout(() => setIsKilled(false), 220);
  };
  const toggleAgent = async () => {
    if (agentState === "active" || agentState === "starting") return stopAgent();
    setAgentState("starting");
    try {
      await apiRequest("/api/agent/start", { method: "POST", body: JSON.stringify({ format: activeRuleset?.battleType || "double", rulesetId: activeRuleset?.rulesetId, teamText: teamToShowdown(team), games: 1, teamVersion: "forge-ui", acknowledgeAutomationPolicy: true }) });
      setAgentState("active");
      setAnnouncement("Agent 已开始单连接排位");
    } catch (error) {
      setAgentState("paused");
      setAnnouncement(`Agent 未启动：${error.message}`);
      setAccountOpen(error.data?.code === "ACCOUNT_NOT_READY");
    }
  };
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const [rules, agent] = await Promise.all([apiRequest("/api/rules/active"), apiRequest("/api/agent/status")]);
        if (!mounted) return;
        setRegistry(rules);
        setAgentState(agent.status === "RUNNING" || agent.status === "STARTING" ? "active" : "paused");
      } catch {}
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const handler = (event) => {
      if (event.key.toLowerCase() === "k" && event.ctrlKey && event.shiftKey) {
        event.preventDefault();
        stopAgent();
        return;
      }
      if (event.key === "Escape" && accountOpen) {
        setAccountOpen(false);
        return;
      }
      if (event.altKey && /^[1-6]$/.test(event.key)) {
        event.preventDefault();
        setPage(navItems[Number(event.key) - 1][0]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [accountOpen]);
  const content = useMemo(() => ({
    dashboard: <Dashboard team={team} onNavigate={setPage} agentState={agentState} onToggleAgent={toggleAgent} onOpenAccount={() => setAccountOpen(true)} registry={registry} />,
    forge: <Forge team={team} setTeam={setTeam} onNavigate={setPage} />,
    arena: <Arena agentState={agentState} onToggleAgent={toggleAgent} onStop={stopAgent} />,
    replays: <Replays />,
    rules: <Rules />,
    models: <Models />,
  }[page]), [agentState, page, registry, team]);
  return <div className={`app-shell ${agentState === "paused" ? "agent-paused" : ""}`}><div className="app-bg-layer" aria-hidden="true" /><div className="sr-only" aria-live="assertive">{announcement}</div><header className="topbar"><div className="brand"><div className="brand-mark"><span /></div><strong>Champion Forge</strong><span className="desktop-only brand-sub">Competitive Agent Workbench</span></div><div className="top-status"><StatusPill tone={registry.status === "ACTIVE" ? "blue" : "yellow"} icon={BookOpen}>{activeRuleset?.name?.replace(/^\[Gen \d+ Champions\]\s*/, "") || registry.status}</StatusPill><StatusPill tone={registry.canOperate ? "green" : "yellow"} icon={Activity}>{registry.canOperate ? "RULES SYNCED" : "RULES BLOCKED"}</StatusPill><StatusPill tone={agentState === "active" ? "green" : "muted"} icon={Bot}>{agentState === "active" ? <span className="agent-breath">Agent active</span> : agentState === "starting" ? "Agent starting" : "Agent paused"}</StatusPill></div><div className="top-actions"><button className="top-account" onClick={() => setAccountOpen(true)} aria-label="账号设置"><span className="account-avatar"><Bot size={15} /></span><span className="desktop-only">专用账号</span></button><button className={`kill-switch ${isKilled ? "kill-flash" : ""}`} onClick={stopAgent} aria-label="紧急停止 Agent"><CircleStop size={15} /> <span className="desktop-only">KILL SWITCH</span><kbd>Ctrl ⇧ K</kbd></button><button className="mobile-menu icon-button" aria-label="打开菜单"><Menu size={19} /></button></div></header><div className="shell-body"><aside className="sidebar" aria-label="主导航"><div className="nav-group">{navItems.map(([id, label, Icon]) => <button key={id} className={`nav-item ${page === id ? "is-active" : ""}`} onClick={() => setPage(id)} aria-current={page === id ? "page" : undefined}><Icon size={18} /><span>{label}</span>{page === id && <i />}</button>)}</div><div className="sidebar-foot"><button className="nav-item" onClick={() => setAccountOpen(true)}><Settings size={18} /><span>设置</span></button><div className="sync-card"><div><span className={`dot ${registry.canOperate ? "dot-green" : "dot-yellow"}`} />规则同步</div><strong>{registry.canOperate ? "当前快照有效" : registry.status}</strong><small>{activeRuleset?.regulation || "等待同步"}</small></div></div></aside><main className="main-content">{content}</main></div>{accountOpen && <AccountWizard onClose={() => setAccountOpen(false)} />}</div>;
}

createRoot(document.getElementById("root")).render(<App />);
