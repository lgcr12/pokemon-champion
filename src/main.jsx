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

function Dashboard({ team, onNavigate, agentState, onToggleAgent, onOpenAccount }) {
  return <div className="page page-dashboard">
    <div className="hero-strip"><div><span className="eyebrow">ACTIVE WORKSPACE</span><h1>Champion Forge</h1><p>让每一次配队都能被验证，让每一场对战都能推动下一版。</p></div><div className="hero-rule"><span>当前规则快照</span><strong>Champions · VGC 2026 Reg M-B</strong><StatusPill icon={ShieldCheck}>LOCAL / ONLINE SYNCED</StatusPill></div></div>
    <div className="dashboard-grid">
      <section className="panel team-panel"><SectionHeader eyebrow="CURRENT TEAM" title="Rain Electro Burst" action={<button className="ghost-button" onClick={() => onNavigate("forge")}>打开工坊 <ChevronRight size={15} /></button>} /><TeamPreview team={team} onSelect={() => onNavigate("forge")} /><div className="team-route"><div className="route-head"><span>主胜利路线</span><strong>Drizzle <ChevronRight size={14} /> Electro Shot <ChevronRight size={14} /> 终盘收割</strong></div><div className="route-track"><span className="route-node node-water"><CloudRain size={15} /></span><span className="route-line line-water" /><span className="route-node node-blue"><Zap size={15} /></span><span className="route-line line-blue" /><span className="route-node node-red"><Target size={15} /></span></div><div className="route-foot"><span>备用路线：Fake Out + Tailwind</span><span className="mono">结构置信度 86%</span></div></div></section>
      <aside className="stack-column">
        <section className="panel agent-panel"><SectionHeader eyebrow="AGENT ENGINE" title="Champion v4.2.1" action={<StatusPill tone={agentState === "active" ? "green" : "muted"} icon={Bot}>{agentState === "active" ? "LADDERING" : "PAUSED"}</StatusPill>} /><div className="rating-line"><div><span>Glicko-2 rating</span><strong>1742 <small>±22</small></strong></div><div className="rating-up">+18 <small>7d</small></div></div><div className="progress-label"><span>训练批次</span><b>34 / 50</b></div><div className="progress"><span style={{ width: "68%" }} /></div><div className="agent-actions"><button className="primary-button" onClick={onToggleAgent}>{agentState === "active" ? <><Pause size={16} />暂停 Agent</> : <><Play size={16} />开始排位</>}</button><button className="icon-button" title="账号设置" aria-label="账号设置" onClick={onOpenAccount}><Lock size={17} /></button></div></section>
        <section className="panel compact-panel"><SectionHeader eyebrow="RECENT MATCHES" title="最近对局" action={<button className="icon-button" title="查看全部" aria-label="查看全部" onClick={() => onNavigate("replays")}><ChevronRight size={17} /></button>} /><div className="match-list"><MatchRow result="W" score="+14" opponent="Rain Mirror" rating="1682" /><MatchRow result="L" score="-12" opponent="VGC_Master_JP" rating="1668" /><MatchRow result="W" score="+16" opponent="CyberCynthia" rating="1680" /></div></section>
      </aside>
      <section className="panel metrics-panel"><SectionHeader eyebrow="LIVE COVERAGE" title="队伍结构指标" action={<span className="mono muted">UPDATED 2 MIN AGO</span>} /><div className="metric-grid"><Metric label="速度计划" value="A-" detail="Tailwind / Icy Wind" tone="yellow" icon={Gauge} /><Metric label="防守覆盖" value="86%" detail="16-type matrix" tone="blue" icon={ShieldCheck} /><Metric label="首发协同" value="4.2" detail="lead pairs" tone="green" icon={Users} /><Metric label="环境压力" value="B+" detail="12 meta threats" tone="red" icon={Target} /></div></section>
      <section className="panel evolution-panel"><SectionHeader eyebrow="MODEL EVOLUTION" title="Agent 正在学习什么" action={<button className="ghost-button" onClick={() => onNavigate("models")}>模型实验室 <ChevronRight size={15} /></button>} /><div className="evolution-body"><div className="sparkline"><svg viewBox="0 0 420 100" role="img" aria-label="最近七天排位分趋势"><path d="M4 82 C45 75 52 58 90 64 S130 45 164 55 S208 38 245 48 S290 22 330 31 S378 16 416 9" fill="none" stroke="currentColor" strokeWidth="3" /><path d="M4 82 C45 75 52 58 90 64 S130 45 164 55 S208 38 245 48 S290 22 330 31 S378 16 416 9 V100 H4Z" fill="currentColor" opacity=".08" /></svg><div className="sparkline-labels"><span>7 days ago</span><span>now</span></div></div><div className="learning-notes"><div><span className="dot dot-green" />改善：首发保护</div><div><span className="dot dot-yellow" />训练中：终盘路线</div><div><span className="dot dot-blue" />观察：空间反制</div></div></div></section>
    </div>
  </div>;
}

function MatchRow({ result, score, opponent, rating }) { return <div className="match-row"><span className={`result result-${result.toLowerCase()}`}>{result}</span><div><strong>{opponent}</strong><small>Showdown ladder · {rating}</small></div><b className={result === "W" ? "positive" : "negative"}>{score}</b></div>; }

function Forge({ team, setTeam, onNavigate }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(team[0]?.id);
  const [saveState, setSaveState] = useState("idle");
  const searchRef = useRef(null);
  const shown = candidates.filter((item) => `${item.name} ${item.role} ${item.meta}`.toLowerCase().includes(query.toLowerCase()));
  const toggleLock = (id) => setTeam((current) => current.map((member) => member.id === id ? { ...member, locked: !member.locked } : member));
  const validateAndSave = () => {
    setSaveState("saved");
    window.setTimeout(() => setSaveState("idle"), 1800);
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
  }, []);
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
  return <div className="page forge-page"><div className="page-title-row"><div><span className="eyebrow">TEAM FORGE</span><h1>配队工坊</h1><p>从体系和职责开始构筑，而不是从六个单体开始拼接。</p></div><div className="toolbar-actions"><button className="secondary-button"><RefreshCw size={16} />重新分析</button><button className="primary-button" onClick={validateAndSave}><Check size={16} />{saveState === "saved" ? "已校验保存" : "校验并保存"}</button></div></div><div className="sr-only" role="status" aria-live="polite">{saveState === "saved" ? "当前队伍已校验并保存" : ""}</div><div className="forge-layout">
    <aside className="panel candidate-panel"><SectionHeader eyebrow="CANDIDATE POOL" title="候选库" action={<StatusPill tone="blue">227 available</StatusPill>} /><label className="search-field"><Search size={16} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索宝可梦、职责或体系" /></label><div className="filter-row"><button className="filter-chip is-active">全部</button><button className="filter-chip">天气</button><button className="filter-chip">控速</button><button className="filter-chip">终盘</button></div><div className="candidate-list">{shown.map((candidate) => <button className="candidate-row" key={candidate.id} onClick={() => addCandidate(candidate)}><div className={`candidate-avatar tone-${candidate.tone}`}><Sprite id={candidate.sprite} size="sm" /></div><div><strong>{candidate.name}</strong><span>{candidate.role}</span></div><small>{candidate.meta}</small><Plus size={15} /></button>)}</div></aside>
    <main className="forge-main"><section className="panel workspace-panel"><SectionHeader eyebrow="TEAM WORKSPACE" title="Rain Electro Burst" action={<div className="team-health"><span className="dot dot-green" />结构健康 <b>86</b></div>} /><div className="slot-grid">{team.map((member, index) => <button key={`${member.id}-${index}`} className={`team-slot ${selected === member.id ? "is-selected" : ""}`} onClick={() => setSelected(member.id)} onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setSelected(member.id); toggleLock(member.id); } }} aria-pressed={member.locked} aria-label={`${member.name}，槽位 ${index + 1}，${member.locked ? "已锁定" : "未锁定"}`}><div className="slot-top"><span>SLOT {String(index + 1).padStart(2, "0")}</span>{member.locked ? <Lock size={13} /> : <span className="ai-badge">AI</span>}</div><div className={`slot-art tone-${member.tone}`}><Sprite id={member.sprite} /></div><div className="slot-body"><strong>{member.name}</strong><span>{member.role}</span><small>{member.ability} · {member.item}</small></div><div className="move-pills">{member.moves.map((move, moveIndex) => <span key={`${move}-${moveIndex}`}>{move}</span>)}</div></button>)}</div></section><TacticalFlow team={team} /></main>
    <aside className="panel analysis-panel"><SectionHeader eyebrow="STRUCTURAL ENGINE" title="实时分析" action={<Activity size={17} className="text-green" />} /><div className="analysis-block"><span className="analysis-label">主胜利路线</span><strong>天气启动 → 电光炮台</strong><p>Pelipper 创造雨天，Archaludon 用 Electro Shot 把天气回合转成输出压力。</p></div><div className="analysis-block"><span className="analysis-label">速度阶梯</span><div className="speed-ladder"><span><b>277</b> Flutter Mane</span><span><b>205</b> Archaludon</span><span><b>136</b> Pelipper</span></div></div><div className="analysis-block"><span className="analysis-label">防守覆盖</span><div className="coverage-grid">{["火", "水", "草", "电", "地面", "冰", "格斗", "妖精"].map((type, index) => <div key={type}><span>{type}</span><i className={index % 3 === 0 ? "weak" : index % 2 === 0 ? "resist" : "neutral"} /></div>)}</div></div><div className="warning-note"><AlertTriangle size={15} /><span>对手控速时保留 Whimsicott，不要过早暴露 Flutter Mane。</span></div></aside>
  </div></div>;
}

function TacticalFlow({ team }) { return <section className="panel flow-panel"><SectionHeader eyebrow="TACTICAL FLOW" title="队友联动" action={<span className="mono muted">LIVE ENGINE ANALYSIS</span>} /><div className="flow-canvas"><svg viewBox="0 0 900 180" preserveAspectRatio="none" aria-label="队伍联动关系"><path d="M110 90 C230 10 310 10 430 90" className="flow-line flow-water-line" /><path d="M430 90 C545 168 650 168 780 90" className="flow-line flow-yellow-line" /><path d="M110 90 C310 150 550 150 780 90" className="flow-line flow-green-line" /></svg><div className="flow-nodes">{team.slice(0, 4).map((member, index) => <div className="flow-node" key={member.id}><div className={`flow-avatar tone-${member.tone}`}><Sprite id={member.sprite} size="sm" /></div><span>{member.name}</span><small>{index === 0 ? "RAIN" : index === 1 ? "PAYOFF" : index === 2 ? "SPEED" : "CLOSER"}</small></div>)}</div></div><div className="flow-legend"><span><i className="legend-water" />天气</span><span><i className="legend-yellow" />速度</span><span><i className="legend-green" />安全上场</span></div></section>; }

function Arena({ agentState, onToggleAgent, onStop }) { const [turn, setTurn] = useState(3); useEffect(() => { if (agentState !== "active") return undefined; const timer = setInterval(() => setTurn((value) => value >= 6 ? 1 : value + 1), 2600); return () => clearInterval(timer); }, [agentState]); return <div className="page arena-page"><div className="page-title-row"><div><span className="eyebrow">AGENT ARENA</span><h1>实时竞技场</h1><p>只使用当前规则允许、当前回合可见的信息。</p></div><div className="toolbar-actions"><StatusPill tone={agentState === "active" ? "green" : "muted"} icon={agentState === "active" ? Activity : Pause}>{agentState === "active" ? "LIVE LADDER" : "PAUSED"}</StatusPill><button className="danger-button" onClick={onStop}><CircleStop size={16} />紧急停止</button></div></div><div className="arena-layout"><section className="panel battle-panel"><div className="battle-head"><div><span className="eyebrow">MATCH #8492041</span><h2>Champion v4.2.1 <span>vs</span> VGC_Master_JP</h2></div><div className="battle-meta"><span>TURN {turn}/6</span><span>VGC M-B</span></div></div><div className="battle-field"><BattleSide side="player" name="Champion Model" mons={[teamMember("archaludon"), teamMember("pelipper")]} /><div className="field-center"><div className="weather-mark"><CloudRain size={20} /> RAIN <b>3</b></div><div className="versus">VS</div><div className="terrain-mark">GRASSY TERRAIN <b>2</b></div></div><BattleSide side="opponent" name="VGC_Master_JP" mons={[teamMember("incineroar"), teamMember("rillaboom")]}/></div><div className="battle-actions"><button className="primary-button" onClick={onToggleAgent}>{agentState === "active" ? <><Pause size={16} />暂停 Agent</> : <><Play size={16} />继续对局</>}</button><button className="secondary-button"><History size={16} />保存日志</button></div></section><section className="panel decision-panel"><SectionHeader eyebrow="MCTS TELEMETRY" title="动作决策树" action={<StatusPill tone="blue">LEGAL ACTIONS</StatusPill>} /><Decision priority="01" selected title="Archaludon → Electro Shot" target="Incineroar" value="+12.4%" note="KO expected" /><Decision priority="02" title="Switch Pelipper → Incineroar" target="防守中转" value="+4.1%" note="Defensive pivot" /><Decision priority="03" title="Archaludon → Draco Meteor" target="Rillaboom" value="-2.8%" note="SpA drop penalty" /><div className="guardrail-box"><div><ShieldCheck size={16} /><strong>Agent Guardrails</strong></div><span>Daily battles <b>42 / 100</b></span><span>Hourly limit <b>8 / 15</b></span><span>WS latency <b>14ms</b></span></div></section></div></div>; }

function teamMember(id) { return initialTeam.find((item) => item.id === id) || candidates.find((item) => item.id === id) || initialTeam[0]; }
function BattleSide({ side, name, mons }) { return <div className={`battle-side side-${side}`}><div className="side-heading"><span>{name}</span><small>{side === "player" ? "RATING 1742" : "RATING 1750"}</small></div>{mons.map((mon) => <div className="active-mon" key={mon.id}><div className={`active-art tone-${mon.tone}`}><Sprite id={mon.sprite} size="sm" /></div><div><strong>{mon.name}</strong><div className="hp-line"><span style={{ width: mon.id === "incineroar" ? "62%" : "82%" }} /></div><small>{mon.id === "incineroar" ? "62% HP" : "82% HP"}</small></div></div>)}</div>; }
function Decision({ priority, selected, title, target, value, note }) { return <div className={`decision-row ${selected ? "is-selected" : ""}`}><span className="decision-priority">{priority}</span><div><strong>{title}</strong><span>{target} · {note}</span></div><b className={value.startsWith("-") ? "negative" : "positive"}>{value}</b></div>; }

function Replays() { return <div className="page"><div className="page-title-row"><div><span className="eyebrow">MATCHES & REPLAYS</span><h1>对局与回放</h1><p>从胜负之外，找到真正改变局势的回合。</p></div><button className="secondary-button"><Database size={16} />训练集管理</button></div><div className="replay-layout"><section className="panel replay-list-panel"><label className="search-field"><Search size={16} /><input placeholder="搜索对手、规则或版本" /></label><div className="replay-filters"><button className="filter-chip is-active">全部 20</button><button className="filter-chip">胜利 13</button><button className="filter-chip">失败 7</button></div>{[{r:"W",opp:"Rain Mirror",time:"2 min ago",score:"+14",tag:"关键回合 T3"},{r:"L",opp:"VGC_Master_JP",time:"18 min ago",score:"-12",tag:"首发不利"},{r:"W",opp:"CyberCynthia",time:"42 min ago",score:"+16",tag:"终盘收割"},{r:"L",opp:"TrickRoomLab",time:"1 hr ago",score:"-9",tag:"速度计划"}].map((item,index)=><button className={`replay-item ${index === 0 ? "is-selected" : ""}`} key={item.opp}><span className={`result result-${item.r.toLowerCase()}`}>{item.r}</span><div><strong>{item.opp}</strong><small>{item.time} · VGC M-B</small></div><span className={item.r === "W" ? "positive" : "negative"}>{item.score}</span><span className="replay-tag">{item.tag}</span></button>)}</section><section className="panel replay-detail"><div className="replay-detail-head"><div><span className="eyebrow">REPLAY #8492041</span><h2>Rain Mirror <StatusPill tone="green">WIN +14</StatusPill></h2></div><span className="mono muted">Champion v4.2.1</span></div><div className="prob-chart"><div className="chart-label">WIN PROBABILITY <strong>68.4%</strong></div><svg viewBox="0 0 700 190" preserveAspectRatio="none"><path d="M0 144 C80 130 100 148 155 118 S235 124 290 83 S360 92 420 66 S500 82 565 42 S650 48 700 24" fill="none" stroke="currentColor" strokeWidth="3" /><path d="M0 144 C80 130 100 148 155 118 S235 124 290 83 S360 92 420 66 S500 82 565 42 S650 48 700 24 V190 H0Z" fill="currentColor" opacity=".09" /></svg><div className="chart-axis"><span>T1</span><span>T2</span><span className="key-tick">T3 · KEY KO</span><span>T4</span><span>T5</span><span>T6</span></div></div><div className="replay-turn"><div><span className="eyebrow">TURN 3 · KEY TURN</span><h3>Electro Shot into Incineroar</h3><p>雨天强化带来 78% 伤害，击倒对方中转点，同时保留 Tailwind 作为备用速度路线。</p></div><div className="causality"><span className="cause positive"><Check size={14} />Rain boosted damage</span><span className="cause positive"><Check size={14} />Speed advantage</span><button className="secondary-button"><Plus size={15} />加入训练集</button></div></div><div className="boundary-note"><ShieldCheck size={15} />本局所有 Agent 动作仅基于 Team Preview 与已公开对战信息。</div></section></div></div>; }

function Rules() { const [drift, setDrift] = useState(false); return <div className="page"><div className="page-title-row"><div><span className="eyebrow">RULES & META</span><h1>规则与环境</h1><p>规则先于模型，当前快照先于历史经验。</p></div><button className="secondary-button"><RefreshCw size={16} />同步规则</button></div><section className={`drift-banner ${drift ? "is-drift" : ""}`}><div className="drift-icon">{drift ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}</div><div><strong>{drift ? "RULE DRIFT DETECTED" : "规则快照已同步"}</strong><p>{drift ? "本地引擎与官方格式存在差异，配队与排位已暂停。" : "Local Showdown engine matches the active official format."}</p></div><button className="ghost-button" onClick={() => setDrift((value) => !value)}>{drift ? "模拟恢复" : "查看快照"}<ChevronRight size={15} /></button></section><div className="rules-grid"><section className="panel"><SectionHeader eyebrow="ACTIVE SNAPSHOT" title="当前官方排位" /><div className="rule-card"><div className="rule-heading"><div className="rule-badge">VGC</div><div><strong>VGC 2026 Reg M-B</strong><span>gen9championsvgc2026regmb</span></div><StatusPill icon={Check}>RATED</StatusPill></div><div className="rule-tags"><span>Flat Rules</span><span>VGC Timer</span><span>Open Team Sheets</span></div><div className="rule-meta"><span>规则版本 <b>2026.03.18</b></span><span>同步于 <b>2 min ago</b></span></div></div></section><section className="panel"><SectionHeader eyebrow="META PULSE" title="环境信号" action={<span className="mono muted">LAST 7 DAYS</span>} /><div className="meta-bars"><div><span>Incineroar</span><i><b style={{ width: "74%" }} /></i><strong>74%</strong></div><div><span>Pelipper</span><i><b style={{ width: "52%" }} /></i><strong>52%</strong></div><div><span>Archaludon</span><i><b style={{ width: "38%" }} /></i><strong>38%</strong></div><div><span>Whimsicott</span><i><b style={{ width: "29%" }} /></i><strong>29%</strong></div></div></section></div></div>; }

function Models() { return <div className="page"><div className="page-title-row"><div><span className="eyebrow">MODEL LAB</span><h1>模型实验室</h1><p>让 Challenger 先证明自己，再进入生产环境。</p></div><button className="secondary-button"><GitBranch size={16} />版本树</button></div><div className="model-grid"><section className="panel model-card"><span className="eyebrow">CHAMPION</span><h2>v4.2.1-prod</h2><div className="model-rating"><strong>1742</strong><span>±22 Glicko-2</span></div><div className="model-stat"><span>固定测试集</span><b>64.2%</b></div><div className="model-stat"><span>当前状态</span><StatusPill icon={ShieldCheck}>ACTIVE</StatusPill></div></section><section className="panel benchmark-card"><SectionHeader eyebrow="BENCHMARK ARENA" title="Head-to-head" action={<span className="mono muted">100 MATCHES</span>} /><div className="benchmark-bars"><div><span>Champion</span><i><b style={{ width: "42%" }} /></i><strong>42%</strong></div><div><span>Challenger</span><i><b style={{ width: "58%" }} /></i><strong>58%</strong></div></div><div className="benchmark-note"><Trophy size={16} />Challenger 在固定测试池领先 8.4%</div></section><section className="panel model-card challenger"><span className="eyebrow">CHALLENGER</span><h2>v4.3.0-rc2</h2><div className="model-rating"><strong>1785</strong><span>±28 Glicko-2</span></div><div className="model-stat"><span>训练批次</span><b>34 / 50</b></div><button className="primary-button"><GitBranch size={16} />进入评估</button></section></div><section className="panel training-panel"><SectionHeader eyebrow="TRAINING BATCH" title="当前训练进度" action={<StatusPill tone="yellow">IN PROGRESS</StatusPill>} /><div className="training-progress"><div className="progress large"><span style={{ width: "68%" }} /></div><div className="training-numbers"><strong>34 / 50 matches</strong><span>Epoch 120 / 200</span><span>Policy loss 0.024</span><span>LR 0.0003</span></div></div><div className="version-tree"><div><span>v4.0.0</span><small>Baseline</small></div><ChevronRight /><div><span>v4.2.1</span><small>Active</small></div><ChevronRight /><div className="tree-current"><span>v4.3.0</span><small>Promote candidate</small></div></div></section></div>; }

function AccountWizard({ onClose }) { const [step, setStep] = useState(1); const steps = ["Identity", "Encryption", "Register", "Verification", "Auth"]; return <div className="modal-backdrop" role="presentation"><div className="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title"><button className="modal-close icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button><span className="eyebrow">SHOWDOWN ACCOUNT</span><h2 id="account-title">连接专用竞技账号</h2><p className="modal-intro">系统会自动准备账号资料。官方要求人机验证时，只需在官方页面完成一次验证。</p><div className="wizard-steps">{steps.map((item, index) => <div className={`wizard-step ${index + 1 <= step ? "is-done" : ""}`} key={item}><span>{index + 1 < step ? <Check size={13} /> : index + 1}</span><small>{item}</small></div>)}</div><div className="wizard-body">{step === 1 && <><label>用户名偏好<input placeholder="例如 ChampionForge" /></label><div className="suggestion-row"><span>可用候选</span><button>ChampionForge_27</button><button>ForgeAgent_04</button></div></>}{step === 2 && <div className="security-state"><Lock size={22} /><strong>凭据将由系统安全保存</strong><p>密码不会显示在日志、前端状态或普通设置页中。</p></div>}{step === 3 && <div className="security-state"><Bot size={22} /><strong>准备打开官方注册页面</strong><p>账号只用于 Champion Forge 的专用排位，不会批量创建。</p></div>}{step === 4 && <div className="verification-state"><AlertTriangle size={22} /><strong>等待官方人机验证</strong><p>请在官方 Showdown 页面完成验证。我们不会绕过或模拟验证码。</p><button className="secondary-button"><RefreshCw size={15} />重新检查状态</button></div>}{step === 5 && <div className="security-state success"><Check size={22} /><strong>账号已连接</strong><p>Champion Forge 可以开始进行规则校验和排位。</p></div>}</div><div className="modal-actions"><button className="ghost-button" onClick={step > 1 ? () => setStep(step - 1) : onClose}>{step > 1 ? "上一步" : "取消"}</button>{step < 5 ? <button className="primary-button" onClick={() => setStep(step + 1)}>{step === 4 ? "验证并继续" : "继续"}<ChevronRight size={15} /></button> : <button className="primary-button" onClick={onClose}><Check size={15} />完成</button>}</div></div></div>; }

function App() {
  const [page, setPage] = useState("dashboard");
  const [team, setTeam] = useState(initialTeam);
  const [agentState, setAgentState] = useState("paused");
  const [accountOpen, setAccountOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const stopAgent = () => {
    setAgentState("paused");
    setAnnouncement("Agent 已紧急停止");
  };
  const toggleAgent = () => setAgentState((value) => {
    const next = value === "active" ? "paused" : "active";
    setAnnouncement(next === "active" ? "Agent 已开始排位" : "Agent 已暂停");
    return next;
  });
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
    dashboard: <Dashboard team={team} onNavigate={setPage} agentState={agentState} onToggleAgent={toggleAgent} onOpenAccount={() => setAccountOpen(true)} />,
    forge: <Forge team={team} setTeam={setTeam} onNavigate={setPage} />,
    arena: <Arena agentState={agentState} onToggleAgent={toggleAgent} onStop={stopAgent} />,
    replays: <Replays />,
    rules: <Rules />,
    models: <Models />,
  }[page]), [agentState, page, team]);
  return <div className="app-shell"><div className="sr-only" aria-live="assertive">{announcement}</div><header className="topbar"><div className="brand"><div className="brand-mark"><span /></div><strong>Champion Forge</strong><span className="desktop-only brand-sub">Competitive Agent Workbench</span></div><div className="top-status"><StatusPill tone="blue" icon={BookOpen}>VGC 2026 Reg M-B</StatusPill><StatusPill icon={Activity}>WS 14ms</StatusPill><StatusPill tone={agentState === "active" ? "green" : "muted"} icon={Bot}>{agentState === "active" ? "Agent active" : "Agent paused"}</StatusPill></div><div className="top-actions"><button className="top-account" onClick={() => setAccountOpen(true)} aria-label="账号设置"><span className="account-avatar"><Bot size={15} /></span><span className="desktop-only">专用账号</span></button><button className="kill-switch" onClick={stopAgent} aria-label="紧急停止 Agent"><CircleStop size={15} /> <span className="desktop-only">KILL SWITCH</span><kbd>Ctrl ⇧ K</kbd></button><button className="mobile-menu icon-button" aria-label="打开菜单"><Menu size={19} /></button></div></header><div className="shell-body"><aside className="sidebar" aria-label="主导航"><div className="nav-group">{navItems.map(([id, label, Icon]) => <button key={id} className={`nav-item ${page === id ? "is-active" : ""}`} onClick={() => setPage(id)} aria-current={page === id ? "page" : undefined}><Icon size={18} /><span>{label}</span>{page === id && <i />}</button>)}</div><div className="sidebar-foot"><button className="nav-item" onClick={() => setAccountOpen(true)}><Settings size={18} /><span>设置</span></button><div className="sync-card"><div><span className="dot dot-green" />规则同步</div><strong>当前快照有效</strong><small>2 min ago</small></div></div></aside><main className="main-content">{content}</main></div>{accountOpen && <AccountWizard onClose={() => setAccountOpen(false)} />}</div>;
}

createRoot(document.getElementById("root")).render(<App />);
