import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
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
  Shuffle,
  Sparkles,
  Swords,
  Target,
  Trophy,
  Users,
  X,
  Zap,
} from "lucide-react";
import "./styles.css";
import zhHansTerms from "../data/zh-hans-terms.json";

const SPRITE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork";
const ZH_TERMS = {
  pokemon: {
    mawile: "大嘴娃", garchomp: "烈咬陆鲨", lucario: "路卡利欧", gengar: "耿鬼", mimikyu: "谜拟丘",
    rotom: "洛托姆", rotomheat: "加热洛托姆", rotomwash: "清洗洛托姆", hippowdon: "河马兽", greninja: "甲贺忍蛙",
    pelipper: "大嘴鸥", archaludon: "铝钢桥龙", sinistcha: "来悲粗茶", incineroar: "炽焰咆哮虎", basculegion: "幽尾玄鱼", venusaur: "妙蛙花",
  },
  moves: { protect: "守住", fakeout: "击掌奇袭", earthquake: "地震", closecombat: "近身战", shadowball: "暗影球", swordsdance: "剑舞", trickroom: "戏法空间", tailwind: "顺风", flamethrower: "喷射火焰", icebeam: "冰冻光束" },
  abilities: { intimidate: "威吓", disguise: "画皮", levitate: "飘浮", roughskin: "粗糙皮肤", innerfocus: "精神力", torrent: "激流", drizzle: "降雨" },
  items: { leftovers: "吃剩的东西", focussash: "气势披带", lifeorb: "生命宝珠", choiceband: "讲究头带", choicescarf: "讲究围巾", assaultvest: "突击背心" },
};

const NORMALIZED_ZH_TERMS = Object.fromEntries(
  Object.entries(zhHansTerms || {})
    .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))
    .map(([category, values]) => [category, Object.fromEntries(Object.entries(values).map(([key, value]) => [termKey(key), value]))]),
);

function termKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function localizedTerm(value, category) {
  const raw = String(value || "");
  if (!raw) return "";
  return NORMALIZED_ZH_TERMS[category]?.[termKey(raw)] || ZH_TERMS[category]?.[termKey(raw)] || raw;
}

function displayValue(value, fallback = "暂无") {
  if (value == null || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => displayValue(item, "")).filter(Boolean).join(" / ") || fallback;
  if (typeof value === "object") {
    const labels = { hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" };
    return Object.entries(value).map(([key, item]) => `${labels[key] || key} ${item}`).join(" / ") || fallback;
  }
  return String(value);
}

function spriteSlug(value) {
  const key = termKey(value);
  const forms = {
    rotomheat: "rotom-heat",
    rotomwash: "rotom-wash",
    rotomfrost: "rotom-frost",
    rotomfan: "rotom-fan",
    rotommow: "rotom-mow",
    ogerponwellspring: "ogerpon-wellspring",
    ogerponhearthflame: "ogerpon-hearthflame",
    ogerponcornerstone: "ogerpon-cornerstone",
    urshifurapidstrike: "urshifu-rapid-strike",
    urshifusinglestrike: "urshifu-single-strike",
  };
  return forms[key] || String(value || "unknown").toLowerCase().replace(/\s+/g, "-");
}

const initialTeam = [
  { id: "pelipper", name: "Pelipper", localizedName: "大嘴鸥", dex: "279", role: "天气启动 / 速度控制", item: "Focus Sash", itemLabel: "气势披带", ability: "Drizzle", abilityLabel: "降雨", stats: "H1/C32/S32", types: ["水", "飞行"], sprite: 279, locked: true, tone: "water", moves: ["Weather Ball", "Hurricane", "Tailwind", "Protect"], moveLabels: ["气象球", "暴风", "顺风", "守住"] },
  { id: "archaludon", name: "Archaludon", localizedName: "铝钢桥龙", dex: "1018", role: "雨天炮台", item: "Leftovers", itemLabel: "吃剩的东西", ability: "Stamina", abilityLabel: "持久力", stats: "H25/B3/C6/D25/S7", types: ["钢", "龙"], sprite: 1018, locked: false, tone: "steel", moves: ["Flash Cannon", "Dragon Pulse", "Electro Shot", "Protect"], moveLabels: ["加农光炮", "龙之波动", "电光束", "守住"] },
  { id: "sinistcha", name: "Sinistcha", localizedName: "来悲粗茶", dex: "1013", role: "空间启动 / 掩护辅助", item: "Colbur Berry", itemLabel: "刺耳果", ability: "Hospitality", abilityLabel: "款待", stats: "H32/B2/C1/D30/S1", types: ["草", "幽灵"], sprite: 1013, locked: false, tone: "grass", moves: ["Matcha Gotcha", "Trick Room", "Protect", "Rage Powder"], moveLabels: ["刷刷茶炮", "戏法空间", "守住", "愤怒粉"] },
  { id: "incineroar", name: "Incineroar", localizedName: "炽焰咆哮虎", dex: "727", role: "轮转辅助", item: "Chople Berry", itemLabel: "莲蒲果", ability: "Intimidate", abilityLabel: "威吓", stats: "H32/B11/D20/S3", types: ["火", "恶"], sprite: 727, locked: false, tone: "fire", moves: ["Flare Blitz", "Throat Chop", "Fake Out", "Parting Shot"], moveLabels: ["闪焰冲锋", "地狱突刺", "击掌奇袭", "抛下狠话"] },
  { id: "basculegion", name: "Basculegion", localizedName: "幽尾玄鱼", dex: "902", role: "高速终盘", item: "Choice Scarf", itemLabel: "讲究围巾", ability: "Adaptability", abilityLabel: "适应力", stats: "A32/B1/S32", types: ["水", "幽灵"], sprite: 902, locked: false, tone: "water", moves: ["Flip Turn", "Aqua Jet", "Wave Crash", "Last Respects"], moveLabels: ["快速折返", "水流喷射", "波动冲", "扫墓"] },
  { id: "venusaur", name: "Venusaur", localizedName: "妙蛙花", dex: "3", role: "Mega 耐久输出", item: "Venusaurite", itemLabel: "妙蛙花进化石", ability: "Chlorophyll", abilityLabel: "叶绿素", stats: "H32/B9/C10/D8/S7", types: ["草", "毒"], sprite: 3, locked: false, tone: "grass", moves: ["Sludge Bomb", "Leech Seed", "Earth Power", "Protect"], moveLabels: ["污泥炸弹", "寄生种子", "大地之力", "守住"] },
];

const navItems = [
  ["teamlab", "配队实验", Sparkles],
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

function championStatsToShowdown(value = "") {
  const aliases = { h: "HP", a: "Atk", b: "Def", c: "SpA", d: "SpD", s: "Spe" };
  const entries = [...String(value || "").matchAll(/(?:^|[\s/,])([habcds])\s*(\d{1,3})(?=$|[\s/,])/gi)];
  return entries.length ? entries.map((match) => `${match[2]} ${aliases[match[1].toLowerCase()]}`).join(" / ") : String(value || "").trim();
}

function teamToShowdown(team = []) {
  return team.map((member) => [
    `${member.species || member.name} @ ${member.item}`,
    `Ability: ${member.ability}`,
    "Level: 50",
    ...(member.stats ? [`EVs: ${championStatsToShowdown(member.stats)}`] : []),
    ...(member.nature ? [`${member.nature} Nature`] : []),
    ...(member.moves || []).map((move) => `- ${move}`),
  ].join("\n")).join("\n\n");
}

function Sprite({ id, size = "md", muted = false }) {
  const source = /^\d+$/.test(String(id || "")) ? `${SPRITE}/${id}.png` : `https://img.pokemondb.net/sprites/scarlet-violet/normal/${spriteSlug(id)}.png`;
  return <img className={`sprite sprite-${size}${muted ? " is-muted" : ""}`} src={source} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />;
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
  const [games, setGames] = useState(1);
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
    const timer = window.setInterval(refresh, 1000);
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
  const running = connectedAgentStatuses.has(overview.agent?.status) || agentState === "active";
  const sessionActive = running || pendingAgentStatuses.has(overview.agent?.status) || agentState === "starting";
  return <div className="page page-dashboard motion-fade-in">
    <div className="hero-strip stagger-item" style={{ "--stagger-idx": 0 }}><div><span className="eyebrow">ACTIVE WORKSPACE</span><h1>Champion Forge</h1><p>让每一次配队都能被验证，让每一场对战都能推动下一版。</p></div><div className="hero-rule"><span>当前规则快照</span><strong>{activeRuleset?.name?.replace(/^\[Gen \d+ Champions\]\s*/, "") || "等待规则同步"}</strong><StatusPill icon={ShieldCheck} tone={registry.canOperate ? "green" : "yellow"}>{registry.canOperate ? "LOCAL / ONLINE SYNCED" : registry.status}</StatusPill></div></div>
    <div className="dashboard-grid">
      <section className="panel team-panel"><SectionHeader eyebrow="CURRENT TEAM" title="Rain Electro Burst" action={<button className="ghost-button" onClick={() => onNavigate("forge")}>打开工坊 <ChevronRight size={15} /></button>} /><TeamPreview team={team} onSelect={() => onNavigate("forge")} /><div className="team-route"><div className="route-head"><span>主胜利路线</span><strong>Drizzle <ChevronRight size={14} /> Electro Shot <ChevronRight size={14} /> 终盘收割</strong></div><div className="route-track"><span className="route-node node-water"><CloudRain size={15} /></span><span className="route-line line-water" /><span className="route-node node-blue"><Zap size={15} /></span><span className="route-line line-blue" /><span className="route-node node-red"><Target size={15} /></span></div><div className="route-foot"><span>备用路线：Fake Out + Tailwind</span><span className="mono">{activeRuleset?.rulesetId || "NO RULESET"}</span></div></div></section>
      <aside className="stack-column">
        <section className="panel agent-panel"><SectionHeader eyebrow="AGENT ENGINE" title={champion} action={<StatusPill tone={running ? "green" : pendingAgentStatuses.has(overview.agent?.status) ? "blue" : "muted"} icon={Bot}>{running ? <span className="agent-breath">{overview.agent?.status}</span> : overview.agent?.status || "IDLE"}</StatusPill>} /><div className="rating-line"><div><span>当前会话</span><strong className="tabular-num">{overview.agent?.gamesFinished || 0} <small>/ {overview.agent?.gamesRequested || 0}</small></strong></div><div className="rating-up">{totalGames} <small>total</small></div></div><div className="progress-label"><span>下一个训练检查点</span><b className="tabular-num">{checkpointProgress} / 50</b></div><div className="progress"><span style={{ width: `${checkpointProgress * 2}%` }} /></div><div className="agent-actions"><label className="dashboard-games">场数<input type="number" min="1" max="10" value={games} onChange={(event) => setGames(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} disabled={sessionActive} /></label><button className="primary-button" onClick={() => onToggleAgent({ games })}>{sessionActive ? <><Pause size={16} />停止 Agent</> : <><Play size={16} />开始 {games} 场</>}</button><button className="icon-button" title="账号设置" aria-label="账号设置" onClick={onOpenAccount}><Lock size={17} /></button></div></section>
        <section className="panel compact-panel"><SectionHeader eyebrow="RECENT BATCHES" title="最近真实对局" action={<button className="icon-button" title="查看全部" aria-label="查看全部" onClick={() => onNavigate("replays")}><ChevronRight size={17} /></button>} /><div className="match-list">{replays.length ? replays.slice(0, 3).map((item, index) => <BatchRow item={item} key={`${item.finishedAt}-${index}`} />) : <div className="empty-state compact">{error || "尚无真实排位记录"}</div>}</div></section>
      </aside>
      <section className="panel metrics-panel"><SectionHeader eyebrow="LIVE COVERAGE" title="当前队伍可验证指标" action={<span className="mono muted">FROM TEAM SETS</span>} /><div className="metric-grid"><Metric label="控速招式" value={speedControl} detail="Tailwind / Icy Wind / TR" tone="yellow" icon={Gauge} /><Metric label="保护手段" value={protection} detail="Protect / Guard" tone="blue" icon={ShieldCheck} /><Metric label="转场工具" value={positioning} detail="Fake Out / pivot" tone="green" icon={Users} /><Metric label="属性数量" value={typeCount} detail={`${team.length} members`} tone="red" icon={Target} /></div></section>
      <section className="panel evolution-panel"><SectionHeader eyebrow="MODEL EVOLUTION" title="规则隔离训练状态" action={<button className="ghost-button" onClick={() => onNavigate("models")}>模型实验室 <ChevronRight size={15} /></button>} /><div className="evolution-body"><div className="model-state-summary"><span>Champion</span><strong>{champion}</strong><small>{activeRuleset?.rulesetId || "尚无激活规则"}</small></div><div className="learning-notes">{challengers.length ? challengers.slice(-3).reverse().map((item) => <div key={item.version}><span className={`dot ${item.status === "active" ? "dot-green" : "dot-yellow"}`} />{item.version}：{item.status}</div>) : <div><span className="dot dot-blue" />累计 50 场真实对局后创建 Challenger</div>}<div><span className={`dot ${overview.agent?.account?.status === "READY" ? "dot-green" : "dot-yellow"}`} />账号：{overview.agent?.account?.status || "UNKNOWN"}</div></div></div></section>
    </div>
  </div>;
}

function BatchRow({ item }) { const won = Number(item.wins || 0) >= Number(item.losses || 0); return <div className="match-row"><span className={`result ${won ? "result-w" : "result-l"}`}>{won ? "W" : "L"}</span><div><strong>{item.policyVersion || "unknown policy"}</strong><small>{item.finishedAt ? new Date(item.finishedAt).toLocaleString() : item.rulesetId}</small></div><b className={won ? "positive" : "negative"}>{item.wins || 0}-{item.losses || 0}</b></div>; }

function CandidateEntry({ candidate, expanded, onToggle, onAdd }) {
  return <article className={`candidate-entry ${expanded ? "is-expanded" : ""}`}>
    <button className="candidate-row" onClick={onToggle} aria-expanded={expanded}>
      <div className={`candidate-avatar tone-${candidate.types?.[0]?.toLowerCase() || "steel"}`}><Sprite id={candidate.sprite} size="sm" /></div>
      <div className="candidate-identity"><strong>{candidate.localizedName}<small>{candidate.name}</small></strong><span>{candidate.role}</span></div>
      <div className="candidate-count"><b>{candidate.sets?.length || 0}</b><small>套玩法</small></div>
      <ChevronDown size={15} />
    </button>
    {expanded && <div className="candidate-sets">{candidate.sets.map((set) => <div className="candidate-set" key={set.id}>
      <div className="candidate-set-head"><div><strong>{set.role}</strong><span>{set.source}{set.usageCount ? ` · ${set.usageCount} 份样本` : ""}</span></div><button className="candidate-set-add" onClick={() => onAdd(candidate, set)} title="使用这套配置" aria-label={`使用 ${candidate.localizedName} 的 ${set.role} 配置`}><Plus size={15} /></button></div>
      <div className="candidate-set-meta"><span><b>特性</b>{set.abilityLabel}</span><span><b>道具</b>{set.itemLabel}</span><span><b>性格</b>{set.natureLabel || "未记录"}</span></div>
      <div className="candidate-set-moves">{set.moveLabels.map((move, moveIndex) => <span key={`${set.id}-${moveIndex}`}>{move}</span>)}</div>
    </div>)}</div>}
  </article>;
}

function agentStartProblemSummary(problems = []) {
  const text = problems.join(" ");
  if (/exactly 0 Stat Points/i.test(text)) return "队伍中有成员缺少数值分配。";
  if (/does not exist in Gen|is banned|tagged .* banned/i.test(text)) return "队伍包含当前规则不可用的宝可梦、道具或形态。";
  if (/can't learn/i.test(text)) return "队伍包含当前规则下无法学习的招式。";
  if (/same item|Item Clause/i.test(text)) return "队伍违反道具重复限制。";
  return problems[0] || "请先在配队工坊通过规则校验。";
}

const connectedAgentStatuses = new Set(["SEARCHING", "BATTLE", "RUNNING"]);
const pendingAgentStatuses = new Set(["STARTING", "CONNECTING", "AUTHENTICATED"]);

function agentUiState(status = "") {
  if (connectedAgentStatuses.has(status)) return "active";
  if (pendingAgentStatuses.has(status)) return "starting";
  return "paused";
}

function Forge({ team, setTeam, onNavigate }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [candidateState, setCandidateState] = useState({ items: [], total: 0, poolTotal: 0, sourceTotal: 0, excludedTotal: 0, configurationTotal: 0, matchedConfigurationTotal: 0, hasMore: false, rulesetId: "", loading: true, error: "" });
  const [expandedCandidate, setExpandedCandidate] = useState("");
  const [selected, setSelected] = useState(team[0]?.id);
  const [saveState, setSaveState] = useState("idle");
  const [validationMessage, setValidationMessage] = useState("");
  const searchRef = useRef(null);
  const loadCandidates = async ({ append = false } = {}) => {
    const offset = append ? candidateState.items.length : 0;
    if (!append) setCandidateState((current) => ({ ...current, items: [], loading: true, error: "" }));
    else setCandidateState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const params = new URLSearchParams({ format: "double", query, category, offset: String(offset), limit: "24" });
      const data = await apiRequest(`/api/rules/candidates?${params}`);
      setCandidateState((current) => ({
        items: append ? [...current.items, ...(data.items || [])] : data.items || [],
        total: data.total || 0,
        poolTotal: data.poolTotal || 0,
        sourceTotal: data.sourceTotal || data.poolTotal || 0,
        excludedTotal: data.excludedTotal || 0,
        configurationTotal: data.configurationTotal || 0,
        matchedConfigurationTotal: data.matchedConfigurationTotal || 0,
        hasMore: Boolean(data.hasMore),
        rulesetId: data.rulesetId || "",
        loading: false,
        error: "",
      }));
    } catch (error) {
      setCandidateState((current) => ({ ...current, loading: false, error: error.message }));
    }
  };
  useEffect(() => {
    setExpandedCandidate("");
    const timer = window.setTimeout(() => loadCandidates(), 180);
    return () => window.clearTimeout(timer);
  }, [query, category]);
  const toggleLock = (id) => setTeam((current) => current.map((member) => member.id === id ? { ...member, locked: !member.locked } : member));
  const validateAndSave = async () => {
    setSaveState("validating");
    setValidationMessage("");
    try {
      const validation = await apiRequest("/api/validate-team", { method: "POST", body: JSON.stringify({ format: "double", rulesetId: candidateState.rulesetId, text: teamToShowdown(team) }) });
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
  const addCandidate = (candidate, set) => {
    const next = { id: candidate.id, name: candidate.name, species: candidate.teamSpecies || candidate.name, localizedName: candidate.localizedName, dex: candidate.dex, sprite: candidate.sprite, tone: candidate.types?.[0]?.toLowerCase() || "steel", types: candidate.typeLabels || candidate.types || [], role: set.role, item: set.item, itemLabel: set.itemLabel, ability: set.ability, abilityLabel: set.abilityLabel, nature: set.nature, natureLabel: set.natureLabel, stats: set.stats, locked: false, moves: set.moves, moveLabels: set.moveLabels, configurationId: set.id };
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
    <aside className="panel candidate-panel"><SectionHeader eyebrow="CANDIDATE POOL" title="候选库" action={<StatusPill tone="blue">{candidateState.poolTotal || "--"} / {candidateState.sourceTotal || "--"} 合法</StatusPill>} /><label className="search-field"><Search size={16} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索宝可梦、招式、特性或道具" /></label><div className="filter-row">{[["all", "全部"], ["weather", "天气"], ["speed", "控速"], ["trickroom", "空间"], ["support", "辅助"], ["offense", "输出"], ["endgame", "终盘"]].map(([value, label]) => <button key={value} className={`filter-chip ${category === value ? "is-active" : ""}`} onClick={() => setCategory(value)}>{label}</button>)}</div><div className="candidate-summary"><span><b>{candidateState.total}</b> 种 · <b>{candidateState.matchedConfigurationTotal}</b> 套玩法</span><small>{candidateState.rulesetId || "正在读取当前规则"}</small></div>{candidateState.excludedTotal > 0 && <div className="candidate-source-note">原始池 {candidateState.sourceTotal} 种，已剔除 {candidateState.excludedTotal} 个当前规则非法条目</div>}<div className="candidate-list">{candidateState.items.map((candidate) => <CandidateEntry candidate={candidate} expanded={expandedCandidate === candidate.id} onToggle={() => setExpandedCandidate((current) => current === candidate.id ? "" : candidate.id)} onAdd={addCandidate} key={candidate.id} />)}{candidateState.loading && <div className="candidate-state">正在读取当前规则候选...</div>}{!candidateState.loading && candidateState.error && <div className="candidate-state is-error">{candidateState.error}</div>}{!candidateState.loading && !candidateState.error && !candidateState.items.length && <div className="candidate-state">没有匹配的合法配置</div>}</div>{candidateState.hasMore && <button className="candidate-load-more" onClick={() => loadCandidates({ append: true })} disabled={candidateState.loading}>加载更多 <span>{candidateState.items.length} / {candidateState.total}</span></button>}</aside>
    <main className="forge-main"><section className="panel workspace-panel"><SectionHeader eyebrow="TEAM WORKSPACE" title="Rain Electro Burst" action={<div className="team-health"><span className="dot dot-green" />结构健康 <b>86</b></div>} /><div className="slot-grid">{team.map((member, index) => <button key={`${member.id}-${index}`} className={`team-slot ${selected === member.id ? "is-selected" : ""}`} onClick={() => setSelected(member.id)} onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setSelected(member.id); toggleLock(member.id); } }} aria-pressed={member.locked} aria-label={`${member.name}，槽位 ${index + 1}，${member.locked ? "已锁定" : "未锁定"}`}><div className="slot-top"><span>SLOT {String(index + 1).padStart(2, "0")}</span>{member.locked ? <Lock size={13} /> : <span className="ai-badge">AI</span>}</div><div className={`slot-art tone-${member.tone}`}><Sprite id={member.sprite} /></div><div className="slot-body"><strong>{member.localizedName || member.name}</strong><span>{member.role}</span><small>{member.abilityLabel || member.ability} · {member.itemLabel || member.item}</small></div><div className="move-pills">{member.moves.map((move, moveIndex) => <span key={`${move}-${moveIndex}`}>{member.moveLabels?.[moveIndex] || move}</span>)}</div></button>)}</div></section><TacticalFlow team={team} /></main>
    <aside className="panel analysis-panel"><SectionHeader eyebrow="STRUCTURAL ENGINE" title="实时分析" action={<Activity size={17} className="text-green" />} /><div className="analysis-block"><span className="analysis-label">主胜利路线</span><strong>天气启动 → 电光炮台</strong><p>Pelipper 创造雨天，Archaludon 用 Electro Shot 把天气回合转成输出压力。</p></div><div className="analysis-block"><span className="analysis-label">速度阶梯</span><div className="speed-ladder"><span><b>277</b> Flutter Mane</span><span><b>205</b> Archaludon</span><span><b>136</b> Pelipper</span></div></div><div className="analysis-block"><span className="analysis-label">防守覆盖</span><div className="coverage-grid">{["火", "水", "草", "电", "地面", "冰", "格斗", "妖精"].map((type, index) => <div key={type}><span>{type}</span><i className={index % 3 === 0 ? "weak" : index % 2 === 0 ? "resist" : "neutral"} /></div>)}</div></div><div className="warning-note"><AlertTriangle size={15} /><span>对手控速时保留 Whimsicott，不要过早暴露 Flutter Mane。</span></div></aside>
  </div></div>;
}

function TacticalFlow({ team }) { return <section className="panel flow-panel"><SectionHeader eyebrow="TACTICAL FLOW" title="队友联动" action={<span className="mono muted">LIVE ENGINE ANALYSIS</span>} /><div className="flow-canvas"><svg viewBox="0 0 900 180" preserveAspectRatio="none" aria-label="队伍联动关系"><path d="M110 90 C230 10 310 10 430 90" className="flow-line flow-water-line" /><path d="M430 90 C545 168 650 168 780 90" className="flow-line flow-yellow-line" /><path d="M110 90 C310 150 550 150 780 90" className="flow-line flow-green-line" /></svg><div className="flow-nodes">{team.slice(0, 4).map((member, index) => <div className="flow-node" key={member.id}><div className={`flow-avatar tone-${member.tone}`}><Sprite id={member.sprite} size="sm" /></div><span>{member.name}</span><small>{index === 0 ? "RAIN" : index === 1 ? "PAYOFF" : index === 2 ? "SPEED" : "CLOSER"}</small></div>)}</div></div><div className="flow-legend"><span><i className="legend-water" />天气</span><span><i className="legend-yellow" />速度</span><span><i className="legend-green" />安全上场</span></div></section>; }

function AgentLearningPanel({ format = "single", rulesetId = "" }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [activeRulesetId, setActiveRulesetId] = useState(rulesetId);

  useEffect(() => {
    setActiveRulesetId(rulesetId);
  }, [rulesetId]);

  const activeRulesetForFormat = async () => {
    const registry = await apiRequest("/api/rules/active");
    const snapshot = registry.active?.find((item) => item.battleType === format && item.status === "active") || registry.active?.find((item) => item.status === "active");
    if (!snapshot?.rulesetId) throw new Error("当前没有可用的激活规则，暂时无法分析真实对局。");
    setActiveRulesetId(snapshot.rulesetId);
    return snapshot.rulesetId;
  };

  const load = async (preferredRulesetId = activeRulesetId || rulesetId) => {
    if (!preferredRulesetId) return;
    try {
      const result = await apiRequest(`/api/agent/learning?format=${format}&rulesetId=${encodeURIComponent(preferredRulesetId)}`);
      if (!result.summary?.games && preferredRulesetId === rulesetId) {
        const modelData = await apiRequest("/api/agent/models").catch(() => ({ items: [] }));
        const historicalCandidates = (modelData.items || []).filter((item) => item.rulesetId && item.rulesetId !== preferredRulesetId && item.rulesetId.includes(format === "double" ? "double" : "single"));
        for (const candidate of historicalCandidates) {
          const historical = await apiRequest(`/api/agent/learning?format=${format}&rulesetId=${encodeURIComponent(candidate.rulesetId)}`).catch(() => null);
          if (historical?.summary?.games) {
            setActiveRulesetId(candidate.rulesetId);
            setData(historical);
            setError("");
            return;
          }
        }
      }
      setData(result);
      setError("");
    } catch (requestError) {
      if (requestError.data?.code === "RULESET_MISMATCH") {
        try {
          const nextRulesetId = await activeRulesetForFormat();
          setData(await apiRequest(`/api/agent/learning?format=${format}&rulesetId=${encodeURIComponent(nextRulesetId)}`));
          setError("");
          return;
        } catch (retryError) {
          setError(retryError.message);
          return;
        }
      }
      setError(requestError.message);
    }
  };
  useEffect(() => { load(rulesetId); }, [format, rulesetId]);
  const run = async (path) => {
    setBusy(path);
    setError("");
    try {
      let requestRulesetId = activeRulesetId || rulesetId;
      let result;
      try {
        result = await apiRequest(path, { method: "POST", body: JSON.stringify({ format, rulesetId: requestRulesetId }) });
      } catch (requestError) {
        if (requestError.data?.code !== "RULESET_MISMATCH") throw requestError;
        requestRulesetId = await activeRulesetForFormat();
        result = await apiRequest(path, { method: "POST", body: JSON.stringify({ format, rulesetId: requestRulesetId }) });
      }
      setActiveRulesetId(result.rulesetId || requestRulesetId);
      if (path.endsWith("evolve-team")) setData(result);
      else await load(result.rulesetId || requestRulesetId);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(""); }
  };
  const summary = data?.summary || {};
  const failures = summary.failures || [];
  return <section className="panel agent-learning-panel"><SectionHeader eyebrow="LEARNING LOOP" title={`${format === "single" ? "BSS 单打" : "VGC 双打"} · 排位数据与 Challenger`} action={<div className="learning-panel-status"><StatusPill icon={Database} tone={summary.games ? "green" : "muted"}>{summary.games || 0} GAMES</StatusPill>{data?.historical && <StatusPill tone="yellow">历史规则数据</StatusPill>}</div>} /><div className="learning-toolbar"><button className="secondary-button" onClick={() => run("/api/agent/analyze")} disabled={Boolean(busy)}><RefreshCw size={15} className={busy === "/api/agent/analyze" ? "spin" : ""} />{busy === "/api/agent/analyze" ? "分析中..." : data?.historical ? "重新分析历史对局" : "分析真实对局"}</button><button className="primary-button" onClick={() => run("/api/agent/evolve-team")} disabled={Boolean(busy) || Boolean(data?.historical)} title={data?.historical ? "历史规则数据只能复盘，不能生成当前规则 Challenger" : "生成当前规则 Challenger"}><GitBranch size={15} className={busy === "/api/agent/evolve-team" ? "spin" : ""} />{busy === "/api/agent/evolve-team" ? "生成中..." : data?.historical ? "历史数据不可生成" : "生成 Challenger"}</button></div>{data?.historical && <div className="boundary-note"><ShieldCheck size={15} />当前规则已更新，以下数据来自同格式的历史 rulesetId：{activeRulesetId}。可用于复盘和统计，不会混入当前规则排位。</div>}<div className="learning-summary"><Metric label="胜率" value={`${summary.winRate || 0}%`} tone="blue" icon={Trophy} /><Metric label="失败归因" value={failures.length} tone="red" icon={Target} /><Metric label="候选队伍" value={data?.candidates?.length || 0} tone="green" icon={Swords} /></div>{failures.length ? <div className="learning-failure-list">{failures.slice(0, 4).map((item) => <div className="learning-failure" key={item.code}><strong>{item.label}</strong><span>{item.count} 次 · {item.avoid}</span></div>)}</div> : <div className="empty-state compact">完成真实对局后，系统会从公开 trace 提取失败原因，再生成同一 rulesetId 下的候选队伍。</div>}{error && <div className="boundary-note is-error"><AlertTriangle size={15} />{error}</div>}</section>;
}

function LegacyArena({ agentState, onToggleAgent, onStop, registry }) {
  const [status, setStatus] = useState({ status: "IDLE", gamesFinished: 0, gamesRequested: 0 });
  const [error, setError] = useState("");
  const [games, setGames] = useState(1);
  const [policy, setPolicy] = useState("structured");
  const formats = registry?.active || [];
  const [formatId, setFormatId] = useState("");
  useEffect(() => {
    const refresh = () => apiRequest("/api/agent/status").then(setStatus).catch((requestError) => setError(requestError.message));
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const running = connectedAgentStatuses.has(status.status) || agentState === "active";
  const sessionActive = running || pendingAgentStatuses.has(status.status) || agentState === "starting";
  const statusTone = running ? "green" : pendingAgentStatuses.has(status.status) ? "blue" : status.status === "FAILED" ? "yellow" : "muted";
  const selectedFormat = formats.find((item) => item.rulesetId === formatId) || formats.find((item) => item.battleType === "double") || formats[0];
  useEffect(() => {
    if (policy === "laplace") {
      const single = formats.find((item) => item.battleType === "single");
      if (single) setFormatId(single.rulesetId);
    }
  }, [policy, formats]);
  return <div className="page arena-page"><div className="page-title-row"><div><span className="eyebrow">AGENT ARENA</span><h1>Agent 控制台</h1><p>这里只显示 sidecar 的真实连接与对局状态。</p></div><div className="toolbar-actions"><StatusPill tone={statusTone} icon={running ? Activity : Pause}>{status.status}</StatusPill><button className="danger-button" onClick={onStop}><CircleStop size={16} />紧急停止</button></div></div><div className="arena-layout"><section className="panel battle-panel"><SectionHeader eyebrow="LADDER SESSION" title={status.username || "尚未启动"} action={<span className="mono muted">{status.showdownFormatId || "NO CONNECTION"}</span>} /><div className="metric-grid"><Metric label="计划对局" value={status.gamesRequested || 0} tone="blue" icon={Swords} /><Metric label="已完成" value={status.gamesFinished || 0} tone="green" icon={Check} /><Metric label="胜利" value={status.wins || 0} tone="green" icon={Trophy} /><Metric label="失败" value={status.losses || 0} tone="red" icon={Target} /></div><div className="agent-config-row"><label>规则格式<select value={selectedFormat?.rulesetId || ""} onChange={(event) => setFormatId(event.target.value)} disabled={sessionActive}>{formats.map((item) => <option key={item.rulesetId} value={item.rulesetId}>{item.battleType === "single" ? "BSS 单打" : "VGC 双打"} · {item.regulation}</option>)}</select></label><label>对局数量<input type="number" min="1" max="10" value={games} onChange={(event) => setGames(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} disabled={sessionActive} /></label><label>策略<select value={policy} onChange={(event) => setPolicy(event.target.value)} disabled={sessionActive}><option value="structured">结构化策略</option><option value="laplace">Laplace 单打实验</option></select></label><span className="config-hint">单账号 · 单连接 · 当前批次最多 10 场</span></div><div className="battle-actions"><button className="primary-button" onClick={() => onToggleAgent({ games, policy, format: selectedFormat?.battleType, rulesetId: selectedFormat?.rulesetId })}>{sessionActive ? <><Pause size={16} />停止 Agent</> : <><Play size={16} />开始 {games} 场排位</>}</button></div>{status.policyFallback && <div className="boundary-note"><AlertTriangle size={15} />{status.policyFallback}</div>}{(status.lastError || error) && <div className="boundary-note"><AlertTriangle size={15} />{status.lastError || error}</div>}</section><section className="panel decision-panel"><SectionHeader eyebrow="POLICY BOUNDARY" title={status.policyVersion || "策略未加载"} action={<StatusPill tone="blue">VISIBLE STATE ONLY</StatusPill>} /><div className="guardrail-box"><div><ShieldCheck size={16} /><strong>运行约束</strong></div><span>Showdown 连接 <b>{status.connectionStatus || "DISCONNECTED"}</b></span><span>匹配状态 <b>{status.queueStatus || "IDLE"}</b></span><span>规则状态 <b>{status.rules || "UNKNOWN"}</b></span><span>并发上限 <b>1</b></span></div><div className="boundary-note"><ShieldCheck size={15} />只有完成身份验证并发出匹配请求后才显示 SEARCHING；真实 replay 在对局完成后保存。</div></section></div></div>;
}

function BattleBoard({ team = [], status = {}, selectedFormat }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [focusedId, setFocusedId] = useState(team[0]?.id || "");
  const dragRef = useRef({
    pointerId: null,
    element: null,
    pointerTarget: null,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
    width: 0,
    height: 0,
    pendingLeft: 0,
    pendingTop: 0,
    dragging: false,
    raf: 0,
  });
  const snapshot = status.battleSnapshot || {};
  const ownSnapshot = snapshot.own?.slots?.length ? snapshot.own.slots : (status.submittedTeam || []);
  const opponentSnapshot = snapshot.opponent?.slots || [];
  const mergeSnapshotTeam = (members, slots) => {
    if (!slots.length) return members;
    if (!members.length) return slots;
    return members.map((member) => {
      const key = String(member.name || member.species || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const slot = slots.find((item) => String(item.species || item.name || "").toLowerCase().replace(/[^a-z0-9]/g, "") === key);
      return slot ? { ...member, ...slot, name: member.name || slot.species || slot.name, id: member.id || slot.id } : member;
    });
  };
  const submittedTeam = Array.isArray(status.submittedTeam) ? status.submittedTeam : [];
  const battleSourceTeam = submittedTeam.length ? submittedTeam : (status.status === "BATTLE" || status.activeBattleId ? ownSnapshot : team);
  const battleTeam = mergeSnapshotTeam(battleSourceTeam, ownSnapshot);
  const focused = battleTeam.find((member) => member.id === focusedId) || battleTeam[0];
  const battleType = selectedFormat?.battleType || status.battleType || "double";
  const isBattle = status.status === "BATTLE";
  const isStale = status.battleHealth === "STALE";
  const publicCount = Math.min(6, opponentSnapshot.length || Number(status.opponentRevealedCount || status.revealedOpponentCount || 0));
  const hiddenCount = Math.max(0, 6 - publicCount);
  const boardState = isStale ? "STALE" : isBattle ? "LIVE" : status.status === "SEARCHING" ? "SEARCHING" : "IDLE";
  const focusName = focused?.localizedName || localizedTerm(focused?.name || focused?.species, "pokemon") || "未选择宝可梦";
  const focusMoves = focused?.moves || [];
  const battleSourceLabel = status.teamSource === "hot" ? (status.teamTitle || "规则内热门队伍") : "排位提交队伍";
  const displayName = (member) => member?.localizedName || localizedTerm(member?.name || member?.species, "pokemon") || member?.name || "未知宝可梦";
  const displayMove = (move, member, index) => member?.moveLabels?.[index] || localizedTerm(move, "moves") || move;
  const displayAbility = (member) => member?.abilityLabel || localizedTerm(member?.ability, "abilities") || member?.ability || "未知特性";
  const displayItem = (member) => member?.itemLabel || localizedTerm(member?.item, "items") || member?.item || "未公开道具";
  const displayStatus = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "已公开";
    if (raw.includes("fnt") || raw.includes("fainted")) return "已倒下";
    return ({ brn: "烧伤", par: "麻痹", slp: "睡眠", frz: "冰冻", psn: "中毒", tox: "剧毒" }[raw] || value);
  };

  useEffect(() => {
    if (battleTeam.length && !battleTeam.some((member) => member.id === focusedId)) setFocusedId(battleTeam[0].id);
  }, [battleTeam, focusedId]);

  useEffect(() => {
    const clampPosition = (left, top, width, height) => ({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, left)),
      top: Math.max(8, Math.min(window.innerHeight - height - 8, top)),
    });

    const flushPosition = () => {
      const drag = dragRef.current;
      drag.raf = 0;
      if (!drag.dragging) return;
      if (drag.element) {
        drag.element.style.left = `${drag.pendingLeft}px`;
        drag.element.style.top = `${drag.pendingTop}px`;
        drag.element.style.right = "auto";
        drag.element.style.bottom = "auto";
      }
    };

    const move = (event) => {
      const drag = dragRef.current;
      if (drag.pointerId == null || event.pointerId !== drag.pointerId) return;

      if (!drag.dragging) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (distance < 5) return;
        drag.dragging = true;
        setDragging(true);
        setPosition({ left: drag.startLeft, top: drag.startTop });
        document.body.classList.add("is-dragging-battle-board");
        try {
          drag.pointerTarget?.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture can fail when the browser cancels the pointer.
        }
      }

      const next = clampPosition(
        drag.startLeft + event.clientX - drag.startX,
        drag.startTop + event.clientY - drag.startY,
        drag.width,
        drag.height,
      );
      drag.pendingLeft = next.left;
      drag.pendingTop = next.top;
      if (!drag.raf) drag.raf = window.requestAnimationFrame(flushPosition);
    };

    const up = (event) => {
      const drag = dragRef.current;
      if (drag.pointerId == null || (event.pointerId != null && event.pointerId !== drag.pointerId)) return;
      if (drag.raf) window.cancelAnimationFrame(drag.raf);
      drag.raf = 0;
      if (drag.dragging) {
        if (drag.element) {
          drag.element.style.left = `${drag.pendingLeft}px`;
          drag.element.style.top = `${drag.pendingTop}px`;
          drag.element.style.right = "auto";
          drag.element.style.bottom = "auto";
        }
        setPosition({ left: drag.pendingLeft, top: drag.pendingTop });
      }
      try {
        if (drag.pointerTarget?.hasPointerCapture(drag.pointerId)) drag.pointerTarget.releasePointerCapture(drag.pointerId);
      } catch {
        // The pointer may already have been released by the browser.
      }
      dragRef.current = {
        pointerId: null,
        element: null,
        pointerTarget: null,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        width: 0,
        height: 0,
        pendingLeft: 0,
        pendingTop: 0,
        dragging: false,
        raf: 0,
      };
      setDragging(false);
      document.body.classList.remove("is-dragging-battle-board");
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (dragRef.current.raf) window.cancelAnimationFrame(dragRef.current.raf);
      document.body.classList.remove("is-dragging-battle-board");
    };
  }, []);

  const beginDrag = (event) => {
    if (event.target.closest("button")) return;
    const element = event.currentTarget.closest(".battle-board");
    if (!element) return;
    const rect = element.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      element,
      pointerTarget: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: rect.width,
      height: rect.height,
      pendingLeft: rect.left,
      pendingTop: rect.top,
      dragging: false,
      raf: 0,
    };
    event.preventDefault();
  };

  const panelStyle = position ? { left: `${position.left}px`, top: `${position.top}px`, right: "auto", bottom: "auto" } : undefined;
  const statusName = (value) => ({ brn: "烧伤", par: "麻痹", slp: "睡眠", frz: "冰冻", psn: "中毒", tox: "剧毒" }[String(value || "").toLowerCase()] || value);
  const spriteId = (member) => member?.sprite || member?.num || 0;
  const hpPercent = (member) => member?.hpFraction == null ? 100 : Math.round(Number(member.hpFraction) * 100);

  return <>
    {!open && <button type="button" className={`battle-ball-trigger board-state-${boardState.toLowerCase()}`} onClick={() => setOpen(true)} aria-label="Open battle board" title="Open battle board"><span /><i /><b>VS</b></button>}
    {open && createPortal(<section style={panelStyle} className={`battle-board board-state-${boardState.toLowerCase()} ${dragging ? "is-dragging" : ""}`} aria-label="Interactive battle board">
    <div className="battle-board-head" onPointerDown={beginDrag} title="拖动移动对战面板">
      <div><span className="eyebrow">对战面板</span><h2>实时对战视图</h2><p>本场使用：{battleSourceLabel} · 只显示 Showdown 已公开的信息。</p></div>
      <div className="battle-board-head-actions"><div className="battle-board-status"><span className="battle-board-live-dot" />{({ LIVE: "对战中", SEARCHING: "搜索中", STALE: "连接延迟", IDLE: "空闲" }[boardState] || boardState)}<small>{battleType === "single" ? "BSS 单打" : "VGC 双打"}</small></div><button type="button" className="battle-board-close" onClick={() => setOpen(false)} aria-label="关闭对战面板"><X size={17} /></button></div>
    </div>
    <div className="battle-board-field">
      <div className="battle-board-side battle-board-side-player">
        <div className="battle-side-label"><span>我方队伍</span><strong>{battleTeam.length || 0} 只</strong></div>
        <div className="battle-mon-grid">{battleTeam.map((member, index) => <button type="button" key={`${member.id}-${index}`} className={`battle-mon-card ${focused?.id === member.id ? "is-focused" : ""} ${member.active ? "is-active" : ""} ${member.fainted ? "is-fainted" : ""}`} onClick={() => setFocusedId(member.id)} aria-pressed={focused?.id === member.id} aria-label={`Focus ${member.name}`}>
          <span className="battle-slot-number">{String(index + 1).padStart(2, "0")}</span>
          <div className={`battle-mon-art tone-${member.tone}`}><Sprite id={spriteId(member)} size="sm" /></div>
          <strong>{displayName(member)}</strong><small>{member.role || "已提交配置"}</small>
          <i className="battle-hp-mini"><b style={{ width: `${hpPercent(member)}%` }} /></i>
        </button>)}</div>
      </div>
      <div className="battle-vs-core" aria-hidden="true"><i /><strong>VS</strong><span>{status.lastDecisionTurn ? `第 ${status.lastDecisionTurn} 回合` : "准备中"}</span></div>
      <div className="battle-board-side battle-board-side-opponent">
        <div className="battle-side-label"><span>对手队伍</span><strong>{publicCount ? `已公开 ${publicCount} / 6` : "尚未公开 0 / 6"}</strong></div>
        <div className="battle-unknown-grid">{Array.from({ length: 6 }, (_, index) => { const member = opponentSnapshot[index]; return <div className={`battle-unknown-slot ${member ? "is-public" : ""} ${member?.fainted ? "is-fainted" : ""}`} key={member?.id || index}>{member && <div className="battle-opponent-art"><Sprite id={spriteId(member) || member.slug} size="sm" /></div>}<span>{member ? displayName(member) : "未公开"}</span>{member && <><strong>{member.active ? "当前在场" : member.status ? displayStatus(member.status) : "已公开"}</strong><i className="battle-hp-mini"><b style={{ width: `${hpPercent(member)}%` }} /></i></>}<em /></div>; })}</div>
        <div className="battle-public-note"><ShieldCheck size={15} /><span>{publicCount ? `Showdown 已公开 ${publicCount} 只，${hiddenCount} 个位置仍未公开` : "等待 Showdown 公开对手信息"}</span></div>
      </div>
    </div>
    <div className="battle-mon-focus">
      <div className="battle-focus-art"><Sprite id={spriteId(focused) || spriteId(battleTeam[0])} size="lg" /></div>
      <div className="battle-focus-copy"><span className="eyebrow">当前焦点</span><h3>{focusName}</h3><p>{displayValue(focused?.role, "点击我方宝可梦查看本场配置。")}</p><div className="battle-focus-meta"><span>{displayItem(focused)}</span><span>{displayAbility(focused)}</span><span>{displayValue(focused?.stats, "未公开配招数值")}</span></div></div>
      <div className="battle-move-list"><span className="eyebrow">招式配置</span><div>{focusMoves.length ? focusMoves.map((move, index) => <span key={`${move}-${index}`}>{displayMove(move, focused, index)}</span>) : <em>暂无招式信息</em>}</div></div>
    </div>
    <div className="battle-status-line"><span className="battle-status-marker" /><strong>{isStale ? "连接延迟，等待服务器响应" : isBattle ? "Agent 正在读取实时对战" : status.status === "SEARCHING" ? "正在搜索合法对手" : "等待下一场对战"}</strong><span className="battle-field-effects">{snapshot.weather ? `天气：${snapshot.weather}` : "天气：无"} · {snapshot.terrain ? `场地：${snapshot.terrain}` : "场地：无"}</span><span className="mono">{status.activeBattleId || "暂无对局"}</span><span className="battle-last-action">{status.lastSentMessage ? `最近动作：${status.lastSentMessage}` : "尚未提交动作"}</span></div>
    </section>, document.body)}
  </>;
}

function ArenaCommandCenter({ team, agentState, onToggleAgent, onStop, registry }) {
  const [status, setStatus] = useState({ status: "IDLE", gamesFinished: 0, gamesRequested: 0 });
  const [error, setError] = useState("");
  const [games, setGames] = useState(1);
  const [policy, setPolicy] = useState("structured");
  const [teamMode, setTeamMode] = useState("workbench");
  const [hotTeams, setHotTeams] = useState([]);
  const [hotPoolTotal, setHotPoolTotal] = useState(0);
  const [hotTeam, setHotTeam] = useState(null);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotError, setHotError] = useState("");
  const formats = registry?.active || [];
  const [formatId, setFormatId] = useState("");

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const next = await apiRequest("/api/agent/status");
        if (mounted) { setStatus(next); setError(""); }
      } catch (requestError) {
        if (mounted) setError(requestError.message);
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  const running = connectedAgentStatuses.has(status.status) || agentState === "active";
  const sessionActive = running || pendingAgentStatuses.has(status.status) || agentState === "starting";
  const selectedFormat = formats.find((item) => item.rulesetId === formatId) || formats.find((item) => item.battleType === "double") || formats[0];
  const health = status.battleHealth || (status.status === "BATTLE" ? "ACTIVE" : status.status);
  const statusLabel = { CONNECTING: "连接中", AUTHENTICATED: "已登录", SEARCHING: "搜索对手", BATTLE: "对战中", STOPPED: "已停止", COMPLETE: "批次完成", FAILED: "连接失败", IDLE: "空闲" }[status.status] || status.status || "未知";
  const healthLabel = health === "STALE" ? "等待服务器响应" : health === "ACTIVE" ? "实时运行" : statusLabel;
  const statusTone = health === "STALE" ? "yellow" : running ? "green" : pendingAgentStatuses.has(status.status) ? "blue" : status.status === "FAILED" ? "yellow" : "muted";
  const progress = status.gamesRequested ? Math.min(100, Math.round((Number(status.gamesFinished || 0) / Number(status.gamesRequested)) * 100)) : 0;
  const lastActivity = status.lastActivityAt ? new Date(status.lastActivityAt).toLocaleTimeString() : "暂无";

  useEffect(() => {
    if (policy === "laplace") {
      const single = formats.find((item) => item.battleType === "single");
      if (single) setFormatId(single.rulesetId);
    }
  }, [policy, formats]);

  const loadHotTeams = async () => {
    if (!selectedFormat?.rulesetId) return;
    setHotLoading(true);
    setHotError("");
    try {
      const data = await apiRequest(`/api/agent/hot-teams?format=${selectedFormat.battleType}&rulesetId=${encodeURIComponent(selectedFormat.rulesetId)}&limit=120`);
      setHotTeams(data.items || []);
      setHotPoolTotal(Number(data.total || data.items?.length || 0));
      setHotTeam(data.selected || data.items?.[0] || null);
    } catch (requestError) {
      setHotError(requestError.message);
      setHotTeams([]);
      setHotPoolTotal(0);
      setHotTeam(null);
    } finally {
      setHotLoading(false);
    }
  };

  useEffect(() => { if (teamMode === "hot") loadHotTeams(); }, [teamMode, selectedFormat?.rulesetId]);

  const rerollHotTeam = () => {
    if (!hotTeams.length) return loadHotTeams();
    const choices = hotTeams.filter((item) => item.id !== hotTeam?.id);
    const pool = choices.length ? choices : hotTeams;
    setHotTeam(pool[Math.floor(Math.random() * pool.length)]);
  };
  const selectedTeamText = teamMode === "hot" ? hotTeam?.teamText || "" : "";
  const selectedTeamLabel = teamMode === "hot" ? hotTeam?.title || "规则内热门队伍" : "当前配队工坊队伍";
  const route = [
    ["身份", status.connectionStatus || "DISCONNECTED", ["AUTHENTICATED", "CONNECTED"].includes(status.connectionStatus)],
    ["匹配", status.queueStatus || "IDLE", ["SEARCH_SENT", "SEARCH_CONFIRMED"].includes(status.queueStatus)],
    ["对局", status.activeBattleId ? "LIVE" : status.status === "BATTLE" ? "WAITING" : "IDLE", status.status === "BATTLE"],
  ];
  const signalItems = [
    { icon: Activity, label: status.lastServerEvent || "等待 Showdown 事件", value: lastActivity, tone: health === "STALE" ? "yellow" : "green" },
    { icon: Zap, label: status.lastSentMessage ? `最近动作 ${status.lastSentMessage}` : "尚未发送动作", value: `${status.decisionCount || 0} decisions`, tone: "blue" },
    { icon: Database, label: `${status.requestCount || 0} requests / ${status.turnEventCount || 0} turns`, value: status.activeBattleId || "无活动对局", tone: "muted" },
  ];

  return <div className={`page arena-page arena-command-page arena-health-${String(health).toLowerCase()} motion-fade-in`}>
    <BattleBoard team={team} status={status} selectedFormat={selectedFormat} />
    <header className="arena-command-hero"><div className="arena-hero-copy"><div className="arena-kicker"><span className="arena-live-dot" />AGENT OPERATIONS <span>/</span> SHOWDOWN LADDER</div><h1>竞技场控制台</h1><p>从队伍来源到实时事件，都在同一个可追踪的操作面内完成。</p></div><div className="arena-hero-status"><div className="arena-status-orbit"><span /><span /><span /></div><div><span>当前状态</span><strong>{healthLabel}</strong><small>{status.lastServerEvent || "等待连接事件"}</small></div></div></header>

    <div className="arena-summary-strip"><div className="arena-summary-main"><span className="eyebrow">LADDER SESSION</span><strong>{status.username || "专用账号尚未启动"}</strong><small>{status.showdownFormatId || "NO FORMAT SELECTED"} · {status.rulesetId || "等待规则快照"}</small></div><div className="arena-summary-stat"><span>完成进度</span><strong>{status.gamesFinished || 0}<em>/{status.gamesRequested || 0}</em></strong><i><b style={{ width: `${progress}%` }} /></i></div><div className="arena-summary-stat"><span>战绩</span><strong>{status.wins || 0}<em>W</em> <b>{status.losses || 0}<em>L</em></b></strong><small>{status.ties || 0} ties</small></div><div className="arena-summary-stat"><span>最近活动</span><strong>{lastActivity}</strong><small>{status.activeBattleId ? "battle active" : "no active battle"}</small></div></div>

    <div className="arena-command-grid"><section className="arena-command-surface"><div className="arena-surface-head"><div><span className="eyebrow">MISSION CONTROL</span><h2>启动一批排位对局</h2><p>规则、策略和队伍在提交前固定，运行中不可切换。</p></div><StatusPill tone={statusTone} icon={health === "STALE" ? AlertTriangle : running ? Activity : Pause}>{healthLabel}</StatusPill></div><div className="arena-route-rail">{route.map(([label, value, active], index) => <div className={`arena-route-step ${active ? "is-active" : ""} ${index < route.length - 1 ? "has-link" : ""}`} key={label}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{label}</strong><small>{value}</small></div></div>)}</div><div className="arena-form-grid"><label><span>规则格式</span><select value={selectedFormat?.rulesetId || ""} onChange={(event) => setFormatId(event.target.value)} disabled={sessionActive}>{formats.map((item) => <option key={item.rulesetId} value={item.rulesetId}>{item.battleType === "single" ? "BSS 单打" : "VGC 双打"} · {item.regulation}</option>)}</select></label><label><span>对局数量</span><input type="number" min="1" max="10" value={games} onChange={(event) => setGames(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} disabled={sessionActive} /></label><label><span>策略引擎</span><select value={policy} onChange={(event) => setPolicy(event.target.value)} disabled={sessionActive}><option value="structured">结构化策略</option><option value="laplace">Laplace 单打实验</option></select></label></div><div className="arena-team-source"><div className="arena-source-head"><div><span className="eyebrow">TEAM SOURCE</span><strong>{selectedTeamLabel}</strong></div><span className="arena-source-id">{teamMode === "hot" ? hotTeam?.id || "WAITING" : "FORGE WORKSPACE"}</span></div><div className="arena-segmented"><button className={teamMode === "workbench" ? "is-active" : ""} onClick={() => setTeamMode("workbench")} disabled={sessionActive}><Swords size={15} />当前配队</button><button className={teamMode === "hot" ? "is-active" : ""} onClick={() => setTeamMode("hot")} disabled={sessionActive}><Sparkles size={15} />热门随机</button></div>{teamMode === "hot" && <div className="arena-hot-preview"><div className="arena-hot-heading"><div><strong>{hotTeam?.title || (hotLoading ? "正在抽取队伍" : "暂无队伍")}</strong><small>{hotTeam ? `${hotTeam.source} · ${hotTeam.sourceSeason} · ${hotTeam.rate ? `${hotTeam.rate}% 使用率` : `排名 #${hotTeam.rank || "-"}`}` : "仅展示通过当前 rulesetId 校验的完整队伍"}</small></div><button className="icon-text-button" onClick={rerollHotTeam} disabled={hotLoading || sessionActive}><Shuffle size={15} />重新抽取</button></div>{hotTeam?.members?.length ? <div className="arena-hot-members">{hotTeam.members.map((member) => <div key={`${hotTeam.id}-${member.slug}`}><div>{member.sprite ? <Sprite id={member.sprite} size="sm" /> : <Sparkles size={16} />}</div><span>{member.name}</span></div>)}</div> : <div className="arena-hot-empty">{hotError || (hotLoading ? "正在验证当前规则下的完整队伍..." : "暂无通过当前规则校验的热门队伍")}</div>}<small className={`arena-hot-footnote ${hotTeam?.seasonMatched ? "is-current" : ""}`}>{hotTeam?.seasonMatched ? `数据赛季匹配 ${selectedFormat?.regulation}` : `数据源 ${hotTeam?.sourceSeason || "未知"}，已按 ${selectedFormat?.regulation} 重新校验`}</small></div>}</div><div className="arena-command-footer"><div><span>本次提交队伍</span><strong>{selectedTeamLabel}</strong></div><button className="arena-primary-cta" onClick={() => onToggleAgent({ games, policy, format: selectedFormat?.battleType, rulesetId: selectedFormat?.rulesetId, teamText: selectedTeamText, teamSource: teamMode, teamId: hotTeam?.id || "", teamTitle: hotTeam?.title || "" })} disabled={teamMode === "hot" && !hotTeam}>{sessionActive ? <><Pause size={16} />停止 Agent</> : <><Play size={16} />开始 {games} 场排位</>}</button></div>{(status.lastError || error) && <div className="arena-error"><AlertTriangle size={16} />{status.lastError || error}</div>}{status.policyFallback && <div className="arena-info"><ShieldCheck size={16} />{status.policyFallback}</div>}</section>

      <aside className="arena-side-column"><section className="arena-telemetry-surface"><div className="arena-surface-head compact"><div><span className="eyebrow">LIVE TELEMETRY</span><h2>运行遥测</h2></div><span className="arena-health-chip"><i />{status.status || "IDLE"}</span></div><div className="arena-telemetry-grid"><div><span>当前对局</span><strong className="mono">{status.activeBattleId ? status.activeBattleId.replace(/^battle-/, "") : "无"}</strong></div><div><span>当前回合</span><strong>{status.lastDecisionTurn || 0}</strong></div><div><span>已收请求</span><strong>{status.requestCount || 0}</strong></div><div><span>已发决策</span><strong>{status.decisionCount || 0}</strong></div></div><div className="arena-telemetry-line"><span>连接</span><b>{status.connectionStatus || "DISCONNECTED"}</b><span>规则</span><b>{status.rules || "UNKNOWN"}</b></div></section><section className="arena-signal-surface"><div className="arena-surface-head compact"><div><span className="eyebrow">SIGNAL STREAM</span><h2>事件流</h2></div><span className="arena-stream-line" /></div><div className="arena-signal-list">{signalItems.map(({ icon: Icon, label, value, tone }) => <div className={`arena-signal-item signal-${tone}`} key={`${label}-${value}`}><Icon size={15} /><div><strong>{label}</strong><small>{value}</small></div></div>)}</div>{health === "STALE" && <div className="arena-stale-note"><AlertTriangle size={15} />超过 {status.staleForSeconds || 0} 秒没有新的服务器事件</div>}</section></aside></div>
  </div>;
}

function Arena({ agentState, onToggleAgent, onStop, registry }) {
  const [status, setStatus] = useState({ status: "IDLE", gamesFinished: 0, gamesRequested: 0 });
  const [error, setError] = useState("");
  const [games, setGames] = useState(1);
  const [policy, setPolicy] = useState("structured");
  const [teamMode, setTeamMode] = useState("workbench");
  const [hotTeams, setHotTeams] = useState([]);
  const [hotTeam, setHotTeam] = useState(null);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotError, setHotError] = useState("");
  const formats = registry?.active || [];
  const [formatId, setFormatId] = useState("");

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const next = await apiRequest("/api/agent/status");
        if (mounted) {
          setStatus(next);
          setError("");
        }
      } catch (requestError) {
        if (mounted) setError(requestError.message);
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  const running = connectedAgentStatuses.has(status.status) || agentState === "active";
  const sessionActive = running || pendingAgentStatuses.has(status.status) || agentState === "starting";
  const selectedFormat = formats.find((item) => item.rulesetId === formatId) || formats.find((item) => item.battleType === "double") || formats[0];
  const health = status.battleHealth || (status.status === "BATTLE" ? "ACTIVE" : status.status);
  const statusLabel = {
    CONNECTING: "连接中",
    AUTHENTICATED: "已登录",
    SEARCHING: "搜索对手",
    BATTLE: "对战中",
    STOPPED: "已停止",
    COMPLETE: "本批次完成",
    FAILED: "连接失败",
    IDLE: "空闲",
  }[status.status] || status.status || "未知";
  const healthLabel = health === "STALE" ? "等待 Showdown 响应" : health === "ACTIVE" ? "实时活动" : statusLabel;
  const statusTone = health === "STALE" ? "yellow" : running ? "green" : pendingAgentStatuses.has(status.status) ? "blue" : status.status === "FAILED" ? "yellow" : "muted";
  const lastActivity = status.lastActivityAt ? new Date(status.lastActivityAt).toLocaleTimeString() : "暂无";

  useEffect(() => {
    if (policy === "laplace") {
      const single = formats.find((item) => item.battleType === "single");
      if (single) setFormatId(single.rulesetId);
    }
  }, [policy, formats]);

  const loadHotTeams = async () => {
    if (!selectedFormat?.rulesetId) return;
    setHotLoading(true);
    setHotError("");
    try {
      const data = await apiRequest(`/api/agent/hot-teams?format=${selectedFormat.battleType}&rulesetId=${encodeURIComponent(selectedFormat.rulesetId)}&limit=24`);
      setHotTeams(data.items || []);
      setHotTeam(data.selected || data.items?.[0] || null);
    } catch (requestError) {
      setHotError(requestError.message);
      setHotTeams([]);
      setHotTeam(null);
    } finally {
      setHotLoading(false);
    }
  };

  useEffect(() => {
    if (teamMode === "hot") loadHotTeams();
  }, [teamMode, selectedFormat?.rulesetId]);

  const rerollHotTeam = () => {
    if (!hotTeams.length) return loadHotTeams();
    const choices = hotTeams.filter((item) => item.id !== hotTeam?.id);
    setHotTeam((choices.length ? choices : hotTeams)[Math.floor(Math.random() * (choices.length ? choices : hotTeams).length)]);
  };
  const selectedTeamText = teamMode === "hot" ? hotTeam?.teamText || "" : "";
  const selectedTeamLabel = teamMode === "hot" ? hotTeam?.title || "规则内热门队伍" : "当前配队工坊队伍";

  return <div className={`page arena-page motion-fade-in arena-health-${String(health).toLowerCase()}`}>
    <div className="page-title-row"><div><span className="eyebrow">AGENT ARENA</span><h1>Agent 控制台</h1><p>状态来自 sidecar 与 Showdown 事件流，每秒刷新。</p></div><div className="toolbar-actions"><StatusPill tone={statusTone} icon={health === "STALE" ? AlertTriangle : running ? Activity : Pause}>{healthLabel}</StatusPill><button className="danger-button" onClick={onStop}><CircleStop size={16} />紧急停止</button></div></div>
    <div className="arena-layout"><section className="panel battle-panel"><SectionHeader eyebrow="LADDER SESSION" title={status.username || "尚未启动"} action={<span className="mono muted">{status.showdownFormatId || "NO CONNECTION"}</span>} /><div className="metric-grid"><Metric label="计划对局" value={status.gamesRequested || 0} tone="blue" icon={Swords} /><Metric label="已完成" value={status.gamesFinished || 0} tone="green" icon={Check} /><Metric label="胜利" value={status.wins || 0} tone="green" icon={Trophy} /><Metric label="失败" value={status.losses || 0} tone="red" icon={Target} /></div><div className="agent-config-row"><label>规则格式<select value={selectedFormat?.rulesetId || ""} onChange={(event) => setFormatId(event.target.value)} disabled={sessionActive}>{formats.map((item) => <option key={item.rulesetId} value={item.rulesetId}>{item.battleType === "single" ? "BSS 单打" : "VGC 双打"} · {item.regulation}</option>)}</select></label><label>对局数量<input type="number" min="1" max="10" value={games} onChange={(event) => setGames(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} disabled={sessionActive} /></label><label>策略<select value={policy} onChange={(event) => setPolicy(event.target.value)} disabled={sessionActive}><option value="structured">结构化策略</option><option value="laplace">Laplace 单打实验</option></select></label><span className="config-hint">单账号 · 单连接 · 当前批次最多 10 场</span></div><div className="team-source-switch" role="group" aria-label="排位队伍来源"><button className={teamMode === "workbench" ? "is-active" : ""} onClick={() => setTeamMode("workbench")} disabled={sessionActive}><Swords size={15} />当前配队</button><button className={teamMode === "hot" ? "is-active" : ""} onClick={() => setTeamMode("hot")} disabled={sessionActive}><Sparkles size={15} />规则内热门随机</button></div>{teamMode === "hot" && <div className="hot-team-picker"><div className="hot-team-head"><div><span className="eyebrow">RULE-SCOPED HOT POOL</span><strong>{hotTeam?.title || (hotLoading ? "正在抽取热门队伍" : "尚未抽取队伍")}</strong><small>{hotTeam ? `${hotTeam.source} · ${hotTeam.sourceSeason} · ${hotTeam.rate ? `${hotTeam.rate}% 使用率` : `排名 #${hotTeam.rank || "-"}`}` : "只使用当前规则可通过校验的完整队伍"}</small></div><button className="secondary-button" onClick={rerollHotTeam} disabled={hotLoading || sessionActive}><Shuffle size={15} />重新抽取</button></div>{hotTeam?.members?.length ? <div className="hot-team-members">{hotTeam.members.map((member) => <div className="hot-team-member" key={`${hotTeam.id}-${member.slug}`}><div className="hot-team-sprite">{member.sprite ? <Sprite id={member.sprite} size="sm" /> : <Sparkles size={16} />}</div><span>{member.name}</span></div>)}</div> : <div className="hot-team-empty">{hotError || (hotLoading ? "正在验证当前规则下的完整队伍..." : "暂无通过当前规则校验的热门队伍")}</div>}{hotTeam && <div className={`hot-team-validity ${hotTeam.seasonMatched ? "is-current" : ""}`}><span className="dot dot-green" />{hotTeam.seasonMatched ? `数据赛季匹配 ${selectedFormat?.regulation}` : `数据源赛季 ${hotTeam.sourceSeason || "未知"}，已按 ${selectedFormat?.regulation} 重新校验`}</div>}</div>}<div className="selected-team-bar"><div><span>本批次实际队伍</span><strong>{selectedTeamLabel}</strong></div><span className="mono">{teamMode === "hot" ? hotTeam?.id || "等待选择" : "forge-ui"}</span></div><div className="battle-actions"><button className="primary-button" onClick={() => onToggleAgent({ games, policy, format: selectedFormat?.battleType, rulesetId: selectedFormat?.rulesetId, teamText: selectedTeamText, teamSource: teamMode, teamId: hotTeam?.id || "", teamTitle: hotTeam?.title || "" })} disabled={teamMode === "hot" && !hotTeam}>{sessionActive ? <><Pause size={16} />停止 Agent</> : <><Play size={16} />开始 {games} 场排位</>}</button></div>{status.policyFallback && <div className="boundary-note"><AlertTriangle size={15} />{status.policyFallback}</div>}{(status.lastError || error) && <div className="boundary-note is-error"><AlertTriangle size={15} />{status.lastError || error}</div>}</section>
      <section className={`panel decision-panel telemetry-panel ${health === "ACTIVE" ? "is-live" : ""}`}><SectionHeader eyebrow="LIVE TELEMETRY" title={healthLabel} action={<StatusPill tone={statusTone}>{status.status || "IDLE"}</StatusPill>} /><div className="guardrail-box"><div><Activity size={16} /><strong>实时对局数据</strong><span className="telemetry-pulse" aria-hidden="true" /></div><span>连接 <b>{status.connectionStatus || "DISCONNECTED"}</b></span><span>匹配 <b>{status.queueStatus || "IDLE"}</b></span><span>当前对局 <b className="mono">{status.activeBattleId || "无"}</b></span><span>最近活动 <b>{lastActivity}</b></span><span>当前回合 <b>{status.lastDecisionTurn || 0}</b></span><span>已收请求 <b>{status.requestCount || 0}</b></span><span>已发决策 <b>{status.decisionCount || 0}</b></span><span>回合事件 <b>{status.turnEventCount || 0}</b></span></div><div className="boundary-note"><ShieldCheck size={15} />最近事件：{status.lastServerEvent || "等待 Showdown 事件"}。最近动作：<span className="mono">{status.lastSentMessage || "暂无"}</span></div>{health === "STALE" && <div className="boundary-note is-error"><AlertTriangle size={15} />已超过 {status.staleForSeconds || 0} 秒没有新的服务端事件。请先观察连接状态，再决定是否停止，不会自动重复提交动作。</div>}</section></div>
  </div>;
}

function Replays() {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [selectedReplay, setSelectedReplay] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const data = await apiRequest("/api/agent/replays");
        if (!mounted) return;
        const nextItems = data.items || [];
        setItems(nextItems);
        setSelected((current) => current ? nextItems.find((item) => item.batchId === current.batchId) || current : nextItems[0] || null);
        setSelectedReplay((current) => current || nextItems[0]?.replayFiles?.[0] || nextItems[0]?.replays?.[0]?.fileName || "");
        setError("");
      } catch (requestError) {
        if (mounted) setError(requestError.message);
      }
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  const replayUrl = selected && selectedReplay ? `/api/agent/replay/${encodeURIComponent(selected.rulesetId)}/${encodeURIComponent(selectedReplay)}` : "";
  return <div className="page"><div className="page-title-row"><div><span className="eyebrow">MATCHES & REPLAYS</span><h1>对局与回放</h1><p>只展示 sidecar 实际完成并保存的对局批次。</p></div><StatusPill icon={Database} tone={items.length ? "green" : "muted"}>{items.length} BATCHES · {items.reduce((sum, item) => sum + Number(item.games || 0), 0)} GAMES</StatusPill></div><div className="replay-layout"><section className="panel replay-list-panel">{items.length ? items.map((item, index) => <button className={`replay-item ${selected === item ? "is-selected" : ""}`} key={`${item.rulesetId}-${item.finishedAt}-${index}`} onClick={() => { setSelected(item); setSelectedReplay(item.replayFiles?.[0] || item.replays?.[0]?.fileName || ""); }}><span className={`result ${item.wins >= item.losses ? "result-w" : "result-l"}`}>{item.wins >= item.losses ? "W" : "L"}</span><div><strong>{item.policyVersion}</strong><small>{new Date(item.finishedAt).toLocaleString()} · {item.rulesetId}</small></div><span className={item.wins >= item.losses ? "positive" : "negative"}>{item.wins}-{item.losses}</span><span className="replay-tag">{item.games} games · {item.replayCount || item.replayFiles?.length || 0} replay</span></button>) : <div className="empty-state">{error || "还没有真实排位批次。账号、规则和合法队伍就绪后才能产生记录。"}</div>}</section><section className="panel replay-detail">{selected ? <><div className="replay-detail-head"><div><span className="eyebrow">BATCH RESULT</span><h2>{selected.policyVersion} <StatusPill tone={selected.wins >= selected.losses ? "green" : "yellow"}>{selected.wins}W {selected.losses}L</StatusPill></h2></div><span className="mono muted">{selected.teamVersion}</span></div><div className="metric-grid"><Metric label="对局" value={selected.games} tone="blue" icon={Swords} /><Metric label="胜利" value={selected.wins} tone="green" icon={Trophy} /><Metric label="失败" value={selected.losses} tone="red" icon={Target} /><Metric label="平局" value={selected.ties} tone="yellow" icon={History} /></div><div className="boundary-note"><ShieldCheck size={15} />记录绑定 {selected.rulesetId}，不会进入其他规则版本的训练反馈。</div>{(selected.replayFiles?.length || selected.replays?.length) ? <div className="replay-viewer-tools"><label>选择对局<select value={selectedReplay || selected.replayFiles?.[0] || selected.replays?.[0]?.fileName || ""} onChange={(event) => setSelectedReplay(event.target.value)}>{(selected.replayFiles || selected.replays?.map((item) => item.fileName) || []).map((fileName) => <option key={fileName} value={fileName}>{fileName}</option>)}</select></label>{replayUrl && <a className="secondary-button" href={replayUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />新窗口打开</a>} </div> : <div className="empty-state compact">该批次没有找到 HTML 回放文件。</div>}{replayUrl && <iframe className="replay-frame" title="Showdown 对局回放" src={replayUrl} />}</> : <div className="empty-state">选择一个真实对局批次查看详情。</div>}</section></div></div>;
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

function TeamLab({ team, setTeam }) {
  const [format, setFormat] = useState("single");
  const [rules, setRules] = useState({ active: [], status: "LOADING" });
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const activeRule = rules.active?.find((item) => item.battleType === format && item.status === "active");

  const load = async () => {
    setError("");
    try {
      const [nextRules, nextLab] = await Promise.all([
        apiRequest("/api/rules/active"),
        apiRequest(`/api/team-lab?format=${format}`),
      ]);
      setRules(nextRules);
      setData(nextLab);
    } catch (requestError) {
      setError(requestError.message);
    }
  };
  useEffect(() => { load(); }, [format]);

  const generate = async () => {
    setBusy("generate");
    setError("");
    try {
      const next = await apiRequest("/api/team-lab/generate", {
        method: "POST",
        body: JSON.stringify({ format, count: 4, gamesPerOpponent: 1, evaluate: true, currentTeam: team }),
      });
      setData((current) => ({ ...current, ...next, experiments: [...(next.experiments || []), ...(current?.experiments || [])] }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  };

  const promote = async (candidateId) => {
    setBusy(candidateId);
    setError("");
    try {
      const next = await apiRequest("/api/team-lab/promote", {
        method: "POST",
        body: JSON.stringify({ format, candidateId, rulesetId: data?.rulesetId }),
      });
      setData((current) => ({ ...current, champion: next.champion, experiments: (current?.experiments || []).map((item) => item.id === candidateId ? { ...item, status: "promoted" } : item) }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  };

  const loadCandidate = (candidate) => {
    const nextTeam = (candidate.team || []).map((member) => ({
      id: member.slug || member.id || member.name,
      name: member.slug || member.name,
      localizedName: member.name || member.slug,
      sprite: member.slug || member.name,
      role: member.role || "结构成员",
      item: member.item || "",
      itemLabel: member.item || "",
      ability: member.ability || "",
      abilityLabel: member.ability || "",
      nature: member.nature || "",
      stats: member.evs || "",
      moves: member.moves || [],
      moveLabels: member.moves || [],
      locked: false,
      tone: "steel",
    }));
    if (nextTeam.length) setTeam(nextTeam);
  };

  return <div className="page team-lab-page">
    <div className="page-title-row"><div><span className="eyebrow">TEAM RESEARCH LOOP</span><h1>配队实验室</h1><p>规则约束、结构搜索、本地对战评估和排位反馈在同一条实验链路中。</p></div><div className="toolbar-actions"><StatusPill icon={ShieldCheck} tone={data?.rulesetId ? "green" : "muted"}>{data?.rulesetId || "读取规则中"}</StatusPill><button className="primary-button" onClick={generate} disabled={busy === "generate" || !activeRule}><Sparkles size={16} />{busy === "generate" ? "搜索与评估中..." : "生成候选队伍"}</button></div></div>
    <div className="team-lab-switch"><button className={format === "single" ? "is-active" : ""} onClick={() => setFormat("single")}>BSS 单打</button><button className={format === "double" ? "is-active" : ""} onClick={() => setFormat("double")}>VGC 双打</button><span>{activeRule?.name?.replace(/^\[Gen \d+ Champions\]\s*/, "") || "当前规则不可用"}</span></div>
    {error && <div className="boundary-note is-error"><AlertTriangle size={15} />{error}</div>}
    <div className="team-lab-summary"><Metric label="排位反馈" value={`${data?.summary?.games || 0} 场`} detail="仅使用相同 rulesetId" tone="blue" icon={Database} /><Metric label="当前胜率" value={`${data?.summary?.winRate || 0}%`} detail="不是候选队伍胜率" tone="yellow" icon={Trophy} /><Metric label="候选数量" value={data?.experiments?.length || 0} detail="规则隔离保存" tone="green" icon={GitBranch} /><Metric label="晋级队伍" value={data?.champion ? "1" : "0"} detail="需显式晋级" tone="red" icon={ShieldCheck} /></div>
    <section className="panel team-lab-panel"><SectionHeader eyebrow="SEARCHED CANDIDATES" title="候选队伍" action={<span className="mono muted">STRICT SEARCH + LOCAL SHOWDOWN</span>} />{data?.experiments?.length ? <div className="team-lab-grid">{data.experiments.map((candidate) => { const evaluation = candidate.evaluation || {}; const canPromote = evaluation.ok && Number(evaluation.games || 0) >= 4 && candidate.status !== "promoted"; return <article className="team-lab-card" key={candidate.id}><div className="team-lab-card-head"><div><span className="eyebrow">{candidate.status === "promoted" ? "PROMOTED" : "CANDIDATE"}</span><h2>{candidate.id}</h2></div><StatusPill tone={candidate.validation?.ok ? "green" : "red"}>{candidate.validation?.ok ? "规则合法" : "待修复"}</StatusPill></div><div className="team-lab-members">{(candidate.team || []).map((member) => <div key={`${candidate.id}-${member.slug}-${member.item}`}><div className="team-lab-sprite"><Sprite id={member.slug || member.name} size="sm" /></div><strong>{member.name || member.slug}</strong><small>{member.role || "结构成员"}</small></div>)}</div><div className="team-lab-stats"><div><span>结构分</span><b>{Number(candidate.score || 0).toFixed(1)}</b></div><div><span>本地评估</span><b>{evaluation.games ? `${evaluation.winRate}%` : "未评估"}</b></div><div><span>战绩</span><b>{evaluation.games ? `${evaluation.wins}-${evaluation.losses}` : "-"}</b></div></div><div className="team-lab-note">{candidate.buildReport?.plan || "已通过当前规则的严格配置搜索。"}</div><div className="team-lab-actions">{canPromote && <button className="primary-button" onClick={() => promote(candidate.id)} disabled={Boolean(busy)}><Trophy size={15} />{busy === candidate.id ? "晋级中..." : "晋级为 Champion"}</button>}{!evaluation.ok && <span className="muted">需要更多本地靶队评估后才能晋级</span>}{candidate.status === "promoted" && <span className="positive"><Check size={15} />已进入规则队伍注册表</span>}</div></article>; })}</div> : <div className="empty-state">还没有候选队伍。点击“生成候选队伍”开始当前规则下的搜索实验。</div>}</section>
    <section className="panel team-lab-panel"><SectionHeader eyebrow="FEEDBACK LOOP" title="配队反馈如何被使用" /><div className="team-lab-feedback"><div><Target size={17} /><strong>失败归因</strong><span>{(data?.summary?.failures || []).slice(0, 3).map((item) => item.label).join("、") || "完成对局后自动提取"}</span></div><div><Swords size={17} /><strong>固定靶队</strong><span>来自当前规则热门队伍，先做本地精确评估</span></div><div><ShieldCheck size={17} /><strong>规则边界</strong><span>所有候选绑定 {data?.rulesetId || "当前 rulesetId"}</span></div></div></section>
  </div>;
}

function Models() {
  const [registries, setRegistries] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => { apiRequest("/api/agent/models").then((data) => setRegistries(data.items || [])).catch((requestError) => setError(requestError.message)); }, []);
  const [learning, setLearning] = useState(null);
  const [learningBusy, setLearningBusy] = useState(false);
  const learningRuleset = registries[0]?.rulesetId || "";
  const learningFormat = learningRuleset.includes("single") ? "single" : "double";
  const refreshLearning = async () => {
    if (!learningRuleset) return;
    setLearning(await apiRequest(`/api/agent/learning?format=${learningFormat}&rulesetId=${encodeURIComponent(learningRuleset)}`));
  };
  useEffect(() => { refreshLearning().catch(() => {}); }, [learningRuleset]);
  const runLearning = async (path) => {
    setLearningBusy(true);
    try {
      const result = await apiRequest(path, { method: "POST", body: JSON.stringify({ format: learningFormat, rulesetId: learningRuleset }) });
      setLearning(result);
      if (path.endsWith("evolve-team")) setRegistries((items) => items);
    } catch (requestError) { setError(requestError.message); }
    finally { setLearningBusy(false); }
  };
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
  const repairingLogin = account.verificationCode === "EXISTING_ACCOUNT_LOGIN_REQUIRED";
  const repairingPassword = account.verificationCode === "OLD_PASSWORD_REQUIRED_FOR_ROTATION";
  const repairInProgress = repairingLogin || repairingPassword;
  const verificationGuide = repairingLogin
    ? ["只在 Showdown 官方窗口输入现有密码并登录", "登录成功后回到这里点击继续"]
    : repairingPassword
      ? ["只填写 Showdown 的 Old password，新密码已安全填入", "填写后回到这里点击继续"]
      : ["在 Showdown 窗口完成当前宝可梦识别题", "回到这里点击“已完成，验证并继续”"];
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
              {waitingForHuman && <div className="verification-hint"><span>1</span><p>{verificationGuide[0]}</p><span>2</span><p>{verificationGuide[1]}</p></div>}
              <StatusPill tone={account.status === "READY" ? "green" : ["FAILED", "LOCKED"].includes(account.status) ? "yellow" : "blue"}>{account.status}</StatusPill>
            </div>
          )}
          {error && <div className="boundary-note"><AlertTriangle size={15} />{error}</div>}
        </div>
        <div className="modal-actions">
          <button className="ghost-button" onClick={onClose}>关闭</button>
          {account.status === "UNCONFIGURED" && <button className="primary-button" disabled={busy} onClick={() => perform("/api/agent/account/bootstrap", { method: "POST", body: JSON.stringify({ prefix }) })}><Bot size={15} />{busy ? "准备中" : "自动注册"}</button>}
          {waitingForHuman && !repairInProgress && <button className="secondary-button" disabled={busy} onClick={() => perform("/api/agent/account/reconcile", { method: "POST", body: "{}" })}><ShieldCheck size={15} />账号已经注册</button>}
          {waitingForHuman && <button className="secondary-button" disabled={busy} onClick={() => perform("/api/agent/account/focus", { method: "POST", body: "{}" })}><ExternalLink size={15} />打开官方窗口</button>}
          {["WAITING_FOR_HUMAN_VERIFICATION", "FAILED"].includes(account.status) && <button className="primary-button" disabled={busy} onClick={() => perform("/api/agent/account/continue", { method: "POST", body: "{}" })}><RefreshCw size={15} />{repairInProgress ? "已完成，继续" : "已完成，验证并继续"}</button>}
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
  const [announcementTone, setAnnouncementTone] = useState("info");
  const [isKilled, setIsKilled] = useState(false);
  const lastAgentStatus = useRef("");
  const activeRuleset = registry.active?.find((item) => item.battleType === "double") || registry.active?.[0];
  const stopAgent = async () => {
    await apiRequest("/api/agent/stop", { method: "POST", body: "{}" }).catch(() => {});
    setAgentState("paused");
    setAnnouncement("Agent 已紧急停止");
    setAnnouncementTone("success");
    setIsKilled(true);
    window.setTimeout(() => setIsKilled(false), 220);
  };
  const toggleAgent = async ({ games = 1, policy = "structured", format, rulesetId, teamText = "", teamSource = "workbench", teamId = "", teamTitle = "" } = {}) => {
    if (agentState === "active" || agentState === "starting") return stopAgent();
    setAgentState("starting");
    setAnnouncement("正在校验队伍并连接 Showdown 排位...");
    setAnnouncementTone("info");
    try {
      await apiRequest("/api/agent/start", { method: "POST", body: JSON.stringify({ format: format || activeRuleset?.battleType || "double", rulesetId: rulesetId || activeRuleset?.rulesetId, teamText: teamText || teamToShowdown(team), games, policy, teamVersion: teamSource === "hot" ? `hot-${teamId || "random"}` : "forge-ui", teamSource, teamId, teamTitle, acknowledgeAutomationPolicy: true }) });
      setAgentState("starting");
      setAnnouncement("启动请求已提交，正在等待 Showdown 登录确认...");
      setAnnouncementTone("info");
    } catch (error) {
      setAgentState("paused");
      const problemSummary = agentStartProblemSummary(error.data?.details?.problems || []);
      setAnnouncement(`Agent 未启动：${error.message} ${problemSummary}`);
      setAnnouncementTone("error");
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
        setAgentState(agentUiState(agent.status));
        if (!lastAgentStatus.current) {
          lastAgentStatus.current = agent.status;
          return;
        }
        if (lastAgentStatus.current === agent.status) return;
        lastAgentStatus.current = agent.status;
        if (agent.status === "SEARCHING") {
          setAnnouncement("Showdown 已认证，正在搜索排位对手。");
          setAnnouncementTone("success");
        } else if (agent.status === "BATTLE") {
          setAnnouncement("已匹配到对手，Agent 正在进行对战。");
          setAnnouncementTone("success");
        } else if (agent.status === "FAILED") {
          setAnnouncement(`Agent 连接失败：${agent.lastError || "未知错误"}`);
          setAnnouncementTone("error");
        }
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
    teamlab: <TeamLab team={team} setTeam={setTeam} />,
    arena: <ArenaCommandCenter team={team} agentState={agentState} onToggleAgent={toggleAgent} onStop={stopAgent} registry={registry} />,
    replays: <Replays />,
    rules: <Rules />,
    models: <><Models />{(registry.active || []).filter((snapshot) => snapshot.status === "active" && (snapshot.battleType === "single" || snapshot.battleType === "double")).map((snapshot) => <AgentLearningPanel key={snapshot.rulesetId} format={snapshot.battleType} rulesetId={snapshot.rulesetId} />)}</>,
  }[page]), [agentState, page, registry, team]);
  return <div className={`app-shell ${agentState === "paused" ? "agent-paused" : ""}`}><div className="app-bg-layer" aria-hidden="true" /><div className="sr-only" aria-live="assertive">{announcement}</div><header className="topbar"><div className="brand"><div className="brand-mark"><span /></div><strong>Champion Forge</strong><span className="desktop-only brand-sub">Competitive Agent Workbench</span></div><div className="top-status"><StatusPill tone={registry.status === "ACTIVE" ? "blue" : "yellow"} icon={BookOpen}>{activeRuleset?.name?.replace(/^\[Gen \d+ Champions\]\s*/, "") || registry.status}</StatusPill><StatusPill tone={registry.canOperate ? "green" : "yellow"} icon={Activity}>{registry.canOperate ? "RULES SYNCED" : "RULES BLOCKED"}</StatusPill><StatusPill tone={agentState === "active" ? "green" : "muted"} icon={Bot}>{agentState === "active" ? <span className="agent-breath">Agent active</span> : agentState === "starting" ? "Agent starting" : "Agent paused"}</StatusPill></div><div className="top-actions"><button className="top-account" onClick={() => setAccountOpen(true)} aria-label="账号设置"><span className="account-avatar"><Bot size={15} /></span><span className="desktop-only">专用账号</span></button><button className={`kill-switch ${isKilled ? "kill-flash" : ""}`} onClick={stopAgent} aria-label="紧急停止 Agent"><CircleStop size={15} /> <span className="desktop-only">KILL SWITCH</span><kbd>Ctrl ⇧ K</kbd></button><button className="mobile-menu icon-button" aria-label="打开菜单"><Menu size={19} /></button></div></header>{announcement && <div className={`app-notice notice-${announcementTone}`} role="status">{announcementTone === "error" ? <AlertTriangle size={16} /> : announcementTone === "success" ? <Check size={16} /> : <Bot size={16} />}<span>{announcement}</span><button className="icon-button" onClick={() => setAnnouncement("")} aria-label="关闭状态提示"><X size={15} /></button></div>}<div className="shell-body"><aside className="sidebar" aria-label="主导航"><div className="nav-group">{navItems.map(([id, label, Icon]) => <button key={id} className={`nav-item ${page === id ? "is-active" : ""}`} onClick={() => setPage(id)} aria-current={page === id ? "page" : undefined}><Icon size={18} /><span>{label}</span>{page === id && <i />}</button>)}</div><div className="sidebar-foot"><button className="nav-item" onClick={() => setAccountOpen(true)}><Settings size={18} /><span>设置</span></button><div className="sync-card"><div><span className={`dot ${registry.canOperate ? "dot-green" : "dot-yellow"}`} />规则同步</div><strong>{registry.canOperate ? "当前快照有效" : registry.status}</strong><small>{activeRuleset?.regulation || "等待同步"}</small></div></div></aside><main className="main-content">{content}</main></div>{accountOpen && <AccountWizard onClose={() => setAccountOpen(false)} />}</div>;
}

createRoot(document.getElementById("root")).render(<App />);
