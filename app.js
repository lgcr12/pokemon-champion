const TYPES = ["一般", "火", "水", "电", "草", "冰", "格斗", "毒", "地面", "飞行", "超能力", "虫", "岩石", "幽灵", "龙", "恶", "钢", "妖精"];

import { buildBattleKnowledge, packTeam } from "./battle-knowledge.mjs";

const TEAM_FORM_ALIASES = new Map([
  [10061, { id: 670, slug: "floette" }],
  [10008, { id: 479, slug: "rotom-heat" }],
  [10009, { id: 479, slug: "rotom-wash" }],
  [10012, { id: 479, slug: "rotom-mow" }],
  [10104, { id: 38, slug: "ninetales-alola" }],
  [10172, { id: 199, slug: "slowking-galar" }],
  [10230, { id: 59, slug: "arcanine-hisui" }],
  [10233, { id: 157, slug: "typhlosion-hisui" }],
  [10236, { id: 503, slug: "samurott-hisui" }],
]);

const TARGET_NAME_ALIASES = [
  {
    pattern: /超级姆克鹰|mega\s*staraptor|staraptor-?mega/i,
    keys: ["staraptormega"],
    fallback: {
      id: "staraptormega",
      slug: "staraptor-mega",
      name: "超级姆克鹰",
      baseSlug: "staraptor",
      baseName: "姆克鹰",
      types: ["一般", "飞行"],
      stats: { HP: 85, 攻击: 160, 防御: 90, 特攻: 65, 特防: 70, 速度: 125 },
      abilities: [{ name: "唱反调" }],
      preMegaAbilities: [{ name: "威吓" }, { name: "舍身" }],
    },
  },
  {
    pattern: /姆克鹰|staraptor/i,
    keys: ["staraptor"],
    fallback: {
      id: "staraptor",
      slug: "staraptor",
      name: "姆克鹰",
      baseSlug: "staraptor",
      baseName: "姆克鹰",
      types: ["一般", "飞行"],
      stats: { HP: 85, 攻击: 120, 防御: 70, 特攻: 50, 特防: 60, 速度: 100 },
      abilities: [{ name: "威吓" }, { name: "舍身" }],
    },
  },
];

const state = {
  rawData: null,
  data: null,
  battleKnowledgeData: null,
  format: "single",
  team: [],
  teamConfigs: {},
  teamLibrary: [],
  teamSeasonFilter: "",
  teamSourceFilter: "public",
  selectedTeamId: "",
  importedTeam: null,
  activeEditIndex: null,
  aiBusy: false,
  aiLastAdvice: null,
  aiLastMode: "complete-team",
  aiLastContext: null,
  aiBattleBusy: false,
  aiBattleEval: null,
  battleReviewOpen: false,
  battleReviewFormat: "single",
  battleReviewEntry: null,
  showdownValidation: null,
  uiLevel: "beginner",
  query: "",
  searchOpen: false,
  teamLibraryConfigCache: new Map(),
  recommendedItemsCache: new Map(),
  rankedSetsCache: new Map(),
  rulePrefs: {
    allowDuplicateItems: false,
    ignoreTera: false,
  },
};

const $ = (selector) => document.querySelector(selector);
const DRAFT_KEY = "champion-lab-current-draft-v2";
const AI_CONFIG_KEY = "champion-lab-ai-config-v1";
const AI_MODELS_CACHE_KEY = "champion-lab-ai-models-v1";
const AI_FAILURE_MEMORY_KEY = "champion-lab-ai-failure-memory-v1";
const AI_BATTLE_HISTORY_KEY = "champion-lab-ai-battle-history-v1";
const RULE_PREFS_KEY = "champion-lab-rule-prefs-v1";
const UI_LEVEL_KEY = "champion-lab-ui-level-v1";
const AI_REQUEST_TIMEOUTS_MS = {
  quick: 120000,
  deep: 240000,
  compare: 300000,
};

function aiRequestTimeoutMs(promptMode = "quick") {
  return AI_REQUEST_TIMEOUTS_MS[promptMode] || AI_REQUEST_TIMEOUTS_MS.quick;
}

const UI_LEVELS = {
  beginner: {
    label: "初级",
    value: "beginner",
    aiTone: "面向新手：少用 Showdown/速度档/校验术语，先写队伍怎么打、下一步点什么、最小改动是什么。",
  },
  intermediate: {
    label: "中级",
    value: "intermediate",
    aiTone: "面向中手：聚焦短板、补强、结构和替换代价，术语可以用但要给动作建议。",
  },
  advanced: {
    label: "高级",
    value: "advanced",
    aiTone: "面向高级玩家：可以展开速度档、对局分支、配置依据、本地模拟和日志级细节。",
  },
};

function loadUiLevel() {
  const saved = localStorage.getItem(UI_LEVEL_KEY);
  return saved && UI_LEVELS[saved] ? saved : "beginner";
}

function saveUiLevel(level) {
  if (!UI_LEVELS[level]) return;
  localStorage.setItem(UI_LEVEL_KEY, level);
}

function uiLevelLabel(level = state.uiLevel) {
  return UI_LEVELS[level]?.label || UI_LEVELS.intermediate.label;
}

function uiLevelPrompt(level = state.uiLevel) {
  if (level === "advanced") return "高级：直接看速度档、对局回顾和完整校验。";
  if (level === "intermediate") return "中级：看短板、补强和结构。";
  return "初级：先知道下一步该点什么。";
}

function uiLevelInstruction(level = state.uiLevel) {
  return UI_LEVELS[level]?.aiTone || UI_LEVELS.beginner.aiTone;
}

function isUiLevel(level) {
  return state.uiLevel === level;
}

function isUiAtLeast(level) {
  const order = { beginner: 0, intermediate: 1, advanced: 2 };
  return (order[state.uiLevel] || 0) >= (order[level] || 0);
}

function setUiLevel(level) {
  if (!UI_LEVELS[level] || state.uiLevel === level) return;
  state.uiLevel = level;
  saveUiLevel(level);
  if (state.aiLastAdvice) {
    rerenderAIAdvice();
    return;
  }
  render();
}

const TYPE_CN_TO_EN = {
  一般: "Normal",
  火: "Fire",
  水: "Water",
  电: "Electric",
  草: "Grass",
  冰: "Ice",
  格斗: "Fighting",
  毒: "Poison",
  地面: "Ground",
  飞行: "Flying",
  超能力: "Psychic",
  虫: "Bug",
  岩石: "Rock",
  幽灵: "Ghost",
  龙: "Dragon",
  恶: "Dark",
  钢: "Steel",
  妖精: "Fairy",
};
const TYPE_EN_TO_CN = Object.fromEntries(Object.entries(TYPE_CN_TO_EN).map(([cn, en]) => [en.toLowerCase(), cn]));
const SHOWDOWN_DEX = typeof globalThis !== "undefined" ? globalThis.Dex || null : null;
const SHOWDOWN_SPECIES_LIST = SHOWDOWN_DEX?.species?.all ? SHOWDOWN_DEX.species.all() : [];
const SHOWDOWN_SPECIES_BY_ID = new Map(SHOWDOWN_SPECIES_LIST.map((species) => [String(species.id || "").toLowerCase(), species]));
const SHOWDOWN_SPECIES_BY_NUM = new Map(SHOWDOWN_SPECIES_LIST.filter((species) => Number.isFinite(Number(species.num))).map((species) => [Number(species.num), species]));
const LOCALIZED_TERMS = {
  abilities: {
    contrary: "唱反调",
    intimidate: "威吓",
    reckless: "舍身",
    "stance change": "战斗切换",
    stancechange: "战斗切换",
    "rough skin": "粗糙皮肤",
    roughskin: "粗糙皮肤",
    "あらいはだ": "粗糙皮肤",
    "parental bond": "亲子爱",
    parentalbond: "亲子爱",
    "magic bounce": "魔法镜",
    magicbounce: "魔法镜",
    prankster: "恶作剧之心",
    "いたずらごころ": "恶作剧之心",
    drought: "日照",
    "ひでり": "日照",
    drizzle: "降雨",
    "あめふらし": "降雨",
    "natural cure": "自然回复",
    naturalcure: "自然回复",
    "しぜんかいふく": "自然回复",
    "regenerator": "再生力",
    "さいせいりょく": "再生力",
    "torrent": "激流",
    "げきりゅう": "激流",
    "solar power": "太阳之力",
    solarpower: "太阳之力",
    sturdy: "结实",
    "がんじょう": "结实",
    "adaptability": "适应力",
    "てきおうりょく": "适应力",
    "defiant": "不服输",
    "まけんき": "不服输",
    "unburden": "轻装",
    "かるわざ": "轻装",
    "hospitality": "款待",
    "flower veil": "花幕",
    flowerveil: "花幕",
    "フラワーベール": "花幕",
    "queenly majesty": "女王的威严",
    queenlymajesty: "女王的威严",
    "じょおうのいげん": "女王的威严",
    "blaze": "猛火",
    "もうか": "猛火",
    "cursed body": "诅咒之躯",
    cursedbody: "诅咒之躯",
    "のろわれボディ": "诅咒之躯",
    "unnerve": "紧张感",
    "きんちょうかん": "紧张感",
    "sand stream": "扬沙",
    sandstream: "扬沙",
    "すなおこし": "扬沙",
    "pixilate": "妖精皮肤",
    "フェアリースキン": "妖精皮肤",
    "stamina": "持久力",
    "じきゅうりょく": "持久力",
    "protean": "变幻自如",
    "へんげんじざい": "变幻自如",
    "armor tail": "尾甲",
    armortail: "尾甲",
    "テイルアーマー": "尾甲",
    "sand rush": "拨沙",
    sandrush: "拨沙",
    "gale wings": "疾风之翼",
    galewings: "疾风之翼",
    "toxic debris": "毒满地",
    toxicdebris: "毒满地",
    "どくげしょう": "毒满地",
    "sharpness": "锋锐",
    "きれあじ": "锋锐",
    "technician": "技术高手",
    "テクニシャン": "技术高手",
    "unaware": "纯朴",
    "てんねん": "纯朴",
    "inner focus": "精神力",
    innerfocus: "精神力",
    "せいしんりょく": "精神力",
    "friend guard": "友情防守",
    friendguard: "友情防守",
    "competitive": "好胜",
    "mirror armor": "镜甲",
    mirrorarmor: "镜甲",
    "ミラーアーマー": "镜甲",
    "poison touch": "毒手",
    poisontouch: "毒手",
    "どくしゅ": "毒手",
    "snow warning": "降雪",
    snowwarning: "降雪",
    "ゆきふらし": "降雪",
    "supreme overlord": "大将",
    supremeoverlord: "大将",
    "そうだいしょう": "大将",
    "overgrow": "茂盛",
    "しんりょく": "茂盛",
    "swift swim": "悠游自如",
    swiftswim: "悠游自如",
    chlorophyll: "叶绿素",
    "ようりょくそ": "叶绿素",
    "clear body": "恒净之躯",
    clearbody: "恒净之躯",
    "クリアボディ": "恒净之躯",
    disguise: "画皮",
    "ばけのかわ": "画皮",
    "anger point": "愤怒穴位",
    angerpoint: "愤怒穴位",
    "いかりのつぼ": "愤怒穴位",
    oblivious: "迟钝",
    "どんかん": "迟钝",
    "snow cloak": "雪隐",
    snowcloak: "雪隐",
    "ゆきがくれ": "雪隐",
    "zero-to-hero": "全能变身",
    "zero to hero": "全能变身",
    zerotohero: "全能变身",
    "マイティチェンジ": "全能变身",
    "speed boost": "加速",
    speedboost: "加速",
    "かそく": "加速",
    "magic bounce": "魔法镜",
    magicbounce: "魔法镜",
    "mold breaker": "破格",
    moldbreaker: "破格",
    "moxie": "自信过度",
    "hyper cutter": "怪力钳",
    hypercutter: "怪力钳",
    "thick fat": "厚脂肪",
    thickfat: "厚脂肪",
    "あついしぼう": "厚脂肪",
    "flash fire": "引火",
    flashfire: "引火",
    "lightning rod": "避雷针",
    lightningrod: "避雷针",
    levitate: "漂浮",
    "soundproof": "隔音",
  },
  natures: {
    adamant: "固执",
    jolly: "爽朗",
    modest: "内敛",
    timid: "胆小",
    calm: "温和",
    bold: "大胆",
    careful: "慎重",
    impish: "淘气",
    brave: "勇敢",
    quiet: "冷静",
    "おくびょう": "胆小",
    "ひかえめ": "内敛",
    "いじっぱり": "固执",
    "ずぶとい": "大胆",
    "おだやか": "温和",
    "しんちょう": "慎重",
    "わんぱく": "淘气",
  },
  moves: {
    "brave bird": "勇鸟猛攻",
    bravebird: "勇鸟猛攻",
    "close combat": "近身战",
    closecombat: "近身战",
    protect: "守住",
    roost: "羽栖",
    tailwind: "顺风",
    "quick attack": "电光一闪",
    quickattack: "电光一闪",
    "double-edge": "舍身冲撞",
    doubleedge: "舍身冲撞",
    "shadow sneak": "影子偷袭",
    shadowsneak: "影子偷袭",
    "iron head": "铁头",
    ironhead: "铁头",
    "sacred sword": "圣剑",
    sacredsword: "圣剑",
    "king's shield": "王者盾牌",
    kingsshield: "王者盾牌",
    "steel wing": "钢翼",
    steelwing: "钢翼",
    moonblast: "月亮之力",
    "ムーンフォース": "月亮之力",
    encore: "再来一次",
    "アンコール": "再来一次",
    tailwind: "顺风",
    "おいかぜ": "顺风",
    protect: "守住",
    "まもる": "守住",
    "sunny day": "大晴天",
    sunnyday: "大晴天",
    "にほんばれ": "大晴天",
    "weather ball": "气象球",
    weatherball: "气象球",
    "ウェザーボール": "气象球",
    "solar beam": "日光束",
    solarbeam: "日光束",
    "ソーラービーム": "日光束",
    "hurricane": "暴风",
    "ぼうふう": "暴风",
    "wide guard": "广域防守",
    wideguard: "广域防守",
    "ワイドガード": "广域防守",
    "quick guard": "快速防守",
    quickguard: "快速防守",
    "ファストガード": "快速防守",
    "wave crash": "波动冲",
    wavecrash: "波动冲",
    "ウェーブタックル": "波动冲",
    "quick turn": "快速折返",
    quickturn: "快速折返",
    "クイックターン": "快速折返",
    aquajet: "水流喷射",
    "aqua jet": "水流喷射",
    "アクアジェット": "水流喷射",
    "leech seed": "寄生种子",
    leechseed: "寄生种子",
    "やどりぎのタネ": "寄生种子",
    substitute: "替身",
    "みがわり": "替身",
    taunt: "挑衅",
    "ちょうはつ": "挑衅",
    endeavor: "蛮干",
    "がむしゃら": "蛮干",
    "memento": "临别礼物",
    "おきみやげ": "临别礼物",
    "cotton spore": "棉孢子",
    cottonspore: "棉孢子",
    "わたほうし": "棉孢子",
    "power whip": "强力鞭打",
    powerwhip: "强力鞭打",
    "パワーウィップ": "强力鞭打",
    "electro ball": "电球",
    electroball: "电球",
    "エレキボール": "电球",
    "rock slide": "岩崩",
    rockslide: "岩崩",
    "いわなだれ": "岩崩",
    earthquake: "地震",
    "じしん": "地震",
    eruption: "喷火",
    "ふんか": "喷火",
    "heat wave": "热风",
    heatwave: "热风",
    "ねっぷう": "热风",
    "earth power": "大地之力",
    earthpower: "大地之力",
    "だいちのちから": "大地之力",
    "fake out": "击掌奇袭",
    fakeout: "击掌奇袭",
    "ねこだまし": "击掌奇袭",
    "throat chop": "地狱突刺",
    throatchop: "地狱突刺",
    "じごくづき": "地狱突刺",
    "darkest lariat": "DD金勾臂",
    darkestlariat: "DD金勾臂",
    "parting shot": "抛下狠话",
    partingshot: "抛下狠话",
    "すてゼリフ": "抛下狠话",
    "flare blitz": "闪焰冲锋",
    flareblitz: "闪焰冲锋",
    "フレアドライブ": "闪焰冲锋",
    "dragon claw": "龙爪",
    dragonclaw: "龙爪",
    "ドラゴンクロー": "龙爪",
    "rapid spin": "高速旋转",
    rapidspin: "高速旋转",
    "こうそくスピン": "高速旋转",
    "trick room": "戏法空间",
    trickroom: "戏法空间",
    "トリックルーム": "戏法空间",
    "sucker punch": "突袭",
    suckerpunch: "突袭",
    "ふいうち": "突袭",
    "draining kiss": "吸取之吻",
    drainingkiss: "吸取之吻",
    "ドレインキッス": "吸取之吻",
    waterfall: "攀瀑",
    "たきのぼり": "攀瀑",
    "thunder wave": "电磁波",
    thunderwave: "电磁波",
    "でんじは": "电磁波",
    "ice punch": "冰冻拳",
    icepunch: "冰冻拳",
    "れいとうパンチ": "冰冻拳",
    "sparkling aria": "泡影的咏叹调",
    sparklingaria: "泡影的咏叹调",
    "うたかたのアリア": "泡影的咏叹调",
    "last respects": "扫墓",
    lastrespects: "扫墓",
    "おはかまいり": "扫墓",
    "rage powder": "愤怒粉",
    ragepowder: "愤怒粉",
    "kowtow cleave": "仆刀",
    kowtowcleave: "仆刀",
    "ドゲザン": "仆刀",
    "dire claw": "克命爪",
    direclaw: "克命爪",
    "low kick": "踢倒",
    lowkick: "踢倒",
    "trop kick": "热带踢",
    tropkick: "热带踢",
    "shadow ball": "暗影球",
    shadowball: "暗影球",
    "シャドーボール": "暗影球",
    "hyper voice": "巨声",
    hypervoice: "巨声",
    "dazzling gleam": "魔法闪耀",
    dazzlinggleam: "魔法闪耀",
    "calm mind": "冥想",
    calmmind: "冥想",
    "めいそう": "冥想",
    "swords dance": "剑舞",
    swordsdance: "剑舞",
    "つるぎのまい": "剑舞",
    "matcha gotcha": "刷刷茶炮",
    matchagotcha: "刷刷茶炮",
    "draco meteor": "流星群",
    dracometeor: "流星群",
    "りゅうせいぐん": "流星群",
    thunderbolt: "十万伏特",
    "10まんボルト": "十万伏特",
    "stomping tantrum": "跺脚",
    stompingtantrum: "跺脚",
    "high horsepower": "十万马力",
    highhorsepower: "十万马力",
    "dual wingbeat": "双翼",
    dualwingbeat: "双翼",
    "sludge bomb": "污泥炸弹",
    sludgebomb: "污泥炸弹",
    "ヘドロばくだん": "污泥炸弹",
    "energy ball": "能量球",
    energyball: "能量球",
    "エナジーボール": "能量球",
    "sleep powder": "催眠粉",
    sleeppowder: "催眠粉",
    "ねむりごな": "催眠粉",
    "clear smog": "清除之烟",
    clearsmog: "清除之烟",
    "クリアスモッグ": "清除之烟",
    blizzard: "暴风雪",
    "yawn": "哈欠",
    "あくび": "哈欠",
    "slack off": "偷懒",
    slackoff: "偷懒",
    "なまける": "偷懒",
    flamethrower: "喷射火焰",
    "かえんほうしゃ": "喷射火焰",
    "helping hand": "帮助",
    helpinghand: "帮助",
    "life dew": "生命水滴",
    lifedew: "生命水滴",
    psychic: "精神强念",
    "サイコキネシス": "精神强念",
    "dark pulse": "恶之波动",
    darkpulse: "恶之波动",
    "あくのはどう": "恶之波动",
    "tri attack": "三重攻击",
    triattack: "三重攻击",
    "u turn": "急速折返",
    uturn: "急速折返",
    "とんぼがえり": "急速折返",
    "flash cannon": "加农光炮",
    flashcannon: "加农光炮",
    "ラスターカノン": "加农光炮",
    "dragon pulse": "龙之波动",
    dragonpulse: "龙之波动",
    "will o wisp": "鬼火",
    willowisp: "鬼火",
    "おにび": "鬼火",
    "knock off": "拍落",
    knockoff: "拍落",
    "はたきおとす": "拍落",
    "sludge wave": "污泥波",
    sludgewave: "污泥波",
    "ヘドロウェーブ": "污泥波",
    "dragon tail": "龙尾",
    dragontail: "龙尾",
    "ドラゴンテール": "龙尾",
    "electro shot": "电光束",
    electroshot: "电光束",
    "icy wind": "冰冻之风",
    icywind: "冰冻之风",
    "ice beam": "冰冻光束",
    icebeam: "冰冻光束",
    "れいとうビーム": "冰冻光束",
    "scale shot": "鳞射",
    scaleshot: "鳞射",
    "スケイルショット": "鳞射",
    liquidation: "水流裂破",
    crunch: "咬碎",
    "leaf storm": "飞叶风暴",
    leafstorm: "飞叶风暴",
    thunder: "打雷",
    surf: "冲浪",
    "muddy water": "浊流",
    muddywater: "浊流",
    "body press": "扑击",
    bodypress: "扑击",
    "air slash": "空气斩",
    airslash: "空气斩",
    overheat: "过热",
    "quick attack": "电光一闪",
    quickattack: "电光一闪",
    "dragon dance": "龙之舞",
    dragondance: "龙之舞",
    "りゅうのまい": "龙之舞",
    detect: "看穿",
    playrough: "嬉闹",
    "play rough": "嬉闹",
    "じゃれつく": "嬉闹",
    "hydro pump": "水炮",
    hydropump: "水炮",
    "extreme speed": "神速",
    extremespeed: "神速",
    "aurora veil": "极光幕",
    auroraveil: "极光幕",
    "volt switch": "伏特替换",
    voltswitch: "伏特替换",
    "light of ruin": "破灭之光",
    lightofruin: "破灭之光",
    "rain dance": "求雨",
    raindance: "求雨",
    "power gem": "力量宝石",
    powergem: "力量宝石",
    "bullet punch": "子弹拳",
    bulletpunch: "子弹拳",
    outrage: "逆鳞",
    "げきりん": "逆鳞",
    synthesis: "光合作用",
    "こうごうせい": "光合作用",
    poltergeist: "灵骚",
    "ポルターガイスト": "灵骚",
    "aura sphere": "波导弹",
    aurasphere: "波导弹",
    "triple axel": "三旋击",
    tripleaxel: "三旋击",
    "ice fang": "冰冻牙",
    icefang: "冰冻牙",
    "flip turn": "快速折返",
    flipturn: "快速折返",
    "jet punch": "喷射拳",
    jetpunch: "喷射拳",
    "bulk up": "健美",
    bulkup: "健美",
    "flying press": "飞身重压",
    flyingpress: "飞身重压",
    entrainment: "找伙伴",
    "cross chop": "十字劈",
    crosschop: "十字劈",
    "fake tears": "假哭",
    faketears: "假哭",
    "drain punch": "吸取拳",
    drainpunch: "吸取拳",
    "stealth rock": "隐形岩",
    stealthrock: "隐形岩",
    "rock tomb": "岩石封锁",
    rocktomb: "岩石封锁",
    coaching: "指导",
    discharge: "放电",
    trick: "戏法",
  },
  items: {
    "weakness policy": "弱点保险",
    weaknesspolicy: "弱点保险",
    charcoal: "木炭",
    "もくたん": "木炭",
    "chople berry": "抗斗果",
    chopleberry: "抗斗果",
    "ヨプのみ": "抗斗果",
    "focus sash": "气势披带",
    focussash: "气势披带",
    "きあいのタスキ": "气势披带",
    "sitrus berry": "文柚果",
    sitrusberry: "文柚果",
    "オボンのみ": "文柚果",
    "passho berry": "抗水果",
    passhoberry: "抗水果",
    "passho-berry": "抗水果",
    "ソクノのみ": "抗水果",
    "figy berry": "勿花果",
    figyberry: "勿花果",
    "フィラのみ": "勿花果",
    "wiki berry": "异奇果",
    wikiberry: "异奇果",
    "aguav berry": "芒芒果",
    aguavberry: "芒芒果",
    "iapapa berry": "芭亚果",
    iapapaberry: "芭亚果",
    "life orb": "生命宝珠",
    lifeorb: "生命宝珠",
    "choice scarf": "讲究围巾",
    choicescarf: "讲究围巾",
    "choice band": "讲究头带",
    choiceband: "讲究头带",
    "choice specs": "讲究眼镜",
    choicespecs: "讲究眼镜",
    "こだわりスカーフ": "讲究围巾",
    "white herb": "白色香草",
    whiteherb: "白色香草",
    "しろいハーブ": "白色香草",
    staraptorite: "姆克鹰进化石",
    dragoninite: "快龙进化石",
    emboarite: "炎武王进化石",
    chesnaughtite: "布里卡隆进化石",
    aerodactylite: "化石翼龙进化石",
    hawluchanite: "摔角鹰人进化石",
    gyaradosite: "暴鲤龙进化石",
    "gyaradosite": "暴鲤龙进化石",
    "ギャラドスナイト": "暴鲤龙进化石",
    tyranitarite: "班基拉斯进化石",
    "バンギラスナイト": "班基拉斯进化石",
    salamencite: "暴飞龙进化石",
    "ボーマンダナイト": "暴飞龙进化石",
    garchompite: "烈咬陆鲨进化石",
    "ガブリアスナイト": "烈咬陆鲨进化石",
    gengarite: "耿鬼进化石",
    "ゲンガナイト": "耿鬼进化石",
    venusaurite: "妙蛙花进化石",
    "フシギバナイト": "妙蛙花进化石",
    froslassite: "雪妖女进化石",
    floettite: "花叶蒂进化石",
    kangaskhanite: "袋兽进化石",
    "ガルーラナイト": "袋兽进化石",
    "charizardite x": "喷火龙进化石 X",
    charizarditex: "喷火龙进化石 X",
    "リザードナイトx": "喷火龙进化石 X",
    "charizardite y": "喷火龙进化石 Y",
    charizarditey: "喷火龙进化石 Y",
    "リザードナイトy": "喷火龙进化石 Y",
    "occa berry": "抗火果",
    occaberry: "抗火果",
    "coba berry": "抗飞果",
    cobaberry: "抗飞果",
    "mental herb": "心灵香草",
    mentalherb: "心灵香草",
    "メンタルハーブ": "心灵香草",
    "bright powder": "光粉",
    brightpowder: "光粉",
    "covert cloak": "密探斗篷",
    covertcloak: "密探斗篷",
    leftovers: "剩饭",
    "たべのこし": "剩饭",
    "fairy feather": "妖精羽毛",
    fairyfeather: "妖精羽毛",
    "ようせいのハネ": "妖精羽毛",
    "kebia berry": "抗毒果",
    kebiaberry: "抗毒果",
    "black glasses": "黑色眼镜",
    blackglasses: "黑色眼镜",
    "くろいメガネ": "黑色眼镜",
    "lum berry": "木子果",
    lumberry: "木子果",
    "ラムのみ": "木子果",
    "mystic water": "神秘水滴",
    mysticwater: "神秘水滴",
    "しんぴのしずく": "神秘水滴",
    "spell tag": "诅咒之符",
    spelltag: "诅咒之符",
    "のろいのおふだ": "诅咒之符",
    "dragon fang": "龙之牙",
    dragonfang: "龙之牙",
    "りゅうのキバ": "龙之牙",
    "shuca berry": "抗地果",
    shucaberry: "抗地果",
    "シュカのみ": "抗地果",
    "roseli berry": "抗妖果",
    roseliberry: "抗妖果",
    "ロゼルのみ": "抗妖果",
    "kasib berry": "抗鬼果",
    kasibberry: "抗鬼果",
    "colbur berry": "抗恶果",
    colburberry: "抗恶果",
    "mental herb": "心灵香草",
    mentalherb: "心灵香草",
    "soft sand": "柔软沙子",
    softsand: "柔软沙子",
    "やわらかいすな": "柔软沙子",
    "life orb": "生命宝珠",
    lifeorb: "生命宝珠",
    "sharp beak": "锐利鸟嘴",
    sharpbeak: "锐利鸟嘴",
    "haban berry": "抗龙果",
    habanberry: "抗龙果",
    "ハバンのみ": "抗龙果",
    "metal coat": "金属膜",
    metalcoat: "金属膜",
    "never melt ice": "不融冰",
    nevermeltice: "不融冰",
    "とけないこおり": "不融冰",
    "scope lens": "焦点镜",
    scopelens: "焦点镜",
    "ピントレンズ": "焦点镜",
    "light clay": "光之黏土",
    lightclay: "光之黏土",
    "quick claw": "先制之爪",
    quickclaw: "先制之爪",
    "yache berry": "抗冰果",
    yacheberry: "抗冰果",
    "charti berry": "抗岩果",
    chartiberry: "抗岩果",
    "wacan berry": "抗电果",
    wacanberry: "抗电果",
    "silk scarf": "丝绸围巾",
    silkscarf: "丝绸围巾",
    "damp rock": "潮湿岩石",
    damprock: "潮湿岩石",
    magnet: "磁铁",
    "assault vest": "突击背心",
    assaultvest: "突击背心",
    feraligite: "大力鳄进化石",
  },
};
const TYPE_EFFECTIVENESS = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy: { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};
const AI_PROVIDER_PRESETS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    endpoint: "responses",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    endpoint: "chat",
    models: ["deepseek-chat", "deepseek-reasoner", "deepseek-r1", "deepseek-v4-flash"],
  },
  kimi: {
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2-0711-preview",
    endpoint: "chat",
    models: ["kimi-k2-0711-preview", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    endpoint: "chat",
    models: ["qwen-plus", "qwen-turbo", "qwen-max", "qwen-long"],
  },
  minimax: {
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M1",
    endpoint: "chat",
    models: ["MiniMax-M1", "MiniMax-Text-01"],
  },
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    endpoint: "chat",
    models: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen3-32B"],
  },
  custom: {
    baseUrl: "",
    model: "",
    endpoint: "chat",
    models: [],
  },
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pct(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return `${Math.round(Number(value) * 10) / 10}%`;
}

function formatCacheTime(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replaceAll("/", "-");
}

function currentCacheTime() {
  return state.rawData?.refreshedAt || state.rawData?.fetchedAt || state.data?.refreshedAt || state.data?.fetchedAt || state.data?.updatedAt || "";
}

function formatLabel(format) {
  return format === "double" ? "双打" : "单打";
}

function names(entries = [], limit = 2) {
  return entries.slice(0, limit).filter((item) => item?.name).map((item) => item.name).join(" / ");
}

function knownConfigValue(value = "") {
  const text = String(value || "").trim();
  return text && !["不明", "なし", "None", "-1"].includes(text) ? text : "";
}

function knownConfigList(values = []) {
  return (Array.isArray(values) ? values : []).map(knownConfigValue).filter(Boolean);
}

function isPlaceholderConfigValue(value = "") {
  const text = String(value || "").trim();
  if (!text) return true;
  return /^(不明|なし|none|-1|unknown|n\/a|待定|任意)$/i.test(text) || /可替换|按.*调整|速度线|视情况|根据.*选择|待补|未填写/i.test(text);
}

function usableConfigValue(value = "", category = "") {
  const localized = category ? localizeTerm(value, category) : String(value || "").trim();
  return isPlaceholderConfigValue(localized) ? "" : localized;
}

function adviceSpeciesConfigKeySet(format = state.format) {
  const keys = new Set();
  const add = (value = "") => {
    const key = localTermKey(value);
    if (key) keys.add(key);
  };
  for (const data of [state.data, state.rawData?.formats?.[format], state.rawData?.formats?.single, state.rawData?.formats?.double].filter(Boolean)) {
    for (const mon of data.pokemon || []) {
      add(mon.id);
      add(mon.slug);
      add(mon.name);
    }
  }
  for (const team of state.teamLibrary || []) {
    for (const entry of [...(team.members || []), ...(team.configurations || [])]) {
      add(entry?.id);
      add(entry?.slug);
      add(entry?.name);
    }
  }
  return keys;
}

function isForeignConfigResidue(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/[\u3040-\u30ff]/.test(text)) return true;
  return /^[a-z0-9][a-z0-9\s'-]*$/i.test(text);
}

function isSpeciesConfigValue(value = "", format = state.format) {
  const key = localTermKey(value);
  return Boolean(key && adviceSpeciesConfigKeySet(format).has(key));
}

function cleanAdviceConfigValue(value = "", category = "", format = state.format) {
  const text = usableConfigValue(value, category);
  if (!text) return "";
  if (isSpeciesConfigValue(text, format)) return "";
  if (category && isForeignConfigResidue(text)) return "";
  return text;
}

function uniqueSentenceNote(note = "") {
  const sentences = String(note || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。！？!?])\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(sentences)].join("");
}

function appendUniqueNote(note = "", addition = "") {
  return uniqueSentenceNote([note, addition].filter(Boolean).join(" "));
}

function isGenericAdviceNote(note = "") {
  const text = String(note || "").trim();
  if (!text) return true;
  return (
    /^(承担主要输出、强化或收尾任务|按[单双]打节奏补足|负责补位|强力|很强|优秀|好用|泛用)/.test(text) ||
    /承担主要输出、强化或收尾任务。?$/.test(text) ||
    /按双打节奏补足守住、控速或站场协作。?$/.test(text) ||
    /按单打节奏补足撒场、清场或终盘路线。?$/.test(text)
  );
}

function generatedAdviceMemberNote(item = {}, mon = null, format = state.format) {
  const text = `${item.role || ""} ${item.item || ""} ${item.ability || ""} ${(item.moves || []).join(" ")} ${mon ? `${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${textOf(mon, "items")}` : ""}`;
  const moves = Array.isArray(item.moves) ? item.moves.filter(Boolean) : [];
  const moveText = moves.join(" / ");
  const roles = mon ? getRoles(mon) : [];
  const atk = mon ? stat(mon, "攻击") : 0;
  const spa = mon ? stat(mon, "特攻") : 0;
  const spe = mon ? stat(mon, "速度") : 0;
  const bulk = mon ? stat(mon, "HP") + stat(mon, "防御") + stat(mon, "特防") : 0;
  const parts = [];
  const add = (value) => {
    if (value && !parts.includes(value)) parts.push(value);
  };

  if (MOVE_PATTERNS.hazard.test(text)) add("负责撒场压血线");
  if (MOVE_PATTERNS.removal.test(text)) add("负责清理撒场");
  if (MOVE_PATTERNS.speedControl.test(text)) add("提供控速");
  if (MOVE_PATTERNS.pivot.test(text)) add("用转场带核心安全上场");
  if (MOVE_PATTERNS.fakeOut.test(text)) add("用击掌抢首回合节奏");
  if (MOVE_PATTERNS.protect.test(text) && format === "double") add("用守住管理集火和回合");
  if (MOVE_PATTERNS.spread.test(text) && format === "double") add("提供双打范围压力");
  if (MOVE_PATTERNS.status.test(text)) add("用状态或干扰限制展开");
  if (MOVE_PATTERNS.sustain.test(text) || /剩饭|文柚果|再生力|leftovers|sitrus|regenerator/i.test(text)) add("承担多次换入");
  if (/讲究围巾|choice scarf/i.test(text) || spe >= 105) add("压高速线或终盘收割");
  if (/生命宝珠|讲究头带|讲究眼镜|适应力|巨大之力|life orb|choice band|choice specs|adaptability|huge power/i.test(text) || Math.max(atk, spa) >= 120) {
    add(atk >= spa ? "承担物理突破" : "承担特殊突破");
  }
  if (/Mega|进化石/i.test(`${item.role || ""} ${item.item || ""}`)) add("作为 Mega 资源点");
  if (!parts.length && roles.includes("耐久位")) add("补防守换入和轮转");
  if (!parts.length && roles.includes("功能位")) add("补队伍功能位");
  if (!parts.length && (roles.includes("高速位") || spe >= 100)) add("补速度线");
  if (!parts.length && bulk >= 285) add("补抗性或耐久中转");
  if (!parts.length) add(format === "double" ? "补双打协作位" : "补单打结构位");

  const lead = item.name ? `${item.name}` : "该成员";
  const detail = moves.length ? `配置侧重 ${moveText.slice(0, 42)}。` : "";
  return `${lead}${parts.slice(0, 3).join("、")}。${detail}`;
}

function normalizeAdviceMemberNote(item = {}, mon = null, format = state.format) {
  const note = uniqueSentenceNote(localizeAdviceText(item.note || ""));
  if (!isGenericAdviceNote(note)) return note;
  const generated = generatedAdviceMemberNote(item, mon, format);
  const itemAdjustment = note.match(/道具已按当前环境常见配置[^。]*。?/);
  return appendUniqueNote(generated, itemAdjustment?.[0] || "");
}

function localTermKey(value = "") {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function cnKey(value = "") {
  return String(value || "").replace(/[^\u3400-\u9fff]+/g, "");
}

function nameMatchesGoal(goal = "", name = "") {
  const source = String(name || "").trim();
  if (!source) return false;
  const lowerGoal = String(goal || "").toLowerCase();
  const compactGoal = idKey(goal);
  const compactGoalCn = cnKey(goal);
  const lowerName = source.toLowerCase();
  const compactName = idKey(source);
  const compactNameCn = cnKey(source);
  if (lowerGoal.includes(lowerName) || (compactName && compactGoal.includes(compactName))) return true;
  if (!compactNameCn || !compactGoalCn) return false;
  const baseNameCn = compactNameCn.replace(/^(超级|超极巨)/, "");
  return (
    compactGoalCn.includes(compactNameCn) ||
    (baseNameCn.length >= 2 && compactGoalCn.includes(baseNameCn)) ||
    (compactGoalCn.length >= 2 && compactNameCn.includes(compactGoalCn))
  );
}

function targetMatchScore(goal = "", target = {}) {
  const names = [target.name, target.slug, target.identifier, target.speciesIdentifier, target.names?.zh, target.names?.en, target.names?.ja].filter(Boolean);
  if (!names.some((name) => nameMatchesGoal(goal, name))) return 0;
  const compactGoalCn = cnKey(goal);
  const compactGoal = idKey(goal);
  const isMegaGoal = /mega/i.test(goal) || compactGoalCn.includes("超级");
  const isMegaTarget = /(^|-)(mega|gmax)(-|$)/i.test(String(target.slug || target.identifier || "")) || String(target.names?.zh || target.name || "").includes("超级");
  const exactCn = names.some((name) => cnKey(name) && cnKey(name) === compactGoalCn);
  const exactId = names.some((name) => idKey(name) && idKey(name) === compactGoal);
  return 1 + Number(exactCn || exactId) * 4 + Number(isMegaGoal && isMegaTarget) * 8 + Number(isMegaTarget) * 1;
}

function localizeTerm(value = "", category = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/[\u3400-\u9fff]/.test(text)) return text;
  const dict = LOCALIZED_TERMS[category] || {};
  return dict[text.toLowerCase()] || dict[localTermKey(text)] || text;
}

function ensureAdviceMove(item = {}, moveName = "") {
  if (!moveName) return item;
  const aliasKey = (move = "") => {
    const text = String(localizeTerm(move, "moves") || move || "");
    const key = localTermKey(text);
    if (/顺风|tailwind/i.test(text) || key === "tailwind") return "顺风";
    if (/戏法空间|trick\s*room/i.test(text) || key === "trickroom") return "戏法空间";
    if (/求雨|雨天|rain\s*dance/i.test(text) || key === "raindance") return "求雨";
    if (/大晴天|晴天|sunny\s*day/i.test(text) || key === "sunnyday") return "大晴天";
    if (/沙暴|sandstorm/i.test(text) || key === "sandstorm") return "沙暴";
    if (/雪景|冰雹|snowscape|hail/i.test(text) || key === "snowscape" || key === "hail") return "雪景";
    return key || cnKey(text) || normalizedItemName(text);
  };
  const moves = (Array.isArray(item.moves) ? item.moves : []).map((move) => localizeTerm(move, "moves")).filter(Boolean);
  if (!moves.some((move) => aliasKey(move) === aliasKey(moveName))) {
    if (moves.length >= 4) moves[moves.length - 1] = moveName;
    else moves.push(moveName);
  }
  item.moves = moves;
  return item;
}

function fallbackAdviceMovesFor(item = {}, mon = null, format = state.format, existingMoves = []) {
  const moves = [];
  const add = (move) => {
    const text = cleanAdviceConfigValue(localizeTerm(move, "moves"), "moves", format);
    if (!text) return;
    const key = localTermKey(text) || cnKey(text) || normalizedItemName(text);
    if (key && !moves.some((own) => (localTermKey(own) || cnKey(own) || normalizedItemName(own)) === key)) moves.push(text);
  };
  existingMoves.forEach(add);
  for (const config of teamLibraryConfigsFor(mon, format).slice(0, 8)) {
    for (const move of config.moves || []) add(move);
  }
  for (const move of mon?.moves || []) add(move?.name || move);
  const context = `${item.name || ""} ${item.slug || ""} ${item.id || ""} ${item.role || ""} ${item.ability || ""} ${(existingMoves || []).join(" ")} ${item.note || ""} ${mon?.name || ""} ${mon?.slug || ""} ${mon?.id || ""}`;

  if (/风妖精|whimsicott/i.test(context)) ["顺风", "月亮之力", "再来一次", "守住", "挑衅", "棉孢子"].forEach(add);
  else if (/大嘴鸥|pelipper/i.test(context)) ["暴风", "气象球", "顺风", "广域防守", "守住"].forEach(add);
  else if (/蚊香蛙皇|politoed/i.test(context)) ["求雨", "水炮", "帮助", "再来一次", "守住"].forEach(add);
  else if (/幽尾玄鱼|basculegion/i.test(context)) ["波动冲", "扫墓", "水流喷射", "守住", "咬碎"].forEach(add);
  else if (/海豚侠|palafin/i.test(context)) ["波动冲", "喷射拳", "快速折返", "健美", "守住"].forEach(add);
  else if (/铝钢桥龙|archaludon/i.test(context)) ["电光束", "流星群", "加农光炮", "守住", "扑击"].forEach(add);
  else if (/洛托姆|rotom/i.test(context)) {
    if (/wash|清洗/i.test(context)) add("水炮");
    if (/mow|cut|切割/i.test(context)) add("飞叶风暴");
    if (/heat|加热/i.test(context)) add("过热");
    if (/frost|结冰/i.test(context)) add("暴风雪");
    ["十万伏特", "伏特替换", "鬼火", "守住"].forEach(add);
  } else if (/喷火龙|charizard/i.test(context)) {
    if (/喷火龙顺风|顺风喷火龙|charizard.*tailwind|tailwind.*charizard/i.test(String(state.aiLastContext?.userGoal || ""))) ["顺风", "守住", "热风", "过热", "喷射火焰"].forEach(add);
    else if (/晴天|日照|大晴天|sun|drought/i.test(String(state.aiLastContext?.userGoal || ""))) ["热风", "气象球", "日光束", "守住", "顺风"].forEach(add);
    else ["热风", "过热", "喷射火焰", "守住", "顺风"].forEach(add);
  }
  else if (/克雷色利亚|cresselia|多边兽2|porygon2|青铜钟|bronzong|奇麒麟|farigiraf|布莉姆温|hatterene|夜巡灵|dusclops|爱管侍|indeedee/i.test(context)) {
    ["戏法空间", "守住", "冰冻之风", "精神强念"].forEach(add);
  }

  const themes = Array.isArray(state.aiLastContext?.intent?.goalConstraints?.themes)
    ? state.aiLastContext.intent.goalConstraints.themes
    : Array.isArray(state.aiLastContext?.goalConstraints?.themes)
      ? state.aiLastContext.goalConstraints.themes
      : [];
  if (themes.includes("tailwind") && /顺风|tailwind|风妖精|whimsicott|大嘴鸥|pelipper|烈箭鹰|talonflame/i.test(context)) add("顺风");
  if (themes.includes("rain") && /雨天|降雨|求雨|大嘴鸥|pelipper|蚊香蛙皇|politoed/i.test(context)) add("求雨");
  if (themes.includes("sun") && /晴天|日照|煤炭龟|torkoal|喷火龙|charizard/i.test(context)) add("大晴天");
  if (themes.includes("trick-room") && /空间|戏法空间|trick|克雷色利亚|cresselia|多边兽2|porygon2/i.test(context)) add("戏法空间");
  if (themes.includes("sand") && /沙暴|扬沙|班基拉斯|tyranitar|河马兽|hippowdon/i.test(context)) add("沙暴");
  if (themes.includes("snow") && /雪天|雪景|降雪|九尾|ninetales|暴雪王|abomasnow/i.test(context)) add("雪景");
  if (format === "double") add("守住");
  ["守住", "替身", "挑衅", "急速折返"].forEach(add);
  return moves.slice(0, 4);
}

function fallbackAdviceAbilityFor(item = {}, mon = null) {
  const abilityText = (mon?.abilities || []).map((ability) => ability?.name || ability).filter(Boolean).join(" ");
  const text = `${item.name || ""} ${item.slug || ""} ${item.id || ""} ${item.role || ""} ${mon?.name || ""} ${mon?.slug || ""} ${mon?.id || ""} ${abilityText}`;
  if (/大嘴鸥|pelipper|蚊香蛙皇|politoed/i.test(text)) return "降雨";
  if (/煤炭龟|torkoal/i.test(text)) return "日照";
  if (/班基拉斯|tyranitar|河马兽|hippowdon|庞岩怪|gigalith/i.test(text)) return "扬沙";
  if (/阿罗拉.*九尾|九尾.*阿罗拉|ninetales.*alola|alolan.*ninetales|暴雪王|abomasnow/i.test(text)) return "降雪";
  if (/风妖精|whimsicott/i.test(text)) return "恶作剧之心";
  if (/烈箭鹰|talonflame/i.test(text)) return "疾风之翼";
  if (/海豚侠|palafin/i.test(text)) return "全能变身";
  if (/妙蛙花|venusaur/i.test(text)) return /晴天|日照|叶绿素|chlorophyll/i.test(text) ? "叶绿素" : "茂盛";
  if (/谜拟|mimikyu/i.test(text)) return "画皮";
  if (/多龙巴鲁托|dragapult/i.test(text)) return "恒净之躯";
  if (/流氓鳄|krookodile|风速狗|arcanine|炽焰咆哮虎|incineroar/i.test(text)) return "威吓";
  if (/象牙猪|mamoswine/i.test(text)) return "迟钝";
  if (/甜冷美后|tsareena/i.test(text)) return "女王的威严";
  if (/重泥挽马|mudsdale/i.test(text)) return "持久力";
  if (/加热洛托姆|清洗洛托姆|切割洛托姆|结冰洛托姆|洛托姆|rotom/i.test(text)) return "漂浮";
  return "";
}

function localizeAdviceText(value = "") {
  let text = String(value || "");
  if (!text) return "";
  const replacements = {
    "charizardite-y": "喷火龙进化石 Y",
    "charizardite-x": "喷火龙进化石 X",
    dragoninite: "快龙进化石",
    emboarite: "炎武王进化石",
    chesnaughtite: "布里卡隆进化石",
    "chople-berry": "抗斗果",
    "passho-berry": "抗水果",
    "passho berry": "抗水果",
    "gyaradosite": "暴鲤龙进化石",
    "ギャラドスナイト": "暴鲤龙进化石",
    "figy-berry": "勿花果",
    "focus-sash": "气势披带",
    "sitrus-berry": "文柚果",
    "heat-wave": "热风",
    "earth-power": "大地之力",
    "fake-out": "击掌奇袭",
    "throat-chop": "地狱突刺",
    "parting-shot": "抛下狠话",
    "flare-blitz": "闪焰冲锋",
    "dragon-claw": "龙爪",
    "rock-slide": "岩崩",
    "rapid-spin": "高速旋转",
    "hydro-pump": "水炮",
    "electro-shot": "电光束",
    "flash-cannon": "加农光炮",
    "draco-meteor": "流星群",
    "weather-ball": "气象球",
    "snarl": "大声咆哮",
    "rain-dance": "求雨",
    "sunny-day": "大晴天",
    "sandstorm": "沙暴",
    "snowscape": "雪景",
    "aurora-veil": "极光幕",
    "icy-wind": "冰冻之风",
    "thunder-wave": "电磁波",
    "baton-pass": "接棒",
    "u-turn": "急速折返",
    "volt-switch": "伏特替换",
    "choice-scarf": "讲究围巾",
    "life-orb": "生命宝珠",
    "mental-herb": "心灵香草",
    "covert-cloak": "密探斗篷",
    "trick-room": "戏法空间",
    "Great Tusk": "雄伟牙",
    "Gholdengo": "赛富豪",
    "Incineroar": "炽焰咆哮虎",
    "Landorus": "土地云",
    "Flutter Mane": "振翼发",
    "Iron Bundle": "铁包袱",
    "Walking Wake": "波荡水",
    "Chi-Yu": "古玉鱼",
    "Archaludon": "铝钢桥龙",
    "Hydreigon": "三首恶龙",
    "Gyarados": "暴鲤龙",
    "Pelipper": "大嘴鸥",
    "Whimsicott": "风妖精",
    "Talonflame": "烈箭鹰",
    "Charizard": "喷火龙",
    "Basculegion": "幽尾玄鱼",
    "Rotom-Wash": "清洗洛托姆",
    "Rotom-Mow": "切割洛托姆",
    "Rotom-Heat": "加热洛托姆",
    charcoal: "木炭",
    eruption: "喷火",
    leftovers: "剩饭",
    Mega: "超级",
    "trick room": "戏法空间",
    "with": "搭配",
    "and": "和",
    "under": "在",
    "uses": "使用",
    "use": "使用",
    "mode": "模式",
    "attacker": "打手",
    "support": "辅助",
    "setter": "开启手",
    "rain setter": "雨天开启手",
    "sun setter": "晴天开启手",
    "rain abuser": "雨天收益位",
    "sun abuser": "晴天收益位",
    "tailwind setter": "顺风控速手",
    "rain": "雨天",
    "sun": "晴天",
    "special attacker": "特攻打手",
    "physical attacker": "物攻打手",
    "wallbreaker": "破盾手",
    "pivot": "轮转位",
    "sweeper": "清场手",
    "bulky": "耐久",
    "fast": "高速",
    "HP": "HP",
    "Atk": "攻击",
    "Def": "防御",
    "SpA": "特攻",
    "SpD": "特防",
    "Spe": "速度",
  };
  for (const [from, to] of Object.entries(replacements).sort((a, b) => b[0].length - a[0].length)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = /[a-z]/i.test(from) ? "gi" : "g";
    if (/^[A-Za-z][A-Za-z\s-]*$/.test(from)) {
      text = text.replace(new RegExp(`(^|[^A-Za-z0-9_-])(${escaped})(?=$|[^A-Za-z0-9_-])`, flags), (match, prefix) => `${prefix}${to}`);
    } else {
      text = text.replace(new RegExp(escaped, flags), to);
    }
  }
  const phraseEntries = Object.values(LOCALIZED_TERMS)
    .flatMap((dict) => Object.entries(dict))
    .filter(([from, to]) => from && to && from !== to && /[^a-z0-9]/i.test(from))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of phraseEntries) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(^|[^A-Za-z0-9_-])(${escaped})(?=$|[^A-Za-z0-9_-])`, /[a-z]/i.test(from) ? "gi" : "g"), (match, prefix) => `${prefix}${to}`);
  }
  text = text.replace(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[A-Za-z][A-Za-z0-9]+/g, (token) => {
    for (const category of ["items", "moves", "abilities", "natures"]) {
      const translated = localizeTerm(token, category);
      if (translated && translated !== token) return translated;
    }
    const pokemonName = localizePokemonName(token);
    if (pokemonName && pokemonName !== token) return pokemonName;
    return token;
  });
  return text;
}

function localizePokemonName(value = "") {
  const text = String(value || "").trim();
  if (!text || /[\u3400-\u9fff]/.test(text)) return text;
  const key = idKey(text);
  const pokemonAliases = {
    staraptor: "姆克鹰",
    staraptormega: "超级姆克鹰",
    greattusk: "雄伟牙",
    gholdengo: "赛富豪",
    incineroar: "炽焰咆哮虎",
    landorus: "土地云",
    landorustherian: "土地云-灵兽",
    landorusincarnate: "土地云-化身",
    archaludon: "铝钢桥龙",
    hydreigon: "三首恶龙",
    gyarados: "暴鲤龙",
    pelipper: "大嘴鸥",
    whimsicott: "风妖精",
    talonflame: "烈箭鹰",
    tornadus: "龙卷云",
    charizard: "喷火龙",
    kingdra: "刺龙王",
    ludicolo: "乐天河童",
    barraskewda: "戽斗尖梭",
    swampert: "巨沼怪",
    drednaw: "暴噬龟",
    basculegion: "幽尾玄鱼",
    basculegionfemale: "幽尾玄鱼（雌性）",
    basculegionmale: "幽尾玄鱼",
    palafin: "海豚侠",
    rotomwash: "清洗洛托姆",
    rotommow: "切割洛托姆",
    rotomheat: "加热洛托姆",
    rotomfrost: "结冰洛托姆",
    rotomfan: "旋转洛托姆",
    rotom: "洛托姆",
    infernape: "烈焰猴",
    cresselia: "克雷色利亚",
    porygon2: "多边兽2",
    bronzong: "青铜钟",
    farigiraf: "奇麒麟",
    hatterene: "布莉姆温",
    dusclops: "夜巡灵",
    indeedee: "爱管侍",
    torkoal: "煤炭龟",
    ninetales: "九尾",
    venusaur: "妙蛙花",
    excadrill: "龙头地鼠",
    tyranitar: "班基拉斯",
    hippowdon: "河马兽",
    gigalith: "庞岩怪",
    abomasnow: "暴雪王",
    cetitan: "浩大鲸",
    baxcalibur: "冻脊龙",
    ironbundle: "铁包袱",
    fluttermane: "振翼发",
    chiyu: "古玉鱼",
  };
  if (pokemonAliases[key]) return pokemonAliases[key];
  const fromCurrent = state.data?.pokemon?.find((mon) => [mon.slug, mon.name, knowledgeEntryFor(mon)?.showdown?.name].some((name) => idKey(name) === key));
  if (fromCurrent?.name) return fromCurrent.name;
  const data = currentPokeCampData();
  const fromPokeCamp = data?.pokemonList?.find((mon) => [mon.identifier, mon.speciesIdentifier, mon.names?.en, mon.names?.zh].some((name) => idKey(name) === key));
  return fromPokeCamp?.names?.zh || text;
}

function localizeAdviceItem(item = {}) {
  return {
    ...item,
    name: localizePokemonName(item.name || item.id || item.slug || ""),
    item: localizeTerm(item.item, "items"),
    ability: localizeTerm(item.ability, "abilities"),
    nature: localizeTerm(item.nature, "natures"),
    role: localizeAdviceText(item.role || ""),
    note: localizeAdviceText(item.note || ""),
    evs: localizeAdviceText(item.evs || ""),
    moves: Array.isArray(item.moves) ? item.moves.map((move) => localizeTerm(move, "moves")) : item.moves,
  };
}

function adviceConfigPoolsForMon(mon, format = state.format) {
  if (!mon) {
    return {
      moves: new Set(),
      items: new Set(),
      abilities: new Set(),
      natures: new Set(),
      fallbackConfig: {},
    };
  }
  const configs = teamLibraryConfigsFor(mon, format).slice(0, 4);
  const fallbackConfig = configs[0] || defaultConfigFor(mon) || {};
  const pools = {
    moves: new Set(),
    items: new Set(),
    abilities: new Set(),
    natures: new Set(),
    fallbackConfig,
  };
  const add = (pool, value, category) => {
    const text = usableConfigValue(value, category);
    if (text) pool.add(normalizedItemName(text));
  };
  for (const config of [fallbackConfig, ...configs]) {
    add(pools.items, config.item, "items");
    add(pools.abilities, config.ability, "abilities");
    add(pools.natures, config.nature, "natures");
    for (const move of config.moves || []) add(pools.moves, move, "moves");
  }
  for (const move of mon.moves || []) add(pools.moves, move?.name || move, "moves");
  for (const item of mon.items || []) add(pools.items, item?.name || item, "items");
  for (const ability of mon.abilities || []) add(pools.abilities, ability?.name || ability, "abilities");
  for (const nature of mon.natures || []) add(pools.natures, nature?.name || nature, "natures");
  return pools;
}

function idKey(value = "") {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function topNames(entries = [], limit = 2) {
  return entries
    .slice(0, limit)
    .filter((item) => item?.name)
    .map((item) => `${item.name}${item.percentage ? ` ${pct(item.percentage)}` : ""}`)
    .join(" / ");
}

function stat(pokemon, label) {
  return Number(pokemon?.stats?.[label] || 0);
}

function textOf(pokemon, key) {
  const isTeamMember = state.team.some((mon) => mon.slug === pokemon?.slug || Number(mon.id) === Number(pokemon?.id));
  if (isTeamMember && ["moves", "items", "abilities"].includes(key)) {
    const config = editableConfigFor(pokemon);
    if (key === "moves") return (config.moves || []).join(" ");
    if (key === "items") return config.item || "";
    if (key === "abilities") return config.ability || "";
  }
  return (pokemon?.[key] || []).map((item) => item.name).join(" ");
}

function hasMove(pokemon, pattern) {
  return pattern.test(textOf(pokemon, "moves"));
}

function hasAbility(pokemon, pattern) {
  return pattern.test(textOf(pokemon, "abilities"));
}

function hasItem(pokemon, pattern) {
  return pattern.test(textOf(pokemon, "items"));
}

const MOVE_PATTERNS = {
  hazard: /隐形岩|撒菱|毒菱|黏黏网|ステルスロック|まきびし|どくびし|ねばねばネット|stealth rock|spikes|toxic spikes|sticky web/i,
  removal: /高速旋转|清除浓雾|こうそくスピン|きりばらい|rapid spin|defog/i,
  setup: /剑舞|龙舞|诡计|冥想|健美|蝶舞|破壳|腹鼓|つるぎのまい|りゅうのまい|わるだくみ|めいそう|ビルドアップ|ちょうのまい|からをやぶる|はらだいこ|swords dance|dragon dance|nasty plot|calm mind|bulk up|quiver dance|shell smash|belly drum/i,
  speedControl: /顺风|电磁波|戏法空间|冰冻之风|岩石封锁|黏黏网|おいかぜ|でんじは|トリックルーム|こごえるかぜ|がんせきふうじ|ねばねばネット|tailwind|thunder wave|trick room|icy wind|rock tomb|sticky web/i,
  pivot: /急速折返|伏特替换|抛下狠话|接棒|とんぼがえり|ボルトチェンジ|すてゼリフ|バトンタッチ|u-turn|volt switch|parting shot|baton pass/i,
  priority: /神速|突袭|子弹拳|水流喷射|冰砾|影子偷袭|音速拳|击掌奇袭|しんそく|ふいうち|バレットパンチ|アクアジェット|こおりのつぶて|かげうち|マッハパンチ|ねこだまし|extreme speed|sucker punch|bullet punch|aqua jet|ice shard|shadow sneak|mach punch|fake out/i,
  protect: /守住|看穿|まもる|みきり|protect|detect/i,
  fakeOut: /击掌奇袭|ねこだまし|fake out/i,
  intimidate: /威吓|いかく|intimidate/i,
  redirection: /看我嘛|愤怒粉|このゆびとまれ|いかりのこな|follow me|rage powder/i,
  spread: /地震|岩崩|热风|魔法闪耀|喷水|喷火|暴风雪|放电|じしん|いわなだれ|ねっぷう|マジカルシャイン|しおふき|ふんか|ふぶき|ほうでん|earthquake|rock slide|heat wave|dazzling gleam|water spout|eruption|blizzard|discharge/i,
  status: /剧毒|电磁波|鬼火|挑衅|どくどく|でんじは|おにび|ちょうはつ|toxic|thunder wave|will-o-wisp|taunt/i,
  sustain: /自我再生|羽栖|月光|晨光|光合作用|じこさいせい|はねやすめ|つきのひかり|あさのひざし|こうごうせい|recover|roost|moonlight|morning sun|synthesis/i,
};

const ROLE_TEMPLATES = {
  garchomp: {
    roles: ["地面物攻核心", "撒场压制", "围巾清场"],
    notes: ["常用来压制电/钢/火位，也能用隐形岩建立单打节奏。", "如果携带围巾，重点是中后期清场；如果携带气势披带，更像开局压制。"],
  },
  charizard: {
    roles: ["Mega 核心", "晴天输出", "终盘强化"],
    notes: ["需要保护进场和岩石抗性压力，队伍最好有清场/除钉或强换入节奏。"],
  },
  kangaskhan: {
    roles: ["Mega 普通核心", "击掌/先制压制", "换血突破"],
    notes: ["适合作为进攻轴起点，队伍需要处理格斗和鬼系换入。"],
  },
  gengar: {
    roles: ["高速干扰", "鬼毒压制", "状态/收割"],
    notes: ["适合补高速控制和对受队压力，但需要避免被先制和围巾位反杀。"],
  },
  primarina: {
    roles: ["特殊破坏", "水妖联防", "龙/恶压制"],
    notes: ["能补龙、恶、火等对位，但速度线偏慢，需要控速或安全换入。"],
  },
  corviknight: {
    roles: ["物理中转", "地面免疫", "清场/轮转"],
    notes: ["适合补换入链和地面免疫，能缓解队伍被物攻滚雪球。"],
  },
  duraludon: {
    roles: ["钢龙炮台", "妖精/龙抗性", "特攻压制"],
    notes: ["能补钢系联防和特殊输出，但需要注意地面与格斗压力。"],
  },
  incineroar: {
    roles: ["威吓枢纽", "击掌辅助", "轮转"],
    notes: ["双打常见节奏位，能帮核心获得安全行动回合。"],
  },
  rillaboom: {
    roles: ["青草场地", "击掌辅助", "先制草压制"],
    notes: ["适合帮队伍控地面伤害和补先制节奏。"],
  },
  amoonguss: {
    roles: ["掩护辅助", "催眠干扰", "空间/慢速轴"],
    notes: ["双打能用愤怒粉和蘑菇孢子保护核心，但要处理挑衅和草系免疫。"],
  },
};

function effectiveSpeed(pokemon) {
  const base = stat(pokemon, "速度");
  const boosts = [];
  if (hasItem(pokemon, /讲究围巾/)) boosts.push({ label: "围巾", value: Math.floor(base * 1.5) });
  if (hasMove(pokemon, MOVE_PATTERNS.speedControl)) boosts.push({ label: "控速", value: base * 2 });
  if (hasAbility(pokemon, /悠游自如|叶绿素|拨沙|拨雪|轻装|加速/)) boosts.push({ label: "特性加速", value: base * 2 });
  return boosts.sort((a, b) => b.value - a.value)[0] || { label: "原速", value: base };
}

function currentPokeCampData() {
  const regulations = state.battleKnowledgeData?.pokeCamp || {};
  const entries = Object.entries(regulations);
  if (!entries.length) return null;
  const preferredSeason = state.data?.season || state.rawData?.season || state.teamData?.season;
  if (preferredSeason && regulations[preferredSeason]) return regulations[preferredSeason];
  const seasonAliases = {
    "M-1": "M-A",
    "M-2": "M-B",
  };
  const alias = seasonAliases[preferredSeason];
  if (alias && regulations[alias]) return regulations[alias];
  const withPresets = entries.find(([, data]) => Object.keys(data.speedline?.presets || {}).length);
  return (withPresets || entries[0])[1];
}

function pokeCampEntryFor(mon) {
  const data = currentPokeCampData();
  if (!data?.pokemonList?.length) return null;
  const targetId = Number(mon.id);
  const targetKeys = new Set([idKey(mon.slug), idKey(mon.name)].filter(Boolean));
  return (
    data.pokemonList.find((entry) => Number(entry.id) === targetId) ||
    data.pokemonList.find((entry) => [entry.identifier, entry.speciesIdentifier, entry.names?.zh, entry.names?.ja, entry.names?.en].some((value) => targetKeys.has(idKey(value))))
  );
}

function pokeCampSpeedPresetFor(mon, format = state.format) {
  const data = currentPokeCampData();
  const entry = pokeCampEntryFor(mon);
  if (!data?.speedline?.presets || !entry) return null;
  const preset = data.speedline.presets[entry.identifier] || data.speedline.presets[entry.speciesIdentifier];
  if (!preset) return null;
  const key = format === "double" ? "doubles" : "singles";
  return preset[key]?.natureId ? preset[key] : preset.all?.natureId ? preset.all : null;
}

function speedPresetNote(mon) {
  const preset = pokeCampSpeedPresetFor(mon);
  if (!preset) return "";
  const parts = [];
  if (preset.natureId) parts.push(`性格 ${preset.natureId}`);
  if (Number.isFinite(Number(preset.speedSp))) parts.push(`速度点 ${preset.speedSp}`);
  if (preset.speedSpPercentage) parts.push(`占比 ${pct(preset.speedSpPercentage)}`);
  return parts.join("，");
}

function absolutePokeCampAsset(url = "") {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `https://pokecamp.cc${url.startsWith("/") ? "" : "/"}${url}`;
}

function aiApiUrl(path) {
  const base = window.location.port === "4174"
    ? ""
    : "http://127.0.0.1:4174";
  return `${base}${path}`;
}

function speedlinePresetForIdentifier(identifier = "") {
  const data = currentPokeCampData();
  if (!identifier || !data?.speedline?.presets) return null;
  const entry = data.pokemonList?.find((item) => String(item.id) === String(identifier) || String(item.speciesIdentifier) === String(identifier) || String(item.identifier) === String(identifier));
  const keyId = entry?.identifier || entry?.speciesIdentifier || identifier;
  const preset = data.speedline.presets[keyId];
  if (!preset) return null;
  const key = state.format === "double" ? "doubles" : "singles";
  return preset[key]?.natureId ? preset[key] : preset.all?.natureId ? preset.all : null;
}

function level50Speed(baseSpeed = 0, { ev = 252, iv = 31, nature = 1.1 } = {}) {
  const base = Number(baseSpeed || 0);
  if (!base) return 0;
  const raw = Math.floor(((2 * base + Number(iv) + Math.floor(Number(ev) / 4)) * 50) / 100 + 5);
  return Math.floor(raw * Number(nature || 1));
}

function speedlineDetailUrl(mon = {}) {
  const id = mon.id || mon.linkId;
  return id ? `https://pokecamp.cc/zh/champions/pokemon/${encodeURIComponent(id)}` : "https://pokecamp.cc/zh/champions/speedline";
}

function speedlinePokemonSprite(mon = {}) {
  const data = currentPokeCampData();
  const entry = data?.pokemonList?.find((item) => Number(item.id) === Number(mon.id) || Number(item.id) === Number(mon.linkId) || item.names?.zh === mon.name);
  const local = state.data?.pokemon?.find((item) => Number(item.id) === Number(mon.id) || Number(item.id) === Number(mon.linkId) || item.name === mon.name);
  return absolutePokeCampAsset(entry?.sprite || local?.sprite || mon.sprite);
}

function getRoles(pokemon) {
  const roles = new Set();
  const moves = textOf(pokemon, "moves");
  const abilities = textOf(pokemon, "abilities");
  const items = textOf(pokemon, "items");
  if (stat(pokemon, "攻击") >= 115 || MOVE_PATTERNS.setup.test(moves)) roles.add("物理输出");
  if (stat(pokemon, "特攻") >= 115 || MOVE_PATTERNS.setup.test(moves)) roles.add("特殊输出");
  if (stat(pokemon, "速度") >= 100) roles.add("高速位");
  if (stat(pokemon, "HP") + stat(pokemon, "防御") + stat(pokemon, "特防") >= 290) roles.add("耐久位");
  if (MOVE_PATTERNS.hazard.test(moves) || MOVE_PATTERNS.status.test(moves) || MOVE_PATTERNS.speedControl.test(moves) || MOVE_PATTERNS.fakeOut.test(moves) || MOVE_PATTERNS.protect.test(moves) || MOVE_PATTERNS.redirection.test(moves)) roles.add("功能位");
  if (/威吓|いかく|再生力|さいせいりょく|魔法镜|マジックミラー|粗糙皮肤|さめはだ|恶作剧之心|いたずらごころ|友情防守|フレンドガード|避雷针|ひらいしん/.test(abilities)) roles.add("特性价值");
  if (/气势披带|讲究|生命宝珠|突击背心|吃剩的东西|防尘护目镜/.test(items)) roles.add("标准配置");
  return [...roles];
}

const ATTACK_TYPE_HINTS = [
  ["Fire", /火|炎|喷火|热风|过热|喷射火焰|闪焰冲锋|eruption|heat wave|overheat|flamethrower|flare blitz|lava plume/i],
  ["Water", /水|水炮|波动冲|水流裂破|水流喷射|热水|hydro pump|wave crash|liquidation|aqua jet|scald|water spout/i],
  ["Electric", /电|打雷|十万伏特|伏特替换|电光束|thunder|thunderbolt|volt switch|electro shot|wild charge/i],
  ["Grass", /草|日光束|强力鞭打|能量球|木槌|solar beam|power whip|energy ball|wood hammer|leaf storm/i],
  ["Ice", /冰|暴风雪|冰冻光束|冰砾|冰冻之风|三旋击|blizzard|ice beam|ice shard|icy wind|triple axel/i],
  ["Fighting", /格斗|近身战|波导弹|吸取拳|踢倒|close combat|aura sphere|drain punch|low kick|body press/i],
  ["Poison", /毒|污泥炸弹|污泥波|克命爪|sludge bomb|sludge wave|dire claw|gunk shot/i],
  ["Ground", /地面|地震|大地之力|跺脚|earthquake|earth power|stomping tantrum|high horsepower/i],
  ["Flying", /飞行|勇鸟猛攻|暴风|空气斩|双翼|brave bird|hurricane|air slash|dual wingbeat/i],
  ["Psychic", /超能力|精神强念|广域战力|psychic|psyshock|expanding force/i],
  ["Bug", /虫|急速折返|u-turn|bug buzz|megahorn/i],
  ["Rock", /岩石|岩崩|岩石封锁|力量宝石|尖石攻击|rock slide|rock tomb|power gem|stone edge/i],
  ["Ghost", /幽灵|暗影球|影子偷袭|扫墓|灵骚|shadow ball|shadow sneak|last respects|poltergeist/i],
  ["Dragon", /龙|龙爪|龙之波动|流星群|逆鳞|鳞射|dragon claw|dragon pulse|draco meteor|outrage|scale shot/i],
  ["Dark", /恶|突袭|恶之波动|拍落|仆刀|地狱突刺|sucker punch|dark pulse|knock off|kowtow cleave|throat chop/i],
  ["Steel", /钢|铁头|加农光炮|子弹拳|巨兽斩|iron head|flash cannon|bullet punch|behemoth blade/i],
  ["Fairy", /妖精|月亮之力|魔法闪耀|嬉闹|破灭之光|moonblast|dazzling gleam|play rough|light of ruin/i],
];

function pokemonUsageProfile(mon, format = state.format) {
  const usage = externalKnowledgeFor(mon, format)?.usage || null;
  const sets = rankedTeamLibrarySetsFor(mon, 3);
  const topMoves = [
    ...(sets.flatMap((set) => set.moves || [])),
    ...(usage?.moves || []).map((item) => item.name),
    ...(mon.moves || []).map((item) => item.name),
  ];
  const topItems = [
    ...sets.map((set) => set.item),
    ...(usage?.items || []).map((item) => item.name),
    ...(mon.items || []).map((item) => item.name),
  ];
  const topAbilities = [
    ...sets.map((set) => set.ability),
    ...(usage?.abilities || []).map((item) => item.name),
    ...(mon.abilities || []).map((item) => item.name),
    ...Object.values(knowledgeEntryFor(mon)?.showdown?.abilities || {}),
  ];
  const unique = (values, category, limit) => [...new Set(values.map((value) => localizeTerm(value, category)).filter(knownConfigValue))].slice(0, limit);
  return {
    source: usage?.format ? `环境统计 ${usage.format}` : sets.length ? "玩家上传队伍" : "本地规则数据",
    moves: unique(topMoves, "moves", 8),
    items: unique(topItems, "items", 5),
    abilities: unique(topAbilities, "abilities", 4),
    teammates: (usage?.teammates || []).slice(0, 6).map((item) => localizePokemonName(item.name)),
  };
}

function roleProfileFor(mon, format = state.format) {
  const roles = getRoles(mon);
  const template = roleTemplateFor(mon);
  const usage = pokemonUsageProfile(mon, format);
  const speed = effectiveSpeed(mon);
  const bulk = stat(mon, "HP") + stat(mon, "防御") + stat(mon, "特防");
  const strengths = [];
  const cautions = [];
  if (template?.roles?.length) strengths.push(...template.roles.slice(0, 3));
  if (roles.includes("高速位")) strengths.push(`速度线 ${speed.value}，可承担先手压制`);
  if (roles.includes("耐久位")) strengths.push("可承担换入或中转职责");
  if (roles.includes("功能位")) strengths.push("具备控速/状态/保护/干扰等功能价值");
  if (stat(mon, "攻击") >= 115) strengths.push("物理输出端充足");
  if (stat(mon, "特攻") >= 115) strengths.push("特殊输出端充足");
  if (bulk < 230 && !roles.includes("高速位")) cautions.push("耐久与速度都不突出，需要队友创造行动回合");
  if (speed.value < 80 && !/戏法空间|trick room/i.test(usage.moves.join(" "))) cautions.push("速度偏慢，最好搭配空间、顺风或安全换入");
  if (usage.items.includes("讲究围巾") || usage.items.includes("讲究头带") || usage.items.includes("讲究眼镜")) cautions.push("讲究道具会锁招，队伍要准备换人节奏");
  return {
    roles: [...new Set([...roles, ...(template?.roles || [])])].slice(0, 6),
    strengths: [...new Set(strengths)].slice(0, 5),
    cautions: [...new Set([...(template?.notes || []), ...cautions])].slice(0, 4),
    common: usage,
  };
}

function pokemonSummary(mon) {
  return {
    id: mon.id,
    name: mon.name,
    slug: mon.slug,
    rank: mon.rank,
    types: mon.types,
    stats: mon.stats,
    effectiveSpeed: effectiveSpeed(mon),
    commonMoves: mon.moves?.slice(0, 8),
    commonItems: mon.items?.slice(0, 5),
    teamLibraryItems: recommendedItemsFor(mon, new Set(), 6).map((item) => ({ name: item.name, count: item.count, score: item.score })),
    teamLibrarySets: rankedTeamLibrarySetsFor(mon, 5),
    commonAbilities: mon.abilities?.slice(0, 5),
    commonNatures: mon.natures?.slice(0, 5),
    roles: getRoles(mon),
    roleProfile: roleProfileFor(mon),
    nameMap: nameMapFor(mon),
    roleTemplate: roleTemplateFor(mon),
    externalKnowledge: externalKnowledgeFor(mon),
    pokeCamp: pokeCampEntryFor(mon),
    speedPreset: pokeCampSpeedPresetFor(mon),
    importedConfig: importedConfigFor(mon),
    customConfig: editableConfigFor(mon),
  };
}

function externalKnowledgeFor(mon, format = state.format) {
  const entry = knowledgeEntryFor(mon);
  if (!entry) return null;
  const preferredFormats =
    format === "double"
      ? ["gen9doublesou", "gen9vgc2026", "gen9vgc2025", "gen9ou"]
      : ["gen9ou", "gen9nationaldex", "gen9doublesou"];
  const smogonFormat = preferredFormats.find((item) => entry.smogon?.[item]) || Object.keys(entry.smogon || {})[0] || "";
  const smogon = smogonFormat ? entry.smogon[smogonFormat] : null;
  return {
    source: smogon ? `Smogon ${smogonFormat}` : "Pokemon Showdown",
    showdown: entry.showdown
      ? {
          types: entry.showdown.types,
          baseStats: entry.showdown.baseStats,
          tier: entry.showdown.tier,
          abilities: entry.showdown.abilities,
        }
      : null,
    usage: smogon
      ? {
          format: smogonFormat,
          usage: smogon.usage,
          items: smogon.items?.slice(0, 5),
          abilities: smogon.abilities?.slice(0, 4),
          moves: smogon.moves?.slice(0, 8),
          teammates: smogon.teammates?.slice(0, 6),
          teraTypes: smogon.teraTypes?.slice(0, 5),
          spreads: smogon.spreads?.slice(0, 4),
          counters: smogon.counters?.slice(0, 5),
        }
      : null,
  };
}

function knowledgeEntryFor(mon) {
  const cache = state.battleKnowledgeData;
  if (!cache?.pokemon || !mon) return null;
  const megaShowdownKey = String(mon.slug || "").endsWith("-mega") ? `${String(mon.slug).replace(/-mega$/, "")}mega` : "";
  const keys = [mon.slug, megaShowdownKey, mon.name, mon.id, mon.pokeCamp?.identifier, mon.pokeCamp?.speciesIdentifier].map(idKey).filter(Boolean);
  const direct = keys.map((key) => cache.pokemon[key]).find(Boolean);
  if (direct) return direct;
  const numericId = Number(mon.id);
  if (Number.isFinite(numericId)) {
    return Object.values(cache.pokemon).find((entry) => Number(entry?.showdown?.num) === numericId) || null;
  }
  return null;
}

function megaProfileFor(mon) {
  const slug = String(mon?.slug || "");
  const isMega = /mega/i.test(slug) || slug.endsWith("-mega") || String(mon?.name || "").includes("超级");
  if (!isMega) return null;
  const finalAbilities = [
    ...Object.values(knowledgeEntryFor(mon)?.showdown?.abilities || {}),
    ...(mon.abilities || []).map((item) => item.name),
  ].map((name) => localizeTerm(name, "abilities")).filter(knownConfigValue);
  const baseSlug = mon.baseSlug || slug.replace(/-?mega$/i, "");
  const baseEntry = knowledgeEntryFor({ slug: baseSlug });
  const preMegaAbilities = [
    ...(mon.preMegaAbilities || []).map((item) => item.name),
    ...Object.values(baseEntry?.showdown?.abilities || {}),
  ].map((name) => localizeTerm(name, "abilities")).filter(knownConfigValue);
  return {
    isMega: true,
    baseName: mon.baseName || localizePokemonName(baseEntry?.showdown?.name || baseSlug),
    baseSlug,
    preMegaAbilities: [...new Set(preMegaAbilities)].slice(0, 4),
    finalAbilities: [...new Set(finalAbilities)].slice(0, 4),
    priorityRule: "反制结论以 Mega 后最终特性为准；普通形态/进场前特性只用于判断首回合进场风险。",
  };
}

function nameMapFor(mon) {
  const imported = importedConfigFor(mon);
  const showdown = knowledgeEntryFor(mon)?.showdown;
  return {
    champion: mon?.name || "",
    imported: imported?.name || "",
    slug: mon?.slug || "",
    showdown: showdown?.name || showdownSpeciesName(mon),
    id: mon?.id || "",
  };
}

function roleTemplateFor(mon) {
  const keys = [mon?.slug, knowledgeEntryFor(mon)?.showdown?.name, mon?.name].map(idKey).filter(Boolean);
  return keys.map((key) => ROLE_TEMPLATES[key]).find(Boolean) || null;
}

function goalText() {
  return $("#ai-user-goal")?.value?.trim() || "";
}

function requestedBattleFormat(goal = "") {
  const text = `${goal} ${String(goal || "").toLowerCase()}`;
  const asksSingle = /单打|单人对战|1v1|singles?/.test(text);
  const asksDouble = /双打|双人对战|2v2|doubles?/.test(text);
  if (asksSingle && !asksDouble) return "single";
  if (asksDouble && !asksSingle) return "double";
  return "";
}

function goalMatchesPokemon(goal = "", mon) {
  const names = [
    mon.name,
    mon.slug,
    knowledgeEntryFor(mon)?.showdown?.name,
    pokeCampEntryFor(mon)?.names?.zh,
    pokeCampEntryFor(mon)?.names?.en,
    pokeCampEntryFor(mon)?.identifier,
  ].filter(Boolean);
  return names.some((name) => nameMatchesGoal(goal, name));
}

function targetPokemonFromGoal(goal = goalText()) {
  if (!goal) return [];
  const fromKnowledge = [];
  const matchedAlias = TARGET_NAME_ALIASES.find((alias) => alias.pattern.test(goal));
  const matchedAliasKeys = new Set((matchedAlias?.keys || []).map(idKey));
  for (const alias of matchedAlias ? [matchedAlias] : []) {
    for (const key of alias.keys) {
      const entry = state.battleKnowledgeData?.pokemon?.[key];
      const mon = entry?.showdown
        ? {
            id: entry.showdown.num || key,
            slug: entry.showdown.id || key,
            name: localizePokemonName(entry.showdown.name) || entry.showdown.name,
            rank: 9999,
            types: (entry.showdown.types || []).map((type) => TYPE_EN_TO_CN[String(type).toLowerCase()] || type),
            stats: {
              HP: entry.showdown.baseStats?.hp || 0,
              攻击: entry.showdown.baseStats?.atk || 0,
              防御: entry.showdown.baseStats?.def || 0,
              特攻: entry.showdown.baseStats?.spa || 0,
              特防: entry.showdown.baseStats?.spd || 0,
              速度: entry.showdown.baseStats?.spe || 0,
            },
            moves: [],
            items: [],
            abilities: Object.values(entry.showdown.abilities || {}).map((name) => ({ name: localizeTerm(name, "abilities") })),
            natures: [],
            externalTarget: true,
          }
        : alias.fallback
          ? { ...alias.fallback, rank: 9999, moves: [], items: [], natures: [], externalTarget: true }
          : null;
      if (!mon) continue;
      fromKnowledge.push({
        mon,
        score: 99,
      });
    }
  }
  const fromCurrent =
    state.data?.pokemon
      ?.map((mon) => ({ mon, score: targetMatchScore(goal, { ...mon, identifier: mon.slug, names: { zh: mon.name } }) }))
      .filter((item) => item.score > 0) || [];
  const data = currentPokeCampData();
  const fromPokeCamp = (data?.pokemonList || [])
    .map((entry) => ({ entry, score: targetMatchScore(goal, entry) }))
    .filter((item) => item.score > 0)
    .map(({ entry, score }) => ({
      mon: {
        id: entry.id,
        slug: entry.identifier || entry.speciesIdentifier,
        name: entry.names?.zh || entry.names?.en || entry.identifier,
        rank: entry.usage?.rank || 9999,
        types: (entry.types || []).map((type) => TYPE_EN_TO_CN[String(type).toLowerCase()] || type),
        stats: {
          HP: entry.stats?.hp || 0,
          攻击: entry.stats?.attack || 0,
          防御: entry.stats?.defense || 0,
          特攻: entry.stats?.specialAttack || 0,
          特防: entry.stats?.specialDefense || 0,
          速度: entry.stats?.speed || 0,
        },
        moves: [],
        items: [],
        abilities: Object.values(knowledgeEntryFor({ slug: entry.identifier, name: entry.names?.zh, id: entry.id })?.showdown?.abilities || {}).map((name) => ({ name })),
        natures: [],
        externalTarget: true,
        pokeCamp: entry,
      },
      score,
    }));
  const seen = new Set();
  return [...fromKnowledge, ...fromPokeCamp, ...fromCurrent]
    .sort((a, b) => b.score - a.score || Number(a.mon.rank || 9999) - Number(b.mon.rank || 9999))
    .filter(({ mon }) => {
      const key = idKey(mon.slug || mon.name || mon.id);
      if (matchedAliasKeys.size && !matchedAliasKeys.has(key) && ![mon.slug, mon.name, mon.id].some((value) => matchedAliasKeys.has(idKey(value)))) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map(({ mon }) => mon);
}

function requestedTeamStyle(goal = "") {
  const text = String(goal || "").toLowerCase();
  const cn = cnKey(goal);
  if (/stall|semi-?stall|fat/i.test(text) || /受队|盾队|消耗队|轮转受|半受/.test(cn)) {
    return {
      id: "stall",
      name: "受队/耐久消耗",
      hardRules: [
        "从零构筑时不得改成天气进攻、空间进攻、纯高速攻或泛用热门队。",
        "优先选择耐久中转、回复、状态、撒场、除钉/清场、转场、抗性联防和残局消耗路线。",
        "双打分区也要保持偏耐久/控场思路，不能无故加入喷火龙晴天、大嘴鸥雨天等天气进攻轴。",
      ],
      preferRoles: ["耐久位", "功能位", "特性价值"],
      preferMoves: ["roost", "recover", "slack-off", "wish", "protect", "toxic", "will-o-wisp", "stealth-rock", "spikes", "defog", "rapid-spin", "u-turn", "volt-switch", "羽栖", "自我再生", "偷懒", "许愿", "守住", "剧毒", "鬼火", "隐形岩", "撒菱", "清除浓雾", "高速旋转", "急速折返", "伏特替换"],
      avoidThemes: ["sun", "rain", "trick-room", "hyper-offense"],
    };
  }
  if (/balance|balanced/i.test(text) || /平衡|轮转/.test(cn)) {
    return { id: "balance", name: "平衡轮转", hardRules: ["围绕攻防转换构筑，避免只堆高速输出。"], preferRoles: ["耐久位", "功能位", "物理输出", "特殊输出"], preferMoves: ["u-turn", "volt-switch", "recover", "stealth-rock", "急速折返", "伏特替换", "自我再生", "隐形岩"], avoidThemes: [] };
  }
  if (/hyper.?offense|offense|ho/i.test(text) || /攻队|进攻|速攻/.test(cn)) {
    return { id: "offense", name: "进攻队", hardRules: ["优先明确破盾、清场和速度线，少放纯消耗位。"], preferRoles: ["物理输出", "特殊输出", "高速位"], preferMoves: ["swords-dance", "nasty-plot", "dragon-dance", "tailwind", "剑舞", "诡计", "龙之舞", "顺风"], avoidThemes: [] };
  }
  if (/sun|晴/.test(text) || /晴天/.test(cn)) return { id: "sun", name: "晴天队", hardRules: ["必须围绕晴天收益构筑。"], preferRoles: ["特殊输出", "高速位", "功能位"], preferMoves: ["sunny-day", "大晴天"], avoidThemes: [] };
  if (/rain|雨/.test(text) || /雨天/.test(cn)) return { id: "rain", name: "雨天队", hardRules: ["必须围绕雨天收益构筑。"], preferRoles: ["物理输出", "特殊输出", "高速位"], preferMoves: ["rain-dance", "求雨"], avoidThemes: [] };
  if (/trick.?room|space/i.test(text) || /空间|戏法空间/.test(cn)) return { id: "trick-room", name: "空间队", hardRules: ["必须围绕戏法空间回合构筑，优先低速高压输出。"], preferRoles: ["耐久位", "物理输出", "特殊输出"], preferMoves: ["trick-room", "戏法空间"], avoidThemes: [] };
  return null;
}

function shouldRebuildFromGoal(goal = "") {
  const cn = cnKey(goal);
  const text = String(goal || "").toLowerCase();
  const asksForNewTeam = /配置|组|组建|构筑|来个|来一个|想一个|配一个|做一个/.test(cn) || /\b(build|make|create|new)\b/.test(text);
  const asksToSweep = /灭队|横扫|清场/.test(cn) || /\bsweep\b/.test(text);
  const mentionsTeam = /队伍|阵容|队|team/.test(`${goal} ${text}`);
  const preserveCurrent = /当前|已选|这几只|现有|保留|补全|改配置|配招|moveset/.test(`${cn} ${text}`);
  return !preserveCurrent && (asksToSweep || (asksForNewTeam && mentionsTeam));
}

function goalIsCounterTarget(goal = "") {
  const cn = cnKey(goal);
  const text = String(goal || "").toLowerCase();
  return /反制|针对|克制|压制|处理|打爆|打赢|counter|beat|check/.test(`${cn} ${text}`);
}

function selectedBuildIntent() {
  return $("#ai-build-intent")?.value || "auto";
}

function requestedTeamTemplate(goal = "", style = null) {
  const text = String(goal || "").toLowerCase();
  const cn = cnKey(goal);
  if (style?.id === "stall") {
    return {
      id: "stall",
      requiredComponents: ["回复或可靠续航", "状态或消耗手段", "撒场/清场至少其一", "抗性换入", "残局胜点"],
      avoidPitfalls: ["不要把受队写成天气进攻队", "不要只有耐久道具而没有回复/状态/转场闭环"],
    };
  }
  if (/空间|戏法空间|trickroom|trick room/.test(`${cn} ${text}`)) {
    return {
      id: "trick-room",
      requiredComponents: ["至少 1 个戏法空间手", "低速高收益打手", "防挑衅或保证启动的道具/辅助", "非空间回合的备用路线"],
      avoidPitfalls: ["煤炭龟/低速打手不能没有空间手", "不要全队只在空间回合能行动"],
    };
  }
  const wantsCounterWeather = /反制|针对|克制|压制|处理|覆盖|抢|破坏/.test(cn) && /天气|晴|雨|雪|沙/.test(cn);
  if (wantsCounterWeather) {
    return {
      id: "counter-weather",
      requiredComponents: ["明确目标天气", "至少 1 个覆盖天气手段：晴天/求雨/雪景/沙暴或自动天气", "不依赖被自己天气削弱的主输出", "对方重新开天气后的备用处理"],
      avoidPitfalls: ["天气招式要写明用于覆盖对方天气", "不要把反天气工具写成随机双天气轴"],
    };
  }
  if (/晴天|日照|大晴天|sun|drought/.test(`${cn} ${text}`)) {
    return {
      id: "sun",
      requiredComponents: ["晴天来源", "晴天收益打手", "反天气/被抢天气时的备用路线", "水/岩/龙等常见抗性处理"],
      avoidPitfalls: ["晴天队不要无说明依赖打雷/暴风", "双天气必须说明切换收益"],
    };
  }
  if (/雨天|降雨|求雨|rain|drizzle/.test(`${cn} ${text}`)) {
    return {
      id: "rain",
      requiredComponents: ["雨天来源", "雨天收益打手", "反天气/被抢天气时的备用路线", "草/电/水免疫或联防处理"],
      avoidPitfalls: ["雨天队不要无说明依赖喷火/热风/日光束", "双天气必须说明切换收益"],
    };
  }
  return null;
}

function requiredCorePokemonFromGoal(goal = "", source = state.data?.pokemon || []) {
  if (!goal || goalIsCounterTarget(goal)) return [];
  const data = Array.isArray(source) ? source : [];
  const wantsMega = /mega|超级/i.test(goal);
  const familyKey = (mon = {}) =>
    idKey(mon.slug || mon.name || mon.id)
      .replace(/mega.*$/i, "")
      .replace(/gmax.*$/i, "")
      .replace(/midday$/i, "")
      .replace(/midnight$/i, "")
      .replace(/dusk$/i, "");
  const isMegaForm = (mon = {}) => /mega|超级/i.test(`${mon.slug || ""} ${mon.name || ""}`);
  const direct = data
    .filter((mon) => goalMatchesPokemon(goal, mon))
    .sort((a, b) => {
      const megaPreference = wantsMega ? Number(isMegaForm(b)) - Number(isMegaForm(a)) : Number(isMegaForm(a)) - Number(isMegaForm(b));
      return megaPreference || Number(a.rank || 9999) - Number(b.rank || 9999);
    });
  const seen = new Set();
  const seenFamilies = new Set();
  return direct
    .filter((mon) => {
      const key = idKey(mon.slug || mon.name || mon.id);
      const family = familyKey(mon) || key;
      if (!key || seen.has(key)) return false;
      if (family && seenFamilies.has(family)) return false;
      seen.add(key);
      seenFamilies.add(family);
      return true;
    })
    .slice(0, 2);
}

function goalConstraintsFromGoal(goal = "", requiredPokemon = []) {
  const cn = cnKey(goal);
  const text = String(goal || "").toLowerCase();
  const goalText = `${goal} ${text}`;
  const constraints = {
    requiredPokemon: requiredPokemon.map((mon) => ({
      id: mon.id,
      name: mon.name,
      slug: mon.slug,
      reason: "用户目标指定为队伍核心，必须进入最终阵容。",
    })),
    requiredMoves: [],
    requiredRoles: [],
    themes: [],
    hardRules: [],
  };
  if (constraints.requiredPokemon.length) {
    constraints.hardRules.push(`最终 single.team 和 double.team 都必须包含：${constraints.requiredPokemon.map((item) => item.name).join("、")}；这是队伍核心，不是要克制的对象。`);
  }
  if (/喷火龙|charizard/i.test(goalText) && !constraints.requiredPokemon.some((item) => /喷火龙|charizard/i.test(`${item.name || ""} ${item.slug || ""}`))) {
    constraints.requiredPokemon.push({ id: 6, name: "喷火龙", slug: "charizard", reason: "用户明确点名喷火龙，必须进入最终阵容。" });
    constraints.hardRules.push("如果用户点名喷火龙，最终队伍必须包含喷火龙，不得用三首恶龙、暴鲤龙等泛用位替代。");
  }
  if (/顺风|tailwind|おいかぜ/i.test(goalText)) {
    constraints.requiredMoves.push({ name: "顺风", category: "speed-control", reason: "用户明确要求顺风队，至少一名成员必须携带顺风。" });
    constraints.requiredRoles.push({ id: "tailwind-setter", name: "顺风控速手", reason: "顺风队必须有可启动顺风的成员，并在 plan 中服务主输出。" });
    constraints.themes.push("tailwind");
    constraints.hardRules.push("最终队伍必须有顺风设置者，plan/watch/note 必须说明谁开顺风、谁吃顺风收益、顺风被阻止后的备用路线。");
  }
  if (/晴天|日照|大晴天|sun|drought/i.test(`${cn} ${text}`)) {
    constraints.themes.push("sun");
    constraints.requiredRoles.push({ id: "sun-source", name: "晴天来源", reason: "晴天队必须说明日照/大晴天来源和晴天收益点。" });
    constraints.hardRules.push("如果用户要求晴天/日照，最终队伍必须包含晴天来源，并说明晴天收益打手与被抢天气后的备用路线。");
  }
  if (/雨天|降雨|求雨|rain|drizzle/i.test(`${cn} ${text}`)) {
    constraints.themes.push("rain");
    constraints.requiredRoles.push({ id: "rain-source", name: "雨天来源", reason: "雨天队必须说明降雨/求雨来源和雨天收益点。" });
    constraints.hardRules.push("如果用户要求雨天/降雨，最终队伍必须包含雨天来源，并说明雨天收益打手与被抢天气后的备用路线。");
  }
  if (/空间|戏法空间|trickroom|trick room/i.test(`${cn} ${text}`)) {
    constraints.themes.push("trick-room");
    constraints.requiredMoves.push({ name: "戏法空间", category: "speed-control", reason: "空间队必须至少有一名可启动戏法空间的成员。" });
    constraints.requiredRoles.push({ id: "trick-room-setter", name: "戏法空间手", reason: "空间队必须说明谁开空间、谁吃低速收益、非空间回合怎么打。" });
    constraints.hardRules.push("如果用户要求空间/戏法空间，最终队伍必须包含空间手，并说明低速收益核心与非空间回合备用路线。");
  }
  if (/喷火龙顺风|顺风喷火龙|charizard.*tailwind|tailwind.*charizard/i.test(goalText)) {
    constraints.themes.push("tailwind");
    constraints.requiredMoves.push({ name: "顺风", category: "speed-control", reason: "喷火龙顺风必须有真实顺风启动者。" });
    constraints.hardRules.push("喷火龙顺风队必须同时包含喷火龙与真实顺风手；不能把别的泛用位写成启动手。");
  }
  if (/沙暴|沙队|扬沙|sand|sandstorm|sand stream/i.test(`${cn} ${text}`)) {
    constraints.themes.push("sand");
    constraints.requiredRoles.push({ id: "sand-source", name: "沙暴来源", reason: "沙暴队必须说明扬沙/沙暴来源和沙暴收益点。" });
    constraints.hardRules.push("如果用户要求沙暴/沙队，最终队伍必须包含沙暴来源，并说明沙暴收益打手与被抢天气后的备用路线。");
  }
  if (/雪天|雪景|雪队|降雪|snow|snowscape|hail|snow warning/i.test(`${cn} ${text}`)) {
    constraints.themes.push("snow");
    constraints.requiredRoles.push({ id: "snow-source", name: "雪天来源", reason: "雪天队必须说明降雪/雪景来源和雪天收益点。" });
    constraints.hardRules.push("如果用户要求雪天/雪队，最终队伍必须包含雪天来源，并说明极光幕/冰系收益与被抢天气后的备用路线。");
  }
  return constraints;
}

function pokemonConfigTextForTheme(mon, format = state.format) {
  return [
    mon?.name,
    mon?.slug,
    textOf(mon, "moves"),
    textOf(mon, "abilities"),
    textOf(mon, "items"),
    rankedTeamLibrarySetsFor(mon, 4).map((set) => `${set.item || ""} ${set.ability || ""} ${(set.moves || []).join(" ")}`),
    teamLibraryConfigsFor(mon, format).slice(0, 6).map((config) => `${config.item || ""} ${config.ability || ""} ${(config.moves || []).join(" ")}`),
  ].flat().filter(Boolean).join(" ");
}

function pokemonActuallySetsTailwind(mon, format = state.format) {
  return /顺风|tailwind|おいかぜ/i.test(pokemonConfigTextForTheme(mon, format));
}

function pokemonActuallySetsTheme(mon, theme = "", format = state.format) {
  const config = pokemonConfigTextForTheme(mon, format);
  const species = `${mon?.name || ""} ${mon?.slug || ""} ${pokeCampEntryFor(mon)?.identifier || ""} ${pokeCampEntryFor(mon)?.speciesIdentifier || ""}`;
  if (theme === "rain") return /(降雨|あめふらし|\bdrizzle\b|求雨|雨乞い|あまごい|\brain[-\s]?dance\b)/i.test(config) || /大嘴鸥|pelipper|蚊香蛙皇|politoed|盖欧卡|kyogre/i.test(species);
  if (theme === "sun") return /(日照|ひでり|\bdrought\b|大晴天|晴天|にほんばれ|\bsunny[-\s]?day\b)/i.test(config) || /煤炭龟|torkoal|九尾|ninetales|固拉多|groudon/i.test(species);
  if (theme === "trick-room") return /(戏法空间|トリックルーム|\btrick[-\s]?room\b)/i.test(config);
  if (theme === "sand") return /(扬沙|すなおこし|\bsand[-\s]?stream\b|沙暴|すなあらし|\bsandstorm\b)/i.test(config) || /班基拉斯|tyranitar|河马兽|hippowdon|庞岩怪|gigalith/i.test(species);
  if (theme === "snow") return /(降雪|ゆきふらし|\bsnow[-\s]?warning\b|雪景|冰雹|あられ|ゆきげしき|\bsnowscape\b|\bhail\b)/i.test(config) || /九尾.*阿罗拉|阿罗拉.*九尾|ninetales.*alola|alolan.*ninetales|暴雪王|abomasnow/i.test(species);
  return false;
}

function goalSupportCandidatesForContext(source = [], constraints = {}, format = state.format) {
  const themes = new Set(constraints.themes || []);
  const wanted = [];
  const addMatching = (patterns = [], limit = 3) => {
    for (const mon of source) {
      if (wanted.length >= 18) break;
      const text = `${mon.name || ""} ${mon.slug || ""} ${pokeCampEntryFor(mon)?.identifier || ""} ${pokeCampEntryFor(mon)?.speciesIdentifier || ""}`;
      if (!patterns.some((pattern) => pattern.test(text))) continue;
      if (!wanted.some((own) => own.id === mon.id || own.slug === mon.slug)) wanted.push(mon);
      if (wanted.filter((own) => patterns.some((pattern) => pattern.test(`${own.name || ""} ${own.slug || ""}`))).length >= limit) break;
    }
  };
  const addByConfig = (patterns = [], limit = 4) => {
    const matches = source
      .filter((mon) => patterns.some((pattern) => pattern.test(`${pokemonConfigTextForTheme(mon, format)} ${mon.name || ""} ${mon.slug || ""}`)))
      .slice(0, limit);
    for (const mon of matches) {
      if (!wanted.some((own) => own.id === mon.id || own.slug === mon.slug)) wanted.push(mon);
    }
  };

  if (themes.has("rain")) {
    addMatching([/大嘴鸥|pelipper/i, /蚊香蛙皇|politoed/i, /盖欧卡|kyogre/i], 3);
    addMatching([/铝钢桥龙|archaludon/i, /刺龙王|kingdra/i, /乐天河童|ludicolo/i, /戽斗尖梭|barraskewda/i, /巨沼怪|swampert/i, /暴噬龟|drednaw/i, /幽尾玄鱼|basculegion/i, /海豚侠|palafin/i], 5);
    addByConfig([/悠游自如|swift swim/i, /电光束|electro[-\s]?shot/i, /打雷|thunder/i, /暴风|hurricane/i, /水炮|hydro pump/i, /波动冲|wave crash/i], 5);
    source.filter((mon) => pokemonActuallySetsTheme(mon, "rain", format)).slice(0, 3).forEach((mon) => {
      if (!wanted.some((own) => own.id === mon.id || own.slug === mon.slug)) wanted.push(mon);
    });
  }
  if (themes.has("sun")) {
    addMatching([/煤炭龟|torkoal/i, /九尾|ninetales/i, /固拉多|groudon/i], 3);
    addMatching([/妙蛙花|venusaur/i, /裙儿小姐|lilligant/i, /波荡水|walking wake/i, /振翼发|flutter mane/i, /古玉鱼|chi-yu/i], 4);
    addByConfig([/叶绿素|chlorophyll/i, /太阳之力|solar power/i, /日光束|solar beam/i, /喷火|eruption/i, /热风|heat wave/i], 5);
  }
  if (themes.has("trick-room")) {
    addMatching([/克雷色利亚|cresselia/i, /多边兽2|porygon2/i, /青铜钟|bronzong/i, /奇麒麟|farigiraf/i, /布莉姆温|hatterene/i, /夜巡灵|dusclops/i, /爱管侍|indeedee/i], 4);
    addByConfig([/低速|最慢|slow|min speed|空间打手|trick room abuser/i, /喷火|eruption/i], 5);
  }
  if (themes.has("sand")) {
    addMatching([/班基拉斯|tyranitar/i, /河马兽|hippowdon/i, /庞岩怪|gigalith/i], 3);
    addMatching([/龙头地鼠|excadrill/i, /鬃岩狼人|lycanroc/i], 4);
    addByConfig([/拨沙|sand rush/i, /沙之力|sand force/i, /岩崩|rock slide/i, /地震|earthquake/i], 5);
  }
  if (themes.has("snow")) {
    addMatching([/阿罗拉.*九尾|九尾.*阿罗拉|ninetales.*alola|alolan.*ninetales/i, /暴雪王|abomasnow/i], 3);
    addMatching([/浩大鲸|cetitan/i, /冻脊龙|baxcalibur/i, /铁包袱|iron bundle/i, /阿罗拉.*穿山王|sandslash.*alola/i], 4);
    addByConfig([/拨雪|slush rush/i, /极光幕|aurora veil/i, /暴风雪|blizzard/i, /冷冻干燥|freeze-dry/i], 5);
  }
  if (themes.has("tailwind")) {
    addMatching([/风妖精|whimsicott/i, /烈箭鹰|talonflame/i, /叉字蝠|crobat/i, /龙卷云|tornadus/i], 5);
    source.filter((mon) => pokemonActuallySetsTailwind(mon, format)).slice(0, 5).forEach((mon) => {
      if (!wanted.some((own) => own.id === mon.id || own.slug === mon.slug)) wanted.push(mon);
    });
    if (/喷火龙|charizard/i.test(String(constraints.requiredPokemon?.map((item) => `${item.name || ""} ${item.slug || ""}`).join(" ") || "") || "")) {
      addMatching([/喷火龙|charizard/i], 2);
    }
  }
  return wanted;
}

function teamStyleCandidateScore(mon, style) {
  if (!style || !mon) return 0;
  const roles = getRoles(mon);
  const text = `${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${textOf(mon, "items")} ${rankedTeamLibrarySetsFor(mon, 3).map((set) => `${set.item} ${set.ability} ${(set.moves || []).join(" ")}`).join(" ")}`.toLowerCase();
  const bulk = stat(mon, "HP") + stat(mon, "防御") + stat(mon, "特防");
  let score = 0;
  if (style.id === "stall") {
    score += Math.max(0, bulk - 240) / 12;
    if (roles.includes("耐久位")) score += 8;
    if (roles.includes("功能位")) score += 5;
    if (roles.includes("特性价值")) score += 3;
    if (/(recover|roost|slack|wish|protect|toxic|will-o-wisp|stealth|spikes|defog|rapid|u-turn|volt|自我再生|羽栖|偷懒|许愿|守住|剧毒|鬼火|隐形岩|撒菱|清除浓雾|高速旋转|急速折返|伏特替换|やどりぎ|みがわり)/i.test(text)) score += 7;
    if (/(charizard|drought|sunny-day|pelipper|drizzle|rain-dance|trick-room|喷火龙|日照|大晴天|大嘴鸥|降雨|求雨|戏法空间)/i.test(`${mon.slug} ${text}`)) score -= 14;
    if (stat(mon, "速度") >= 125 && bulk < 240) score -= 4;
  } else {
    for (const role of style.preferRoles || []) if (roles.includes(role)) score += 4;
    for (const move of style.preferMoves || []) if (text.includes(String(move).toLowerCase())) score += 3;
  }
  return score;
}

function supportCandidateReport(mon) {
  const text = `${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${rankedTeamLibrarySetsFor(mon, 2).map((set) => `${set.ability} ${(set.moves || []).join(" ")}`).join(" ")}`;
  const hasPrankster = /恶作剧之心|いたずらごころ|prankster/i.test(text);
  const tags = [];
  const reasons = [];
  let score = 0;
  const add = (points, tag, reason) => {
    score += points;
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };
  if (!hasPrankster) return { score: 0, hasPrankster: false, tags, reasons };
  add(2, "prankster", "恶作剧之心让变化招式获得先手价值。");
  if (/顺风|电磁波|冰冻之风|棉孢子|黏黏网|tailwind|thunder wave|icy wind|cotton spore|sticky web/i.test(text)) add(4, "speed-control", "先手控速可服务中速/低速打手。");
  if (/挑衅|再来一次|定身法|封印|encore|taunt|disable|imprison/i.test(text)) add(3, "anti-setup", "先手挑衅/再来一次能反展开和限制强化。");
  if (/鬼火|电磁波|剧毒|哈欠|催眠|will-o-wisp|thunder wave|toxic|yawn|spore|sleep powder/i.test(text)) add(3, "status-pressure", "先手状态能压制输出或逼迫轮换。");
  if (/光墙|反射壁|极光幕|reflect|light screen|aurora veil/i.test(text)) add(3, "screens", "先手墙类能保护核心启动。");
  if (/帮助|撒娇|假哭|临别礼物|再生力|helping hand|charm|fake tears|memento/i.test(text)) add(2, "core-support", "辅助招式能放大核心输出或削弱对手。");
  if (MOVE_PATTERNS.redirection.test(text) || /看我嘛|愤怒粉|广域防守|follow me|rage powder|wide guard/i.test(text)) add(2, "protection", "保护/掩护工具能保关键行动回合。");
  if (!tags.some((tag) => tag !== "prankster") && getRoles(mon).includes("功能位")) add(1, "utility", "具备基础功能位价值。");
  return { score: Math.min(12, score), hasPrankster, tags, reasons: reasons.slice(0, 5) };
}

function supportCandidateScore(mon) {
  return supportCandidateReport(mon).score;
}

function megaCandidateScore(mon) {
  if (!mon) return 0;
  if (megaProfileFor(mon)) return 4;
  const itemPool = [...(mon.items || []), ...recommendedItemsFor(mon, new Set(), 3)].map((item) => item?.name || item);
  return itemPool.some(isMegaStone) ? 3 : 0;
}

function buildMegaPlan(candidateSource = [], { targetAnswerScores = new Map(), styleScores = new Map(), synergyReports = new Map(), rebuildFromGoal = false } = {}) {
  const selectedMega = rebuildFromGoal
    ? []
    : state.team
        .filter((mon) => isMegaStone(editableConfigFor(mon).item) || megaProfileFor(mon))
        .map((mon) => ({
          id: mon.id,
          name: mon.name,
          slug: mon.slug,
          locked: true,
          reason: "当前队伍已选 Mega 位，优先围绕它补安全上场、抗性和速度支持。",
          megaProfile: megaProfileFor(mon),
        }));
  const candidates = candidateSource
    .map((mon) => {
      const megaProfile = megaProfileFor(mon);
      const itemPool = [...(mon.items || []), ...recommendedItemsFor(mon, new Set(), 3)].map((item) => item?.name || item).filter(Boolean);
      const megaItems = itemPool.filter(isMegaStone).slice(0, 2);
      const megaBias = megaCandidateScore(mon);
      if (!megaBias) return null;
      const score =
        megaBias * 4 +
        (synergyReports.get(mon.id)?.score || 0) +
        (targetAnswerScores.get(mon.slug) || 0) +
        Math.max(0, styleScores.get(mon.id) || 0) +
        (Number(mon.rank || 9999) <= 30 ? 2 : 0);
      const supportNeeds = [
        "安全上场：转场、威吓、击掌、掩护或耐久中转",
        "弱点覆盖：补它怕的属性换入点",
        "速度支持：顺风、电磁波、围巾、先制或空间/天气节奏",
      ];
      return {
        id: mon.id,
        name: mon.name,
        slug: mon.slug,
        score: Math.round(score),
        itemOptions: megaItems,
        megaProfile,
        synergyReasons: synergyReports.get(mon.id)?.reasons || [],
        supportNeeds,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  const primary = selectedMega[0] || candidates[0] || null;
  const secondary = selectedMega[1] || (!selectedMega.length ? candidates.find((item) => item.id !== primary?.id) : null) || null;
  return {
    recommendation: primary ? "prefer-mega" : "no-forced-mega",
    rule: "通常优先规划 1 个主 Mega；允许 2 个主副 Mega 分支，但必须说明对局选择，不能为了硬凑破坏联动。",
    primary,
    secondary,
    candidates: candidates.slice(0, 6),
    noMegaReason: primary ? "" : "候选池没有足够合理的 Mega 位；不要为了硬凑 Mega 破坏队伍联动、速度线或抗性闭环。",
  };
}

const SLOT_CATALOG = {
  single: [
    ["primary-core", "主轴核心", 10, "队伍需要明确主要胜利路线。"],
    ["secondary-core", "副轴/备用路线", 8, "主轴被针对时需要替代推进路线。"],
    ["mega-slot", "Mega 位", 8, "通常优先规划 1 个合理 Mega；无合理联动时不硬凑。"],
    ["speed-control", "速度资源", 9, "需要高速压制、控速、先制或围巾/加速资源。"],
    ["safe-entry", "安全上场", 9, "核心需要转场、耐久中转、状态逼换或保护回合进场。"],
    ["defensive-switch", "防守换入", 8, "至少要有能承接关键属性或常见威胁的换入点。"],
    ["wallbreaker", "破盾/突破", 7, "需要能打开对方防守核心的火力。"],
    ["endgame-cleaner", "终盘收割", 7, "需要残局清场或稳定结束比赛的成员。"],
    ["hazard", "撒场压力", 6, "单打优先考虑隐形岩、撒菱、毒菱或黏黏网。"],
    ["removal", "清场/除钉", 6, "单打需要处理对方场地压力，或给出替代轮转节奏。"],
    ["status-pressure", "状态/干扰", 6, "状态、挑衅、再来一次等能阻止对手顺利展开。"],
  ],
  double: [
    ["primary-core", "主轴核心", 10, "双打也需要明确主要输出/站场轴。"],
    ["secondary-core", "副轴/备用路线", 8, "首发被压制时需要第二行动链。"],
    ["mega-slot", "Mega 位", 8, "通常优先规划 1 个合理 Mega；第二 Mega 只能作为对局分支。"],
    ["speed-control", "速度资源", 10, "双打必须重视顺风、空间、电磁波、冰冻之风、先制或加速。"],
    ["lead-pair", "首发组合", 9, "需要能开局抢节奏的双人组合。"],
    ["protection", "保护/掩护", 9, "守住、击掌、威吓、掩护或广域防守用来保关键行动。"],
    ["disruption", "先手干扰", 7, "挑衅、再来一次、击掌、威吓或状态能打断对方展开。"],
    ["spread-pressure", "范围压力", 7, "热风、岩崩、魔法闪耀等范围招式能压站位。"],
    ["defensive-switch", "防守换入", 7, "双打仍需要联防、换位和抗性中转。"],
    ["endgame-cleaner", "终盘收割", 6, "残局需要高速、先制或强化后的清场点。"],
  ],
};

function slotCatalogFor(format = state.format, teamStyle = null, megaPlan = null) {
  const catalog = (format === "double" ? SLOT_CATALOG.double : SLOT_CATALOG.single).map(([id, label, priority, reason]) => ({ id, label, priority, reason }));
  const megaSlot = catalog.find((slot) => slot.id === "mega-slot");
  if (megaSlot && megaPlan?.recommendation === "no-forced-mega") {
    megaSlot.priority = 5;
    megaSlot.reason = "没有足够合理 Mega 候选时，不为了硬凑 Mega 破坏队伍联动。";
  }
  if (teamStyle?.id === "stall" && format === "single") {
    for (const slot of catalog) {
      if (["defensive-switch", "safe-entry", "status-pressure", "hazard", "removal"].includes(slot.id)) slot.priority += 2;
      if (["wallbreaker", "endgame-cleaner"].includes(slot.id)) slot.priority -= 1;
    }
  }
  return catalog;
}

function slotTagsForPokemon(mon, format = state.format) {
  if (!mon) return { slots: [], reasons: [] };
  const roles = getRoles(mon);
  const usage = pokemonUsageProfile(mon, format);
  const setsText = rankedTeamLibrarySetsFor(mon, 3).map((set) => `${set.item} ${set.ability} ${(set.moves || []).join(" ")}`).join(" ");
  const text = `${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${textOf(mon, "items")} ${usage.moves.join(" ")} ${usage.items.join(" ")} ${usage.abilities.join(" ")} ${setsText}`;
  const speed = effectiveSpeed(mon).value || stat(mon, "速度");
  const bulk = stat(mon, "HP") + stat(mon, "防御") + stat(mon, "特防");
  const atk = stat(mon, "攻击");
  const spa = stat(mon, "特攻");
  const templateRoles = roleTemplateFor(mon)?.roles || [];
  const slots = new Set();
  const reasons = [];
  const add = (slot, reason) => {
    slots.add(slot);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  if (megaProfileFor(mon) || isMegaStone(text)) add("mega-slot", "可作为 Mega 资源规划。");
  if (Math.max(atk, spa) >= 120 || MOVE_PATTERNS.setup.test(text) || templateRoles.some((role) => /核心|Mega|输出|破坏/.test(role))) add("primary-core", "具备承担主轴输出或强化推进的条件。");
  if (Math.max(atk, spa) >= 105 || roles.includes("高速位") || roles.includes("耐久位") || templateRoles.some((role) => /副|中转|压制|收割/.test(role))) add("secondary-core", "可作为副轴、压制点或备用行动链。");
  if (MOVE_PATTERNS.speedControl.test(text) || roles.includes("高速位") || MOVE_PATTERNS.priority.test(text) || /讲究围巾|choice scarf|悠游自如|叶绿素|拨沙|swift swim|chlorophyll|sand rush/i.test(text)) add("speed-control", "能提供控速、高速压制、先制或速度收益。");
  if (MOVE_PATTERNS.pivot.test(text) || MOVE_PATTERNS.intimidate.test(text) || MOVE_PATTERNS.fakeOut.test(text) || MOVE_PATTERNS.redirection.test(text) || MOVE_PATTERNS.protect.test(text) || roles.includes("耐久位")) add("safe-entry", "能用转场、威吓、击掌、掩护、守住或耐久中转创造进场回合。");
  if (roles.includes("耐久位") || roles.includes("特性价值") || bulk >= 285 || /再生力|威吓|漂浮|蓄水|引火|避雷针|厚脂肪|regenerator|intimidate|levitate|water absorb|flash fire|lightning rod|thick fat/i.test(text)) add("defensive-switch", "可提供抗性、特性免疫或耐久换入点。");
  if (Math.max(atk, spa) >= 120 || /讲究头带|讲究眼镜|生命宝珠|适应力|巨大之力|choice band|choice specs|life orb|adaptability|huge power/i.test(text)) add("wallbreaker", "具备突破防守核心的火力。");
  if (speed >= 100 || MOVE_PATTERNS.priority.test(text) || MOVE_PATTERNS.setup.test(text) || /讲究围巾|choice scarf|自信过度|moxie/i.test(text)) add("endgame-cleaner", "具备终盘清场、先制或滚雪球能力。");
  if (MOVE_PATTERNS.hazard.test(text)) add("hazard", "能提供撒场压力。");
  if (MOVE_PATTERNS.removal.test(text)) add("removal", "能处理对方撒场。");
  if (MOVE_PATTERNS.status.test(text) || /再来一次|哈欠|催眠|定身法|鬼面|encore|yawn|spore|sleep powder|disable|scary face/i.test(text)) add("status-pressure", "能用状态或干扰限制对方展开。");

  if (format === "double") {
    if (MOVE_PATTERNS.fakeOut.test(text) || MOVE_PATTERNS.speedControl.test(text) || MOVE_PATTERNS.redirection.test(text) || MOVE_PATTERNS.intimidate.test(text) || /气势披带|focus sash/i.test(text)) add("lead-pair", "适合开局配合队友抢节奏。");
    if (MOVE_PATTERNS.protect.test(text) || MOVE_PATTERNS.fakeOut.test(text) || MOVE_PATTERNS.redirection.test(text) || MOVE_PATTERNS.intimidate.test(text) || /广域防守|帮助|wide guard|helping hand/i.test(text)) add("protection", "能保护队友关键行动或减少集火风险。");
    if (MOVE_PATTERNS.status.test(text) || MOVE_PATTERNS.fakeOut.test(text) || MOVE_PATTERNS.intimidate.test(text) || /挑衅|再来一次|定身法|封印|taunt|encore|disable|imprison/i.test(text)) add("disruption", "能打断对手开局或强化节奏。");
    if (MOVE_PATTERNS.spread.test(text)) add("spread-pressure", "拥有范围招式，能压制双打站位。");
  }

  return { slots: [...slots], reasons: reasons.slice(0, 8) };
}

function buildSlotModel(team = [], format = state.format, { megaPlan = null, teamStyle = null } = {}) {
  const catalog = slotCatalogFor(format, teamStyle, megaPlan);
  const coverage = new Map(catalog.map((slot) => [slot.id, []]));
  for (const mon of team) {
    const tags = slotTagsForPokemon(mon, format);
    for (const slotId of tags.slots) {
      if (coverage.has(slotId)) coverage.get(slotId).push(mon.name);
    }
  }
  const coveredSlots = catalog
    .map((slot) => ({ id: slot.id, label: slot.label, priority: slot.priority, members: [...new Set(coverage.get(slot.id) || [])] }))
    .filter((slot) => slot.members.length);
  const missingSlots = catalog
    .filter((slot) => !(coverage.get(slot.id) || []).length)
    .map((slot) => ({
      id: slot.id,
      label: slot.label,
      priority: Math.max(1, slot.priority),
      reason: slot.reason,
    }))
    .sort((a, b) => b.priority - a.priority);
  return {
    format,
    style: teamStyle?.name || "",
    requiredSlots: catalog,
    coveredSlots,
    missingSlots,
    slotPriorities: missingSlots.slice(0, 6).map((slot) => `${slot.label}:${slot.priority}`),
    notes: [
      "槽位模型是构筑骨架：先补主轴/副轴/Mega/速度/进场/联防，再比较热门度。",
      "一只宝可梦可以覆盖多个槽位，但不能让单一成员过载承担所有关键职责。",
      megaPlan?.recommendation === "no-forced-mega" ? "没有合理 Mega 时允许不选，但必须说明不硬凑原因。" : "优先围绕主 Mega 补安全上场、弱点覆盖和速度支持。",
    ],
  };
}

function candidateSlotFit(mon, slotModel, format = state.format) {
  const tags = slotTagsForPokemon(mon, format);
  const missing = new Map((slotModel?.missingSlots || []).map((slot) => [slot.id, slot]));
  const matched = tags.slots
    .map((slotId) => missing.get(slotId))
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority);
  const score = matched.reduce((sum, slot) => sum + slot.priority, 0) + Math.min(4, tags.slots.length);
  return {
    score: Math.round(score),
    slots: tags.slots,
    fillSlots: matched.map((slot) => slot.id),
    reasons: [
      ...matched.slice(0, 4).map((slot) => `补${slot.label}`),
      ...tags.reasons,
    ].filter(Boolean).slice(0, 6),
  };
}

const ARCHETYPE_CATALOG = [
  {
    id: "sun",
    name: "晴天进攻",
    formats: ["single", "double"],
    goal: /晴天|日照|大晴天|sun|drought/i,
    components: [
      { id: "weather-setter", label: "晴天来源", pattern: /日照|大晴天|sunny day|drought/i, slots: ["primary-core", "secondary-core"] },
      { id: "weather-abuser", label: "晴天收益打手", pattern: /喷火|热风|日光束|太阳之力|叶绿素|eruption|heat wave|solar beam|solar power|chlorophyll/i, slots: ["wallbreaker", "endgame-cleaner", "speed-control"] },
      { id: "weather-cover", label: "水/岩/龙应对", slots: ["defensive-switch", "safe-entry"] },
      { id: "backup-line", label: "非晴天备用路线", slots: ["secondary-core", "speed-control"] },
    ],
  },
  {
    id: "rain",
    name: "雨天速度",
    formats: ["single", "double"],
    goal: /雨天|降雨|求雨|rain|drizzle/i,
    components: [
      { id: "weather-setter", label: "雨天来源", pattern: /降雨|求雨|rain dance|drizzle/i, slots: ["primary-core", "secondary-core"] },
      { id: "weather-abuser", label: "雨天收益打手", pattern: /打雷|暴风|悠游自如|水炮|波动冲|thunder|hurricane|swift swim|hydro pump|wave crash/i, slots: ["wallbreaker", "endgame-cleaner", "speed-control"] },
      { id: "weather-cover", label: "草/电应对", slots: ["defensive-switch", "safe-entry"] },
      { id: "backup-line", label: "反天气备用路线", slots: ["secondary-core", "status-pressure"] },
    ],
  },
  {
    id: "trick-room",
    name: "戏法空间",
    formats: ["single", "double"],
    goal: /空间|戏法空间|trick\s*room/i,
    components: [
      { id: "tr-setter", label: "空间手", pattern: /戏法空间|trick room/i, slots: ["speed-control", "protection"] },
      { id: "slow-abuser", label: "低速高压打手", test: (mon) => stat(mon, "速度") <= 70 && Math.max(stat(mon, "攻击"), stat(mon, "特攻")) >= 100, slots: ["wallbreaker", "primary-core"] },
      { id: "anti-disrupt", label: "防挑衅/保证启动", pattern: /心灵香草|击掌奇袭|看我嘛|愤怒粉|广域防守|mental herb|fake out|follow me|rage powder|wide guard/i, slots: ["safe-entry", "protection", "disruption"] },
      { id: "outside-room", label: "非空间回合路线", slots: ["secondary-core", "priority", "endgame-cleaner"] },
    ],
  },
  {
    id: "balance",
    name: "平衡轮转",
    formats: ["single", "double"],
    goal: /平衡|轮转|balance|balanced/i,
    components: [
      { id: "offense-core", label: "输出核心", slots: ["primary-core", "wallbreaker"] },
      { id: "defensive-core", label: "防守换入", slots: ["defensive-switch", "safe-entry"] },
      { id: "pivot", label: "转场节奏", pattern: MOVE_PATTERNS.pivot, slots: ["safe-entry"] },
      { id: "speed-layer", label: "速度层", slots: ["speed-control", "endgame-cleaner"] },
    ],
  },
  {
    id: "hyper-offense",
    name: "高速进攻",
    formats: ["single", "double"],
    goal: /攻队|进攻|速攻|hyper.?offense|\bho\b/i,
    components: [
      { id: "breaker", label: "破盾手", slots: ["wallbreaker", "primary-core"] },
      { id: "cleaner", label: "终盘清场", slots: ["endgame-cleaner", "speed-control"] },
      { id: "setup-or-hazard", label: "强化/撒场铺垫", pattern: new RegExp(`${MOVE_PATTERNS.setup.source}|${MOVE_PATTERNS.hazard.source}`, "i"), slots: ["hazard", "status-pressure"] },
      { id: "emergency-button", label: "先制/高速兜底", pattern: MOVE_PATTERNS.priority, slots: ["speed-control"] },
    ],
  },
  {
    id: "stall",
    name: "耐久消耗",
    formats: ["single"],
    goal: /受队|盾队|消耗队|stall|fat|semi-?stall/i,
    components: [
      { id: "sustain", label: "回复续航", pattern: MOVE_PATTERNS.sustain, slots: ["defensive-switch"] },
      { id: "status", label: "状态消耗", pattern: MOVE_PATTERNS.status, slots: ["status-pressure"] },
      { id: "hazard-control", label: "撒场/清场", slots: ["hazard", "removal"] },
      { id: "wincon", label: "残局胜点", slots: ["endgame-cleaner", "secondary-core"] },
    ],
  },
  {
    id: "hazard-stack",
    name: "撒场压制",
    formats: ["single"],
    goal: /撒场|钉|隐形岩|撒菱|hazard|spikes|stealth/i,
    components: [
      { id: "hazard", label: "撒场手", pattern: MOVE_PATTERNS.hazard, slots: ["hazard"] },
      { id: "spinblock-or-pressure", label: "阻止清场/压制清场", slots: ["status-pressure", "wallbreaker"] },
      { id: "cleaner", label: "终盘收割", slots: ["endgame-cleaner"] },
      { id: "defensive-glue", label: "换入中转", slots: ["defensive-switch", "safe-entry"] },
    ],
  },
  {
    id: "double-goodstuff",
    name: "双打标准协作",
    formats: ["double"],
    goal: /双打|double|vgc|协作|站场/i,
    components: [
      { id: "lead-support", label: "首发辅助", slots: ["lead-pair", "protection", "disruption"] },
      { id: "speed-control", label: "控速", slots: ["speed-control"] },
      { id: "spread-pressure", label: "范围压力", slots: ["spread-pressure"] },
      { id: "endgame", label: "残局点", slots: ["endgame-cleaner", "secondary-core"] },
    ],
  },
  {
    id: "double-tailwind",
    name: "双打顺风进攻",
    formats: ["double"],
    goal: /顺风|tailwind/i,
    components: [
      { id: "tailwind-setter", label: "顺风手", pattern: /顺风|tailwind/i, slots: ["speed-control", "lead-pair"] },
      { id: "fast-abuser", label: "顺风收益打手", slots: ["wallbreaker", "spread-pressure", "endgame-cleaner"] },
      { id: "protective-lead", label: "保护开局", slots: ["protection", "disruption"] },
      { id: "backup-speed", label: "顺风外速度兜底", slots: ["priority", "speed-control", "secondary-core"] },
    ],
  },
];

function archetypeComponentMatch(mon, component, format = state.format) {
  const tags = slotTagsForPokemon(mon, format);
  const text = `${mon?.name || ""} ${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${textOf(mon, "items")} ${rankedTeamLibrarySetsFor(mon, 2).map((set) => `${set.item} ${set.ability} ${(set.moves || []).join(" ")}`).join(" ")}`;
  if (component.pattern?.test(text)) return true;
  if (component.test?.(mon)) return true;
  return (component.slots || []).some((slot) => tags.slots.includes(slot));
}

function scoreArchetype(archetype, team = [], format = state.format, { userGoal = "", teamStyle = null } = {}) {
  if (!archetype.formats.includes(format)) return null;
  const goalTextValue = `${userGoal} ${teamStyle?.name || ""} ${teamStyle?.id || ""}`;
  let score = archetype.goal?.test(goalTextValue) ? 24 : 0;
  if (teamStyle?.id === archetype.id || (teamStyle?.id === "offense" && archetype.id === "hyper-offense")) score += 18;
  const covered = [];
  const missing = [];
  for (const component of archetype.components) {
    const members = team.filter((mon) => archetypeComponentMatch(mon, component, format)).map((mon) => mon.name);
    if (members.length) {
      score += 7;
      covered.push({ id: component.id, label: component.label, members: [...new Set(members)].slice(0, 3) });
    } else {
      missing.push({ id: component.id, label: component.label, slots: component.slots || [] });
    }
  }
  if (!team.length && !score && ((format === "double" && archetype.id === "double-goodstuff") || (format === "single" && archetype.id === "balance"))) score = 10;
  if (team.length && score < 14) return null;
  return {
    id: archetype.id,
    name: archetype.name,
    score,
    coveredComponents: covered,
    missingComponents: missing,
    requiredComponents: archetype.components.map((item) => ({ id: item.id, label: item.label, slots: item.slots || [] })),
  };
}

function buildArchetypeModel(team = [], format = state.format, { userGoal = "", teamStyle = null, compositionReport = null } = {}) {
  const recognized = ARCHETYPE_CATALOG
    .map((archetype) => scoreArchetype(archetype, team, format, { userGoal, teamStyle }))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  const fromComposition = (compositionReport?.archetypes || []).map((item) => item.name).filter(Boolean);
  const primary = recognized[0] || null;
  return {
    format,
    primary,
    alternatives: recognized.slice(1, 4),
    inheritedTags: fromComposition.slice(0, 4),
    missingComponents: primary?.missingComponents || [],
    buildRules: primary
      ? [
          `优先沿用 ${primary.name}，先补 missingComponents 再比较单体强度。`,
          "候选必须说明它补的是原型组件、槽位缺口，还是主轴的联动需求。",
          "如果放弃主原型，必须说明原型组件不足或与用户目标冲突。",
        ]
      : ["没有明确原型时按平衡骨架起步：主轴、副轴、速度、安全上场、联防、终盘。"],
  };
}

function candidateArchetypeFit(mon, archetypeModel, format = state.format) {
  const archetypes = [archetypeModel?.primary, ...(archetypeModel?.alternatives || [])].filter(Boolean).slice(0, 3);
  const matches = [];
  for (const archetype of archetypes) {
    const source = ARCHETYPE_CATALOG.find((item) => item.id === archetype.id);
    if (!source) continue;
    const missingIds = new Set((archetype.missingComponents || []).map((item) => item.id));
    const components = source.components.filter((component) => archetypeComponentMatch(mon, component, format));
    const missingComponents = components.filter((component) => missingIds.has(component.id));
    if (components.length) {
      matches.push({
        id: archetype.id,
        name: archetype.name,
        components: components.map((item) => item.id),
        fillComponents: missingComponents.map((item) => item.id),
        score: missingComponents.length * 9 + components.length * 3 + (archetype.id === archetypeModel?.primary?.id ? 4 : 0),
      });
    }
  }
  const score = matches.reduce((sum, item) => sum + item.score, 0);
  return {
    score: Math.round(score),
    archetypes: matches.map((item) => item.id),
    fillComponents: [...new Set(matches.flatMap((item) => item.fillComponents))],
    reasons: matches
      .sort((a, b) => b.score - a.score)
      .flatMap((item) => [`适配${item.name}`, item.fillComponents.length ? `补原型组件：${item.fillComponents.join("/")}` : "强化既有原型"])
      .filter(Boolean)
      .slice(0, 5),
  };
}

function candidateSynergyReport(mon, { selectedTeam = state.team, targetProfiles = [], teamStyle = null } = {}) {
  const reasons = [];
  let score = 0;
  const text = `${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${textOf(mon, "items")} ${rankedTeamLibrarySetsFor(mon, 2).map((set) => `${set.item} ${set.ability} ${(set.moves || []).join(" ")}`).join(" ")}`;
  const roles = getRoles(mon);
  const selectedText = selectedTeam.map((item) => `${item.name} ${textOf(item, "moves")} ${textOf(item, "abilities")} ${textOf(item, "items")} ${getRoles(item).join(" ")}`).join(" ");
  const selectedHasCore = selectedTeam.some((item) => getRoles(item).some((role) => /输出|高速|Mega/.test(role)) || MOVE_PATTERNS.setup.test(textOf(item, "moves")));
  const selectedHasSlowBreaker = selectedTeam.some((item) => (getRoles(item).some((role) => /输出|Mega/.test(role)) || MOVE_PATTERNS.setup.test(textOf(item, "moves"))) && stat(item, "速度") < 100);
  const selectedHasMega = selectedTeam.some((item) => isMegaStone(editableConfigFor(item).item) || megaProfileFor(item));
  const selectedNeedsPivot = selectedTeam.length && !MOVE_PATTERNS.pivot.test(selectedText);
  const selectedNeedsSpeed = selectedTeam.length && !MOVE_PATTERNS.speedControl.test(selectedText);
  const selectedNeedsProtection = selectedTeam.length && !/(威吓|击掌奇袭|看我嘛|愤怒粉|广域防守|intimidate|fake out|follow me|rage powder|wide guard)/i.test(selectedText);

  const add = (points, reason) => {
    score += points;
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  if (selectedHasCore && selectedNeedsPivot && MOVE_PATTERNS.pivot.test(text)) add(5, "转场带核心安全上场");
  if ((selectedHasSlowBreaker || selectedNeedsSpeed) && MOVE_PATTERNS.speedControl.test(text)) add(5, "控速服务中速/低速打手");
  if (selectedHasCore && (MOVE_PATTERNS.hazard.test(text) || MOVE_PATTERNS.status.test(text))) add(3, "撒场/状态铺垫收割");
  if ((selectedHasCore || selectedHasMega || selectedNeedsProtection) && (MOVE_PATTERNS.fakeOut.test(text) || MOVE_PATTERNS.redirection.test(text) || MOVE_PATTERNS.intimidate.test(text) || /广域防守|wide guard/i.test(text))) add(4, "保护核心输出行动回合");

  const weakTypes = selectedTeam.flatMap((ally) => {
    const ownTypes = englishTypesFor(ally);
    return Object.keys(TYPE_EFFECTIVENESS).filter((attackType) => ownTypes.length && typeEffectiveness(attackType, ownTypes) > 1);
  });
  const ownTypes = englishTypesFor(mon);
  const coveredWeakTypes = [...new Set(weakTypes.filter((attackType) => ownTypes.length && typeEffectiveness(attackType, ownTypes) < 1))].slice(0, 3);
  if (coveredWeakTypes.length) add(Math.min(4, coveredWeakTypes.length * 2), `补${coveredWeakTypes.join("/")}换入`);

  const usage = externalKnowledgeFor(mon)?.usage;
  const selectedNames = new Set(selectedTeam.flatMap((ally) => [ally.name, ally.slug, knowledgeEntryFor(ally)?.showdown?.name]).map(idKey).filter(Boolean));
  const teammateHits = (usage?.teammates || []).filter((item) => selectedNames.has(idKey(item.name))).slice(0, 2);
  if (teammateHits.length) add(4, `常见队友匹配：${teammateHits.map((item) => localizePokemonName(item.name)).join("、")}`);

  if (/(日照|大晴天|drought|sunny day)/i.test(selectedText) && /(叶绿素|太阳之力|日光束|喷火|热风|chlorophyll|solar power|solar beam|eruption|heat wave)/i.test(text)) add(3, "吃晴天收益");
  if (/(降雨|求雨|drizzle|rain dance)/i.test(selectedText) && /(悠游自如|打雷|暴风|水炮|波动冲|swift swim|thunder|hurricane|hydro pump|wave crash)/i.test(text)) add(3, "吃雨天收益");
  if ((megaProfileFor(mon) || isMegaStone(text)) && (MOVE_PATTERNS.pivot.test(selectedText) || MOVE_PATTERNS.speedControl.test(selectedText) || /威吓|击掌奇袭|看我嘛|愤怒粉|intimidate|fake out|follow me|rage powder/i.test(selectedText))) add(3, "现有队友能服务 Mega 位");
  if (selectedHasMega && (MOVE_PATTERNS.pivot.test(text) || MOVE_PATTERNS.speedControl.test(text) || roles.includes("耐久位"))) add(3, "辅助现有 Mega 位");

  for (const profile of targetProfiles) {
    const targetTypes = (profile.target?.types || []).map((type) => TYPE_CN_TO_EN[type] || type).filter(Boolean);
    const defensiveAnswer = targetTypes.some((attackType) => ownTypes.length && typeEffectiveness(attackType, ownTypes) < 1);
    if (defensiveAnswer && (roles.includes("耐久位") || roles.includes("特性价值"))) add(3, `补${profile.target?.name || "目标"}进场答案`);
  }

  if (teamStyle?.id === "stall" && (roles.includes("耐久位") || MOVE_PATTERNS.sustain.test(text)) && (MOVE_PATTERNS.pivot.test(text) || MOVE_PATTERNS.status.test(text))) add(3, "符合耐久消耗闭环");

  return { score: Math.round(score), reasons: reasons.slice(0, 5) };
}

function pokemonSynergyTags(mon, format = state.format) {
  if (!mon) return { tags: [], reasons: [] };
  const slotTags = slotTagsForPokemon(mon, format);
  const usage = pokemonUsageProfile(mon, format);
  const roles = getRoles(mon);
  const setsText = rankedTeamLibrarySetsFor(mon, 3).map((set) => `${set.item} ${set.ability} ${(set.moves || []).join(" ")}`).join(" ");
  const text = `${mon.name || ""} ${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${textOf(mon, "items")} ${usage.moves.join(" ")} ${usage.items.join(" ")} ${usage.abilities.join(" ")} ${setsText}`;
  const tags = new Set(slotTags.slots);
  const reasons = [...slotTags.reasons];
  const add = (tag, reason) => {
    tags.add(tag);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  if (slotTags.slots.some((slot) => ["primary-core", "secondary-core", "wallbreaker"].includes(slot)) || roles.some((role) => /核心|输出|Mega/.test(role))) add("core", "可作为行动链收益端。");
  if (MOVE_PATTERNS.pivot.test(text)) add("pivot", "能用转场招式把核心带上场。");
  if (MOVE_PATTERNS.speedControl.test(text)) add("speed-control", "能改变行动顺序。");
  if (stat(mon, "速度") < 80 && (slotTags.slots.includes("wallbreaker") || slotTags.slots.includes("primary-core"))) add("slow-breaker", "偏慢但有破坏力，需要控速或安全进场。");
  if (slotTags.slots.includes("endgame-cleaner")) add("cleaner", "可承担终盘收割。");
  if (MOVE_PATTERNS.hazard.test(text)) add("hazard", "能撒场铺垫。");
  if (MOVE_PATTERNS.status.test(text)) add("status", "能用状态逼迫换人或削弱输出。");
  if (MOVE_PATTERNS.protect.test(text) || /广域防守|帮助|wide guard|helping hand/i.test(text)) add("protection", "能保护关键行动回合。");
  if (MOVE_PATTERNS.redirection.test(text)) add("redirection", "能掩护队友吃招。");
  if (MOVE_PATTERNS.fakeOut.test(text)) add("fake-out", "能用击掌抢首回合节奏。");
  if (MOVE_PATTERNS.intimidate.test(text)) add("intimidate", "能用威吓降低对方物理压力。");
  if (MOVE_PATTERNS.spread.test(text)) add("spread", "能提供范围压力。");
  if (/日照|大晴天|drought|sunny day/i.test(text)) add("weather-sun-setter", "能建立晴天。");
  if (/降雨|求雨|drizzle|rain dance/i.test(text)) add("weather-rain-setter", "能建立雨天。");
  if (/降雪|雪景|snow warning|snowscape|hail/i.test(text)) add("weather-snow-setter", "能建立雪天。");
  if (/扬沙|沙暴|sand stream|sandstorm/i.test(text)) add("weather-sand-setter", "能建立沙暴。");
  if (/叶绿素|太阳之力|日光束|喷火|热风|chlorophyll|solar power|solar beam|eruption|heat wave/i.test(text)) add("weather-sun-abuser", "能吃晴天收益。");
  if (/悠游自如|打雷|暴风|水炮|波动冲|swift swim|thunder|hurricane|hydro pump|wave crash/i.test(text)) add("weather-rain-abuser", "能吃雨天收益。");
  if (/拨雪|暴风雪|slush rush|blizzard/i.test(text)) add("weather-snow-abuser", "能吃雪天收益。");
  if (/拨沙|沙之力|sand rush|sand force/i.test(text)) add("weather-sand-abuser", "能吃沙暴收益。");
  if (/戏法空间|trick room/i.test(text)) add("trick-room-setter", "能开启戏法空间。");
  if (stat(mon, "速度") <= 60 && (slotTags.slots.includes("wallbreaker") || MOVE_PATTERNS.spread.test(text))) add("trick-room-abuser", "低速高压，适合空间回合。");
  return { tags: [...tags], reasons: reasons.slice(0, 8) };
}

function teamTagMembers(team = [], format = state.format) {
  const byTag = new Map();
  for (const mon of team) {
    for (const tag of pokemonSynergyTags(mon, format).tags) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(mon.name);
    }
  }
  return byTag;
}

function synergyChainCatalog(format = state.format) {
  const common = [
    { id: "pivot-to-core", label: "转场带核心", roles: ["pivot", "core"], priority: 9, reason: "让主轴不用硬换吃伤害。", keywords: ["转场", "安全上场", "带核心"] },
    { id: "speed-to-breaker", label: "控速服务打手", roles: ["speed-control", "slow-breaker"], priority: 9, reason: "让中低速高火力成员稳定出手。", keywords: ["控速", "服务打手", "顺风", "空间"] },
    { id: "status-hazard-to-cleaner", label: "铺垫终盘收割", roles: ["cleaner"], anyRoles: ["hazard", "status"], priority: 8, reason: "撒场或状态把对手压入收割线。", keywords: ["撒场", "状态", "终盘", "收割"] },
    { id: "defensive-core", label: "抗性互补换入", roles: ["defensive-switch", "safe-entry"], priority: 8, reason: "保留多次进场和换位处理空间。", keywords: ["联防", "换入", "抗性互补"] },
    { id: "weather-abuse", label: "天气建立与收益", rolePairs: [["weather-sun-setter", "weather-sun-abuser"], ["weather-rain-setter", "weather-rain-abuser"], ["weather-snow-setter", "weather-snow-abuser"], ["weather-sand-setter", "weather-sand-abuser"]], priority: 7, reason: "天气轴必须同时有天气来源和收益者。", keywords: ["天气", "晴天", "雨天", "雪天", "沙暴"] },
  ];
  if (format === "double") {
    return [
      { id: "lead-pair", label: "双打首发组合", roles: ["lead-pair", "core"], anyRoles: ["fake-out", "redirection", "intimidate", "speed-control"], priority: 10, reason: "双打需要开局就能保护输出或抢行动权。", keywords: ["首发", "开局", "组合"] },
      { id: "protect-core", label: "保护核心行动", roles: ["core"], anyRoles: ["fake-out", "redirection", "intimidate", "protection"], priority: 9, reason: "给输出手创造至少一个稳定行动回合。", keywords: ["保护", "击掌", "掩护", "威吓"] },
      { id: "speed-spread", label: "控速接范围压制", roles: ["speed-control", "spread"], priority: 9, reason: "先改变速度，再用范围招式压站位。", keywords: ["控速", "范围", "热风", "岩崩"] },
      { id: "trick-room-mode", label: "空间模式闭环", roles: ["trick-room-setter", "trick-room-abuser"], priority: 7, reason: "低速炮台需要明确空间手支持。", keywords: ["戏法空间", "空间"] },
      ...common.filter((item) => item.id !== "status-hazard-to-cleaner"),
    ];
  }
  return common;
}

function chainCoverage(chain, membersByTag) {
  const covered = [];
  const missing = [];
  for (const role of chain.roles || []) {
    const members = membersByTag.get(role) || [];
    if (members.length) covered.push({ role, members: [...new Set(members)].slice(0, 3) });
    else missing.push(role);
  }
  if (chain.anyRoles?.length) {
    const anyMembers = chain.anyRoles.flatMap((role) => membersByTag.get(role) || []);
    if (anyMembers.length) covered.push({ role: chain.anyRoles.join("|"), members: [...new Set(anyMembers)].slice(0, 3) });
    else missing.push(chain.anyRoles.join("|"));
  }
  if (chain.rolePairs?.length) {
    const pair = chain.rolePairs.find(([a, b]) => (membersByTag.get(a) || []).length && (membersByTag.get(b) || []).length);
    if (pair) {
      covered.push({ role: pair.join("+"), members: [...new Set([...membersByTag.get(pair[0]), ...membersByTag.get(pair[1])])].slice(0, 4) });
    } else {
      missing.push(chain.rolePairs.map((pairRoles) => pairRoles.join("+")).join("|"));
    }
  }
  return { covered, missing };
}

function buildSynergyChains(team = [], format = state.format, { archetypeModel = null, slotModel = null } = {}) {
  const membersByTag = teamTagMembers(team, format);
  const chains = synergyChainCatalog(format)
    .map((chain) => {
      const coverage = chainCoverage(chain, membersByTag);
      const coveredRoles = coverage.covered.map((item) => item.role);
      const coveredMembers = [...new Set(coverage.covered.flatMap((item) => item.members))];
      const complete = !coverage.missing.length;
      return {
        id: chain.id,
        label: chain.label,
        priority: chain.priority + (complete ? 1 : 0),
        members: coveredMembers,
        coveredRoles,
        missingRoles: coverage.missing,
        complete,
        reason: chain.reason,
        keywords: chain.keywords,
      };
    })
    .sort((a, b) => b.priority - a.priority || Number(a.complete) - Number(b.complete));
  const primaryName = archetypeModel?.primary?.name || "";
  return {
    format,
    primaryArchetype: primaryName,
    chains: chains.slice(0, 8),
    missingChains: chains.filter((chain) => !chain.complete).slice(0, 5),
    notes: [
      "chainModel 是队友联动组合库：先补高优先级 missingRoles，再比较单体强度。",
      "plan/note 必须点名至少 2 条链，例如 A 转场带 B、C 控速服务 D、E 撒场铺垫 F 收割。",
      slotModel?.missingSlots?.length ? `当前还需配合 slotModel 缺槽：${slotModel.missingSlots.slice(0, 3).map((slot) => slot.label).join("、")}` : "当前槽位覆盖较完整，优先检查链条是否闭合。",
    ],
  };
}

function candidateChainFit(mon, chainModel, format = state.format) {
  const tags = pokemonSynergyTags(mon, format);
  const tagSet = new Set(tags.tags);
  const matches = (chainModel?.missingChains || chainModel?.chains || [])
    .map((chain) => {
      const missingRoles = chain.missingRoles || [];
      const fills = missingRoles.filter((role) => role.split("|").some((part) => part.split("+").every((tag) => tagSet.has(tag))));
      const supportsCompleteChain = !missingRoles.length && (chain.coveredRoles || []).some((role) => role.split("|").some((tag) => tagSet.has(tag)));
      const score = fills.length ? fills.length * chain.priority + Math.min(4, tags.tags.length) : supportsCompleteChain ? 3 : 0;
      return { chain, fills, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    score: Math.round(matches.slice(0, 4).reduce((sum, item) => sum + item.score, 0)),
    chains: matches.slice(0, 4).map((item) => item.chain.id),
    fillRoles: [...new Set(matches.flatMap((item) => item.fills))],
    tags: tags.tags.slice(0, 12),
    reasons: matches
      .slice(0, 4)
      .map((item) => `${item.chain.label}: ${item.fills.length ? `补 ${item.fills.join("/")}` : "强化既有链"}`)
      .concat(tags.reasons.slice(0, 2))
      .slice(0, 6),
  };
}

function buildResourceModel(team = [], format = state.format, { megaPlan = null } = {}) {
  const tagCounts = {};
  for (const tag of team.flatMap((mon) => pokemonSynergyTags(mon, format).tags)) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  const selectedText = team.map((mon) => `${mon.name} ${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${textOf(mon, "items")}`).join(" ");
  const risks = [];
  const desired = [];
  const addDesired = (id, label, priority, reason, tags) => desired.push({ id, label, priority, reason, tags });
  const addRisk = (id, label, severity, reason, fixTags = []) => risks.push({ id, label, severity, reason, fixTags });
  const weatherSetters = ["weather-sun-setter", "weather-rain-setter", "weather-snow-setter", "weather-sand-setter"].filter((tag) => tagCounts[tag]);
  const megaCount = team.filter((mon) => isMegaStone(editableConfigFor(mon).item) || megaProfileFor(mon)).length;

  if (team.length && tagCounts.core && !tagCounts["safe-entry"] && !tagCounts.pivot) {
    addRisk("no-safe-entry", "核心缺少安全上场", 9, "主轴会被迫硬换吃伤害。", ["safe-entry", "pivot", "defensive-switch"]);
    addDesired("safe-entry", "安全上场资源", 9, "补转场、中转、击掌、守住或掩护。", ["safe-entry", "pivot", "defensive-switch"]);
  }
  if ((tagCounts["slow-breaker"] || /低速|煤炭龟|torkoal/i.test(selectedText)) && !tagCounts["speed-control"] && !tagCounts["trick-room-setter"]) {
    addRisk("slow-core-no-speed", "低速核心缺控速", 9, "低速打手需要顺风、空间、电磁波或先制节奏。", ["speed-control", "trick-room-setter"]);
    addDesired("speed-control", "速度控制资源", 9, "补顺风、空间、电磁波、冰风、岩封或先制兜底。", ["speed-control", "trick-room-setter"]);
  }
  if (format === "single" && (tagCounts.hazard || tagCounts.status) && !tagCounts.cleaner) {
    addRisk("setup-no-cleaner", "铺垫后缺收割点", 7, "撒场/状态需要终盘收益者闭环。", ["cleaner", "endgame-cleaner"]);
    addDesired("cleaner", "终盘收割点", 7, "补高速、先制、强化或围巾收割。", ["cleaner", "endgame-cleaner"]);
  }
  if (format === "single" && tagCounts.core && !tagCounts["defensive-switch"]) {
    addRisk("no-defensive-switch", "缺少防守换入", 8, "队伍容易只有进攻答案，没有进场答案。", ["defensive-switch"]);
    addDesired("defensive-switch", "防守换入点", 8, "补抗性、免疫、耐久或特性中转。", ["defensive-switch"]);
  }
  if (format === "double" && (tagCounts.core || tagCounts.spread) && !tagCounts.protection && !tagCounts["fake-out"] && !tagCounts.redirection) {
    addRisk("double-no-protection", "双打核心缺行动保护", 9, "输出位容易首回合被集火拆开。", ["protection", "fake-out", "redirection", "intimidate"]);
    addDesired("protection", "行动保护资源", 9, "补守住、击掌、威吓、看我嘛、愤怒粉或广域防守。", ["protection", "fake-out", "redirection", "intimidate"]);
  }
  if (format === "double" && tagCounts.spread && !tagCounts["speed-control"]) {
    addRisk("spread-no-speed", "范围压制缺控速", 8, "范围招式需要先手权或保护回合。", ["speed-control"]);
    addDesired("speed-control", "双打控速资源", 8, "补顺风、冰风、电磁波或空间。", ["speed-control"]);
  }
  if (weatherSetters.length > 1) {
    addRisk("mixed-weather", "多天气资源冲突", 8, "多天气必须说明主天气、备用天气和收益者，否则会互相削弱。", ["weather-sun-abuser", "weather-rain-abuser", "weather-snow-abuser", "weather-sand-abuser"]);
  }
  if (megaCount > 1) {
    addRisk("multi-mega-resource", "Mega 资源竞争", 7, "双 Mega 只能作为主副对局分支，不能同局同时消耗 Mega 位。", ["safe-entry", "speed-control", "defensive-switch"]);
  } else if (!megaCount && megaPlan?.recommendation !== "no-forced-mega") {
    addDesired("mega-support", "Mega 轴或不硬凑说明", 6, "通常至少规划一个合理 Mega；若不选必须说明理由。", ["mega-slot", "safe-entry"]);
  }
  return {
    format,
    resources: tagCounts,
    risks: risks.sort((a, b) => b.severity - a.severity).slice(0, 8),
    desiredResources: desired.sort((a, b) => b.priority - a.priority).slice(0, 8),
    notes: [
      "resourceModel 用来发现资源冲突和闭环断点：安全上场、控速、联防、终盘、保护、天气和 Mega 资源要服务同一主轴。",
      "候选如果只增加强单体但不能修复 desiredResources 或 risks，不能优先于能闭环的补位。",
    ],
  };
}

function candidateResourceFit(mon, resourceModel, format = state.format) {
  const tags = pokemonSynergyTags(mon, format);
  const tagSet = new Set(tags.tags);
  const desiredMatches = (resourceModel?.desiredResources || []).filter((item) => (item.tags || []).some((tag) => tagSet.has(tag)));
  const riskMatches = (resourceModel?.risks || []).filter((risk) => (risk.fixTags || []).some((tag) => tagSet.has(tag)));
  const worsensMixedWeather = (resourceModel?.risks || []).some((risk) => risk.id === "mixed-weather") && [...tagSet].some((tag) => /weather-.*-setter/.test(tag));
  const score = desiredMatches.reduce((sum, item) => sum + item.priority, 0) + riskMatches.reduce((sum, item) => sum + Math.ceil(item.severity / 2), 0) - (worsensMixedWeather ? 6 : 0);
  return {
    score: Math.round(score),
    fixes: [...new Set([...desiredMatches.map((item) => item.id), ...riskMatches.map((item) => item.id)])],
    risks: worsensMixedWeather ? ["mixed-weather"] : [],
    reasons: [
      ...desiredMatches.map((item) => `补资源闭环：${item.label}`),
      ...riskMatches.map((item) => `缓解冲突：${item.label}`),
      ...(worsensMixedWeather ? ["可能加剧多天气冲突，除非 plan 说明天气切换。"] : []),
    ].slice(0, 5),
  };
}

function phaseRoleCatalog(format = state.format) {
  if (format === "double") {
    return [
      { id: "opening", label: "开局抢节奏", priority: 10, roles: ["lead-pair"], anyRoles: ["fake-out", "redirection", "intimidate", "speed-control"], reason: "双打前两回合需要首发组合、控速或先手干扰保护主轴。", keywords: ["开局", "首发", "lead"] },
      { id: "midgame", label: "中盘站场转换", priority: 9, roles: ["protection"], anyRoles: ["spread", "defensive-switch", "safe-entry", "status"], reason: "中盘要靠守住、范围压力、联防或状态维持站场。", keywords: ["中盘", "站场", "轮换"] },
      { id: "endgame", label: "终盘收割", priority: 9, roles: ["cleaner"], anyRoles: ["core", "speed-control", "priority"], reason: "终盘需要明确收割点和速度兜底。", keywords: ["终盘", "收割", "清场"] },
      { id: "anti-lead", label: "反首发切换", priority: 8, anyRoles: ["defensive-switch", "redirection", "intimidate", "protect", "speed-control"], reason: "遇到反首发时要有保护、换位或改速方案。", keywords: ["反首发", "切换", "保护"] },
    ];
  }
  return [
    { id: "opening", label: "开局建立节奏", priority: 9, anyRoles: ["hazard", "status", "pivot", "speed-control"], reason: "单打开局要用撒场、状态、转场或控速建立主动权。", keywords: ["开局", "撒场", "节奏"] },
    { id: "midgame", label: "中盘轮转突破", priority: 9, roles: ["safe-entry"], anyRoles: ["defensive-switch", "pivot", "wallbreaker", "status", "removal"], reason: "中盘需要安全进场、联防、清场或破盾来维持资源。", keywords: ["中盘", "轮转", "消耗", "突破"] },
    { id: "endgame", label: "终盘胜利路线", priority: 10, roles: ["cleaner"], anyRoles: ["core", "speed-control", "priority"], reason: "必须说明最后由谁清场、收割或压制残局。", keywords: ["终盘", "收割", "清场"] },
  ];
}

function phaseCoverage(phase, membersByTag) {
  const covered = [];
  const missing = [];
  for (const role of phase.roles || []) {
    const members = membersByTag.get(role) || [];
    if (members.length) covered.push({ role, members: [...new Set(members)].slice(0, 3) });
    else missing.push(role);
  }
  if (phase.anyRoles?.length) {
    const anyMembers = phase.anyRoles.flatMap((role) => membersByTag.get(role) || []);
    if (anyMembers.length) covered.push({ role: phase.anyRoles.join("|"), members: [...new Set(anyMembers)].slice(0, 3) });
    else missing.push(phase.anyRoles.join("|"));
  }
  return { covered, missing };
}

function buildPhaseModel(team = [], format = state.format, { chainModel = null, resourceModel = null } = {}) {
  const membersByTag = teamTagMembers(team, format);
  const phases = phaseRoleCatalog(format)
    .map((phase) => {
      const coverage = phaseCoverage(phase, membersByTag);
      const members = [...new Set(coverage.covered.flatMap((item) => item.members))];
      return {
        id: phase.id,
        label: phase.label,
        priority: phase.priority + (coverage.missing.length ? 0 : 1),
        members,
        coveredRoles: coverage.covered.map((item) => item.role),
        missingRoles: coverage.missing,
        complete: !coverage.missing.length,
        reason: phase.reason,
        keywords: phase.keywords,
      };
    })
    .sort((a, b) => b.priority - a.priority || Number(a.complete) - Number(b.complete));
  return {
    format,
    phases,
    missingPhases: phases.filter((phase) => !phase.complete).slice(0, 4),
    notes: [
      "phaseModel 是对局阶段路线：开局取得节奏，中盘维持资源或突破，终盘明确胜点。",
      "最终 plan 必须把 chainModel 的联动链放进阶段顺序，而不是只列成员职责。",
      resourceModel?.risks?.length ? `优先让阶段路线修复资源风险：${resourceModel.risks.slice(0, 2).map((risk) => risk.label).join("、")}` : chainModel?.missingChains?.length ? `优先把缺失联动链嵌入阶段：${chainModel.missingChains.slice(0, 2).map((chain) => chain.label).join("、")}` : "阶段路线可围绕已覆盖资源安排主轴和副轴。",
    ],
  };
}

function candidatePhaseFit(mon, phaseModel, format = state.format) {
  const tags = pokemonSynergyTags(mon, format);
  const tagSet = new Set(tags.tags);
  const matches = (phaseModel?.missingPhases || phaseModel?.phases || [])
    .map((phase) => {
      const fills = (phase.missingRoles || []).filter((role) => role.split("|").some((tag) => tagSet.has(tag)));
      const supportsCompletePhase = !fills.length && !(phase.missingRoles || []).length && (phase.coveredRoles || []).some((role) => role.split("|").some((tag) => tagSet.has(tag)));
      const score = fills.length ? fills.length * phase.priority + Math.min(4, tags.tags.length) : supportsCompletePhase ? 3 : 0;
      return { phase, fills, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    score: Math.round(matches.slice(0, 4).reduce((sum, item) => sum + item.score, 0)),
    phases: matches.slice(0, 4).map((item) => item.phase.id),
    fillRoles: [...new Set(matches.flatMap((item) => item.fills))],
    reasons: matches
      .slice(0, 4)
      .map((item) => `${item.phase.label}: ${item.fills.length ? `补 ${item.fills.join("/")}` : "强化阶段路线"}`)
      .slice(0, 5),
  };
}

function branchRoleTags(role) {
  const map = {
    defensiveSwitch: ["defensive-switch", "safe-entry"],
    offensivePressure: ["wallbreaker", "core", "spread"],
    revengeKill: ["cleaner", "priority", "speed-control"],
    speedControl: ["speed-control", "trick-room-setter"],
    statusDisrupt: ["status", "disruption"],
    safePivot: ["pivot", "safe-entry"],
    antiWeather: ["weather-sun-setter", "weather-rain-setter", "weather-snow-setter", "weather-sand-setter", "defensive-switch"],
    protection: ["protection", "fake-out", "redirection", "intimidate"],
    hazardControl: ["removal", "hazard", "status"],
  };
  return map[role] || [role];
}

function branchCatalogFor(format = state.format) {
  const common = [
    { id: "fast-offense", label: "高速压制分支", priority: 9, answerRoles: ["defensiveSwitch", "speedControl", "revengeKill"], reason: "面对高速攻不能只靠正面换血，需要换入点、改速或收割兜底。", keywords: ["高速", "控速", "revenge", "围巾", "先制"] },
    { id: "setup-sweeper", label: "强化展开分支", priority: 8, answerRoles: ["statusDisrupt", "offensivePressure", "revengeKill"], reason: "面对强化手要有挑衅/状态、逼退或终盘兜底。", keywords: ["强化", "展开", "挑衅", "再来一次"] },
    { id: "weather-mode", label: "天气轴分支", priority: 7, answerRoles: ["antiWeather", "defensiveSwitch", "speedControl"], reason: "面对天气队要能抢天气、抗收益打点或改速度。", keywords: ["天气", "晴天", "雨天", "沙暴", "雪天"] },
    { id: "bulky-balance", label: "耐久轮转分支", priority: 7, answerRoles: ["hazardControl", "statusDisrupt", "offensivePressure"], reason: "面对耐久轮转要有撒场/清场、状态或破盾压力。", keywords: ["受队", "耐久", "轮转", "消耗", "破盾"] },
  ];
  if (format === "double") {
    return [
      { id: "double-speed", label: "双打控速分支", priority: 10, answerRoles: ["speedControl", "protection", "offensivePressure"], reason: "双打遇到顺风/空间/高速首发时，需要控速、保护和反压。", keywords: ["顺风", "空间", "控速", "首发"] },
      { id: "double-lead-pressure", label: "双打反首发分支", priority: 9, answerRoles: ["protection", "defensiveSwitch", "statusDisrupt"], reason: "面对击掌、威吓、掩护或集火首发，要有保护与切换路线。", keywords: ["反首发", "击掌", "威吓", "集火"] },
      ...common.filter((item) => item.id !== "bulky-balance"),
    ];
  }
  return [
    { id: "hazard-pressure", label: "撒场压制分支", priority: 8, answerRoles: ["hazardControl", "safePivot", "offensivePressure"], reason: "单打遇到撒场压制时，需要清场/反撒场和安全换入。", keywords: ["撒场", "隐形岩", "撒菱", "清场"] },
    ...common,
  ];
}

function inferBranchPressure(branch, threatMatrix = null, resourceModel = null, phaseModel = null) {
  const rows = threatMatrix?.rows || [];
  const text = rows.map((row) => `${row.name} ${(row.commonMoves || []).join(" ")} ${(row.commonItems || []).join(" ")} ${(row.missingAnswers || []).join(" ")}`).join(" ");
  let pressure = 0;
  const relatedThreats = [];
  if (branch.id.includes("speed") || branch.id === "fast-offense") {
    const matches = rows.filter((row) => row.missingAnswers?.includes("speedOrRevenge") || Number(row.speed || 0) >= 110);
    pressure += matches.length * 2;
    relatedThreats.push(...matches.map((row) => row.name));
  }
  if (branch.id === "weather-mode" && /日照|大晴天|降雨|求雨|雪景|降雪|沙暴|drought|sunny|drizzle|rain|snow|sand/i.test(text)) pressure += 5;
  if (branch.id === "setup-sweeper" && /剑舞|龙舞|诡计|冥想|健美|蝶舞|swords dance|dragon dance|nasty plot|calm mind|bulk up|quiver dance/i.test(text)) pressure += 5;
  if ((branch.id === "hazard-pressure" || branch.id === "bulky-balance") && /隐形岩|撒菱|毒菱|stealth rock|spikes|toxic spikes|recover|roost|leftovers/i.test(text)) pressure += 5;
  if (branch.id === "double-lead-pressure" && /fake out|intimidate|follow me|rage powder|tailwind|trick room|击掌|威吓|看我嘛|愤怒粉|顺风|戏法空间/i.test(text)) pressure += 5;
  if ((resourceModel?.risks || []).some((risk) => /速度|控速|安全上场|行动保护|多天气/.test(risk.label))) pressure += 2;
  if ((phaseModel?.missingPhases || []).some((phase) => /开局|首发|反首发/.test(phase.label)) && /lead|首发|开局|speed|高速|控速/i.test(`${branch.id} ${branch.label}`)) pressure += 2;
  return { pressure, relatedThreats: [...new Set(relatedThreats)].slice(0, 4) };
}

function buildMatchupBranchModel(team = [], format = state.format, { threatMatrix = null, resourceModel = null, phaseModel = null } = {}) {
  const membersByTag = teamTagMembers(team, format);
  const branches = branchCatalogFor(format)
    .map((branch) => {
      const pressure = inferBranchPressure(branch, threatMatrix, resourceModel, phaseModel);
      const missingAnswerRoles = branch.answerRoles.filter((role) => !branchRoleTags(role).some((tag) => (membersByTag.get(tag) || []).length));
      const members = [...new Set(branch.answerRoles.flatMap((role) => branchRoleTags(role).flatMap((tag) => membersByTag.get(tag) || [])))].slice(0, 4);
      return {
        id: branch.id,
        label: branch.label,
        priority: branch.priority + Math.min(5, pressure.pressure),
        answerRoles: branch.answerRoles,
        missingAnswerRoles,
        members,
        relatedThreats: pressure.relatedThreats,
        complete: !missingAnswerRoles.length,
        reason: branch.reason,
        keywords: branch.keywords,
      };
    })
    .filter((branch) => branch.priority >= 8 || branch.relatedThreats.length || branch.missingAnswerRoles.length)
    .sort((a, b) => b.priority - a.priority || Number(a.complete) - Number(b.complete));
  return {
    format,
    branches: branches.slice(0, 8),
    missingBranches: branches.filter((branch) => !branch.complete).slice(0, 5),
    notes: [
      "branchModel 是对局分支模型：不同对手轴要有不同处理顺序，不能只写一条顺风局路线。",
      "watch 必须覆盖高优先级分支，并写清先换入/保护或控速，再逼退/收割。",
    ],
  };
}

function candidateBranchFit(mon, branchModel, format = state.format) {
  const tags = pokemonSynergyTags(mon, format);
  const tagSet = new Set(tags.tags);
  const matches = (branchModel?.missingBranches || branchModel?.branches || [])
    .map((branch) => {
      const fills = (branch.missingAnswerRoles || []).filter((role) => branchRoleTags(role).some((tag) => tagSet.has(tag)));
      const supportsCompleteBranch = !fills.length && !(branch.missingAnswerRoles || []).length && branch.answerRoles.some((role) => branchRoleTags(role).some((tag) => tagSet.has(tag)));
      const score = fills.length ? fills.length * branch.priority + Math.min(4, tags.tags.length) : supportsCompleteBranch ? 3 : 0;
      return { branch, fills, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    score: Math.round(matches.slice(0, 4).reduce((sum, item) => sum + item.score, 0)),
    branches: matches.slice(0, 4).map((item) => item.branch.id),
    fillRoles: [...new Set(matches.flatMap((item) => item.fills))],
    reasons: matches
      .slice(0, 4)
      .map((item) => `${item.branch.label}: ${item.fills.length ? `补 ${item.fills.join("/")}` : "强化对局分支"}`)
      .slice(0, 5),
  };
}

function buildPokemonProfile(mon, format = state.format) {
  if (!mon) return null;
  const usage = pokemonUsageProfile(mon, format);
  const slot = slotTagsForPokemon(mon, format);
  const synergy = pokemonSynergyTags(mon, format);
  const supportProfile = supportCandidateReport(mon);
  const megaProfile = megaProfileFor(mon);
  const tags = [...new Set([...slot.slots, ...synergy.tags, ...(supportProfile.tags || [])])];
  return {
    id: mon.id,
    name: mon.name,
    slug: mon.slug,
    format,
    types: mon.types || [],
    stats: mon.stats || {},
    speed: effectiveSpeed(mon),
    bulk: stat(mon, "HP") + stat(mon, "防御") + stat(mon, "特防"),
    roles: getRoles(mon),
    tags,
    evidence: {
      slot: slot.reasons,
      synergy: synergy.reasons,
      support: supportProfile.reasons || [],
      commonMoves: usage.moves.slice(0, 6),
      commonItems: usage.items.slice(0, 4),
      commonAbilities: usage.abilities.slice(0, 4),
    },
    megaProfile,
    supportProfile,
    roleProfile: roleProfileFor(mon),
  };
}

function summarizeUnderstandingModel(formatModel = {}, format = state.format) {
  const missingSlots = formatModel.slotModel?.missingSlots || [];
  const missingChains = formatModel.chainModel?.missingChains || [];
  const resourceRisks = formatModel.resourceModel?.risks || [];
  const missingPhases = formatModel.phaseModel?.missingPhases || [];
  const missingBranches = formatModel.branchModel?.missingBranches || [];
  const threatRows = formatModel.threatMatrix?.rows || [];
  return {
    format,
    primaryArchetype: formatModel.archetypeModel?.primary?.name || "",
    mainAxis: formatModel.archetypeModel?.primary?.name || (format === "double" ? "双打协作" : "平衡构筑"),
    missing: [
      ...missingSlots.slice(0, 3).map((item) => `槽位:${item.label}`),
      ...missingChains.slice(0, 2).map((item) => `联动:${item.label}`),
      ...missingPhases.slice(0, 2).map((item) => `阶段:${item.label}`),
      ...missingBranches.slice(0, 2).map((item) => `分支:${item.label}`),
    ].slice(0, 8),
    conflicts: resourceRisks.slice(0, 5).map((risk) => risk.label),
    mustFix: [
      ...resourceRisks.filter((risk) => Number(risk.severity || 0) >= 8).map((risk) => risk.label),
      ...threatRows.filter((row) => Number(row.risk || 0) >= 72).slice(0, 3).map((row) => `高风险威胁:${row.name}`),
    ].slice(0, 6),
    topThreats: threatRows.slice(0, 5).map((row) => ({ name: row.name, risk: row.risk, missingAnswers: row.missingAnswers })),
  };
}

function buildTeamUnderstanding(team = state.team, formatList = ["single", "double"], { megaPlan = null, teamStyle = null, userGoal = "", compositionReport = null, compactContext = true, fixedOpponentTeams = {} } = {}) {
  const formatModels = buildFormatModels(team, formatList, { megaPlan, teamStyle, userGoal, compositionReport, compactContext });
  return {
    profiles: Object.fromEntries(formatList.map((format) => [format, team.map((mon) => buildPokemonProfile(mon, format)).filter(Boolean)])),
    formatModels,
    summary: Object.fromEntries(formatList.map((format) => [format, summarizeUnderstandingModel(formatModels[format], format)])),
    fixedOpponentTeams,
    notes: [
      "TeamUnderstanding Engine 是配队理解层：先判断结构缺口、对局分支和资源闭环，再让 AI 生成自然语言配置。",
      "候选排序应优先补 mustFix、missing 和高优先级 threat/branch，而不是只看 rank。",
      "固定评测靶队默认从当前环境热门队池中随机抽样 5 个队伍，用于后续本地模拟和回归比较。",
    ],
  };
}

function scoreCandidateForUnderstanding(mon, understanding, format = state.format, { targetAnswerScores = new Map(), styleScores = new Map(), synergyReports = new Map(), supportScores = new Map(), megaScores = new Map() } = {}) {
  const model = understanding?.formatModels?.[format];
  const fit = formatSpecificFit(mon, model, format);
  const targetScore = targetAnswerScores.get(mon.slug) || 0;
  const styleScore = styleScores.get(mon.id) || 0;
  const synergyScore = synergyReports.get(mon.id)?.score || 0;
  const supportScore = supportScores.get(mon.id) || 0;
  const megaScore = megaScores.get(mon.id) || 0;
  const total = Math.round(
    targetScore * 1.3 +
      styleScore +
      (fit.threatFit?.score || 0) * 1.15 +
      (fit.branchFit?.score || 0) * 1.15 +
      (fit.phaseFit?.score || 0) +
      (fit.chainFit?.score || 0) +
      (fit.resourceFit?.score || 0) +
      (fit.slotFit?.score || 0) +
      (fit.archetypeFit?.score || 0) +
      synergyScore +
      megaScore +
      supportScore,
  );
  return {
    total,
    fit,
    profile: buildPokemonProfile(mon, format),
    reasons: [
      ...(fit.reasons || []),
      ...(synergyReports.get(mon.id)?.reasons || []).slice(0, 2),
    ].slice(0, 8),
    components: {
      targetScore,
      styleScore,
      synergyScore,
      supportScore,
      megaScore,
    },
  };
}

function targetCounterWarnings(target) {
  const mega = megaProfileFor(target);
  const abilities = [
    ...(mega?.finalAbilities || []),
    ...Object.values(knowledgeEntryFor(target)?.showdown?.abilities || {}),
    ...(target?.abilities || []).map((item) => item.name),
  ]
    .map((name) => String(name || ""))
    .filter(Boolean);
  const abilityKeys = abilities.map(localTermKey);
  const warnings = [];
  if (abilityKeys.includes("contrary")) {
    warnings.push({
      type: "ability-trap",
      ability: "唱反调",
      rule: "不要把威吓、抛下狠话、降低攻击/速度/防御的招式当作对策；对唱反调目标这些会反向强化。",
      avoid: ["威吓", "抛下狠话", "鬼面", "岩石封锁", "冰冻之风", "大声咆哮", "降低能力的追加效果"],
      prefer: ["直接击倒", "电/冰/岩石高压打点", "状态限制", "先制收割", "守住拖回合", "速度控制但避免降能力型控速"],
      megaNote: mega ? `该目标 Mega 前可能是 ${mega.preMegaAbilities.join(" / ") || "普通形态特性未知"}，但 Mega 后最终特性是 ${mega.finalAbilities.join(" / ") || "未知"}；克制方案以 Mega 后为准。` : "",
    });
  }
  return warnings;
}

function targetCommonSetHints(target) {
  const related = targetRelatedTeams([target]);
  const configs = related
    .flatMap((team) => {
      const source = state.teamLibrary.find((item) => item.title === team.title && item.rentalCode === team.rentalCode);
      return source?.configurations || [];
    })
    .filter((config) => {
      const configKeys = [config.slug, config.name, config.id].map(idKey).filter(Boolean);
      const targetKeys = [target.slug, target.name, target.id, target.pokeCamp?.speciesIdentifier, target.pokeCamp?.identifier].map(idKey).filter(Boolean);
      return configKeys.some((value) => targetKeys.includes(value));
    });
  return configs.slice(0, 4).map((config) => ({
    item: localizeTerm(config.item, "items"),
    preMegaAbility: localizeTerm(config.ability, "abilities"),
    ability: localizeTerm(config.ability, "abilities"),
    finalAbility: (megaProfileFor(target)?.finalAbilities || Object.values(knowledgeEntryFor(target)?.showdown?.abilities || {}).map((name) => localizeTerm(name, "abilities"))).join(" / "),
    nature: localizeTerm(config.nature, "natures"),
    moves: (config.moves || []).map((move) => localizeTerm(move, "moves")).filter(Boolean),
    stats: config.stats || "",
    note: megaProfileFor(target) ? "玩家上传配置里的 ability 多为 Mega 前普通形态特性；判断克制方式时以 finalAbility 为准。" : "",
  }));
}

function attackCoverageFor(mon, defenderTypes = []) {
  const usage = pokemonUsageProfile(mon);
  const text = `${englishTypesFor(mon).join(" ")} ${usage.moves.join(" ")} ${rankedTeamLibrarySetsFor(mon, 3).flatMap((set) => set.moves || []).join(" ")}`;
  const typeRows = ATTACK_TYPE_HINTS.map(([type, pattern]) => ({
    type,
    multiplier: typeEffectiveness(type, defenderTypes),
    hasMove: pattern.test(text),
    stab: englishTypesFor(mon).includes(type),
  }))
    .filter((item) => item.multiplier > 1 && (item.hasMove || item.stab))
    .sort((a, b) => b.multiplier - a.multiplier || Number(b.hasMove) - Number(a.hasMove));
  return typeRows;
}

function targetAnswerScore(mon, target, defenderTypes = []) {
  const coverage = attackCoverageFor(mon, defenderTypes);
  const roles = getRoles(mon);
  const usage = pokemonUsageProfile(mon);
  const speedGap = effectiveSpeed(mon).value - effectiveSpeed(target).value;
  const ownTypes = englishTypesFor(mon);
  const resistsTargetStab = defenderTypes.some((attackType) => ownTypes.length && typeEffectiveness(attackType, ownTypes) < 1);
  let score = 0;
  if (coverage[0]) score += coverage[0].multiplier * (coverage[0].hasMove ? 10 : 6);
  if (speedGap >= 0 || roles.includes("高速位")) score += 4;
  if (MOVE_PATTERNS.priority.test(usage.moves.join(" "))) score += 3;
  if (MOVE_PATTERNS.speedControl.test(usage.moves.join(" "))) score += 3;
  if (roles.includes("耐久位") && resistsTargetStab) score += 2;
  if (targetCounterWarnings(target).some((warning) => warning.ability === "唱反调") && /威吓|抛下狠话|冰冻之风|岩石封锁|大声咆哮/.test(`${usage.abilities.join(" ")} ${usage.moves.join(" ")}`)) score -= 8;
  return { score, coverage };
}

function targetMatchupProfile(target) {
  if (!target) return null;
  const defenderTypes = englishTypesFor(target);
  const offensiveAnswers = state.data.pokemon
    .filter((mon) => mon.id !== target.id)
    .map((mon) => {
      const answer = targetAnswerScore(mon, target, defenderTypes);
      return { mon, answer };
    })
    .filter((item) => item.answer.score > 0)
    .sort((a, b) => b.answer.score - a.answer.score || Number(a.mon.rank || 9999) - Number(b.mon.rank || 9999))
    .slice(0, 12)
    .map(({ mon, answer }) => ({
      name: mon.name,
      slug: mon.slug,
      rank: mon.rank,
      score: Math.round(answer.score),
      answerTypes: answer.coverage.slice(0, 3).map((item) => `${TYPE_EN_TO_CN[item.type.toLowerCase()] || item.type} x${item.multiplier}${item.hasMove ? " 覆盖招式" : " 本系"}`),
      roles: getRoles(mon),
      roleProfile: roleProfileFor(mon),
    }));
  const usageProfile = pokemonUsageProfile(target);
  const megaProfile = megaProfileFor(target);
  return {
    target: {
      id: target.id,
      name: target.name,
      slug: target.slug,
      rank: target.rank,
      types: target.types,
      stats: target.stats,
      roles: getRoles(target),
      effectiveSpeed: effectiveSpeed(target),
      abilities: Object.values(knowledgeEntryFor(target)?.showdown?.abilities || {}).map((name) => localizeTerm(name, "abilities")),
      megaProfile,
      preMegaAbilities: megaProfile?.preMegaAbilities || [],
      finalAbilities: megaProfile?.finalAbilities || Object.values(knowledgeEntryFor(target)?.showdown?.abilities || {}).map((name) => localizeTerm(name, "abilities")),
      roleProfile: roleProfileFor(target),
      commonMoves: usageProfile.moves,
      commonItems: usageProfile.items,
      commonAbilities: usageProfile.abilities,
      commonTeammates: usageProfile.teammates,
      source: target.externalTarget ? "PokeCamp target" : "current pool",
    },
    defenderTypes,
    offensiveAnswers,
    commonSets: targetCommonSetHints(target),
    counterWarnings: targetCounterWarnings(target),
    defensiveNote: "防守换入需结合目标常见招式判断，不能只看属性。",
  };
}

function targetRelatedTeams(targets = []) {
  if (!targets.length || !state.teamLibrary?.length) return [];
  const targetKeys = new Set(
    targets
      .flatMap((mon) => [idKey(mon.slug), idKey(mon.name), idKey(mon.pokeCamp?.speciesIdentifier), idKey(knowledgeEntryFor(mon)?.showdown?.name || "")])
      .filter(Boolean),
  );
  const matchedByFormat = (format = "") =>
    state.teamLibrary
      .filter((team) => !format || team.format === format)
      .map((team) => {
        const members = team.members || [];
        const shared = members.filter((member) => [member.slug, member.name, member.id].some((value) => targetKeys.has(idKey(value))));
        return { team, shared };
      })
      .filter((item) => item.shared.length);
  const matches = matchedByFormat(state.format);
  const fallbackMatches = matches.length ? matches : matchedByFormat("");
  return fallbackMatches
    .map((team) => {
      if (team.team) return team;
      return { team, shared: team.shared };
    })
    .slice(0, 5)
    .map(({ team, shared }) => ({
      title: team.title,
      source: teamSourceLabel(teamSourceKind(team)),
      rentalCode: team.rentalCode || "",
      format: team.formatLabel || formatLabel(team.format),
      members: team.members.map((member) => member.slug || member.name).slice(0, 6),
      targetMembers: shared.map((member) => member.slug || member.name),
    }));
}

function englishTypesFor(mon) {
  const fromKnowledge = knowledgeEntryFor(mon)?.showdown?.types;
  if (fromKnowledge?.length) return fromKnowledge;
  return (mon.types || []).map((type) => TYPE_CN_TO_EN[type] || type).filter(Boolean);
}

function typeEffectiveness(attackType, defenderTypes = []) {
  return defenderTypes.reduce((value, defenderType) => value * (TYPE_EFFECTIVENESS[attackType]?.[defenderType] ?? 1), 1);
}

function hasOffensiveAnswer(threatTypes = []) {
  return state.team.some((mon) => englishTypesFor(mon).some((type) => typeEffectiveness(type, threatTypes) > 1));
}

function hasDefensiveSwitch(threatTypes = []) {
  return state.team.some((mon) => {
    const ownTypes = englishTypesFor(mon);
    if (!ownTypes.length) return false;
    return threatTypes.some((type) => typeEffectiveness(type, ownTypes) < 1);
  });
}

function showdownNamesForTeam() {
  return new Set(
    state.team
      .map((mon) => knowledgeEntryFor(mon)?.showdown?.name || showdownSpeciesName(mon) || mon.name)
      .map((name) => idKey(name)),
  );
}

function smogonFormatForCurrentMode(format = state.format) {
  if (format === "double") return state.battleKnowledgeData?.formats?.find((item) => item === "gen9doublesou") || state.battleKnowledgeData?.formats?.find((item) => item.includes("vgc")) || "gen9doublesou";
  return state.battleKnowledgeData?.formats?.find((item) => item === "gen9ou") || state.battleKnowledgeData?.formats?.[0] || "gen9ou";
}

function getMatchupReport(limit = 10) {
  const cache = state.battleKnowledgeData;
  if (!cache?.pokemon || !state.team.length) return { score: 0, threats: [], summary: "缺少队伍或环境知识数据。" };
  const format = smogonFormatForCurrentMode();
  const ownIds = new Set(state.team.flatMap((mon) => [idKey(mon.slug), idKey(mon.name), idKey(knowledgeEntryFor(mon)?.showdown?.name || "")].filter(Boolean)));
  const ownNames = showdownNamesForTeam();
  const threats = Object.entries(cache.pokemon)
    .map(([id, entry]) => ({ id, entry, usage: entry.smogon?.[format]?.usage || 0 }))
    .filter((item) => item.usage > 0 && !ownIds.has(item.id))
    .sort((a, b) => b.usage - a.usage)
    .slice(0, 40)
    .map(({ entry, usage }) => {
      const smogon = entry.smogon[format];
      const types = entry.showdown?.types || [];
      const defensiveSwitch = hasDefensiveSwitch(types);
      const offensiveAnswer = hasOffensiveAnswer(types);
      const counterHit = (smogon.counters || []).some((counter) => ownNames.has(idKey(counter.name)));
      let risk = 44 + Math.min(20, usage * 80);
      if (!defensiveSwitch) risk += 18;
      if (!offensiveAnswer) risk += 14;
      if (counterHit) risk -= 24;
      risk = Math.max(8, Math.min(96, Math.round(risk)));
      const reasons = [];
      if (!defensiveSwitch) reasons.push("缺少稳定换入");
      if (!offensiveAnswer) reasons.push("缺少属性压制");
      if (counterHit) reasons.push("队内有统计克制点");
      if (!reasons.length) reasons.push("属性应对基本完整");
      return {
        name: entry.showdown?.name || smogon.name,
        usage,
        types,
        risk,
        level: risk >= 72 ? "高" : risk >= 48 ? "中" : "低",
        reasons,
        commonMoves: smogon.moves?.slice(0, 4) || [],
        commonItems: smogon.items?.slice(0, 3) || [],
      };
    })
    .sort((a, b) => b.risk - a.risk || b.usage - a.usage);
  const visible = threats.slice(0, limit);
  const avgRisk = threats.slice(0, 20).reduce((sum, item) => sum + item.risk, 0) / Math.max(1, Math.min(20, threats.length));
  const score = Math.max(0, Math.min(100, Math.round(100 - avgRisk)));
  return {
    format,
    score,
    threats: visible,
    summary: visible.length ? `基于 ${format} 前 ${Math.min(40, threats.length)} 个环境威胁估算，分数 ${score}/100。` : "没有可用环境威胁数据。",
  };
}

function threatEntryRows(limit = 24, ownTeam = state.team, format = state.format) {
  const cache = state.battleKnowledgeData;
  if (!cache?.pokemon) return [];
  const smogonFormat = smogonFormatForCurrentMode(format);
  const ownIds = new Set(ownTeam.flatMap((mon) => [idKey(mon.slug), idKey(mon.name), idKey(knowledgeEntryFor(mon)?.showdown?.name || "")].filter(Boolean)));
  return Object.entries(cache.pokemon)
    .map(([id, entry]) => ({ id, entry, smogon: entry.smogon?.[smogonFormat], usage: entry.smogon?.[smogonFormat]?.usage || 0 }))
    .filter((item) => item.smogon && item.usage > 0 && !ownIds.has(item.id))
    .sort((a, b) => b.usage - a.usage)
    .slice(0, limit);
}

function threatSpeedValue(threat = {}) {
  return Number(threat.baseStats?.spe || threat.baseStats?.speed || threat.stats?.速度 || 0);
}

function threatAnswerProfile(mon, threat = {}, format = state.format) {
  if (!mon || !threat?.types?.length) return { score: 0, categories: [], reasons: [] };
  const ownTypes = englishTypesFor(mon);
  const roles = getRoles(mon);
  const usage = pokemonUsageProfile(mon, format);
  const text = `${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${textOf(mon, "items")} ${usage.moves.join(" ")} ${usage.items.join(" ")} ${usage.abilities.join(" ")}`;
  const coverage = attackCoverageFor(mon, threat.types);
  const speed = effectiveSpeed(mon).value || stat(mon, "速度");
  const threatSpeed = threatSpeedValue(threat);
  const categories = [];
  const reasons = [];
  let score = 0;
  const add = (points, category, reason) => {
    score += points;
    if (category && !categories.includes(category)) categories.push(category);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  const resistsStab = threat.types.some((attackType) => ownTypes.length && typeEffectiveness(attackType, ownTypes) < 1);
  const immuneStab = threat.types.some((attackType) => ownTypes.length && typeEffectiveness(attackType, ownTypes) === 0);
  if (resistsStab && (roles.includes("耐久位") || roles.includes("特性价值") || stat(mon, "HP") + stat(mon, "防御") + stat(mon, "特防") >= 270)) add(8 + (immuneStab ? 3 : 0), "defensiveSwitch", "能抗性/免疫换入威胁本系压力。");
  if (coverage[0]) add(7 + Math.min(4, coverage[0].multiplier * 2), "offensivePressure", `有${TYPE_EN_TO_CN[coverage[0].type.toLowerCase()] || coverage[0].type}打点压制。`);
  if ((threatSpeed && speed >= threatSpeed + 5) || MOVE_PATTERNS.priority.test(text) || /讲究围巾|choice scarf/i.test(text)) add(6, "revengeKill", "能高速、围巾或先制 revenge kill。");
  if (MOVE_PATTERNS.speedControl.test(text)) add(5, "speedControl", "能用控速削弱威胁行动顺序。");
  if (MOVE_PATTERNS.status.test(text) || /再来一次|哈欠|定身法|encore|yawn|disable/i.test(text)) add(4, "statusDisrupt", "能用状态/干扰限制威胁展开。");
  if (MOVE_PATTERNS.pivot.test(text) && resistsStab) add(3, "safePivot", "能抗性转场维持节奏。");
  return { score: Math.round(score), categories, reasons: reasons.slice(0, 5) };
}

function buildThreatMatrix(team = state.team, format = state.format, limit = 10) {
  const rows = threatEntryRows(Math.max(24, limit * 3), team, format).map(({ entry, smogon, usage }) => {
    const threat = {
      name: entry.showdown?.name || smogon.name,
      types: entry.showdown?.types || [],
      baseStats: entry.showdown?.baseStats || {},
      usage,
      commonMoves: smogon.moves?.slice(0, 5) || [],
      commonItems: smogon.items?.slice(0, 3) || [],
    };
    const answers = team
      .map((mon) => ({ mon, profile: threatAnswerProfile(mon, threat, format) }))
      .filter((item) => item.profile.score > 0)
      .sort((a, b) => b.profile.score - a.profile.score);
    const categories = new Set(answers.flatMap((item) => item.profile.categories));
    let risk = 40 + Math.min(22, usage * 90);
    if (!categories.has("defensiveSwitch")) risk += 18;
    if (!categories.has("offensivePressure")) risk += 12;
    if (!categories.has("revengeKill") && !categories.has("speedControl")) risk += 10;
    if (categories.has("defensiveSwitch") && categories.has("offensivePressure")) risk -= 12;
    if (categories.has("revengeKill") || categories.has("speedControl")) risk -= 6;
    risk = Math.max(8, Math.min(96, Math.round(risk)));
    const missingAnswers = [];
    if (!categories.has("defensiveSwitch")) missingAnswers.push("defensiveSwitch");
    if (!categories.has("offensivePressure")) missingAnswers.push("offensivePressure");
    if (!categories.has("revengeKill") && !categories.has("speedControl")) missingAnswers.push("speedOrRevenge");
    return {
      name: threat.name,
      usage,
      types: threat.types,
      speed: threatSpeedValue(threat),
      risk,
      level: risk >= 72 ? "高" : risk >= 48 ? "中" : "低",
      missingAnswers,
      answers: answers.slice(0, 4).map((item) => ({
        name: item.mon.name,
        categories: item.profile.categories,
        reasons: item.profile.reasons,
        score: item.profile.score,
      })),
      commonMoves: threat.commonMoves,
      commonItems: threat.commonItems,
    };
  });
  const visible = rows.sort((a, b) => b.risk - a.risk || b.usage - a.usage).slice(0, limit);
  const missingSummary = visible.reduce((map, row) => {
    row.missingAnswers.forEach((answer) => map.set(answer, (map.get(answer) || 0) + 1));
    return map;
  }, new Map());
  return {
    format,
    rows: visible,
    priorities: [...missingSummary.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([answer, count]) => ({ answer, count }))
      .slice(0, 5),
    answerLegend: {
      defensiveSwitch: "能换入或抗住威胁常见本系压力",
      offensivePressure: "能用打点逼退或直接压制",
      revengeKill: "能高速、围巾或先制收割",
      speedControl: "能用顺风/电磁波/空间/冰风等改变速度关系",
      statusDisrupt: "能用状态、挑衅、再来一次等阻断展开",
    },
    summary: visible.length ? `威胁矩阵追踪 ${visible.length} 个环境威胁；优先补 ${[...missingSummary.keys()].slice(0, 3).join("、") || "稳定回答"}。` : "缺少环境威胁数据。",
  };
}

function candidateThreatFit(mon, threatMatrix, format = state.format) {
  const rows = threatMatrix?.rows || [];
  const matches = rows
    .map((row) => {
      const profile = threatAnswerProfile(mon, { name: row.name, types: row.types, baseStats: { spe: row.speed }, usage: row.usage }, format);
      const fills = profile.categories.filter((category) => row.missingAnswers.includes(category) || (row.missingAnswers.includes("speedOrRevenge") && ["revengeKill", "speedControl"].includes(category)));
      const score = fills.length ? profile.score + Math.round(row.risk / 8) : Math.max(0, profile.score - 8);
      return { row, profile, fills, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return {
    score: Math.round(matches.slice(0, 4).reduce((sum, item) => sum + item.score, 0)),
    threats: matches.slice(0, 5).map((item) => item.row.name),
    fillAnswers: [...new Set(matches.flatMap((item) => item.fills))],
    reasons: matches
      .slice(0, 4)
      .map((item) => `${item.row.name}: ${item.profile.reasons[0] || "补威胁回答"}`)
      .filter(Boolean),
  };
}

function buildFormatModels(team = state.team, formatList = ["single", "double"], { megaPlan = null, teamStyle = null, userGoal = "", compositionReport = null, compactContext = true } = {}) {
  return Object.fromEntries(
    formatList.map((format) => {
      const slotModel = buildSlotModel(team, format, { megaPlan, teamStyle });
      const archetypeModel = buildArchetypeModel(team, format, { userGoal, teamStyle, compositionReport });
      const threatMatrix = buildThreatMatrix(team, format, compactContext ? 8 : 12);
      const chainModel = buildSynergyChains(team, format, { archetypeModel, slotModel });
      const resourceModel = buildResourceModel(team, format, { megaPlan });
      const phaseModel = buildPhaseModel(team, format, { chainModel, resourceModel });
      const branchModel = buildMatchupBranchModel(team, format, { threatMatrix, resourceModel, phaseModel });
      return [format, { format, slotModel, archetypeModel, threatMatrix, chainModel, resourceModel, phaseModel, branchModel }];
    }),
  );
}

function formatSpecificFit(mon, model, format = state.format) {
  const slotFit = candidateSlotFit(mon, model?.slotModel, format);
  const archetypeFit = candidateArchetypeFit(mon, model?.archetypeModel, format);
  const threatFit = candidateThreatFit(mon, model?.threatMatrix, format);
  const chainFit = candidateChainFit(mon, model?.chainModel, format);
  const resourceFit = candidateResourceFit(mon, model?.resourceModel, format);
  const phaseFit = candidatePhaseFit(mon, model?.phaseModel, format);
  const branchFit = candidateBranchFit(mon, model?.branchModel, format);
  const tags = slotTagsForPokemon(mon, format);
  const usage = pokemonUsageProfile(mon, format);
  const text = `${textOf(mon, "moves")} ${textOf(mon, "abilities")} ${textOf(mon, "items")} ${usage.moves.join(" ")}`;
  let formatBias = 0;
  const reasons = [];
  if (format === "single") {
    if (tags.slots.includes("hazard") || tags.slots.includes("removal")) {
      formatBias += 6;
      reasons.push("单打资源：撒场/清场价值");
    }
    if (MOVE_PATTERNS.pivot.test(text) || MOVE_PATTERNS.sustain.test(text) || tags.slots.includes("defensive-switch")) {
      formatBias += 4;
      reasons.push("单打资源：轮转/续航/换入");
    }
    if (tags.slots.includes("wallbreaker") || tags.slots.includes("endgame-cleaner")) {
      formatBias += 3;
      reasons.push("单打资源：突破或终盘");
    }
  } else {
    if (tags.slots.includes("lead-pair") || tags.slots.includes("protection")) {
      formatBias += 7;
      reasons.push("双打资源：首发协作/保护");
    }
    if (tags.slots.includes("spread-pressure") || MOVE_PATTERNS.spread.test(text)) {
      formatBias += 5;
      reasons.push("双打资源：范围压力");
    }
    if (MOVE_PATTERNS.fakeOut.test(text) || MOVE_PATTERNS.intimidate.test(text) || MOVE_PATTERNS.redirection.test(text)) {
      formatBias += 5;
      reasons.push("双打资源：击掌/威吓/掩护");
    }
  }
  return {
    score: Math.round(threatFit.score + archetypeFit.score + slotFit.score + chainFit.score + resourceFit.score + phaseFit.score + branchFit.score + formatBias),
    slotFit,
    archetypeFit,
    threatFit,
    chainFit,
    resourceFit,
    phaseFit,
    branchFit,
    formatBias,
    reasons: [...reasons, ...branchFit.reasons.slice(0, 2), ...phaseFit.reasons.slice(0, 2), ...chainFit.reasons.slice(0, 2), ...resourceFit.reasons.slice(0, 2), ...threatFit.reasons.slice(0, 2), ...archetypeFit.reasons.slice(0, 2), ...slotFit.reasons.slice(0, 2)].slice(0, 8),
  };
}

function importedConfigFor(mon) {
  return (
    state.importedTeam?.configurations?.find((config) => {
      if (config.slug && config.slug === mon.slug) return true;
      const alias = TEAM_FORM_ALIASES.get(Number(config.id));
      return alias ? alias.slug === mon.slug : Number(config.id) === Number(mon.id);
    }) || null
  );
}

function configKey(mon) {
  return String(mon?.slug || mon?.id || mon?.name || "").toLowerCase();
}

function defaultConfigFor(mon) {
  const imported = importedConfigFor(mon);
  const importedMoves = knownConfigList(imported?.moves).slice(0, 4);
  return {
    item: knownConfigValue(imported?.item) || names(mon.items, 1) || "",
    ability: knownConfigValue(imported?.ability) || names(mon.abilities, 1) || "",
    nature: knownConfigValue(imported?.nature) || names(mon.natures, 1) || "",
    evs: knownConfigValue(imported?.evs) || "",
    ivs: "",
    teraType: "",
    level: "50",
    gender: "",
    shiny: false,
    ball: "",
    language: "",
    moves: importedMoves.length ? importedMoves : mon.moves?.slice(0, 4).map((move) => move.name).filter(Boolean) || [],
  };
}

function editableConfigFor(mon) {
  const base = defaultConfigFor(mon);
  const override = state.teamConfigs[configKey(mon)] || {};
  return {
    ...base,
    ...override,
    moves: Array.isArray(override.moves) ? override.moves : base.moves,
  };
}

function setEditableConfig(mon, config) {
  const key = configKey(mon);
  if (!key) return;
  const base = defaultConfigFor(mon);
  const item = usableConfigValue(config.item, "items") || base.item || "";
  const ability = usableConfigValue(config.ability, "abilities") || base.ability || "";
  const nature = usableConfigValue(config.nature, "natures") || base.nature || "";
  const evs = isPlaceholderConfigValue(config.evs) ? base.evs || "" : config.evs || "";
  const moves = (Array.isArray(config.moves) ? config.moves : [])
    .map((move) => usableConfigValue(move, "moves"))
    .filter(Boolean)
    .slice(0, 4);
  const fallbackMoves = (base.moves || []).map((move) => usableConfigValue(move, "moves")).filter(Boolean);
  state.teamConfigs[key] = {
    item,
    ability,
    nature,
    evs,
    ivs: config.ivs || "",
    teraType: config.teraType || "",
    level: config.level || "50",
    gender: config.gender || "",
    shiny: Boolean(config.shiny),
    ball: config.ball || "",
    language: config.language || "",
    moves: moves.length >= 4 ? moves : [...moves, ...fallbackMoves.filter((move) => !moves.includes(move))].slice(0, 4),
  };
}

function parseStatTotal(line = "") {
  return String(line)
    .split("/")
    .map((part) => Number(part.trim().match(/^(\d+)/)?.[1] || 0))
    .reduce((sum, value) => sum + value, 0);
}

function parseStatParts(line = "") {
  return String(line)
    .split("/")
    .map((part) => {
      const match = part.trim().match(/^(\d+)\s+(.+)$/);
      return match ? { value: Number(match[1]), stat: match[2].trim() } : null;
    })
    .filter(Boolean);
}

function normalizedItemName(value = "") {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeSlugLike(value = "") {
  return localTermKey(value);
}

function teamLibraryConfigsFor(mon, format = state.format) {
  if (!mon || !state.teamLibrary?.length) return [];
  const cacheKey = [state.teamLibrary.length, state.data?.season || state.rawData?.season || "", format || "all", mon.slug || mon.id || mon.name].join("|");
  if (state.teamLibraryConfigCache?.has(cacheKey)) return state.teamLibraryConfigCache.get(cacheKey);
  const rawKeys = [mon.slug, mon.name, mon.id, pokeCampEntryFor(mon)?.identifier, pokeCampEntryFor(mon)?.speciesIdentifier].filter(Boolean);
  const exactKeys = new Set(rawKeys.map(normalizeSlugLike).filter(Boolean));
  const keys = new Set(exactKeys);
  for (const value of rawKeys) {
    const base = String(value || "")
      .replace(/[-_]?mega[-_]?[xy]?$/i, "")
      .replace(/[-_]?gmax$/i, "")
      .replace(/[-_]?gigantamax$/i, "")
      .replace(/[-_]?(female|male|f|m)$/i, "")
      .replace(/[-_]?(heat|wash|mow|fan|frost)$/i, "")
      .replace(/[-_]?(alola|galar|hisui|paldea)$/i, "")
      .replace(/（.*?）/g, "")
      .replace(/雌性|雄性|阿罗拉|伽勒尔|洗翠|帕底亚/g, "");
    const normalized = normalizeSlugLike(base);
    if (normalized) keys.add(normalized);
  }
  const formatMatches = state.teamLibrary.filter((team) => !format || team.format === format);
  const matchesKeys = (config, sourceKeys) => [config.slug, config.name, config.id].some((value) => sourceKeys.has(normalizeSlugLike(value)));
  const preferredExact = formatMatches
    .flatMap((team) => team.configurations || [])
    .filter((config) => matchesKeys(config, exactKeys));
  const allExact = state.teamLibrary
    .flatMap((team) => team.configurations || [])
    .filter((config) => matchesKeys(config, exactKeys));
  const exactMerged = [...preferredExact, ...allExact];
  const preferred = formatMatches
    .flatMap((team) => team.configurations || [])
    .filter((config) => matchesKeys(config, keys));
  const all = state.teamLibrary
    .flatMap((team) => team.configurations || [])
    .filter((config) => matchesKeys(config, keys));
  const merged = [...preferred, ...all];
  const source = exactMerged.length ? exactMerged : merged;
  const seen = new Set();
  const result = source.filter((config) => {
    if (!knownConfigValue(config?.item) && !knownConfigValue(config?.ability) && !(config?.moves || []).length) return false;
    const key = JSON.stringify([config.slug, config.name, config.item, config.ability, config.stats, config.moves]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  state.teamLibraryConfigCache?.set(cacheKey, result);
  return result;
}

function countConfigValues(configs = [], key = "") {
  const counts = new Map();
  for (const config of configs) {
    const raw = knownConfigValue(config?.[key]);
    if (!raw) continue;
    const value = localizeTerm(raw, key === "item" ? "items" : key === "ability" ? "abilities" : key === "nature" ? "natures" : "moves");
    const id = normalizedItemName(value);
    if (!id) continue;
    const prev = counts.get(id) || { name: value, count: 0 };
    prev.count += 1;
    counts.set(id, prev);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

function itemRoleScore(mon, itemName = "") {
  const item = String(itemName || "");
  const moves = `${textOf(mon, "moves")} ${teamLibraryConfigsFor(mon).flatMap((config) => config.moves || []).join(" ")}`;
  const roles = getRoles(mon).join(" ");
  const bulk = stat(mon, "HP") + stat(mon, "防御") + stat(mon, "特防");
  const isFastUtility = stat(mon, "速度") >= 100 && /高速|功能位|控速|tailwind|encore|taunt|fake-tears|sunny-day|おいかぜ|アンコール|ちょうはつ/i.test(`${roles} ${moves}`);
  let score = 0;
  if (/气势披带|focus sash/i.test(item) && (stat(mon, "速度") >= 100 || isFastUtility)) score += 6;
  if (/心灵香草|mental herb/i.test(item) && /功能位|控速|tailwind|trick-room|taunt|encore|おいかぜ|トリックルーム|ちょうはつ|アンコール/i.test(`${roles} ${moves}`)) score += 4;
  if (/抗火果|抗飞果|occa|coba/i.test(item) && /功能位|控速|tailwind|sunny-day/i.test(`${roles} ${moves}`)) score += 3;
  if (/妖精羽毛|fairy feather/i.test(item) && /特殊输出|ムーンフォース|moonblast/i.test(`${roles} ${moves}`)) score += 2;
  if (/剩饭|leftovers/i.test(item)) score += bulk >= 300 && !isFastUtility ? 3 : isFastUtility ? -10 : -4;
  if (/生命宝珠|讲究头带|讲究眼镜|choice band|choice specs|life orb/i.test(item) && /物理输出|特殊输出/.test(roles)) score += 3;
  if (/讲究围巾|choice scarf/i.test(item) && stat(mon, "速度") < 120 && /输出/.test(roles)) score += 2;
  return score;
}

function recommendedItemsFor(mon, used = new Set(), limit = 6) {
  const useCache = !used.size;
  const cacheKey = [state.teamLibrary.length, state.data?.season || state.rawData?.season || "", state.format, mon?.slug || mon?.id || mon?.name, limit].join("|");
  if (useCache && state.recommendedItemsCache?.has(cacheKey)) return state.recommendedItemsCache.get(cacheKey);
  const fromMon = (mon?.items || []).map((item) => ({ name: localizeTerm(item.name || item, "items"), count: Number(item.value || item.count || 0) || 1, source: "usage" }));
  const fromTeams = countConfigValues(teamLibraryConfigsFor(mon), "item").map((item) => ({ ...item, source: "teams" }));
  const combined = new Map();
  for (const item of [...fromTeams, ...fromMon]) {
    if (!knownConfigValue(item.name)) continue;
    const key = normalizedItemName(item.name);
    const prev = combined.get(key) || { name: item.name, count: 0, sources: new Set() };
    prev.count += item.count || 1;
    prev.sources.add(item.source || "usage");
    combined.set(key, prev);
  }
  const generic = ["气势披带", "突击背心", "生命宝珠", "讲究围巾", "讲究头带", "讲究眼镜", "心灵香草", "密探斗篷", "文柚果", "剩饭"].map((name) => ({ name, count: 0, sources: new Set(["fallback"]) }));
  const result = [...combined.values(), ...generic]
    .filter((item, index, list) => list.findIndex((other) => normalizedItemName(other.name) === normalizedItemName(item.name)) === index)
    .map((item) => ({
      ...item,
      score: item.count * 3 + itemRoleScore(mon, item.name) + (item.sources?.has("teams") ? 4 : 0) + (item.sources?.has("usage") ? 3 : 0),
    }))
    .filter((item) => !used.has(normalizedItemName(item.name)) && item.score > -1)
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, limit);
  if (useCache) state.recommendedItemsCache?.set(cacheKey, result);
  return result;
}

function rankedTeamLibrarySetsFor(mon, limit = 5) {
  const cacheKey = [state.teamLibrary.length, state.data?.season || state.rawData?.season || "", state.format, mon?.slug || mon?.id || mon?.name, limit].join("|");
  if (state.rankedSetsCache?.has(cacheKey)) return state.rankedSetsCache.get(cacheKey);
  const result = teamLibraryConfigsFor(mon)
    .filter((config) => knownConfigValue(config.item) || knownConfigValue(config.ability) || (config.moves || []).length)
    .map((config) => ({
      config,
      item: localizeTerm(config.item, "items"),
      score: itemRoleScore(mon, localizeTerm(config.item, "items")) + (knownConfigValue(config.item) ? 3 : 0) + (config.moves?.length || 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ config, item }) => ({
      item,
      ability: localizeTerm(config.ability, "abilities"),
      nature: localizeTerm(config.nature, "natures"),
      stats: config.stats || "",
      moves: (config.moves || []).map((move) => localizeTerm(move, "moves")).filter(Boolean),
    }));
  state.rankedSetsCache?.set(cacheKey, result);
  return result;
}

function isMegaStone(item = "") {
  return /mega|进化石|超进化石|mega stone|ナイト/i.test(String(item));
}

function containsNonShowdownText(value = "") {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(value));
}

function showdownSpeciesFromNum(value = "") {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "";
  return SHOWDOWN_SPECIES_BY_NUM.get(num)?.name || "";
}

function normalizeShowdownSpeciesText(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+$/iu.test(text)) return text;
  return text
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\bgigantamax\b/gi, "Gmax")
    .replace(/\bgmax\b/gi, "Gmax")
    .replace(/\bmega\b/gi, "Mega")
    .replace(/\bpaldean\b/gi, "Paldea")
    .replace(/\balolan\b/gi, "Alola")
    .replace(/\bgalarian\b/gi, "Galar")
    .replace(/\bhisuian\b/gi, "Hisui")
    .replace(/\bfemale\b/gi, "F")
    .replace(/\bmale\b/gi, "M")
    .replace(/^-+|-+$/g, "");
}

function showdownSpeciesVariants(value = "") {
  const text = normalizeShowdownSpeciesText(value);
  if (!text) return [];
  const variants = new Set([text]);
  const parts = text.split("-").filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());
  const specialIndex = lower.findIndex((part) => part === "mega" || part === "gmax");
  if (specialIndex >= 0) {
    const special = lower[specialIndex] === "mega" ? "Mega" : "Gmax";
    const before = parts.slice(0, specialIndex);
    const after = parts.slice(specialIndex + 1);
    const suffixParts = after.filter((part) => /^(x|y)$/i.test(part));
    const remaining = after.filter((part) => !/^(x|y)$/i.test(part));
    if (before.length) variants.add([...before, special, ...suffixParts].join("-"));
    if (before.length) variants.add([...before, special, ...remaining].join("-"));
    if (before.length) variants.add(before.join("-"));
  }
  if (parts.length > 1 && /^(f|m)$/i.test(parts.at(-1))) variants.add(parts.slice(0, -1).join("-"));
  if (/^tauros-paldean-/i.test(text)) variants.add(text.replace(/^tauros-paldean-/i, "Tauros-Paldea-"));
  if (/^tauros-alolan-/i.test(text)) variants.add(text.replace(/^tauros-alolan-/i, "Tauros-Alola-"));
  if (/^wooper-paldean-/i.test(text)) variants.add(text.replace(/^wooper-paldean-/i, "Wooper-Paldea-"));
  return [...variants].filter(Boolean);
}

function legalShowdownSpeciesName(value = "", meta = {}) {
  const candidates = [];
  if (typeof value === "number") candidates.push(showdownSpeciesFromNum(value));
  else candidates.push(String(value || ""));
  for (const extra of [
    meta?.id,
    meta?.slug,
    meta?.name,
    meta?.species,
    meta?.identifier,
    meta?.speciesIdentifier,
    meta?.nameMap?.showdown,
    meta?.pokeCamp?.identifier,
    meta?.pokeCamp?.speciesIdentifier,
  ]) {
    if (extra != null) candidates.push(extra);
  }
  for (const candidate of candidates.flatMap((item) => {
    if (typeof item === "number") return [showdownSpeciesFromNum(item)];
    const text = String(item || "").trim();
    if (!text) return [];
    const variants = [text, normalizeShowdownSpeciesText(text), ...showdownSpeciesVariants(text)];
    if (/^\d+$/.test(text)) variants.unshift(showdownSpeciesFromNum(text));
    return variants;
  })) {
    const text = String(candidate || "").trim();
    if (!text) continue;
    const dex = SHOWDOWN_DEX;
    const direct = dex?.species?.get ? dex.species.get(text) : null;
    if (direct?.exists) return direct.name;
    const compact = text.replace(/[-_]/g, "").toLowerCase();
    const byId = SHOWDOWN_SPECIES_BY_ID.get(compact);
    if (byId?.exists) return byId.name;
    const byNum = showdownSpeciesFromNum(text);
    if (byNum) return byNum;
    const stripped = text
      .replace(/[-_]?mega[-_]?[xy]?$/i, "")
      .replace(/[-_]?gmax$/i, "")
      .replace(/[-_]?(female|male|f|m)$/i, "")
      .replace(/[-_]?(alola|alolan|paldea|paldean|galar|galarian|hisui|hisuian)$/i, "");
    if (stripped && stripped !== text) {
      const strippedDirect = dex?.species?.get ? dex.species.get(stripped) : null;
      if (strippedDirect?.exists) return strippedDirect.name;
      const strippedById = SHOWDOWN_SPECIES_BY_ID.get(stripped.replace(/[-_]/g, "").toLowerCase());
      if (strippedById?.exists) return strippedById.name;
    }
  }
  return "";
}

function showdownSpeciesName(mon) {
  const showdown = knowledgeEntryFor(mon)?.showdown || null;
  const speciesKey = showdown?.name || showdown?.id || mon?.slug || mon?.name || "";
  if (!speciesKey || String(speciesKey).startsWith("external-")) return "";
  return legalShowdownSpeciesName(speciesKey, mon) || String(speciesKey);
}

function showdownLegalSpeciesName(mon) {
  const species = showdownSpeciesName(mon);
  if (!species) return "";
  const dex = typeof globalThis !== "undefined" ? globalThis.Dex : null;
  if (!dex?.species?.get) return species;
  const direct = dex.species.get(species);
  if (direct?.exists) return direct.name;
  const compact = species.replace(/[-_]/g, "").toLowerCase();
  const fallback = dex.species.get(compact);
  if (fallback?.exists) return fallback.name;
  const base = species.replace(/-Mega$|-Gmax$/i, "");
  const baseEntry = dex.species.get(base);
  return baseEntry?.exists ? baseEntry.name : species;
}

function showdownLegalValue(value = "", fallback = "", category = "") {
  const text = String(value || "").trim();
  const safeFallback = String(fallback || "").trim();
  if (!text || containsNonShowdownText(text) || isPlaceholderConfigValue(text)) return safeFallback;
  const dexRoot = typeof globalThis !== "undefined" ? globalThis.Dex : null;
  const dex = category && dexRoot?.[category];
  if (dex?.get) {
    const data = dex.get(text);
    if (!data?.exists) return safeFallback;
  }
  return text;
}

function resolveAdvicePokemonMon(item = {}, format = state.format) {
  const targetData = state.rawData.formats?.[format] || state.data;
  if (!targetData?.pokemon) return null;
  const exactSlug = String(item?.slug || "").toLowerCase();
  if (exactSlug) {
    const bySlug = targetData.pokemon.find((mon) => String(mon.slug).toLowerCase() === exactSlug);
    if (bySlug) return bySlug;
  }
  const exactName = String(item?.name || "").toLowerCase();
  if (exactName) {
    const byName = targetData.pokemon.find((mon) => String(mon.name).toLowerCase() === exactName);
    if (byName) return byName;
  }
  const alias = TEAM_FORM_ALIASES.get(Number(item?.id)) || null;
  if (alias?.slug) {
    const byAlias = targetData.pokemon.find((mon) => String(mon.slug).toLowerCase() === String(alias.slug).toLowerCase());
    if (byAlias) return byAlias;
  }
  const keys = [item?.id, item?.name, item?.slug].filter(Boolean).map((value) => String(value).toLowerCase());
  const direct = targetData.pokemon.find((mon) => keys.includes(String(mon.id).toLowerCase()) || keys.includes(String(mon.slug).toLowerCase()) || keys.includes(String(mon.name).toLowerCase()));
  if (direct) return direct;
  const normalized = idKey(item?.name || item?.slug || item?.id || "");
  return targetData.pokemon.find((mon) => idKey(mon.slug) === normalized || idKey(mon.name) === normalized) || null;
}

function fallbackAdvicePokemonMon(item = {}, format = state.format, index = 0) {
  const targetData = state.rawData.formats?.[format] || state.data;
  const contextCandidates = Array.isArray(state.aiLastContext?.metaCandidates) ? state.aiLastContext.metaCandidates : [];
  const wanted = idKey(item?.id || item?.name || item?.slug || "");
  const matchedCandidate =
    contextCandidates.find((candidate) => [candidate.id, candidate.name, candidate.slug].filter(Boolean).some((value) => idKey(value) === wanted)) ||
    contextCandidates[index] ||
    null;
  const fromCandidate = matchedCandidate ? resolveAdvicePokemonMon(matchedCandidate, format) : null;
  if (fromCandidate) return fromCandidate;
  if (targetData?.pokemon?.length) return targetData.pokemon[index % targetData.pokemon.length] || targetData.pokemon[0] || null;
  return resolveAdvicePokemonMon(item, format);
}

function showdownSpeciesNameForMember(member, format = state.format) {
  const targetData = state.rawData.formats?.[format] || state.data;
  const resolved = pokemonForTeamMember(member, { allowFallback: false, data: targetData });
  return showdownLegalSpeciesName(resolved) || showdownLegalSpeciesName(resolveAdvicePokemonMon(member, format)) || showdownLegalSpeciesName(member);
}

function showdownTeamText() {
  return state.team
    .map((mon) => {
      const config = editableConfigFor(mon);
      const species = showdownLegalSpeciesName(mon);
      const gender = config.gender ? ` (${config.gender})` : "";
      const item = showdownLegalValue(config.item, "", "items");
      const ability = showdownLegalValue(config.ability, "", "abilities");
      const nature = showdownLegalValue(config.nature, "", "natures");
      const moves = (config.moves || []).map((move) => showdownLegalValue(move, "", "moves")).filter(Boolean);
      const lines = [`${species || mon.name}${gender}${item ? ` @ ${item}` : ""}`];
      if (ability) lines.push(`Ability: ${ability}`);
      if (config.level) lines.push(`Level: ${config.level}`);
      if (config.shiny) lines.push("Shiny: Yes");
      if (config.teraType) lines.push(`Tera Type: ${config.teraType}`);
      if (config.evs) lines.push(`EVs: ${config.evs}`);
      if (config.ivs) lines.push(`IVs: ${config.ivs}`);
      if (nature) lines.push(`${nature} Nature`);
      if (config.ball) lines.push(`Ball: ${config.ball}`);
      if (config.language) lines.push(`Language: ${config.language}`);
      for (const move of moves) {
        if (move) lines.push(`- ${move}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function showdownTextForTeamMembers(members = [], configurations = [], format = state.format) {
  const targetData = state.rawData.formats?.[format] || state.data;
  return members
    .slice(0, 6)
    .map((member) => {
      const config = configurations.find((item) => [item.slug, item.name, item.id].some((value) => idKey(value) && [member.slug, member.name, member.id].map(idKey).includes(idKey(value)))) || {};
      const species = showdownSpeciesNameForMember(member, format);
      if (!species) return "";
      const item = showdownLegalValue(config.item, "", "items");
      const ability = showdownLegalValue(config.ability, "", "abilities");
      const nature = showdownLegalValue(config.nature, "", "natures");
      const moves = (config.moves || []).map((move) => showdownLegalValue(move, "", "moves")).filter(Boolean);
      const lines = [`${species}${item ? ` @ ${item}` : ""}`];
      if (ability) lines.push(`Ability: ${ability}`);
      lines.push("Level: 50");
      if (nature) lines.push(`${nature} Nature`);
      for (const move of moves.slice(0, 4)) lines.push(`- ${move}`);
      return lines.filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function showdownSafeValue(value = "", fallback = "") {
  const text = String(value || "").trim();
  if (!text || containsNonShowdownText(text) || isPlaceholderConfigValue(text)) return String(fallback || "").trim();
  return text;
}

function adviceShowdownTeamText(format = state.aiAdviceView || state.format) {
  const team = state.aiLastAdvice?.[format]?.team || [];
  const text = team
    .slice(0, 6)
    .map((item) => {
      const mon = pokemonFromAdvice(item, format);
      if (!mon) return "";
      const fallback = teamLibraryConfigsFor(mon, format)[0] || {};
      const species = showdownLegalSpeciesName(mon);
      const moves = (Array.isArray(item.moves) ? item.moves : [])
        .map((move) => showdownLegalValue(move, "", "moves"))
        .filter(Boolean)
        .slice(0, 4);
      const fallbackMoves = (fallback.moves || []).map((move) => showdownLegalValue(move, "", "moves")).filter(Boolean).slice(0, 4);
      const finalMoves = moves.length >= 2 ? moves : fallbackMoves;
      const itemName = showdownLegalValue(item.item, showdownLegalValue(fallback.item, "", "items"), "items");
      const ability = showdownLegalValue(item.ability, showdownLegalValue(fallback.ability, "", "abilities"), "abilities");
      const nature = showdownLegalValue(item.nature, showdownLegalValue(fallback.nature, "", "natures"), "natures");
      const lines = [`${species || mon.slug || item.name}${itemName ? ` @ ${itemName}` : ""}`];
      if (ability) lines.push(`Ability: ${ability}`);
      lines.push(`Level: ${showdownSafeValue(item.level, "50") || "50"}`);
      lines.push(`EVs: ${showdownSafeValue(item.evs, "4 HP") || "4 HP"}`);
      if (nature) lines.push(`${nature} Nature`);
      for (const move of finalMoves) lines.push(`- ${move}`);
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return text;
}

function fixedOpponentTeamsFor(format = state.format, limit = 5) {
  const currentSeason = state.teamSeasonFilter || state.data?.season || state.rawData?.season || "";
  return state.teamLibrary
    .filter((team) => team.format === format && (!currentSeason || !team.season || team.season === currentSeason))
    .filter((team) => Array.isArray(team.members) && team.members.length >= 6)
    .sort((a, b) => Number(b.rate || 0) - Number(a.rate || 0) || Number(a.rank || 9999) - Number(b.rank || 9999))
    .slice(0, limit)
    .map((team, index) => ({
      id: team.id,
      rank: index + 1,
      title: team.title,
      source: team.source,
      season: team.season,
      format: team.format,
      rate: Number(team.rate || 0),
      rentalCode: team.rentalCode || "",
      members: team.members.map((member) => showdownSpeciesNameForMember(member, format)).filter(Boolean).slice(0, 6),
      configurations: (team.configurations || []).slice(0, 6).map((config) => ({
        slug: config.slug,
        item: config.item,
        ability: config.ability,
        nature: config.nature,
        stats: config.stats,
        moves: config.moves || [],
      })),
      showdownText: showdownTextForTeamMembers(team.members, team.configurations || [], format),
      evaluationRole: "fixed-meta-opponent",
    }));
}

function randomFixedOpponentTeamsFor(format = state.format, limit = 5) {
  const currentSeason = state.teamSeasonFilter || state.data?.season || state.rawData?.season || "";
  const pool = state.teamLibrary
    .filter((team) => team.format === format && (!currentSeason || !team.season || team.season === currentSeason))
    .filter((team) => Array.isArray(team.members) && team.members.length >= 6)
    .sort((a, b) => Number(b.rate || 0) - Number(a.rate || 0) || Number(a.rank || 9999) - Number(b.rank || 9999))
    .slice(0, 120);
  const working = pool.map((team) => ({
    team,
    weight: Math.max(1, Number(team.rate || 0) + (Number(team.rank || 9999) ? Math.max(0, 1400 - Number(team.rank || 9999)) / 50 : 0)),
  }));
  const picks = [];
  while (working.length && picks.length < limit) {
    const total = working.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * total;
    let index = 0;
    for (; index < working.length; index += 1) {
      roll -= working[index].weight;
      if (roll <= 0) break;
    }
    picks.push(working.splice(Math.min(index, working.length - 1), 1)[0].team);
  }
  return picks.map((team, index) => ({
    id: team.id,
    rank: index + 1,
    title: team.title,
    source: team.source,
    season: team.season,
    format: team.format,
    rate: Number(team.rate || 0),
    rentalCode: team.rentalCode || "",
    members: team.members.map((member) => showdownSpeciesNameForMember(member, format)).filter(Boolean).slice(0, 6),
    configurations: (team.configurations || []).slice(0, 6).map((config) => ({
      slug: config.slug,
      item: config.item,
      ability: config.ability,
      nature: config.nature,
      stats: config.stats,
      moves: config.moves || [],
    })),
    showdownText: showdownTextForTeamMembers(team.members, team.configurations || [], format),
    evaluationRole: "hot-random-opponent",
  }));
}

function battleKnowledge() {
  return buildBattleKnowledge(state.team, {
    format: state.format,
    getConfig: editableConfigFor,
    stat,
    effectiveSpeed,
    hasMove,
    hasAbility,
  });
}

function packedTeamText() {
  return packTeam(state.team, editableConfigFor, showdownSpeciesName);
}

function renderShowdownExport() {
  const output = $("#showdown-export");
  if (!output) return;
  output.value = showdownTeamText();
  renderValidationHints();
}

function validationHints() {
  const hints = [];
  if (!state.team.length) return ["先选择宝可梦后再导出。"];
  if (state.team.length < 6) hints.push(`队伍未满 6 只：当前 ${state.team.length}/6。`);
  const itemCounts = new Map();
  const speciesCounts = new Map();
  const megaUsers = [];
  const missingTera = [];
  for (const mon of state.team) {
    const item = editableConfigFor(mon).item;
    const key = normalizedItemName(item);
    const speciesKey = String(mon.id || mon.slug || mon.name).toLowerCase();
    if (speciesKey) speciesCounts.set(speciesKey, [...(speciesCounts.get(speciesKey) || []), mon.name || mon.slug]);
    if (key && !state.rulePrefs.allowDuplicateItems) itemCounts.set(key, [...(itemCounts.get(key) || []), mon.name || mon.slug]);
    if (isMegaStone(item)) megaUsers.push(mon.name || mon.slug);
  }
  for (const mons of speciesCounts.values()) {
    if (mons.length > 1) hints.push(`重复宝可梦：同一队伍中出现了 ${mons.join("、")}。`);
  }
  for (const [item, mons] of itemCounts.entries()) {
    if (mons.length > 1) hints.push(`重复道具：${mons.join("、")} 都携带 ${item}。`);
  }
  if (megaUsers.length > 2) hints.push(`Mega 位过多：当前 ${megaUsers.join("、")} 都携带 Mega 石，通常应保留 1 个主 Mega，最多 2 个主副分支。`);
  else if (megaUsers.length > 1) hints.push(`双 Mega 分支：${megaUsers.join("、")} 都携带 Mega 石，请确认它们是主副选择，且不会破坏队伍联动与道具职责。`);
  for (const mon of state.team) {
    const config = editableConfigFor(mon);
    const name = mon.name || mon.slug;
    const championMon = state.data?.pokemon?.find((item) => Number(item.id) === Number(mon.id) || item.slug === mon.slug || item.name === mon.name);
    if (!championMon && !mon.isExternalMember) hints.push(`Champions 当前${formatLabel(state.format)}数据中未找到 ${name}。`);
    if (!config.item) hints.push(`${name} 缺少道具。`);
    if (!config.ability) hints.push(`${name} 缺少特性。`);
    if (!config.nature) hints.push(`${name} 缺少性格。`);
    if (!config.teraType && !state.rulePrefs.ignoreTera) missingTera.push(name);
    if (!config.level) hints.push(`${name} 缺少等级。`);
    else if (Number(config.level) < 1 || Number(config.level) > 100) hints.push(`${name} 等级 ${config.level} 超出 1-100 范围。`);
    if ((config.moves || []).length < 4) hints.push(`${name} 招式少于 4 个。`);
    const evTotal = parseStatTotal(config.evs);
    if (evTotal > 510) hints.push(`${name} EV 总和 ${evTotal} 超过 510。`);
    for (const ev of parseStatParts(config.evs)) {
      if (ev.value > 252) hints.push(`${name} ${ev.stat} EV ${ev.value} 超过单项 252。`);
    }
    const ivTotal = parseStatTotal(config.ivs);
    if (config.ivs && ivTotal > 186) hints.push(`${name} IV 总和看起来异常，请检查。`);
    for (const iv of parseStatParts(config.ivs)) {
      if (iv.value > 31) hints.push(`${name} ${iv.stat} IV ${iv.value} 超过单项 31。`);
    }
  }
  if (missingTera.length) hints.push(`提示：${missingTera.join("、")} 未填写太晶属性；如目标规则不使用太晶可勾选“不检查太晶属性”。`);
  if (!hints.length) hints.push("Champions 基础校验通过；仍建议用 PKHeX 或目标平台做最终确认。");
  return hints;
}

function renderValidationHints() {
  const target = $("#export-hints");
  if (!target) return;
  const hints = [...validationHints()];
  const championsOk = hints.length === 1 && hints[0].startsWith("Champions 基础校验通过");
  let referenceFailed = false;
  if (state.showdownValidation?.loading) {
    hints.push("提示：正在调用 Pokemon Showdown 参考校验器。");
  } else if (state.showdownValidation) {
    const result = state.showdownValidation;
    if (result.unavailable) {
      hints.push("提示：Showdown 参考校验暂不可用；这不代表 Champions 队伍非法。");
      for (const problem of (result.problems || []).slice(0, 4)) hints.push(problem);
    } else if (result.ok) {
      hints.push(`Showdown 参考校验通过：${result.format}，已解析 ${result.teamSize} 只。`);
    } else {
      referenceFailed = true;
      hints.push(`Showdown 参考校验未通过：${result.format}，${result.problems?.length || 0} 个问题。`);
      for (const problem of (result.problems || []).slice(0, 8)) hints.push(problem);
    }
  }
  target.innerHTML = hints.map((hint) => `<span class="${hint.startsWith("提示：") ? "is-note" : ""}">${escapeHtml(hint)}</span>`).join("");
  target.classList.toggle("is-ok", championsOk && !referenceFailed);
}

async function validateShowdownText() {
  const text = showdownTeamText();
  if (!text) return;
  if (containsNonShowdownText(text)) {
    state.showdownValidation = {
      ok: false,
      unavailable: true,
      format: state.format,
      teamSize: state.team.length,
      problems: ["当前队伍文本包含中文或日文名称，Pokemon Showdown 参考校验只识别英文 Showdown 名称。请以 Champions 基础校验为主。"],
    };
    renderValidationHints();
    return;
  }
  state.showdownValidation = { loading: true };
  renderValidationHints();
  try {
    const res = await fetch(aiApiUrl("/api/validate-team"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, format: state.format }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        throw new Error("当前页面没有连接到本地 AI 后端。请用 npm run start:ai 启动后，从 http://127.0.0.1:4174/ 打开页面，或让页面请求 4174。");
      }
      throw new Error(data.error || `校验服务错误：${res.status}`);
    }
    state.showdownValidation = data;
  } catch (err) {
    state.showdownValidation = {
      ok: false,
      unavailable: true,
      format: state.format,
      teamSize: state.team.length,
      problems: [`Showdown 参考校验调用失败：${err.message}`],
    };
  }
  renderValidationHints();
}

async function copyShowdownText() {
  const text = showdownTeamText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const output = $("#showdown-export");
    output?.select();
    document.execCommand("copy");
  }
}

async function copyPackedText() {
  const text = packedTeamText();
  if (!text) return;
  await navigator.clipboard?.writeText(text);
}

function downloadShowdownText() {
  const text = showdownTeamText();
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pokemon-${state.format}-team.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadJsonDraft() {
  const blob = new Blob([JSON.stringify(draftPayload(), null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pokemon-${state.format}-team.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importJsonDraft(file) {
  if (!file) return;
  const draft = JSON.parse(await file.text());
  const format = draft.format || state.format;
  if (!state.rawData.formats?.[format]) return;
  state.format = format;
  state.data = state.rawData.formats[format];
  state.team = (draft.team || [])
    .map((item) => state.data.pokemon.find((mon) => mon.slug === item.slug || Number(mon.id) === Number(item.id)))
    .filter(Boolean)
    .slice(0, 6);
  state.teamConfigs = draft.teamConfigs || {};
  state.importedTeam = null;
  updateFormatButtons();
  updateMetaLabel();
  updateEditorOptions();
  renderTeamLibrary();
  render();
  saveDraft();
}

async function loadLocalData() {
  state.teamLibraryConfigCache?.clear();
  state.recommendedItemsCache?.clear();
  state.rankedSetsCache?.clear();
  const res = await fetch(`data/champion-data.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("缺少 data/champion-data.json，正在等待启动抓取完成。");
  state.rawData = await res.json();
  try {
    const teamsRes = await fetch(`data/team-data.json?t=${Date.now()}`, { cache: "no-store" });
    if (teamsRes.ok) {
      const teamData = await teamsRes.json();
      state.teamLibrary = teamData.teams || [];
      const seasons = availableTeamSeasons();
      const currentSeason = state.data?.season || state.rawData?.season || "";
      state.teamSeasonFilter = seasons.includes(currentSeason) ? currentSeason : seasons[0] || "";
      state.selectedTeamId = currentLibraryTeams()[0]?.id || state.teamLibrary[0]?.id || "";
    }
  } catch {
    state.teamLibrary = [];
  }
  try {
    const knowledgeRes = await fetch(`data/battle-knowledge.json?t=${Date.now()}`, { cache: "no-store" });
    if (knowledgeRes.ok) state.battleKnowledgeData = await knowledgeRes.json();
  } catch {
    state.battleKnowledgeData = null;
  }
  state.rawData.formats = state.rawData.formats || { [state.rawData.defaultFormat || state.rawData.format || "single"]: state.rawData };
}

async function refreshData() {
  const button = $("#refresh-data");
  const progress = $("#refresh-progress");
  const progressBar = $("#refresh-progress-bar");
  const progressText = $("#refresh-progress-text");
  if (!button) return;
  button.disabled = true;
  button.textContent = "补缺中...";
  if (progress) progress.hidden = false;
  if (progressBar) progressBar.style.setProperty("--refresh-progress", "10%");
  if (progressText) progressText.textContent = "启动中";
  await fetch(aiApiUrl("/api/refresh-data"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "missing-all" }),
  });
  let status = null;
  for (let i = 0; i < 240; i += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    status = await fetch(aiApiUrl("/api/refresh-data"), { cache: "no-store" }).then((res) => res.json());
    const percent = status.running ? Math.min(92, 12 + status.fetched * 8 + status.teamsFetched * 0.2) : status.exitCode === 0 ? 100 : 100;
    if (progressBar) progressBar.style.setProperty("--refresh-progress", `${percent}%`);
    if (progressText) {
      progressText.textContent = status.running
        ? status.stage === "teams"
          ? status.teamsFetched
            ? `热门队伍 ${status.teamsFetched}`
            : "更新热门队伍"
          : status.fetched
            ? `已补 ${status.fetched}`
            : "检查缓存"
        : status.exitCode === 0
          ? `完成 ${status.fetched}`
          : "失败";
    }
    renderDataHealth(status);
    if (!status.running) break;
  }
  if (status?.exitCode === 0) {
    saveDraft();
    await loadLocalData();
    restoreDraft(state.format);
    updateFormatButtons();
    updateMetaLabel();
    updateEditorOptions();
    renderDecorPokemon();
    renderTeamLibrary();
    render();
    renderDataHealth(status);
    button.textContent = "已更新";
    window.setTimeout(() => {
      button.textContent = "补缺数据";
      button.disabled = false;
      if (progress) progress.hidden = true;
    }, 1200);
  } else {
    button.textContent = status?.reason || "补缺失败";
    button.disabled = false;
    if (progressBar) progressBar.style.setProperty("--refresh-progress", "100%");
    renderDataHealth(status);
  }
}

async function waitForInitialData() {
  document.body.innerHTML = `
    <main class="startup-screen">
      <section class="startup-card">
        <h1>PokéForge Lab 正在准备数据</h1>
        <p id="startup-text">首次启动会自动补齐环境数据和热门队伍。</p>
        <div class="startup-progress"><span id="startup-bar"></span></div>
        <pre id="startup-error" hidden></pre>
      </section>
    </main>`;
  const bar = document.querySelector("#startup-bar");
  const text = document.querySelector("#startup-text");
  const error = document.querySelector("#startup-error");
  await fetch(aiApiUrl("/api/refresh-data"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "missing-all" }),
  }).catch(() => {});
  for (let i = 0; i < 300; i += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    const status = await fetch(aiApiUrl("/api/refresh-data"), { cache: "no-store" }).then((res) => res.json()).catch(() => null);
    if (!status) continue;
    const percent = status.running ? Math.min(92, 12 + status.fetched * 8 + status.teamsFetched * 0.2) : status.exitCode === 0 ? 100 : 100;
    if (bar) bar.style.width = `${percent}%`;
    if (text) text.textContent = status.stage === "teams" ? `正在更新热门队伍：${status.teamsFetched || 0}` : `正在补齐环境数据：${status.fetched || 0}`;
    if (!status.running) {
      if (status.exitCode === 0) window.location.reload();
      else {
        if (text) text.textContent = "自动抓取失败";
        if (error) {
          error.hidden = false;
          error.textContent = status.reason || status.error || "请检查网络和数据源。";
        }
      }
      return;
    }
  }
}

function draftPayload() {
  return {
    format: state.format,
    team: state.team.map((mon) => ({ id: mon.id, slug: mon.slug, name: mon.name })),
    teamConfigs: state.teamConfigs,
    savedAt: new Date().toISOString(),
  };
}

function saveDraft() {
  if (!state.data) return;
  const allDrafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
  allDrafts[state.format] = draftPayload();
  allDrafts.lastFormat = state.format;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(allDrafts));
}

function restoreDraft(format = null) {
  try {
    const allDrafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    const targetFormat = format || allDrafts.lastFormat || state.format;
    const draft = allDrafts[targetFormat];
    if (!draft?.team?.length || !state.rawData.formats?.[draft.format]) return false;
    state.format = draft.format;
    state.data = state.rawData.formats[draft.format];
    state.team = draft.team
      .map((item) => state.data.pokemon.find((mon) => mon.slug === item.slug || Number(mon.id) === Number(item.id)))
      .filter(Boolean)
      .slice(0, 6);
    state.teamConfigs = draft.teamConfigs || {};
    return state.team.length > 0;
  } catch {
    return false;
  }
}

function clearDraft() {
  const allDrafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
  delete allDrafts[state.format];
  localStorage.setItem(DRAFT_KEY, JSON.stringify(allDrafts));
}

function pokemonForTeamMember(member, options = {}) {
  const targetData = options.data || state.data;
  if (!member || !targetData?.pokemon) return null;
  const allowFallback = options.allowFallback !== false;
  if (member.slug) {
    const bySlug = targetData.pokemon.find((mon) => mon.slug === member.slug);
    if (bySlug) return bySlug;
  }
  const alias = TEAM_FORM_ALIASES.get(Number(member.id));
  if (alias?.slug) {
    const bySlug = targetData.pokemon.find((mon) => mon.slug === alias.slug);
    if (bySlug) return bySlug;
  }
  const targetId = Number(alias?.id || member.id);
  return targetData.pokemon.find((mon) => Number(mon.id) === targetId) || (allowFallback ? fallbackPokemonForTeamMember(member) : null);
}

function addPokemonToTeam(mon, options = {}) {
  if (!mon) return false;
  const existing = state.team.find((item) => item.slug === mon.slug || item.id === mon.id);
  if (existing) return false;
  if (state.team.length < 6) {
    state.team.push(mon);
  } else if (options.replaceLast) {
    const replaced = state.team[state.team.length - 1];
    if (replaced) delete state.teamConfigs[configKey(replaced)];
    state.team[state.team.length - 1] = mon;
  } else {
    return false;
  }
  state.importedTeam = null;
  render();
  saveDraft();
  return true;
}

function fallbackPokemonForTeamMember(member) {
  const id = Number(member.id);
  return {
    id: Number.isFinite(id) ? id : String(member.id || member.name),
    name: member.name || `外部成员 ${member.id || ""}`.trim(),
    slug: `external-${member.id || member.name}`,
    rank: 9999,
    sprite: member.sprite || "",
    types: [],
    stats: {},
    moves: [],
    items: [],
    abilities: [],
    natures: [],
    isExternalMember: true,
  };
}

function aiContext(mode) {
  const promptMode = $("#ai-prompt-mode")?.value || "quick";
  const compactContext = promptMode === "quick";
  const candidateLimit = compactContext ? 30 : 48;
  const commonMoveLimit = compactContext ? 4 : 5;
  const teamLibrarySetLimit = compactContext ? 2 : 4;
  const speedThreatLimit = compactContext ? 6 : 8;
  const opponentConfigLimit = compactContext ? 5 : 8;
  const matchupLimit = compactContext ? 8 : 12;
  const speedlineLimit = compactContext ? 12 : 20;
  const selectedIds = new Set(state.team.map((mon) => mon.id));
  const knowledge = battleKnowledge();
  const compositionReport = getTeamCompositionReport();
  const userGoal = goalText();
  const requestedFormat = requestedBattleFormat(userGoal);
  const activeFormat = requestedFormat || state.format;
  const activeData = state.rawData.formats?.[activeFormat] || state.data;
  const buildIntent = mode === "new-team" ? "new-team" : selectedBuildIntent();
  const teamStyle = requestedTeamStyle(userGoal);
  const teamTemplate = requestedTeamTemplate(userGoal, teamStyle);
  const rebuildFromGoal = buildIntent === "new-team" || (buildIntent === "auto" && shouldRebuildFromGoal(userGoal));
  const forceCurrentTeam = buildIntent === "current-team" || buildIntent === "moveset-only";
  const counterTargetMode = buildIntent === "counter-target" || goalIsCounterTarget(userGoal);
  const requiredCorePokemon = requiredCorePokemonFromGoal(userGoal, activeData?.pokemon || []);
  const goalConstraints = goalConstraintsFromGoal(userGoal, requiredCorePokemon);
  const targetPokemon = counterTargetMode ? targetPokemonFromGoal(userGoal) : [];
  const targetProfiles = targetPokemon.map(targetMatchupProfile).filter(Boolean);
  const structureRequirements = {
    hardChecks: [
      "联防：至少给出关键威胁的换入点、逼退点和 revenge kill 点，不能只写属性克制招式。",
      "轮换：必须说明核心如何安全上场；优先使用急速折返、伏特替换、抛下狠话、耐久中转、击掌奇袭、守住、掩护或天气/空间回合管理。",
      "速度：必须覆盖至少两类速度资源：高速压制、控速后收益者、先制、围巾/特性加速或耐久中转；慢速主轴必须配稳定控速。",
      "行动链：plan 必须包含开局取得节奏、中盘安全轮换/消耗、终盘由谁收割。",
      "主轴/副轴：每个分区必须有主胜利路线和被针对后的替代路线。",
      "Mega 位：构筑时优先检查是否有合理 Mega 位；通常至少安排 1 个 Mega 核心。允许 2 个 Mega 候选作为主副分支，但必须说明主 Mega、备选 Mega、各自适用对局，且不能破坏队友联动或让道具/职责互相挤占。",
      "槽位：先读取 slotModel.missingSlots；优先补主轴/副轴/Mega/控速/安全上场/防守换入/终盘/格式专属槽位，不能为了高 rank 放弃高优先级缺槽。",
      "原型：先读取 archetypeModel.primary 和 missingComponents；最终队伍必须沿用主原型或明确说明为何转向，不能识别为晴天/雨天/空间/受队/轮转后又输出无关泛用队。",
      "威胁矩阵：先读取 threatMatrix.rows 和 priorities；主要威胁必须同时给 defensiveSwitch、offensivePressure、revengeKill/speedControl 中至少两类答案。",
      "队友联动：最终 6 只必须形成至少 2 组明确配合，例如转场带核心上场、控速服务打手、天气/场地收益、威吓/击掌/掩护保护输出、撒场铺垫收割或抗性互补换入。",
      "资源闭环：单打检查回复、转场、撒场/清场、状态、终盘火力；双打检查守住覆盖、控速、先手干扰、AOE、换位/联防。",
      "道具服务定位：关键开局/控速位优先保证行动，轮转位优先多次进场，突破/收割位优先火力；不要为了不重复破坏定位。",
      "watch：至少 3 条，每条包含威胁、应对成员、具体处理顺序。",
    ],
    targetChecks: targetProfiles.map((profile) => ({
      name: profile.target?.name,
      forms: {
        current: profile.target?.form || profile.target?.slug,
        base: profile.target?.baseName,
      },
      finalAbilities: profile.target?.finalAbilities || profile.target?.abilities?.map((item) => item.name).filter(Boolean) || [],
      preMegaAbilities: profile.target?.preMegaAbilities || [],
      warningRules: profile.counterWarnings || [],
      answerRule: "克制目标必须同时给进攻答案和进场答案；Mega 目标以 finalAbilities 判断反制逻辑，preMegaAbilities 只判断进场回合风险。",
    })),
  };
  const relatedTargetTeams = targetRelatedTeams(targetPokemon);
  const targetAnswerScores = new Map();
  for (const item of targetProfiles.flatMap((profile) => profile.offensiveAnswers)) {
    if (!item.slug) continue;
    targetAnswerScores.set(item.slug, Math.max(targetAnswerScores.get(item.slug) || 0, Number(item.score || 0)));
  }
  const candidateSourceAll = (activeData?.pokemon || []).filter((mon) => rebuildFromGoal || !selectedIds.has(mon.id));
  const candidateLimitAll = compactContext ? 160 : 320;
  const requiredIds = new Set(requiredCorePokemon.map((mon) => String(mon.id)));
  const candidateSource = [
    ...requiredCorePokemon,
    ...candidateSourceAll.filter((mon) => !requiredIds.has(String(mon.id))).slice(0, candidateLimitAll),
  ];
  const styleScores = new Map(candidateSource.map((mon) => [mon.id, teamStyleCandidateScore(mon, teamStyle)]));
  const supportReports = new Map(candidateSource.map((mon) => [mon.id, supportCandidateReport(mon)]));
  const supportScores = new Map(candidateSource.map((mon) => [mon.id, supportReports.get(mon.id)?.score || 0]));
  const megaScores = new Map(candidateSource.map((mon) => [mon.id, megaCandidateScore(mon)]));
  const synergyReports = new Map(candidateSource.map((mon) => [mon.id, candidateSynergyReport(mon, { selectedTeam: rebuildFromGoal ? [] : state.team, targetProfiles, teamStyle })]));
  const megaPlan = buildMegaPlan(candidateSource, { targetAnswerScores, styleScores, synergyReports, rebuildFromGoal });
  const fixedOpponentTeams = {
    single: randomFixedOpponentTeamsFor("single", 5),
    double: randomFixedOpponentTeamsFor("double", 5),
  };
  const understanding = buildTeamUnderstanding(rebuildFromGoal ? [] : state.team, ["single", "double"], { megaPlan, teamStyle, userGoal, compositionReport, compactContext, fixedOpponentTeams });
  const formatModels = understanding.formatModels;
  const slotModel = formatModels[activeFormat]?.slotModel || formatModels.single?.slotModel;
  const archetypeModel = formatModels[activeFormat]?.archetypeModel || formatModels.single?.archetypeModel;
  const threatMatrix = formatModels[activeFormat]?.threatMatrix || formatModels.single?.threatMatrix;
  const chainModel = formatModels[activeFormat]?.chainModel || formatModels.single?.chainModel;
  const resourceModel = formatModels[activeFormat]?.resourceModel || formatModels.single?.resourceModel;
  const phaseModel = formatModels[activeFormat]?.phaseModel || formatModels.single?.phaseModel;
  const branchModel = formatModels[activeFormat]?.branchModel || formatModels.single?.branchModel;
  const scoreOptions = { targetAnswerScores, styleScores, synergyReports, supportScores, megaScores };
  const scoreCache = new Map();
  const candidateScoreFor = (mon, format) => {
    const key = `${mon.id}:${format}`;
    if (!scoreCache.has(key)) scoreCache.set(key, scoreCandidateForUnderstanding(mon, understanding, format, scoreOptions));
    return scoreCache.get(key);
  };
  const formatFits = new Map(
    candidateSource.map((mon) => [
      mon.id,
      {
        single: candidateScoreFor(mon, "single").fit,
        double: candidateScoreFor(mon, "double").fit,
      },
    ]),
  );
  const candidateScores = new Map(candidateSource.map((mon) => [mon.id, candidateScoreFor(mon, activeFormat)]));
  const styleFiltered = teamStyle?.id === "stall" ? candidateSource.filter((mon) => (styleScores.get(mon.id) || 0) >= 0) : candidateSource;
  const sortedCandidatePool = [
    ...requiredCorePokemon,
    ...(styleFiltered.length >= 24 ? styleFiltered : candidateSource).filter((mon) => !requiredIds.has(String(mon.id))),
  ]
    .sort((a, b) => {
      const requiredScore = (requiredIds.has(String(b.id)) ? 1 : 0) - (requiredIds.has(String(a.id)) ? 1 : 0);
      const currentScore = (candidateScores.get(b.id)?.total || 0) - (candidateScores.get(a.id)?.total || 0);
      const targetScore = (targetAnswerScores.get(b.slug) || 0) - (targetAnswerScores.get(a.slug) || 0);
      const styleScore = (styleScores.get(b.id) || 0) - (styleScores.get(a.id) || 0);
      const currentFormat = activeFormat === "double" ? "double" : "single";
      const otherFormat = currentFormat === "double" ? "single" : "double";
      const formatScore = ((formatFits.get(b.id)?.[currentFormat]?.score || 0) + (formatFits.get(b.id)?.[otherFormat]?.score || 0) * 0.35) - ((formatFits.get(a.id)?.[currentFormat]?.score || 0) + (formatFits.get(a.id)?.[otherFormat]?.score || 0) * 0.35);
      const threatScore = (formatFits.get(b.id)?.[currentFormat]?.threatFit?.score || 0) - (formatFits.get(a.id)?.[currentFormat]?.threatFit?.score || 0);
      const chainScore = (formatFits.get(b.id)?.[currentFormat]?.chainFit?.score || 0) - (formatFits.get(a.id)?.[currentFormat]?.chainFit?.score || 0);
      const resourceScore = (formatFits.get(b.id)?.[currentFormat]?.resourceFit?.score || 0) - (formatFits.get(a.id)?.[currentFormat]?.resourceFit?.score || 0);
      const phaseScore = (formatFits.get(b.id)?.[currentFormat]?.phaseFit?.score || 0) - (formatFits.get(a.id)?.[currentFormat]?.phaseFit?.score || 0);
      const branchScore = (formatFits.get(b.id)?.[currentFormat]?.branchFit?.score || 0) - (formatFits.get(a.id)?.[currentFormat]?.branchFit?.score || 0);
      const archetypeScore = (formatFits.get(b.id)?.[currentFormat]?.archetypeFit?.score || 0) - (formatFits.get(a.id)?.[currentFormat]?.archetypeFit?.score || 0);
      const slotScore = (formatFits.get(b.id)?.[currentFormat]?.slotFit?.score || 0) - (formatFits.get(a.id)?.[currentFormat]?.slotFit?.score || 0);
      const synergyScore = (synergyReports.get(b.id)?.score || 0) - (synergyReports.get(a.id)?.score || 0);
      const supportScore = (supportScores.get(b.id) || 0) - (supportScores.get(a.id) || 0);
      const megaScore = (megaScores.get(b.id) || 0) - (megaScores.get(a.id) || 0);
      return requiredScore || currentScore || targetScore || styleScore || formatScore || threatScore || branchScore || phaseScore || chainScore || resourceScore || archetypeScore || slotScore || synergyScore || megaScore || supportScore || Number(a.rank || 9999) - Number(b.rank || 9999);
    });
  const forcedGoalCandidates = goalSupportCandidatesForContext([...requiredCorePokemon, ...candidateSourceAll], goalConstraints, activeFormat);
  const candidatePool = [...forcedGoalCandidates, ...sortedCandidatePool]
    .filter((mon, index, list) => list.findIndex((item) => String(item.id || item.slug || item.name) === String(mon.id || mon.slug || mon.name)) === index)
    .slice(0, candidateLimit);
  const memoryContext = {
    buildIntent,
    format: activeFormat,
    userGoal,
    intent: {
      teamStyle,
      teamTemplate,
      rebuildFromGoal,
      counterTargetMode,
      goalConstraints,
    },
  };
  const failureMemory = relevantFailureMemory(memoryContext);
  const battleHistory = relevantBattleHistory(memoryContext);
  return {
    mode,
    promptMode,
    uiLevel: {
      value: state.uiLevel,
      label: uiLevelLabel(),
      instruction: uiLevelInstruction(),
    },
    buildIntent,
    format: activeFormat,
    formatLabel: formatLabel(activeFormat),
    sourcePriority: [
      "Pokemon Champions 当前格式数据为主规则和主可用池",
      "Showdown 只做参考校验和英文规则参考",
      "Smogon 只做环境趋势和 matchup 参考",
    ],
    userGoal,
    intent: {
      emptyTeamRequest: (!forceCurrentTeam && state.team.length === 0) || rebuildFromGoal,
      rebuildFromGoal,
      forceCurrentTeam,
      movesetOnly: buildIntent === "moveset-only",
      counterTargetMode,
      requestedFormat: activeFormat,
      formatExplicit: Boolean(requestedFormat),
      formatConstraint: requestedFormat
        ? `用户明确要求${formatLabel(activeFormat)}；summary、默认展示和主要对局计划必须围绕${formatLabel(activeFormat)}，不能用另一种格式代替。`
        : "",
      teamStyle,
      teamTemplate,
      goalConstraints,
      uiLevel: {
        value: state.uiLevel,
        label: uiLevelLabel(),
        instruction: uiLevelInstruction(),
      },
      megaPlan,
      understanding,
      slotModel,
      archetypeModel,
      threatMatrix,
      chainModel,
      resourceModel,
      phaseModel,
      branchModel,
      formatModels,
      failureMemory,
      battleHistory,
      targetPokemon: targetProfiles,
      relatedTargetTeams,
      instruction: state.team.length
        ? rebuildFromGoal
          ? `用户要求重新配置一个新队伍；不要保留当前已选 6 只，也不要说“基于当前6只”。请从 metaCandidates 重新选择。${teamStyle ? `用户指定队伍类型：${teamStyle.name}，必须服从 teamStyle.hardRules。` : ""}`
          : `基于已选宝可梦与用户目标调整配置或补全。${teamStyle ? `用户指定队伍类型：${teamStyle.name}，必须服从 teamStyle.hardRules。` : ""}`
        : `用户没有预选宝可梦；请从 metaCandidates 中围绕 userGoal 从零构筑 6 只队伍，并优先处理 targetPokemon。${teamStyle ? `用户指定队伍类型：${teamStyle.name}，必须服从 teamStyle.hardRules。` : ""}`,
    },
    structureRequirements,
    megaPlan,
    understanding,
    battleEvaluation: {
      mode: "fixed-meta-opponents",
      status: "opponent-set-ready",
      note: "当前版本会从热门队池随机抽样固定靶队；本地 Showdown 模拟器会消费 fixedOpponentTeams 并回写胜率、分支失败率和失败原因。",
      fixedOpponentTeams,
    },
    slotModel,
    archetypeModel,
    threatMatrix,
    chainModel,
    resourceModel,
    phaseModel,
    branchModel,
    formatModels,
    failureMemory,
    battleHistory,
    compositionReport,
    battleKnowledge: {
      sourceModel: knowledge.sourceModel,
      score: knowledge.score,
      risks: knowledge.risks,
      strengths: knowledge.strengths,
      needs: knowledge.needs,
      roleCoverage: knowledge.roleCoverage,
      typeProfile: knowledge.typeProfile,
      legality: knowledge.legality,
      formatChecklist: knowledge.formatChecklist,
      stateTags: knowledge.stateTags,
      members: knowledge.members.map((item) => ({
        name: item.name,
        types: item.types,
        roles: item.roles,
        item: item.item,
        ability: item.ability,
        moves: item.moves,
        speed: item.speed,
        matchup: item.matchup,
        flags: item.flags,
      })),
    },
    pokeCampSpeedline: currentPokeCampData()
      ? {
          source: "PokeCamp Champions / Limitless",
          dateRange: currentPokeCampData().dateRange,
          topUsage: currentPokeCampData()
            .pokemonList.slice(0, speedlineLimit)
            .map((item) => ({
              name: item.names?.zh || item.names?.en || item.identifier,
              identifier: item.identifier,
              baseSpeed: item.baseSpeed,
              rank: item.usage?.rank,
              usagePercent: item.usage?.usagePercent,
              singlesRank: item.usage?.singlesRank,
              doublesRank: item.usage?.doublesRank,
              preset: currentPokeCampData().speedline?.presets?.[item.identifier] || currentPokeCampData().speedline?.presets?.[item.speciesIdentifier] || null,
            })),
          baseSpeedGroups: currentPokeCampData().speedline?.baseGroups?.slice(0, speedlineLimit) || [],
        }
      : null,
    packedTeam: packedTeamText(),
    selectedPokemon: rebuildFromGoal ? [] : state.team.map(pokemonSummary),
    ignoredCurrentPokemon: rebuildFromGoal ? state.team.map((mon) => ({ id: mon.id, name: mon.name, slug: mon.slug })) : [],
    importedTeam: state.importedTeam
      ? {
          title: state.importedTeam.title,
          rate: state.importedTeam.rate,
          articleUrl: state.importedTeam.articleUrl,
          configurations: state.importedTeam.configurations,
        }
      : null,
    speedThreats: getSpeedThreats().slice(0, speedThreatLimit).map(({ mon, level, note }) => ({
      name: mon.name,
      rank: mon.rank,
      level,
      speed: stat(mon, "速度"),
      effectiveSpeed: effectiveSpeed(mon),
      note,
    })),
    opponentConfigs: getOpponentConfigs().slice(0, opponentConfigLimit),
    matchupReport: getMatchupReport(matchupLimit),
    metaCandidates: candidatePool.map((mon) => {
      const externalKnowledge = externalKnowledgeFor(mon);
      const megaProfile = megaProfileFor(mon);
      const candidateScore = candidateScores.get(mon.id) || { total: 0, profile: null, reasons: [] };
      return {
        id: mon.id,
        name: mon.name,
        slug: mon.slug,
        megaProfile,
        megaSlotCandidate: Boolean(megaProfile || [...(mon.items || []), ...recommendedItemsFor(mon, new Set(), 3)].some((item) => isMegaStone(item?.name || item))),
        megaPlanRole: megaPlan.primary?.id === mon.id ? "primary" : megaPlan.secondary?.id === mon.id ? "secondary" : "",
        rank: mon.rank,
        types: mon.types,
        stats: mon.stats,
        effectiveSpeed: effectiveSpeed(mon),
        commonMoves: mon.moves?.slice(0, commonMoveLimit),
        commonItems: mon.items?.slice(0, 3),
        teamLibraryItems: recommendedItemsFor(mon, new Set(), 5).map((item) => ({ name: item.name, count: item.count, score: item.score })),
        teamLibrarySets: rankedTeamLibrarySetsFor(mon, teamLibrarySetLimit),
        commonAbilities: mon.abilities?.slice(0, 3),
        commonTeammates: (externalKnowledge?.usage?.teammates || []).slice(0, 4),
        supportBias: supportScores.get(mon.id) || 0,
        supportProfile: supportReports.get(mon.id) || { score: 0, hasPrankster: false, tags: [], reasons: [] },
        megaBias: megaScores.get(mon.id) || 0,
        understandingScore: candidateScore.total,
        understandingReasons: candidateScore.reasons || [],
        pokemonProfile: candidateScore.profile,
        formatFit: formatFits.get(mon.id) || {},
        threatFit: formatFits.get(mon.id)?.[state.format]?.threatFit || { score: 0, threats: [], fillAnswers: [], reasons: [] },
        chainFit: formatFits.get(mon.id)?.[state.format]?.chainFit || { score: 0, chains: [], fillRoles: [], tags: [], reasons: [] },
        resourceFit: formatFits.get(mon.id)?.[state.format]?.resourceFit || { score: 0, fixes: [], risks: [], reasons: [] },
        phaseFit: formatFits.get(mon.id)?.[state.format]?.phaseFit || { score: 0, phases: [], fillRoles: [], reasons: [] },
        branchFit: formatFits.get(mon.id)?.[state.format]?.branchFit || { score: 0, branches: [], fillRoles: [], reasons: [] },
        slotFit: formatFits.get(mon.id)?.[state.format]?.slotFit || { score: 0, slots: [], fillSlots: [], reasons: [] },
        archetypeFit: formatFits.get(mon.id)?.[state.format]?.archetypeFit || { score: 0, archetypes: [], fillComponents: [], reasons: [] },
        synergyScore: synergyReports.get(mon.id)?.score || 0,
        synergyReasons: synergyReports.get(mon.id)?.reasons || [],
        roles: getRoles(mon),
        roleProfile: roleProfileFor(mon),
        externalKnowledge,
      };
    }),
  };
}

function trimArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : value;
}

function slimCandidateForAI(mon = {}) {
  const fit = mon.formatFit || {};
  const slimFit = {};
  for (const format of ["single", "double"]) {
    const item = fit[format] || {};
    slimFit[format] = {
      score: item.score,
      reasons: trimArray(item.reasons, 3),
      slotFit: item.slotFit ? { score: item.slotFit.score, fillSlots: trimArray(item.slotFit.fillSlots, 4), reasons: trimArray(item.slotFit.reasons, 3) } : undefined,
      threatFit: item.threatFit ? { score: item.threatFit.score, fillAnswers: trimArray(item.threatFit.fillAnswers, 4), reasons: trimArray(item.threatFit.reasons, 3) } : undefined,
      chainFit: item.chainFit ? { score: item.chainFit.score, fillRoles: trimArray(item.chainFit.fillRoles, 4), tags: trimArray(item.chainFit.tags, 4), reasons: trimArray(item.chainFit.reasons, 3) } : undefined,
      resourceFit: item.resourceFit ? { score: item.resourceFit.score, fixes: trimArray(item.resourceFit.fixes, 4), reasons: trimArray(item.resourceFit.reasons, 3) } : undefined,
    };
  }
  return {
    id: mon.id,
    name: mon.name,
    slug: mon.slug,
    rank: mon.rank,
    types: mon.types,
    stats: mon.stats,
    effectiveSpeed: mon.effectiveSpeed,
    commonMoves: trimArray(mon.commonMoves, 4),
    commonItems: trimArray(mon.commonItems, 3),
    commonAbilities: trimArray(mon.commonAbilities, 3),
    megaSlotCandidate: mon.megaSlotCandidate,
    megaPlanRole: mon.megaPlanRole,
    supportProfile: mon.supportProfile ? {
      score: mon.supportProfile.score,
      hasPrankster: mon.supportProfile.hasPrankster,
      tags: trimArray(mon.supportProfile.tags, 5),
      reasons: trimArray(mon.supportProfile.reasons, 3),
    } : null,
    understandingScore: mon.understandingScore,
    understandingReasons: trimArray(mon.understandingReasons, 4),
    formatFit: slimFit,
    synergyScore: mon.synergyScore,
    synergyReasons: trimArray(mon.synergyReasons, 4),
    roles: trimArray(mon.roles, 5),
    roleProfile: mon.roleProfile,
  };
}

function quickSummaryForFormatModel(model = {}) {
  return {
    slotModel: model.slotModel ? {
      missingSlots: trimArray(model.slotModel.missingSlots, 5),
      requiredSlots: trimArray(model.slotModel.requiredSlots, 6),
    } : null,
    archetypeModel: model.archetypeModel ? {
      primary: model.archetypeModel.primary,
      missingComponents: trimArray(model.archetypeModel.missingComponents, 5),
      buildRules: trimArray(model.archetypeModel.buildRules, 5),
    } : null,
    threatMatrix: model.threatMatrix ? {
      priorities: trimArray(model.threatMatrix.priorities, 5),
      rows: trimArray(model.threatMatrix.rows, 5),
    } : null,
    chainModel: model.chainModel ? {
      missingChains: trimArray(model.chainModel.missingChains, 5),
    } : null,
    resourceModel: model.resourceModel ? {
      risks: trimArray(model.resourceModel.risks, 5),
      desiredResources: trimArray(model.resourceModel.desiredResources, 5),
    } : null,
    phaseModel: model.phaseModel ? {
      missingPhases: trimArray(model.phaseModel.missingPhases, 4),
    } : null,
    branchModel: model.branchModel ? {
      missingBranches: trimArray(model.branchModel.missingBranches, 5),
    } : null,
  };
}

function trimAIContextForRequest(context = {}) {
  if (context.promptMode !== "quick") return context;
  const formatModels = {
    single: quickSummaryForFormatModel(context.formatModels?.single),
    double: quickSummaryForFormatModel(context.formatModels?.double),
  };
  const understanding = context.understanding ? {
    summary: context.understanding.summary,
    fixedOpponentTeams: {
      single: trimArray(context.understanding.fixedOpponentTeams?.single, 3),
      double: trimArray(context.understanding.fixedOpponentTeams?.double, 3),
    },
  } : null;
  return {
    ...context,
    uiLevel: context.uiLevel,
    formatModels,
    understanding,
    slotModel: formatModels[context.format]?.slotModel || context.slotModel,
    archetypeModel: formatModels[context.format]?.archetypeModel || context.archetypeModel,
    threatMatrix: formatModels[context.format]?.threatMatrix || context.threatMatrix,
    chainModel: formatModels[context.format]?.chainModel || context.chainModel,
    resourceModel: formatModels[context.format]?.resourceModel || context.resourceModel,
    phaseModel: formatModels[context.format]?.phaseModel || context.phaseModel,
    branchModel: formatModels[context.format]?.branchModel || context.branchModel,
    intent: {
      ...context.intent,
      uiLevel: context.intent?.uiLevel || context.uiLevel,
      understanding,
      formatModels,
      slotModel: formatModels[context.format]?.slotModel || context.intent?.slotModel,
      archetypeModel: formatModels[context.format]?.archetypeModel || context.intent?.archetypeModel,
      threatMatrix: formatModels[context.format]?.threatMatrix || context.intent?.threatMatrix,
      chainModel: formatModels[context.format]?.chainModel || context.intent?.chainModel,
      resourceModel: formatModels[context.format]?.resourceModel || context.intent?.resourceModel,
      phaseModel: formatModels[context.format]?.phaseModel || context.intent?.phaseModel,
      branchModel: formatModels[context.format]?.branchModel || context.intent?.branchModel,
      goalConstraints: context.intent?.goalConstraints,
      targetPokemon: trimArray(context.intent?.targetPokemon, 3),
      relatedTargetTeams: trimArray(context.intent?.relatedTargetTeams, 3),
      failureMemory: trimArray(context.intent?.failureMemory, 3),
      battleHistory: trimArray(context.intent?.battleHistory, 3),
    },
    battleEvaluation: {
      mode: context.battleEvaluation?.mode,
      status: context.battleEvaluation?.status,
      fixedOpponentTeams: {
        single: trimArray(context.battleEvaluation?.fixedOpponentTeams?.single, 3),
        double: trimArray(context.battleEvaluation?.fixedOpponentTeams?.double, 3),
      },
    },
    failureMemory: trimArray(context.failureMemory, 3),
    battleHistory: trimArray(context.battleHistory, 3),
    compositionReport: context.compositionReport ? {
      style: context.compositionReport.style,
      cores: trimArray(context.compositionReport.cores, 4),
      winConditions: trimArray(context.compositionReport.winConditions, 4),
      gaps: trimArray(context.compositionReport.gaps, 6),
      buildPriorities: trimArray(context.compositionReport.buildPriorities, 6),
    } : null,
    battleKnowledge: context.battleKnowledge ? {
      score: context.battleKnowledge.score,
      risks: trimArray(context.battleKnowledge.risks, 6),
      strengths: trimArray(context.battleKnowledge.strengths, 5),
      needs: trimArray(context.battleKnowledge.needs, 6),
      roleCoverage: context.battleKnowledge.roleCoverage,
      typeProfile: context.battleKnowledge.typeProfile,
      legality: context.battleKnowledge.legality,
      stateTags: trimArray(context.battleKnowledge.stateTags, 8),
      members: trimArray(context.battleKnowledge.members, 6),
    } : null,
    pokeCampSpeedline: context.pokeCampSpeedline ? {
      source: context.pokeCampSpeedline.source,
      dateRange: context.pokeCampSpeedline.dateRange,
      topUsage: trimArray(context.pokeCampSpeedline.topUsage, 8),
      baseSpeedGroups: trimArray(context.pokeCampSpeedline.baseSpeedGroups, 6),
    } : null,
    importedTeam: context.importedTeam ? {
      title: context.importedTeam.title,
      rate: context.importedTeam.rate,
      configurations: trimArray(context.importedTeam.configurations, 6),
    } : null,
    speedThreats: trimArray(context.speedThreats, 5),
    opponentConfigs: trimArray(context.opponentConfigs, 4),
    matchupReport: context.matchupReport ? {
      threats: trimArray(context.matchupReport.threats, 6),
      risks: trimArray(context.matchupReport.risks, 6),
      notes: trimArray(context.matchupReport.notes, 6),
    } : null,
    metaCandidates: trimArray(context.metaCandidates, 42).map(slimCandidateForAI),
  };
}

function loadAIConfig() {
  try {
    return JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || "{}");
  } catch {
    return {};
  }
}

function loadAIModelCache() {
  try {
    return JSON.parse(localStorage.getItem(AI_MODELS_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveAIModelCache(provider, models = []) {
  const cache = loadAIModelCache();
  cache[provider] = [...new Set(models.filter(Boolean))].slice(0, 200);
  localStorage.setItem(AI_MODELS_CACHE_KEY, JSON.stringify(cache));
}

function getAIConfigFromForm() {
  const selectedModel = $("#ai-model-select")?.value || "";
  const customModel = $("#ai-model")?.value?.trim() || "";
  return {
    provider: $("#ai-provider")?.value || "openai",
    endpoint: $("#ai-endpoint")?.value || "responses",
    baseUrl: $("#ai-base-url")?.value?.trim() || "",
    model: selectedModel === "__custom" ? customModel : selectedModel || customModel,
    apiKey: $("#ai-api-key")?.value?.trim() || "",
  };
}

function hasUsableAIConfig(config = loadAIConfig()) {
  return Boolean(config.apiKey && config.baseUrl && config.model);
}

function updateAIConfigStatus() {
  const status = $("#ai-config-status");
  if (!status) return;
  const config = getAIConfigFromForm();
  status.textContent = hasUsableAIConfig(config)
    ? `将使用 ${config.provider} / ${config.model}，配置只保存在当前浏览器。`
    : "请在此填写 API Key、Base URL 和模型后再使用。";
}

function applyAIProviderPreset(force = false) {
  const provider = $("#ai-provider")?.value || "openai";
  const preset = AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.custom;
  const baseUrl = $("#ai-base-url");
  const endpoint = $("#ai-endpoint");
  if (baseUrl && (force || !baseUrl.value)) baseUrl.value = preset.baseUrl;
  if (endpoint && (force || !endpoint.value)) endpoint.value = preset.endpoint;
  hydrateModelSelect(force ? preset.model : getAIConfigFromForm().model || preset.model);
  updateAIConfigStatus();
}

function hydrateModelSelect(modelValue = "") {
  const provider = $("#ai-provider")?.value || "openai";
  const preset = AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.custom;
  const select = $("#ai-model-select");
  const customInput = $("#ai-model");
  const customField = $("#ai-custom-model-field");
  if (!select || !customInput || !customField) return;
  const cachedModels = loadAIModelCache()[provider] || [];
  const models = [...new Set([...(preset.models || []), ...cachedModels])];
  const model = modelValue || preset.model || "";
  select.innerHTML = [
    ...models.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`),
    `<option value="__custom">自定义模型...</option>`,
  ].join("");
  if (model && models.includes(model)) {
    select.value = model;
    customInput.value = "";
    customField.hidden = true;
  } else {
    select.value = "__custom";
    customInput.value = model;
    customField.hidden = false;
  }
}

function updateModelInputVisibility() {
  const customField = $("#ai-custom-model-field");
  const customInput = $("#ai-model");
  const selected = $("#ai-model-select")?.value || "";
  if (!customField || !customInput) return;
  customField.hidden = selected !== "__custom";
  if (selected !== "__custom") customInput.value = "";
  updateAIConfigStatus();
}

async function refreshAIModels() {
  const status = $("#ai-config-status");
  const button = $("#ai-refresh-models");
  const config = getAIConfigFromForm();
  if (!config.apiKey || !config.baseUrl) {
    if (status) status.textContent = "请先填写 API Key 和 Base URL，再获取模型列表。";
    return;
  }
  if (button) button.disabled = true;
  if (status) status.textContent = "正在从服务商获取模型列表...";
  try {
    const res = await fetch(aiApiUrl("/api/ai-models"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiConfig: config }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `获取失败：${res.status}`);
    if (data.unsupported) {
      if (status) status.textContent = data.message || "当前服务商不开放模型列表接口，请使用预设模型或自定义模型。";
      return;
    }
    saveAIModelCache(config.provider, data.models || []);
    hydrateModelSelect(config.model || data.models?.[0] || "");
    if (status) status.textContent = `已获取 ${data.models?.length || 0} 个模型，可在下拉框选择。`;
  } catch (err) {
    if (status) status.textContent = `${err.message || "获取模型列表失败"}；可以继续使用自定义模型。`;
  } finally {
    if (button) button.disabled = false;
  }
}

function hydrateAIConfigForm() {
  const saved = loadAIConfig();
  const provider = $("#ai-provider");
  const endpoint = $("#ai-endpoint");
  const baseUrl = $("#ai-base-url");
  const apiKey = $("#ai-api-key");
  if (provider) provider.value = saved.provider || "openai";
  if (endpoint) endpoint.value = saved.endpoint || AI_PROVIDER_PRESETS[provider?.value || "openai"]?.endpoint || "responses";
  if (baseUrl) baseUrl.value = saved.baseUrl || AI_PROVIDER_PRESETS[provider?.value || "openai"]?.baseUrl || "";
  hydrateModelSelect(saved.model || AI_PROVIDER_PRESETS[provider?.value || "openai"]?.model || "");
  if (apiKey) apiKey.value = saved.apiKey || "";
  updateAIConfigStatus();
}

function saveAIConfig() {
  const config = getAIConfigFromForm();
  if (hasUsableAIConfig(config)) {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
    updateAIConfigStatus();
    return;
  }
  localStorage.removeItem(AI_CONFIG_KEY);
  updateAIConfigStatus();
}

function clearAIConfig() {
  localStorage.removeItem(AI_CONFIG_KEY);
  const apiKey = $("#ai-api-key");
  if (apiKey) apiKey.value = "";
  applyAIProviderPreset(true);
  updateAIConfigStatus();
}

function loadRulePrefs() {
  try {
    state.rulePrefs = { ...state.rulePrefs, ...JSON.parse(localStorage.getItem(RULE_PREFS_KEY) || "{}") };
  } catch {
    state.rulePrefs = { allowDuplicateItems: false, ignoreTera: false };
  }
}

function hydrateRulePrefs() {
  const duplicate = $("#rule-allow-duplicate-items");
  const tera = $("#rule-ignore-tera");
  if (duplicate) duplicate.checked = Boolean(state.rulePrefs.allowDuplicateItems);
  if (tera) tera.checked = Boolean(state.rulePrefs.ignoreTera);
}

function saveRulePrefs() {
  state.rulePrefs = {
    allowDuplicateItems: Boolean($("#rule-allow-duplicate-items")?.checked),
    ignoreTera: Boolean($("#rule-ignore-tera")?.checked),
  };
  localStorage.setItem(RULE_PREFS_KEY, JSON.stringify(state.rulePrefs));
  renderValidationHints();
}

async function testAIConfig() {
  const status = $("#ai-config-status");
  const button = $("#ai-test-config");
  saveAIConfig();
  const aiConfig = loadAIConfig();
  if (!hasUsableAIConfig(aiConfig)) {
    if (status) status.textContent = "请先填写 API Key、Base URL 和模型。";
    return;
  }
  if (button) button.disabled = true;
  if (status) status.textContent = "正在测试连接...";
  try {
    const res = await fetch(aiApiUrl("/api/ai-test"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiConfig }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `测试失败：${res.status}`);
    if (status) status.textContent = `连接成功：${data.provider} / ${data.model}`;
  } catch (err) {
    if (status) status.textContent = err.message || "连接失败，请检查配置。";
  } finally {
    if (button) button.disabled = false;
  }
}

function renderDataHealth(status = null) {
  const target = $("#data-health-grid");
  if (!target) return;
  const pokemonCount = state.data?.pokemon?.length || 0;
  const supplementalCount = state.data?.pokemon?.filter((mon) => mon.supplemental).length || 0;
  const teamCount = currentLibraryTeams().length || 0;
  const dataMeta = formatCacheTime(currentCacheTime());
  const statusLabel = status?.running ? "抓取中" : status?.exitCode === 0 ? "最近成功" : status?.exitCode ? "最近失败" : "待命";
  target.innerHTML = `
    <div class="data-health-card"><strong>${pokemonCount}</strong><span>当前环境宝可梦</span><small>${escapeHtml([formatLabel(state.format), supplementalCount ? `含补源 ${supplementalCount} 只` : ""].filter(Boolean).join(" · "))}</small></div>
    <div class="data-health-card"><strong>${teamCount}</strong><span>可导入热门队伍</span><small>${teamCount ? "已缓存" : "暂无缓存"}</small></div>
    <div class="data-health-card"><strong>${escapeHtml(statusLabel)}</strong><span>抓取任务</span><small>${escapeHtml(status?.reason || status?.stage || "无错误")}</small></div>
    <div class="data-health-card"><strong>${escapeHtml(dataMeta)}</strong><span>数据更新时间</span><small>本地 JSON 缓存</small></div>`;
  const log = $("#refresh-log");
  if (log && status) {
    const text = [status.reason, status.error, status.output].filter(Boolean).join("\n\n").trim();
    log.hidden = !text;
    log.textContent = text.slice(-1800);
  }
}

function renderHeroCopy() {
  const copy = $("#ui-level-copy");
  if (!copy) return;
  copy.textContent = uiLevelPrompt();
}

function renderQuickstartCopy() {
  const strip = $("#quickstart-strip");
  if (!strip) return;
  strip.dataset.uiLevel = state.uiLevel;
  strip.querySelectorAll("[data-quickstart]").forEach((button) => {
    const key = button.dataset.quickstart;
    button.hidden = false;
    button.classList.toggle("is-primary", key === "import-team" && isUiLevel("beginner"));
  });
}

function renderSpeedlineSummary() {
  const target = $("#speedline-summary");
  if (!target) return;
  const rows = speedlineRows();
  if (!rows.length) {
    target.innerHTML = `<p class="empty">暂无速度线数据。运行 npm run fetch:knowledge 后会显示 PokeCamp 速度线。</p>`;
    return;
  }
  if (!state.team.length) {
    target.innerHTML = `<p class="speedline-summary-text">先选队伍，速度线会自动告诉你哪些档位已压过、哪些接近、哪些还得控速。</p>`;
    return;
  }
  const ownMax = Math.max(...state.team.map((mon) => effectiveSpeed(mon).value));
  const ahead = rows.filter((row) => ownMax >= row.actualSpeed).length;
  const close = rows.filter((row) => ownMax < row.actualSpeed && ownMax >= row.actualSpeed - 10).length;
  const firstGap = rows.find((row) => ownMax < row.actualSpeed) || rows[0];
  const mainText = isUiLevel("beginner")
    ? `你当前最高速度是 ${ownMax}，已压过 ${ahead} 档；先盯住 ${firstGap.actualSpeed} 这一档。`
    : `当前最高速度 ${ownMax}，已压过 ${ahead} 档、接近 ${close} 档；最该盯住 ${firstGap.actualSpeed} 这一档。`;
  target.innerHTML = `<p class="speedline-summary-text">${escapeHtml(mainText)}</p>`;
}

async function refreshDataHealth() {
  const status = await fetch(aiApiUrl("/api/refresh-data"), { cache: "no-store" }).then((res) => res.json()).catch(() => null);
  renderDataHealth(status);
}

function normalizeAdvice(data) {
  const normalize = (advice) => normalizeAdviceDefaults(advice);
  if (data?.advice) {
    const advice = data.advice;
    if (Array.isArray(advice.team)) {
      return normalize({
        ...advice,
        single: { team: advice.team, ...(advice.single || {}) },
        double: { team: advice.team, ...(advice.double || {}) },
      });
    }
    return normalize(advice);
  }
  if (!data?.text) return null;
  const text = data.text.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const advice = JSON.parse(candidate.slice(start, end + 1));
    if (Array.isArray(advice.team)) {
      return normalize({
        ...advice,
        single: { team: advice.team, ...(advice.single || {}) },
        double: { team: advice.team, ...(advice.double || {}) },
      });
    }
    return normalize(advice);
  } catch {
    return null;
  }
}

function normalizeAdviceDefaults(advice) {
  const rawSummary = localizeAdviceText(advice.summary || "").trim();
  const summaryFragment = rawSummary.match(/^\s*["']?summary["']?\s*:\s*["']?([\s\S]*?)["']?\s*,?\s*$/i);
  advice.summary = summaryFragment ? summaryFragment[1].trim() : rawSummary;
  for (const format of ["single", "double"]) {
    if (advice?.[format]) {
      advice[format].plan = localizeAdviceText(advice[format].plan || "");
      advice[format].watch = Array.isArray(advice[format].watch) ? advice[format].watch.map(localizeAdviceText) : [];
    }
    const team = Array.isArray(advice?.[format]?.team) ? advice[format].team : [];
    const used = new Set();
    team.forEach((item, index) => {
      const originalMoves = Array.isArray(item.moves) ? item.moves.map((move) => localizeTerm(move, "moves")).filter(Boolean) : [];
      const originalConfigText = `${item.name || ""} ${item.id || ""} ${item.slug || ""} ${item.role || ""} ${item.ability || ""} ${originalMoves.join(" ")} ${item.note || ""}`;
      Object.assign(item, localizeAdviceItem(item));
      item.level = String(item.level || "50");
      let mon = resolveAdvicePokemonMon(item, format) || pokemonFromAdvice(item, format) || state.data?.pokemon?.find((entry) => [entry.name, entry.slug, String(entry.id)].some((value) => String(value) === String(item.name || item.slug || item.id)));
      if (!mon) mon = fallbackAdvicePokemonMon(item, format, index);
      const pools = adviceConfigPoolsForMon(mon, format);
      const fallbackConfig = pools.fallbackConfig || {};
      const fallbackAbility = cleanAdviceConfigValue(fallbackConfig.ability, "abilities", format) || names(mon?.abilities || [], 1);
      const fallbackNature = cleanAdviceConfigValue(fallbackConfig.nature, "natures", format) || names(mon?.natures || [], 1);
      const fallbackMoves = (fallbackConfig.moves?.length ? fallbackConfig.moves : mon?.moves?.slice(0, 4).map((move) => move.name) || [])
        .map((move) => cleanAdviceConfigValue(move, "moves", format))
        .filter(Boolean);
      const allowed = (value, pool, category) => {
        const text = cleanAdviceConfigValue(value, category, format);
        return text && (!pool.size || pool.has(normalizedItemName(text))) ? text : "";
      };
      item.ability = allowed(item.ability, pools.abilities, "abilities") || fallbackAbility || fallbackAdviceAbilityFor(item, mon) || "";
      item.nature = allowed(item.nature, pools.natures, "natures") || fallbackNature || "";
      item.evs = isPlaceholderConfigValue(item.evs) ? usableConfigValue(fallbackConfig.evs) || "速度与主攻为主" : localizeAdviceText(item.evs || "");
      item.moves = (Array.isArray(item.moves) ? item.moves : [])
        .map((move) => allowed(move, pools.moves, "moves"))
        .filter(Boolean)
        .slice(0, 4);
      if (item.moves.length < 4) {
        item.moves = [...item.moves, ...fallbackMoves.filter((move) => !item.moves.includes(move))].slice(0, 4);
      }
      if (item.moves.length < 4) {
        item.moves = fallbackAdviceMovesFor(item, mon, format, item.moves);
      }
      const constraints = state.aiLastContext?.intent?.goalConstraints || state.aiLastContext?.goalConstraints || {};
      const themes = Array.isArray(constraints.themes) ? constraints.themes : [];
      if (themes.includes("tailwind") && /顺风|tailwind|おいかぜ/i.test(originalConfigText)) ensureAdviceMove(item, "顺风");
      if (themes.includes("rain") && /求雨|雨乞い|あまごい|rain[-\s]?dance/i.test(originalConfigText)) ensureAdviceMove(item, "求雨");
      if (themes.includes("sun") && /大晴天|晴天|にほんばれ|sunny[-\s]?day/i.test(originalConfigText)) ensureAdviceMove(item, "大晴天");
      if (themes.includes("trick-room") && /戏法空间|trick[-\s]?room/i.test(originalConfigText)) ensureAdviceMove(item, "戏法空间");
      if (themes.includes("sand") && /沙暴|すなあらし|sandstorm/i.test(originalConfigText)) ensureAdviceMove(item, "沙暴");
      if (themes.includes("snow") && /雪景|冰雹|あられ|ゆきげしき|snowscape|hail/i.test(originalConfigText)) ensureAdviceMove(item, "雪景");
      item.name = mon?.name || item.name;
      item.slug = mon?.slug || item.slug;
      item.id = mon?.id != null ? String(mon.id) : item.id;
      if (item.moves.length < 4) {
        item.moves = fallbackAdviceMovesFor(item, mon, format, item.moves);
      }
      item.note = normalizeAdviceMemberNote(item, mon, format);
      const originalItem = item.item;
      const itemValue = allowed(item.item, pools.items, "items");
      const key = normalizedItemName(itemValue || usableConfigValue(item.item, "items"));
      const weakFit = mon && key && itemRoleScore(mon, item.item) <= 0 && recommendedItemsFor(mon, new Set(), 1)[0]?.score > 0;
      if (!itemValue || used.has(key) || weakFit) {
        const fallback = recommendedItemsFor(mon, used, 1)[0]?.name || ["气势披带", "心灵香草", "密探斗篷", "文柚果", "生命宝珠", "讲究围巾", "突击背心"].find((candidate) => !used.has(normalizedItemName(candidate))) || `可替换道具${index + 1}`;
        if (weakFit && originalItem && originalItem !== fallback) {
          item.note = appendUniqueNote(item.note, `道具已按当前环境常见配置从“${originalItem}”调整为“${fallback}”。`);
        }
        item.item = fallback;
        used.add(normalizedItemName(fallback));
      } else {
        item.item = itemValue;
        used.add(key);
      }
    });
  }
  return advice;
}

function renderFormatAdvice(title, format, block = {}) {
  const watch = Array.isArray(block.watch) ? block.watch.filter(Boolean).slice(0, 4) : [];
  const team = Array.isArray(block.team) ? block.team.slice(0, 6) : [];
  const active = (state.aiAdviceView || state.format) === format;
  const compact = isUiLevel("intermediate") && !isUiLevel("advanced");
  return `
    <section class="ai-format-card ${active ? "is-active" : ""}" ${active ? "" : "hidden"}>
      <div class="ai-format-head">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(compact ? (block.plan || "按当前队伍微调配置。").slice(0, 96) : block.plan || "按当前队伍微调配置。")}</p>
        </div>
        <button class="${active ? "btn-primary" : "btn-outline neutral"} compact" type="button" data-ai-apply="${format}">
          应用${escapeHtml(title)}
        </button>
      </div>
      ${watch.length && !compact ? `<div class="ai-tags">${watch.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
      ${isUiAtLeast("advanced") ? renderBattleEvalBlock(format) : ""}
      <div class="ai-team-grid ${compact ? "is-compact" : ""}">${team.map((item, index) => renderAdviceCard(item, index, format)).join("")}</div>
    </section>`;
}

function renderBeginnerAdviceTeam(format, team = []) {
  const members = Array.isArray(team) ? team.slice(0, 6) : [];
  if (!members.length) return "";
  return `
    <section class="ai-beginner-team" aria-label="推荐${escapeHtml(formatLabel(format))}队伍">
      <div class="ai-beginner-team-head">
        <strong>推荐${escapeHtml(formatLabel(format))}队伍</strong>
        <button class="btn-primary compact" type="button" data-ai-apply="${escapeHtml(format)}">使用这支队伍</button>
      </div>
      <div class="ai-beginner-team-grid">
        ${members
          .map((item, index) => {
            const mon = adviceLookupPokemon(item, format);
            const name = item.name || item.id || `成员 ${index + 1}`;
            const sprite = mon?.sprite || "";
            return `
              <article class="ai-beginner-member">
                ${sprite ? `<img src="${escapeHtml(sprite)}" alt="" aria-hidden="true">` : `<span class="ai-beginner-member-index">${index + 1}</span>`}
                <span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(item.role || "队伍成员")}</small></span>
              </article>`;
          })
          .join("")}
      </div>
    </section>`;
}

function renderAdviceCard(item = {}, index, format = state.format) {
  const moves = Array.isArray(item.moves) ? item.moves.filter(Boolean).slice(0, 4) : [];
  const meta = [
    item.item ? `道具：${item.item}` : "",
    item.ability ? `特性：${item.ability}` : "",
    item.nature ? `性格：${item.nature}` : "",
    item.evs ? `EV：${item.evs}` : "",
  ].filter(Boolean);
  return `
    <article class="ai-mon-card" data-ai-mon-format="${format}" data-ai-mon-index="${index}">
      <div class="ai-mon-head">
        <span>${index + 1}</span>
        <div>
          <h3>${escapeHtml(item.name || item.id || `Slot ${index + 1}`)}</h3>
          <p>${escapeHtml(item.role || "补位")}</p>
        </div>
      </div>
      ${meta.length ? `<div class="ai-mon-meta">${meta.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
      ${moves.length ? `<div class="ai-moves">${moves.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
      ${item.note ? `<p class="ai-note">${escapeHtml(item.note)}</p>` : ""}
      <div class="ai-card-actions">
        <button class="btn-outline neutral compact" type="button" data-ai-apply-one>只应用这只</button>
        <button class="btn-outline neutral compact" type="button" data-ai-replace-one>替换末位</button>
        <button class="btn-outline neutral compact" type="button" data-ai-copy-one>复制</button>
      </div>
    </article>`;
}

function adviceTeamText(team = []) {
  return team.map((item) => `${item.name || ""} ${item.role || ""} ${item.item || ""} ${item.ability || ""} ${(item.moves || []).join(" ")} ${item.note || ""}`).join(" ");
}

function weatherProfileForAdvice(team = [], block = {}) {
  const teamText = team.map(adviceMemberConfigText).join(" ");
  const goal = state.aiLastContext?.userGoal || "";
  const joined = `${goal} ${teamText} ${block.plan || ""} ${(block.watch || []).join(" ")}`;
  const textHas = (pattern) => pattern.test(joined);
  const wantsWeatherCounter = /反制|针对|克制|压制|处理|破坏|覆盖|抢|改|weather control/i.test(joined);
  const targetWeather = {
    sun: /(晴天|晴|日照|sun|drought)/i.test(goal),
    rain: /(雨天|雨|降雨|rain|drizzle)/i.test(goal),
    snow: /(雪天|雪|雪景|降雪|snow|snowscape|hail)/i.test(goal),
    sand: /(沙暴|沙|sand)/i.test(goal),
  };
  const countersTargetWeather = (weatherKey) => {
    if (!wantsWeatherCounter) return false;
    return Object.entries(targetWeather).some(([target, mentioned]) => mentioned && target !== weatherKey);
  };
  const weather = {
    sun: {
      setters: /喷火龙|煤炭龟|日照|drought/i.test(teamText),
      moves: /大晴天|晴天|sunny day/i.test(teamText),
      abusers: textHas(/喷火|热风|日光束|太阳之力|叶绿素|eruption|heat wave|solar beam|solar power|chlorophyll/i),
      counter: textHas(/反制.*晴|针对.*晴|克制.*晴|抢晴|改晴|覆盖晴|weather control/i) || (/(大晴天|晴天|sunny day)/i.test(teamText) && countersTargetWeather("sun")),
    },
    rain: {
      setters: /大嘴鸥|降雨|drizzle/i.test(teamText),
      moves: /求雨|雨天|rain dance/i.test(teamText),
      abusers: textHas(/打雷|暴风|悠游自如|水炮|波动冲|wave crash|thunder|hurricane|swift swim|hydro pump/i),
      counter: textHas(/反制.*雨|针对.*雨|克制.*雨|抢雨|改雨|覆盖雨|weather control/i) || (/(求雨|雨天|rain dance)/i.test(teamText) && countersTargetWeather("rain")),
    },
    snow: {
      setters: /降雪|snow warning/i.test(teamText),
      moves: /雪景|降雪|snowscape|hail/i.test(teamText),
      abusers: textHas(/暴风雪|拨雪|极光幕|blizzard|slush rush|aurora veil/i),
      counter: textHas(/反制.*雪|针对.*雪|克制.*雪|抢雪|改雪|覆盖雪|weather control/i) || (/(雪景|降雪|snowscape|hail)/i.test(teamText) && countersTargetWeather("snow")),
    },
    sand: {
      setters: /扬沙|sand stream|班基拉斯/i.test(teamText),
      moves: /沙暴|sandstorm/i.test(teamText),
      abusers: textHas(/拨沙|沙之力|sand rush|sand force/i),
      counter: textHas(/反制.*沙|针对.*沙|克制.*沙|抢沙|改沙|覆盖沙|weather control/i) || (/(沙暴|sandstorm)/i.test(teamText) && countersTargetWeather("sand")),
    },
  };
  const active = Object.entries(weather).filter(([, item]) => item.setters || item.moves);
  const abusers = Object.entries(weather).filter(([, item]) => item.abusers);
  const counters = Object.entries(weather).filter(([, item]) => item.moves && item.counter);
  return { weather, active, abusers, counters, joined, teamText };
}

function adviceLookupPokemon(item = {}, format = state.format) {
  return pokemonFromAdvice(item, format) || state.data?.pokemon?.find((entry) => [item.id, item.name, item.slug].filter(Boolean).some((value) => String(value).toLowerCase() === String(entry.id).toLowerCase() || String(value).toLowerCase() === String(entry.name).toLowerCase() || String(value).toLowerCase() === String(entry.slug).toLowerCase())) || null;
}

function adviceMemberText(item = {}) {
  return `${item.name || ""} ${item.role || ""} ${item.item || ""} ${item.ability || ""} ${(item.moves || []).join(" ")} ${item.note || ""}`;
}

function adviceMemberConfigText(item = {}) {
  return `${item.name || ""} ${item.id || ""} ${item.slug || ""} ${item.item || ""} ${item.ability || ""} ${(item.moves || []).join(" ")}`;
}

function adviceMemberActuallySetsTailwind(item = {}) {
  return /顺风|tailwind|おいかぜ/i.test(adviceMemberConfigText(item));
}

function adviceMemberActuallySetsTheme(item = {}, theme = "") {
  const config = adviceMemberConfigText(item);
  const species = `${item.name || ""} ${item.id || ""} ${item.slug || ""}`;
  if (theme === "rain") return /(降雨|あめふらし|\bdrizzle\b|求雨|雨乞い|あまごい|\brain[-\s]?dance\b)/i.test(config) || /大嘴鸥|pelipper|蚊香蛙皇|politoed|盖欧卡|kyogre/i.test(species);
  if (theme === "sun") return /(日照|ひでり|\bdrought\b|大晴天|晴天|にほんばれ|\bsunny[-\s]?day\b)/i.test(config) || /煤炭龟|torkoal|九尾|ninetales|固拉多|groudon/i.test(species);
  if (theme === "trick-room") return /(戏法空间|トリックルーム|\btrick[-\s]?room\b)/i.test(config);
  if (theme === "sand") return /(扬沙|すなおこし|\bsand[-\s]?stream\b|沙暴|すなあらし|\bsandstorm\b)/i.test(config) || /班基拉斯|tyranitar|河马兽|hippowdon|庞岩怪|gigalith/i.test(species);
  if (theme === "snow") return /(降雪|ゆきふらし|\bsnow[-\s]?warning\b|雪景|冰雹|あられ|ゆきげしき|\bsnowscape\b|\bhail\b)/i.test(config) || /九尾.*阿罗拉|阿罗拉.*九尾|ninetales.*alola|alolan.*ninetales|暴雪王|abomasnow/i.test(species);
  return false;
}

function adviceMemberMatchesGoalRef(item = {}, ref = {}) {
  const normalizeGoalKeys = (values = []) => values
    .flatMap((value) => [cnKey(value || "").toLowerCase(), idKey(value || "")])
    .filter(Boolean);
  const own = normalizeGoalKeys([item.id, item.slug, item.name, item.english, item.showdownName]);
  const keys = normalizeGoalKeys([ref.id, ref.slug, ref.name, ref.english, ref.showdownName]);
  return keys.length > 0 && own.some((key) => keys.includes(key));
}

function adviceSatisfiesRequiredMove(team = [], block = {}, required = {}) {
  const name = String(required.name || required.id || "").trim();
  if (!name) return true;
  if (/顺风|tailwind|おいかぜ/i.test(name)) return team.some(adviceMemberActuallySetsTailwind);
  if (/戏法空间|trick room/i.test(name)) return team.some((item) => adviceMemberActuallySetsTheme(item, "trick-room"));
  const pattern = /顺风|tailwind|おいかぜ/i.test(name)
    ? /顺风|tailwind|おいかぜ/i
    : new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return pattern.test(`${JSON.stringify(team || [])} ${block.plan || ""} ${(block.watch || []).join(" ")}`);
}

function adviceSatisfiesRequiredRole(team = [], block = {}, role = {}) {
  const label = String(role.name || role.id || role.label || "").trim();
  if (!label) return true;
  const normalized = `${label} ${localizeAdviceText(label)}`;
  if (/rain[-_\s]?source|rain[-_\s]?setter|雨天来源|雨天启动|降雨|求雨/i.test(normalized)) {
    return team.some((item) => adviceMemberActuallySetsTheme(item, "rain"));
  }
  if (/sun[-_\s]?source|sun[-_\s]?setter|晴天来源|晴天启动|日照|大晴天/i.test(normalized)) {
    return team.some((item) => adviceMemberActuallySetsTheme(item, "sun"));
  }
  if (/tailwind[-_\s]?setter|tailwind|顺风手|顺风控速|顺风启动/i.test(normalized)) {
    return team.some(adviceMemberActuallySetsTailwind);
  }
  if (/trick[-_\s]?room|space[-_\s]?setter|空间手|空间启动|戏法空间手/i.test(normalized)) {
    return team.some((item) => adviceMemberActuallySetsTheme(item, "trick-room"));
  }
  if (/sand[-_\s]?source|sand[-_\s]?setter|沙暴来源|沙暴启动|扬沙/i.test(normalized)) {
    return team.some((item) => adviceMemberActuallySetsTheme(item, "sand"));
  }
  if (/snow[-_\s]?source|snow[-_\s]?setter|雪天来源|雪天启动|降雪|雪景/i.test(normalized)) {
    return team.some((item) => adviceMemberActuallySetsTheme(item, "snow"));
  }
  const roleText = `${block.plan || ""} ${(block.watch || []).join(" ")} ${team.map((item) => `${item.role || ""} ${item.note || ""}`).join(" ")}`;
  return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(roleText);
}

function goalConstraintWarningsForAdvice(team = [], block = {}, format = "single", context = state.aiLastContext || {}) {
  const constraints = context.intent?.goalConstraints || context.goalConstraints || {};
  const warnings = [];
  const requiredPokemon = Array.isArray(constraints.requiredPokemon) ? constraints.requiredPokemon : [];
  for (const ref of requiredPokemon) {
    if (!team.some((item) => adviceMemberMatchesGoalRef(item, ref))) {
      warnings.push(`${formatLabel(format)}没有满足用户目标：最终阵容缺少指定核心 ${ref.name || ref.slug || ref.id}。`);
    }
  }
  const requiredMoves = Array.isArray(constraints.requiredMoves) ? constraints.requiredMoves : [];
  for (const move of requiredMoves) {
    if (!adviceSatisfiesRequiredMove(team, block, move)) {
      warnings.push(`${formatLabel(format)}没有满足用户目标：缺少要求的招式/机制 ${move.name || move.id}。`);
    }
  }
  if ((constraints.themes || []).includes("tailwind")) {
    const joined = `${block.plan || ""} ${(block.watch || []).join(" ")}`;
    if (!team.some(adviceMemberActuallySetsTailwind)) {
      warnings.push(`${formatLabel(format)}没有满足用户目标：这是顺风队请求，但结果没有顺风手和顺风展开说明。`);
    } else if (!/(开|启动|设置|控速|服务|收益|被挑衅|备用|tailwind)/i.test(joined)) {
      warnings.push(`${formatLabel(format)}顺风队说明不足：需要写清谁开顺风、谁吃顺风收益、顺风失败后的备用路线。`);
    }
  }
  if ((constraints.themes || []).includes("sun")) {
    if (!team.some((item) => adviceMemberActuallySetsTheme(item, "sun"))) {
      warnings.push(`${formatLabel(format)}没有满足用户目标：这是晴天队请求，但结果没有晴天来源和晴天收益说明。`);
    }
  }
  if ((constraints.themes || []).includes("rain")) {
    if (!team.some((item) => adviceMemberActuallySetsTheme(item, "rain"))) {
      warnings.push(`${formatLabel(format)}没有满足用户目标：这是雨天队请求，但结果没有雨天来源和雨天收益说明。`);
    }
  }
  if ((constraints.themes || []).includes("trick-room")) {
    if (!team.some((item) => adviceMemberActuallySetsTheme(item, "trick-room"))) {
      warnings.push(`${formatLabel(format)}没有满足用户目标：这是空间队请求，但结果没有戏法空间手和空间展开说明。`);
    }
  }
  if ((constraints.themes || []).includes("sand")) {
    if (!team.some((item) => adviceMemberActuallySetsTheme(item, "sand"))) {
      warnings.push(`${formatLabel(format)}没有满足用户目标：这是沙暴队请求，但结果没有沙暴来源和沙暴收益说明。`);
    }
  }
  if ((constraints.themes || []).includes("snow")) {
    if (!team.some((item) => adviceMemberActuallySetsTheme(item, "snow"))) {
      warnings.push(`${formatLabel(format)}没有满足用户目标：这是雪天队请求，但结果没有雪天来源和雪天收益说明。`);
    }
  }
  if ((constraints.themes || []).includes("tailwind") && requiredPokemon.some((ref) => /喷火龙|charizard/i.test(`${ref.name || ""} ${ref.slug || ""} ${ref.id || ""}`))) {
    if (team.some((item) => adviceMemberActuallySetsTheme(item, "rain")) && !/(雨天|降雨|rain|drizzle)/i.test(context.userGoal || "")) {
      warnings.push(`${formatLabel(format)}喷火龙顺风队混入了雨天轴：需要换成不抢天气的真实顺风手或明确说明双天气收益。`);
    }
  }
  for (const role of Array.isArray(constraints.requiredRoles) ? constraints.requiredRoles : []) {
    const label = role.name || role.id || "";
    if (label && !adviceSatisfiesRequiredRole(team, block, role)) {
      warnings.push(`${formatLabel(format)}没有说明用户要求的职责：${label}。`);
    }
  }
  return warnings;
}

function adviceHasPattern(team = [], pattern) {
  return team.some((item) => pattern.test(adviceMemberText(item)));
}

function adviceMegaMembers(team = []) {
  return team.filter((item) => isMegaStone(item.item) || /mega|超级|Mega 核心|Mega位|Mega 位/i.test(adviceMemberText(item)));
}

function adviceSynergyCount(team = [], block = {}, format = state.format, profile = null, metrics = null) {
  const text = `${adviceTeamText(team)} ${block.plan || ""} ${(block.watch || []).join(" ")}`;
  const checks = [
    /(急速折返|伏特替换|抛下狠话|接棒|转场|轮转|安全上场|带.*上场|u-turn|volt switch|parting shot|pivot).*(核心|输出|Mega|收割|打手)|(?:核心|输出|Mega|收割|打手).*(急速折返|伏特替换|抛下狠话|接棒|转场|轮转|安全上场|带.*上场|u-turn|volt switch|parting shot|pivot)/i.test(text),
    /(顺风|电磁波|戏法空间|冰冻之风|黏黏网|控速|tailwind|thunder wave|trick room|icy wind|sticky web).*(输出|打手|核心|收割|Mega)|(?:输出|打手|核心|收割|Mega).*(顺风|电磁波|戏法空间|冰冻之风|黏黏网|控速|tailwind|thunder wave|trick room|icy wind|sticky web)/i.test(text),
    Boolean(profile?.active?.some(([key, item]) => (item.setters || item.moves) && item.abusers)),
    /(威吓|击掌奇袭|击掌|看我嘛|愤怒粉|广域防守|掩护|守住|保护|intimidate|fake out|follow me|rage powder|wide guard|protect).*(输出|打手|核心|Mega)|(?:输出|打手|核心|Mega).*(威吓|击掌奇袭|击掌|看我嘛|愤怒粉|广域防守|掩护|守住|保护|intimidate|fake out|follow me|rage powder|wide guard|protect)/i.test(text),
    /(隐形岩|撒菱|毒菱|黏黏网|剧毒|鬼火|状态|削血|stealth rock|spikes|toxic spikes|sticky web|toxic|will-o-wisp).*(清场|收割|终盘|强化|sweep|clean|late-game)|(?:清场|收割|终盘|强化|sweep|clean|late-game).*(隐形岩|撒菱|毒菱|黏黏网|剧毒|鬼火|状态|削血|stealth rock|spikes|toxic spikes|sticky web|toxic|will-o-wisp)/i.test(text),
    /(抗性互补|联防|换入|中转|免疫|覆盖.*弱点|补.*弱点|resist|immune|switch-in|defensive core)/i.test(text),
    format === "double" && /(首发|开局|lead).*(\+|和|搭配|配合|组合)|(\+|和|搭配|配合|组合).*(首发|开局|lead)/i.test(text),
  ];
  if (metrics?.hasPivot && metrics?.hasWincon) checks.push(true);
  return checks.filter(Boolean).length;
}

function pranksterSupportCandidates() {
  return (state.aiLastContext?.metaCandidates || [])
    .filter((item) => Number(item.supportProfile?.score || item.supportBias || 0) > 0 && (item.supportProfile?.hasPrankster || /恶作剧之心|prankster/i.test(JSON.stringify(item))))
    .slice(0, 4);
}

function adviceMissingSlotWarnings(metrics, format = state.format) {
  const model = state.aiLastContext?.formatModels?.[format]?.slotModel || state.aiLastContext?.slotModel;
  if (model?.format && model.format !== format) return [];
  const missing = (model?.missingSlots || []).filter((slot) => Number(slot.priority || 0) >= 8);
  if (!missing.length) return [];
  const patterns = {
    "primary-core": /主轴|核心|主胜利|主要胜利|main core|primary/i,
    "secondary-core": /副轴|备用|第二路线|替代路线|secondary|backup/i,
    "mega-slot": /Mega|超进化|进化石|不硬凑|无需.*Mega|不选择.*Mega/i,
    "speed-control": /控速|顺风|戏法空间|电磁波|冰冻之风|黏黏网|先制|围巾|tailwind|trick room|thunder wave|icy wind|priority|scarf/i,
    "safe-entry": /安全上场|转场|轮转|换入|中转|击掌|掩护|守住|u-turn|volt switch|pivot|fake out|protect/i,
    "defensive-switch": /防守换入|联防|抗性|免疫|中转|抗住|resist|immune|switch-in/i,
    "lead-pair": /首发|开局|lead|pair|组合/i,
    protection: /保护|守住|击掌|威吓|掩护|看我嘛|愤怒粉|广域防守|protect|fake out|intimidate|follow me|rage powder|wide guard/i,
  };
  return missing
    .filter((slot) => patterns[slot.id] && !patterns[slot.id].test(metrics.joined))
    .slice(0, 3)
    .map((slot) => `${formatLabel(format)}高优先级槽位未明确覆盖：${slot.label}。`);
}

function adviceChainWarnings(metrics, format = state.format) {
  const model = state.aiLastContext?.formatModels?.[format]?.chainModel || state.aiLastContext?.chainModel;
  if (model?.format && model.format !== format) return [];
  const missingChains = (model?.missingChains || []).filter((chain) => Number(chain.priority || 0) >= 8);
  if (!missingChains.length) return [];
  return missingChains
    .filter((chain) => !(chain.keywords || []).some((keyword) => new RegExp(keyword, "i").test(metrics.joined)))
    .slice(0, 3)
    .map((chain) => `${formatLabel(format)}未明确覆盖高优先级联动链：${chain.label}；需要写清具体成员配合。`);
}

function adviceResourceWarnings(metrics, format = state.format) {
  const model = state.aiLastContext?.formatModels?.[format]?.resourceModel || state.aiLastContext?.resourceModel;
  if (model?.format && model.format !== format) return [];
  const patterns = {
    "no-safe-entry": /安全上场|转场|轮转|中转|换入|击掌|掩护|守住|u-turn|volt switch|pivot|fake out|protect/i,
    "slow-core-no-speed": /控速|顺风|戏法空间|电磁波|冰冻之风|先制|围巾|tailwind|trick room|thunder wave|icy wind|priority|scarf/i,
    "setup-no-cleaner": /终盘|收割|清场|围巾|先制|强化|cleaner|late-game/i,
    "no-defensive-switch": /防守换入|联防|抗性|免疫|抗住|中转|resist|immune|switch-in/i,
    "double-no-protection": /守住|保护|击掌|威吓|掩护|看我嘛|愤怒粉|广域防守|protect|fake out|intimidate|follow me|rage powder|wide guard/i,
    "spread-no-speed": /控速|顺风|戏法空间|冰冻之风|电磁波|tailwind|trick room|icy wind|thunder wave/i,
    "mixed-weather": /主天气|备用天气|切换|覆盖|抢天气|反制天气|双天气|weather control/i,
    "multi-mega-resource": /主.*Mega|Mega.*主|副.*Mega|备选.*Mega|二选一|对局|分支/i,
  };
  return (model?.risks || [])
    .filter((risk) => Number(risk.severity || 0) >= 8 && patterns[risk.id] && !patterns[risk.id].test(metrics.joined))
    .slice(0, 3)
    .map((risk) => `${formatLabel(format)}资源闭环风险未处理：${risk.label}。`);
}

function advicePhaseWarnings(metrics, format = state.format) {
  const model = state.aiLastContext?.formatModels?.[format]?.phaseModel || state.aiLastContext?.phaseModel;
  if (model?.format && model.format !== format) return [];
  const patterns = {
    opening: /开局|首发|起手|先.*节奏|lead|opening|turn 1/i,
    midgame: /中盘|轮转|消耗|站场|突破|换入|midgame|pivot/i,
    endgame: /终盘|残局|收割|清场|胜利路线|endgame|late-game|clean/i,
    "anti-lead": /反首发|反开局|对面首发|遇到.*首发|切换|保护|anti-lead/i,
  };
  const highPriority = (model?.missingPhases?.length ? model.missingPhases : model?.phases || []).filter((phase) => Number(phase.priority || 0) >= 8);
  return highPriority
    .filter((phase) => patterns[phase.id] && !patterns[phase.id].test(metrics.joined))
    .slice(0, 3)
    .map((phase) => `${formatLabel(format)}缺少对局阶段路线：${phase.label}。`);
}

function adviceBranchWarnings(metrics, format = state.format) {
  const model = state.aiLastContext?.formatModels?.[format]?.branchModel || state.aiLastContext?.branchModel;
  if (model?.format && model.format !== format) return [];
  const requiredBranches = (model?.missingBranches?.length ? model.missingBranches : model?.branches || []).filter((branch) => Number(branch.priority || 0) >= 10);
  if (!requiredBranches.length) return [];
  return requiredBranches
    .filter((branch) => !(branch.keywords || []).some((keyword) => new RegExp(keyword, "i").test(metrics.joined)))
    .slice(0, 3)
    .map((branch) => `${formatLabel(format)}缺少对局分支处理：${branch.label}。`);
}

function adviceSpeedValue(item = {}, format = state.format) {
  const mon = adviceLookupPokemon(item, format);
  const base = mon ? stat(mon, "速度") : Number(item.speed || item.baseSpeed || 0);
  const text = adviceMemberText(item);
  if (!base) return 0;
  if (/讲究围巾|choice scarf/i.test(text)) return Math.floor(base * 1.5);
  if (/悠游自如|叶绿素|拨沙|拨雪|轻装|加速|swift swim|chlorophyll|sand rush|slush rush|unburden|speed boost/i.test(text)) return base * 2;
  return base;
}

function adviceDefensiveSwitchCount(team = [], format = state.format) {
  const targetTypes = [
    ...new Set(
      (state.aiLastContext?.intent?.targetPokemon || [])
        .flatMap((profile) => profile.defenderTypes || profile.target?.types || [])
        .map((type) => TYPE_CN_TO_EN[type] || type)
        .filter(Boolean),
    ),
  ];
  if (!targetTypes.length) return 0;
  return team.filter((item) => {
    const mon = adviceLookupPokemon(item, format);
    const ownTypes = mon ? englishTypesFor(mon) : [];
    const text = adviceMemberText(item);
    return targetTypes.some((attackType) => ownTypes.length && typeEffectiveness(attackType, ownTypes) < 1) || /免疫|换入|抗住|中转|联防|resist|immune|switch/i.test(text);
  }).length;
}

function adviceExplanationMetrics(team = [], block = {}, format = state.format) {
  const text = `${adviceTeamText(team)} ${block.plan || ""} ${(block.watch || []).join(" ")}`;
  const noteText = team.map((item) => item.note || "").join(" ");
  const plan = block.plan || "";
  const mentionsSafeEntry = /(安全上场|带.*上场|转场|轮转|换入|中转|保护.*进场|pivot|switch-in|bring.*in)/i.test(text);
  const mentionsServiceTarget = /(控速.*(?:输出|打手|核心|Mega|收割)|(?:输出|打手|核心|Mega|收割).*控速|服务|帮助|掩护|保护.*(?:输出|核心|Mega)|support.*(?:sweeper|core)|enable)/i.test(text);
  const mentionsWeaknessCover = /(覆盖.*弱点|补.*弱点|抗性互补|联防|免疫|抗住|resist|immune|cover.*weakness)/i.test(text);
  const mentionsEndgame = /(终盘|残局|收割|清场|最后|endgame|late-game|clean|sweep)/i.test(text);
  const mentionsLeadPairs = format === "double" ? /(首发|开局|lead).*(\+|和|搭配|配合|组合|pair)|(\+|和|搭配|配合|组合|pair).*(首发|开局|lead)/i.test(text) : true;
  const mentionsAntiLead = format === "double" ? /(反首发|对面.*首发|遇到.*首发|切换|换下|protect|守住|反开局|anti-lead)/i.test(text) : true;
  const concreteNotes = team.filter((item) => {
    const note = String(item.note || "");
    return note.length >= 12 && /(负责|用来|帮助|覆盖|补|提供|保护|服务|压制|换入|收割|控速|撒场|反制|承担)/i.test(note);
  }).length;
  const weakNoteCount = team.filter((item) => String(item.note || "").length < 8 || /强力|很强|优秀|好用|泛用|核心成员|补位$/i.test(String(item.note || ""))).length;
  const actionablePlan = /(开局|中盘|终盘|先|再|然后|之后|保留|换入|逼退|lead|midgame|endgame|first|then)/i.test(plan);
  const missing = [];
  if (!mentionsSafeEntry) missing.push("谁让核心安全上场");
  if (!mentionsServiceTarget) missing.push("谁服务谁输出");
  if (!mentionsWeaknessCover) missing.push("谁覆盖谁弱点");
  if (!mentionsEndgame) missing.push("谁负责终盘");
  if (!mentionsLeadPairs) missing.push("双打首发组合");
  if (!mentionsAntiLead) missing.push("反首发切换");
  if (!actionablePlan) missing.push("开局-中盘-终盘行动链");
  if (concreteNotes < Math.min(4, team.length)) missing.push("成员 note 具体职责");
  return { missing, concreteNotes, weakNoteCount, actionablePlan };
}

function adviceStructureMetrics(team = [], block = {}, format = state.format) {
  const joined = `${adviceTeamText(team)} ${block.plan || ""} ${(block.watch || []).join(" ")}`;
  const configJoined = team.map(adviceMemberConfigText).join(" ");
  const speedValues = team.map((item) => adviceSpeedValue(item, format)).filter(Boolean);
  const speedBands = new Set(speedValues.map((value) => (value >= 130 ? "fast" : value >= 90 ? "mid" : "slow")));
  const hasSpeedControl = /(顺风|戏法空间|电磁波|冰冻之风|岩石封锁|黏黏网|tailwind|trick room|thunder wave|icy wind|rock tomb|sticky web)/i.test(configJoined);
  const hasPriority = /(神速|突袭|子弹拳|水流喷射|冰砾|影子偷袭|音速拳|击掌奇袭|extreme speed|sucker punch|bullet punch|aqua jet|ice shard|shadow sneak|mach punch|fake out)/i.test(joined);
  const hasPivot = /(急速折返|伏特替换|抛下狠话|接棒|轮转|转场|换入|中转|u-turn|volt switch|parting shot|baton pass|pivot)/i.test(joined);
  const hasSustain = /(自我再生|羽栖|偷懒|许愿|寄生种子|剩饭|文柚果|再生力|recover|roost|slack|wish|leech seed|leftovers|sitrus|regenerator)/i.test(joined);
  const hasHazard = /(隐形岩|撒菱|毒菱|黏黏网|stealth rock|spikes|toxic spikes|sticky web)/i.test(joined);
  const hasRemoval = /(清除浓雾|高速旋转|defog|rapid spin)/i.test(joined);
  const hasStatus = /(剧毒|鬼火|电磁波|哈欠|催眠|挑衅|toxic|will-o-wisp|thunder wave|yawn|spore|taunt)/i.test(joined);
  const hasWincon = /(清场|收割|终盘|强化|围巾|先制|剑舞|龙舞|诡计|冥想|sweep|clean|late-game|choice scarf|swords dance|dragon dance|nasty plot|calm mind)/i.test(joined);
  const protectCount = team.filter((item) => /(守住|看穿|protect|detect)/i.test(adviceMemberText(item))).length;
  const spreadCount = team.filter((item) => MOVE_PATTERNS.spread.test(adviceMemberText(item))).length;
  const defensiveSwitchCount = adviceDefensiveSwitchCount(team, format);
  const watch = Array.isArray(block.watch) ? block.watch.filter(Boolean) : [];
  const executableWatchCount = watch.filter((item) => /(先|再|然后|换入|抗住|逼退|收割|限制|保护|处理|交给|用.+?后|switch|then|revenge|protect|force)/i.test(String(item))).length;
  return {
    joined,
    speedBands,
    hasSpeedControl,
    hasPriority,
    hasPivot,
    hasSustain,
    hasHazard,
    hasRemoval,
    hasStatus,
    hasWincon,
    protectCount,
    spreadCount,
    defensiveSwitchCount,
    watchCount: watch.length,
    executableWatchCount,
    hasMainAndBackupAxis: /(主轴|副轴|备用|替代路线|第二路线|主胜利|main|backup|secondary)/i.test(`${block.plan || ""} ${team.map((item) => item.note || "").join(" ")}`),
  };
}

function evaluateAdviceStructure(advice) {
  const warnings = [];
  const style = state.aiLastContext?.intent?.teamStyle;
  const targetWarnings = state.aiLastContext?.intent?.targetPokemon?.flatMap((profile) => profile.counterWarnings || []) || [];
  const hasContraryTarget = targetWarnings.some((item) => item.ability === "唱反调");
  const formatScores = [];
  for (const format of ["single", "double"]) {
    let score = 100;
    const block = advice?.[format];
    const team = Array.isArray(block?.team) ? block.team : [];
    if (!team.length) continue;
    const joined = JSON.stringify(block || {});
    const profile = weatherProfileForAdvice(team, block);
    const metrics = adviceStructureMetrics(team, block, format);
    const explanation = adviceExplanationMetrics(team, block, format);
    const megaMembers = adviceMegaMembers(team);
    const megaCandidates = (state.aiLastContext?.metaCandidates || []).filter((item) => Number(item.megaBias || 0) > 0 || item.megaSlotCandidate);
    const megaPlan = state.aiLastContext?.megaPlan || state.aiLastContext?.intent?.megaPlan || null;
    const userGoal = `${state.aiLastContext?.userGoal || ""} ${state.aiLastContext?.intent?.teamStyle?.name || ""}`;
    const explicitMegaRequest = /mega|超级|超进化|进化石/i.test(userGoal);
    const primaryMegaName = megaPlan?.primary?.name || "";
    const secondaryMegaName = megaPlan?.secondary?.name || "";
    const synergyCount = adviceSynergyCount(team, block, format, profile, metrics);
    const hasPranksterSupport = /恶作剧之心|いたずらごころ|prankster/i.test(metrics.joined);
    const pranksterCandidates = pranksterSupportCandidates();
    const weatherNames = { sun: "晴天", rain: "雨天", snow: "雪天", sand: "沙暴" };
    const goalWarnings = goalConstraintWarningsForAdvice(team, block, format, state.aiLastContext || {});
    if (goalWarnings.length) {
      warnings.push(...goalWarnings);
      score -= Math.min(45, goalWarnings.length * 18);
    }
    const missingSlotWarnings = adviceMissingSlotWarnings(metrics, format);
    if (missingSlotWarnings.length) {
      warnings.push(...missingSlotWarnings);
      score -= Math.min(12, missingSlotWarnings.length * 4);
    }
    const chainWarnings = adviceChainWarnings(metrics, format);
    if (chainWarnings.length) {
      warnings.push(...chainWarnings);
      score -= Math.min(14, chainWarnings.length * 5);
    }
    const resourceWarnings = adviceResourceWarnings(metrics, format);
    if (resourceWarnings.length) {
      warnings.push(...resourceWarnings);
      score -= Math.min(14, resourceWarnings.length * 5);
    }
    const phaseWarnings = advicePhaseWarnings(metrics, format);
    if (phaseWarnings.length) {
      warnings.push(...phaseWarnings);
      score -= Math.min(14, phaseWarnings.length * 5);
    }
    const branchWarnings = adviceBranchWarnings(metrics, format);
    if (branchWarnings.length) {
      warnings.push(...branchWarnings);
      score -= Math.min(14, branchWarnings.length * 5);
    }
    if (megaMembers.length > 2) {
      warnings.push(`${formatLabel(format)}Mega 位过多：${megaMembers.map((item) => item.name || item.id).join("、")} 都像在占 Mega 资源，通常最多保留 2 个主副分支。`);
      score -= 18;
    } else if (explicitMegaRequest && megaPlan?.recommendation === "prefer-mega" && primaryMegaName && !new RegExp(primaryMegaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(metrics.joined) && !/(不选.*Mega|放弃.*Mega|不硬凑|改由|无需.*Mega)/i.test(metrics.joined)) {
      warnings.push(`${formatLabel(format)}Mega 规划建议主 Mega 为 ${primaryMegaName}，但结果没有选择或解释替代理由。`);
      score -= 8;
    } else if (secondaryMegaName && new RegExp(secondaryMegaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(metrics.joined) && !/(备选|副|分支|二选一|对局|matchup)/i.test(metrics.joined)) {
      warnings.push(`${formatLabel(format)}使用了备选 Mega ${secondaryMegaName}，但没有说明它作为对局分支的条件。`);
      score -= 6;
    } else if (megaMembers.length === 2 && !/(主.*Mega|Mega.*主|副.*Mega|备选.*Mega|分支|二选一|对局|matchup)/i.test(metrics.joined)) {
      warnings.push(`${formatLabel(format)}有 2 个 Mega 候选，但没有说明主 Mega、备选 Mega 和各自适用对局。`);
      score -= 10;
    } else if (megaMembers.length === 1 && !/(安全上场|带.*上场|转场|覆盖.*弱点|补.*弱点|保护.*Mega|Mega.*保护|support.*Mega|pivot.*Mega)/i.test(metrics.joined)) {
      warnings.push(`${formatLabel(format)}选择了 Mega 位，但没有说明谁帮它安全进场、谁覆盖弱点。`);
      score -= 8;
    } else if (explicitMegaRequest && !megaMembers.length && megaCandidates.length && !/(不硬凑|不选择.*Mega|无需.*Mega|没有合理 Mega|不值得.*Mega)/i.test(metrics.joined)) {
      warnings.push(`${formatLabel(format)}候选池里有可用 Mega，但结果没有 Mega 位；若不选 Mega，需要说明不硬凑的理由。`);
      score -= 6;
    }
    if (synergyCount < 2) {
      warnings.push(`${formatLabel(format)}队友联动少于 2 组；需要明确谁给谁上场、控速服务谁、谁覆盖弱点或铺垫收割。`);
      score -= 12;
    }
    if (!hasPranksterSupport && pranksterCandidates.length && (!metrics.hasSpeedControl || !metrics.hasStatus)) {
      const labels = pranksterCandidates
        .map((item) => `${item.name}${item.supportProfile?.tags?.length ? `(${item.supportProfile.tags.filter((tag) => tag !== "prankster").join("/")})` : ""}`)
        .filter(Boolean)
        .join("、");
      warnings.push(`${formatLabel(format)}缺少控速/干扰时可考虑恶作剧之心辅助手：${labels}。`);
      score -= 5;
    }
    if (explanation.missing.length) {
      warnings.push(`${formatLabel(format)}解释不够可执行：缺少${explanation.missing.slice(0, 4).join("、")}。`);
      score -= Math.min(16, explanation.missing.length * 3);
    }
    if (explanation.weakNoteCount >= 3) {
      warnings.push(`${formatLabel(format)}多个成员 note 过于泛泛，需要写清具体职责而不是强度评价。`);
      score -= 6;
    }
    const activeNonCounter = profile.active.filter(([key, item]) => !item.counter);
    if (activeNonCounter.length > 1) {
      const hasSwitchPlan = /双天气|切换|覆盖|抢天气|反制天气|weather control/.test(profile.joined);
      const hasEachAbuser = activeNonCounter.every(([key]) => profile.weather[key].abusers || profile.weather[key].counter);
      if (!hasSwitchPlan || !hasEachAbuser) {
        warnings.push(`${formatLabel(format)}存在 ${activeNonCounter.map(([key]) => weatherNames[key]).join(" + ")} 多天气，但没有清晰切换/反制说明或对应收益点。`);
        score -= 16;
      }
    }
    if ((profile.weather.rain.setters || profile.weather.rain.moves) && profile.weather.sun.abusers && !profile.weather.sun.counter) {
      warnings.push(`${formatLabel(format)}雨天会削弱喷火/热风/日光束一类晴天收益，轴心冲突。`);
      score -= 12;
    }
    if ((profile.weather.sun.setters || profile.weather.sun.moves) && profile.weather.rain.abusers && !profile.weather.rain.counter) {
      warnings.push(`${formatLabel(format)}晴天会让打雷/暴风等雨天收益不稳定，轴心冲突。`);
      score -= 12;
    }
    const hasTorkoal = team.some((item) => /煤炭龟|torkoal/i.test(`${item.name || ""} ${item.id || ""} ${item.slug || ""}`));
    const wantsTrickRoom = /空间队|戏法空间|trick\s*room/i.test(userGoal);
    const claimsTrickRoom = /戏法空间|空间手|空间轴|空间核心|空间启动|空间收益|开空间|trick\s*room/i.test(joined);
    const hasTrickRoomSetter = team.some((item) => /戏法空间|空间手|trick\s*room/i.test(`${item.role || ""} ${item.note || ""} ${(item.moves || []).join(" ")}`));
    if ((wantsTrickRoom || claimsTrickRoom) && /低速|空间|喷火|煤炭龟|torkoal|eruption/i.test(joined) && !hasTrickRoomSetter) {
      warnings.push(`${formatLabel(format)}结果使用低速/空间思路但没有戏法空间手；需要补空间手，或把煤炭龟改成非空间晴天炮台。`);
      score -= 18;
    }
    const hasEarthquake = team.some((item) => (item.moves || []).some((move) => /地震|earthquake/i.test(String(move))));
    const groundSafeCount = team.filter((item) => /飞行|漂浮|守住|protect|levitate/i.test(`${item.name || ""} ${item.ability || ""} ${(item.moves || []).join(" ")}`)).length;
    if (format === "double" && hasEarthquake && groundSafeCount < 3) {
      warnings.push("双打里携带地震但队友地面免疫/守住配合不足，容易打到自己人。");
      score -= 8;
    }
    if (metrics.speedBands.size < 2 && !metrics.hasSpeedControl && !metrics.hasPriority) {
      warnings.push(`${formatLabel(format)}速度层级过单一，且没有稳定控速/先制；容易被高速队或控速队压制。`);
      score -= 12;
    }
    if (!metrics.hasPivot && !metrics.hasSustain && format === "single") {
      warnings.push("单打缺少安全轮换/多次进场方式；核心可能只能硬换上场。");
      score -= 10;
    }
    if (format === "single" && !((metrics.hasHazard && metrics.hasWincon) || metrics.hasRemoval || metrics.hasPivot || metrics.hasStatus)) {
      warnings.push("单打资源闭环不足：撒场/清场、状态、转场或终盘火力没有形成明确配合。");
      score -= 10;
    }
    if (format === "double" && metrics.protectCount < 3 && !metrics.hasPriority && !metrics.hasSpeedControl) {
      warnings.push("双打守住覆盖和节奏保护不足；若没有击掌/控速/掩护，首回合容易被集火拆开。");
      score -= 10;
    }
    if (format === "double" && !/(首发|开局|lead|starter)/i.test(`${block.plan || ""} ${(block.watch || []).join(" ")}`)) {
      warnings.push("双打 plan 没有给出明确首发组合和反首发切换。");
      score -= 8;
    }
    if (!metrics.hasMainAndBackupAxis) {
      warnings.push(`${formatLabel(format)}没有明确主轴/副轴；需要说明主胜利路线以及被针对时的替代路线。`);
      score -= 8;
    }
    if (state.aiLastContext?.intent?.targetPokemon?.length && metrics.defensiveSwitchCount < 1 && !/(换入|抗住|免疫|逼退|revenge|收割)/i.test(metrics.joined)) {
      warnings.push(`${formatLabel(format)}针对目标只有进攻答案，没有明确进场答案；需要说明谁能换入、逼退或 revenge kill。`);
      score -= 12;
    }
    if (metrics.watchCount < 3) {
      warnings.push(`${formatLabel(format)}watch 少于 3 条，缺少主要威胁、应对成员和处理顺序。`);
      score -= 8;
    } else if (metrics.executableWatchCount < Math.min(2, metrics.watchCount)) {
      warnings.push(`${formatLabel(format)}watch 处理方式不够具体，不能只写“怕某某”，需要写先后处理顺序。`);
      score -= 6;
    }
    const defensiveTools = /(自我再生|羽栖|偷懒|许愿|寄生种子|守住|剧毒|鬼火|隐形岩|撒菱|清除浓雾|高速旋转|急速折返|伏特替换|recover|roost|slack|wish|leech seed|protect|toxic|will-o-wisp|stealth rock|spikes|defog|rapid spin|u-turn|volt switch)/i;
    const defensiveToolCount = team.reduce((count, item) => count + (defensiveTools.test(`${item.role || ""} ${(item.moves || []).join(" ")} ${item.note || ""}`) ? 1 : 0), 0);
    if (style?.id === "stall" && defensiveToolCount < 4) {
      warnings.push(`${formatLabel(format)}不像受队：回复、状态、撒场、除钉、转场等消耗工具数量不足。`);
      score -= 14;
    }
    if (hasContraryTarget && /(威吓|抛下狠话|鬼面|岩石封锁|冰冻之风|大声咆哮|降低攻击|降低速度|降低能力|intimidate|parting shot|rock tomb|icy wind|snarl)/i.test(joined) && !/(不要|避免|不能|风险|会反向|反而|禁用|不要把|not use|avoid)/i.test(joined)) {
      warnings.push(`${formatLabel(format)}目标存在唱反调风险，但结果仍把威吓/降能力手段写成对策；这会反向强化目标。`);
      score -= 20;
    }
    formatScores.push(Math.max(0, Math.min(100, score)));
  }
  const averageScore = formatScores.length
    ? formatScores.reduce((sum, value) => sum + value, 0) / formatScores.length
    : 0;
  return { score: Math.round(averageScore), warnings: [...new Set(warnings)] };
}

function understandingResponseWarnings(advice, understanding = state.aiLastContext?.understanding || state.aiLastContext?.intent?.understanding) {
  if (!advice || !understanding?.summary) return [];
  const warnings = [];
  for (const format of ["single", "double"]) {
    const block = advice?.[format];
    if (!block) continue;
    const summary = understanding.summary?.[format];
    if (!summary) continue;
    const text = JSON.stringify(block);
    const mustFix = (summary.mustFix || []).filter(Boolean).slice(0, 4);
    const conflicts = (summary.conflicts || []).filter(Boolean).slice(0, 4);
    const missing = (summary.missing || []).filter(Boolean).slice(0, 5);
    const mentioned = (label) => {
      const core = String(label || "").split(":").pop();
      const compact = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return compact && new RegExp(compact, "i").test(text);
    };
    const unresolvedMustFix = mustFix.filter((item) => !mentioned(item));
    if (unresolvedMustFix.length) warnings.push(`${formatLabel(format)}没有回应理解层 mustFix：${unresolvedMustFix.slice(0, 2).join("、")}。`);
    const unresolvedConflicts = conflicts.filter((item) => !mentioned(item) && !/(缓解|避免|处理|修复|覆盖|替代|不硬凑|切换|分支)/i.test(text));
    if (unresolvedConflicts.length) warnings.push(`${formatLabel(format)}没有处理理解层资源冲突：${unresolvedConflicts.slice(0, 2).join("、")}。`);
    const missingSignals = missing.filter((item) => !mentioned(item));
    if (missingSignals.length >= 3) warnings.push(`${formatLabel(format)}缺少对理解层 missing 的明确补位说明：${missingSignals.slice(0, 3).join("、")}。`);
  }
  return [...new Set(warnings)];
}

function evaluateTeamAdvice(advice, context = state.aiLastContext || {}) {
  const base = evaluateAdviceStructure(advice);
  const understandingWarnings = understandingResponseWarnings(advice, context.understanding || context.intent?.understanding);
  const score = Math.max(0, base.score - Math.min(16, understandingWarnings.length * 5));
  return {
    score: Math.round(score),
    warnings: [...new Set([...base.warnings, ...understandingWarnings])],
    baseScore: base.score,
    understandingWarnings,
  };
}

function adviceStyleWarnings(advice) {
  const style = state.aiLastContext?.intent?.teamStyle;
  if (!advice) return [];
  const text = JSON.stringify(advice);
  const warnings = [...evaluateTeamAdvice(advice).warnings];
  if (style?.id === "stall" && /喷火龙|大嘴鸥|晴天|雨天|天气|日照|降雨|sunny|rain|drought|drizzle/i.test(text)) {
    warnings.push("当前目标是受队/耐久消耗，但结果里出现明显天气进攻轴；建议重新生成。");
  }
  if (state.aiLastContext?.intent?.rebuildFromGoal && /基于当前6只|当前6只|保留当前|已选宝可梦/.test(text)) {
    warnings.push("当前请求是重新构筑新队伍，但结果仍像是在沿用页面当前队伍；建议重新生成。");
  }
  return [...new Set(warnings)];
}

function shouldAutoCorrectAdvice(advice, structure) {
  if (!advice || !structure) return false;
  if (structure.score < 72) return true;
  const hardPatterns = /(没有满足用户目标|顺风队说明不足|Mega|槽位|高优先级|联动链|资源闭环|阶段路线|对局分支|缺少稳定控速|没有明确进场答案|空间思路但没有戏法空间手|唱反调|队友联动少于|受队|重新构筑新队伍)/;
  return structure.score < 84 && (structure.warnings || []).some((warning) => hardPatterns.test(warning));
}

function correctionPayloadForAdvice(advice, structure) {
  const teamNames = (format) => (advice?.[format]?.team || []).map((item) => item.name || item.id || item.slug).filter(Boolean).slice(0, 6);
  const understanding = state.aiLastContext?.understanding || state.aiLastContext?.intent?.understanding || null;
  const lowScore = Number(structure?.score || 0) < 72;
  return {
    attempt: 1,
    score: structure?.score || 0,
    warnings: (structure?.warnings || []).slice(0, 8),
    understandingWarnings: (structure?.understandingWarnings || []).slice(0, 6),
    understandingSummary: understanding?.summary || null,
    previousSummary: advice?.summary || "",
    previousTeams: {
      single: teamNames("single"),
      double: teamNames("double"),
    },
    instruction: lowScore
      ? "这是低分自动修正请求。上一版结构不合格，禁止原样重复 previousTeams 中的 6 只；至少替换 2 个成员或改成明确不同的主轴，并必须修复 warnings 中的行动链、Mega、速度、watch 问题。仍然只返回最终 JSON。"
      : "这是自动修正请求。可以保留合理成员，但必须优先修复 warnings 中的结构问题；如果成员导致问题，直接替换。仍然只返回最终 JSON。",
  };
}

function failureMemoryKey(context = state.aiLastContext || {}) {
  return [context.buildIntent || "auto", context.intent?.teamStyle?.id || "general", context.intent?.teamTemplate?.id || "", context.intent?.counterTargetMode ? "counter" : "", context.intent?.rebuildFromGoal ? "rebuild" : ""].filter(Boolean).join("|");
}

function loadFailureMemory() {
  try {
    return JSON.parse(localStorage.getItem(AI_FAILURE_MEMORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveFailureMemory(items = []) {
  localStorage.setItem(AI_FAILURE_MEMORY_KEY, JSON.stringify(items.slice(0, 24)));
}

function loadBattleHistory() {
  try {
    return JSON.parse(localStorage.getItem(AI_BATTLE_HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveBattleHistory(items = []) {
  localStorage.setItem(AI_BATTLE_HISTORY_KEY, JSON.stringify(items.slice(0, 36)));
}

async function hydrateBattleHistory() {
  try {
    const res = await fetch(aiApiUrl("/api/battle-history"), { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(data.items)) saveBattleHistory(data.items);
  } catch {
    // Browser localStorage remains the offline fallback.
  }
}

function syncBattleHistoryToServer(entry) {
  fetch(aiApiUrl("/api/battle-history"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry }),
  }).catch(() => {});
}

function battleHistoryKey(context = state.aiLastContext || {}) {
  return failureMemoryKey(context);
}

function teamSignatureFromAdvice(advice, format) {
  return (advice?.[format]?.team || [])
    .map((item) => item.name || item.id || item.slug)
    .filter(Boolean)
    .slice(0, 6)
    .join(" / ");
}

function summarizeBattleEval(data = {}) {
  const results = Array.isArray(data.results) ? data.results : [];
  const failureReasons = [...new Set(results.flatMap((item) => item.failureReasons || []).filter(Boolean))].slice(0, 5);
  const actionTags = {};
  for (const item of results) {
    for (const [tag, count] of Object.entries(item.actions?.tags || {})) {
      actionTags[tag] = (actionTags[tag] || 0) + Number(count || 0);
    }
  }
  const badOpponents = results
    .filter((item) => item.result === "loss" || item.result === "tie" || item.result === "skipped")
    .map((item) => ({
      title: cleanBattleTitle(item.opponentTitle, "固定靶队"),
      result: item.result,
      turns: item.turns || 0,
      reasons: (item.failureReasons || []).slice(0, 2),
    }))
    .slice(0, 5);
  return {
    games: data.games || 0,
    wins: data.wins || 0,
    losses: data.losses || 0,
    ties: data.ties || 0,
    winRate: data.winRate || 0,
    failureReasons,
    actionTags,
    badOpponents,
  };
}

function cleanBattleTitle(value = "", fallback = "固定靶队") {
  const text = localizeAdviceText(String(value || "").trim());
  if (!text || /[\u3040-\u30ff]/.test(text)) return fallback;
  return text;
}

function compactBattleReviewResult(item = {}, index = 0) {
  const fallbackTrace = [
    `模拟摘要：${item.result || "未知"}，${item.turns || 0} 回合，胜者 ${item.winner || "未定"}`,
    `行动统计：招式 ${item.actions?.moves || 0} 次，换人 ${item.actions?.switches || 0} 次，队伍预览 ${item.actions?.teamPreview || 0} 次。`,
    ...(Array.isArray(item.failureReasons) ? item.failureReasons.slice(0, 3).map((reason) => `风险提示：${reason}`) : []),
  ];
  return {
    id: `${item.opponentId || item.opponentTitle || "battle"}-${item.game || index + 1}`,
    title: cleanBattleTitle(item.opponentTitle, `固定靶队 ${index + 1}`),
    result: item.result || "tie",
    turns: item.turns || 0,
    winner: item.winner || "",
    trace: Array.isArray(item.actions?.trace) && item.actions.trace.length ? item.actions.trace.slice(0, 180) : fallbackTrace,
    errors: Array.isArray(item.actions?.errors) ? item.actions.errors.slice(0, 8) : [],
    failureReasons: Array.isArray(item.failureReasons) ? item.failureReasons.slice(0, 6) : [],
    actions: {
      moves: Number(item.actions?.moves || 0),
      switches: Number(item.actions?.switches || 0),
      teamPreview: Number(item.actions?.teamPreview || 0),
      tags: item.actions?.tags || {},
    },
  };
}

function battleReviewResults(format = state.aiAdviceView || state.format) {
  const record = state.aiBattleEval?.[format];
  const results = Array.isArray(record?.data?.results) ? record.data.results : [];
  return results.filter((item) => item && ["win", "loss", "tie", "skipped"].includes(item.result));
}

function battleHistoryReviewEntries(context = {}) {
  return loadBattleHistory()
    .filter((item) => item && (!context.format || item.format === context.format))
    .flatMap((item, index) => {
      const compactResults = Array.isArray(item.results) ? item.results.filter(Boolean) : [];
      if (compactResults.length) {
        return compactResults.map((result, resultIndex) => ({
          id: result.id || `${item.id || item.key || "battle"}-${resultIndex}`,
          format: item.format || "single",
          title: `${cleanBattleTitle(item.teamSignature || item.userGoal, "历史对局")} · ${cleanBattleTitle(result.title, `固定靶队 ${resultIndex + 1}`)}`,
          result: result.result || "tie",
          turns: result.turns || 0,
          winner: result.winner || "",
          trace: Array.isArray(result.trace) ? result.trace.slice(0, 180) : [],
          errors: Array.isArray(result.errors) ? result.errors.slice(0, 8) : [],
          actions: result.actions || {},
          failureReasons: Array.isArray(result.failureReasons) ? result.failureReasons.slice(0, 6) : [],
          note: result.trace?.length ? "" : "旧历史只保存了汇总，没有过程日志；重新跑一次本地模拟即可补全。",
          score: result.result === "win" ? 1 : result.result === "tie" ? 0.5 : 0,
          summary: `${item.wins || 0}-${item.losses || 0}-${item.ties || 0}`,
        }));
      }
      return [{
        id: item.id || `${item.key || "battle"}-${item.updatedAt || index}`,
        format: item.format || "single",
        title: item.teamSignature || item.userGoal || "历史对局",
        result: item.winRate === 100 ? "win" : item.winRate === 0 ? "loss" : "tie",
        turns: item.turns || item.games || 0,
        winner: item.winner || "",
        trace: Array.isArray(item.trace) ? item.trace.slice(0, 180) : [],
        errors: Array.isArray(item.errors) ? item.errors.slice(0, 8) : [],
        actions: item.actions || {},
        failureReasons: Array.isArray(item.failureReasons) ? item.failureReasons.slice(0, 6) : [],
        note: item.badOpponents?.length ? item.badOpponents.map((opponent) => `${opponent.title}:${opponent.result}`).join("；") : "旧历史只保存了汇总，没有过程日志；重新跑一次本地模拟即可补全。",
        score: Number(item.winRate || 0) / 100,
        summary: `${item.wins || 0}-${item.losses || 0}-${item.ties || 0}`,
      }];
    });
}

function battleReviewEntries(format = state.aiAdviceView || state.format) {
  const live = battleReviewResults(format).map((item, index) => ({
    id: `${item.opponentId || item.opponentTitle || "battle"}-${item.game || index + 1}`,
    format,
    title: `${cleanBattleTitle(item.opponentTitle, `固定靶队 ${index + 1}`)}${item.sideLabel ? ` · ${item.sideLabel}` : ""}`,
    result: item.result,
    turns: item.turns || 0,
    winner: item.winner || "",
    trace: Array.isArray(item.actions?.trace) && item.actions.trace.length
      ? item.actions.trace.slice(0, 140)
      : [
          `模拟摘要：${item.result || "未知"}，${item.turns || 0} 回合，胜者 ${item.winner || "未定"}`,
          `行动统计：招式 ${item.actions?.moves || 0} 次，换人 ${item.actions?.switches || 0} 次，队伍预览 ${item.actions?.teamPreview || 0} 次。`,
          ...(Array.isArray(item.failureReasons) ? item.failureReasons.slice(0, 3).map((reason) => `风险提示：${reason}`) : []),
        ],
    errors: Array.isArray(item.actions?.errors) ? item.actions.errors.slice(0, 8) : [],
    actions: item.actions || {},
    failureReasons: Array.isArray(item.failureReasons) ? item.failureReasons.slice(0, 6) : [],
    note: item.result === "skipped" ? (item.failureReasons || []).join("；") : "",
    score: item.result === "win" ? 1 : item.result === "tie" ? 0.5 : 0,
  }));
  const historical = battleHistoryReviewEntries({ format });
  const combined = [...live, ...historical].filter(Boolean);
  const seen = new Set();
  return combined.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function currentBattleReviewEntry() {
  const format = state.battleReviewFormat || state.aiAdviceView || state.format;
  const entries = battleReviewEntries(format);
  if (!entries.length) return null;
  if (state.battleReviewEntry) {
    const found = entries.find((entry) => entry.id === state.battleReviewEntry.id);
    if (found) return found;
  }
  return entries[0];
}

function renderBattleReviewEntry(entry) {
  const resultLabel = (result) => {
    if (result === "win") return "胜";
    if (result === "loss") return "负";
    if (result === "tie") return "平";
    if (result === "skipped") return "跳过";
    return "未知";
  };
  const trace = Array.isArray(entry?.trace) ? entry.trace : [];
  return `
    <div class="battle-review-details">
      <div class="battle-review-summary">
        <strong>${escapeHtml(entry?.title || "历史对局")}</strong>
        <span>${escapeHtml(resultLabel(entry?.result))} · ${escapeHtml(String(entry?.turns || 0))} 回合${entry?.winner ? ` · 胜者 ${escapeHtml(entry.winner)}` : ""}${entry?.summary ? ` · ${escapeHtml(entry.summary)}` : ""}</span>
      </div>
      ${entry?.note ? `<div class="ai-tags warning"><span>${escapeHtml(entry.note)}</span></div>` : ""}
      ${entry?.failureReasons?.length ? `<div class="ai-tags warning">${entry.failureReasons.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
      ${entry?.errors?.length ? `<div class="battle-review-errors">${entry.errors.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</div>` : ""}
      ${trace.length ? `<ol class="battle-review-trace">${trace.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : `<p class="empty">没有记录到过程日志。</p>`}
    </div>`;
}

function rememberBattleEvaluation(format, data, advice = state.aiLastAdvice, context = state.aiLastContext || {}) {
  if (!data?.games) return;
  const summary = summarizeBattleEval(data);
  const entry = {
    key: battleHistoryKey(context),
    format,
    buildIntent: context.buildIntent || "",
    teamStyle: context.intent?.teamStyle?.name || "",
    userGoal: context.userGoal || "",
    teamSignature: teamSignatureFromAdvice(advice, format),
    ...summary,
    results: Array.isArray(data.results) ? data.results.map((item, index) => compactBattleReviewResult(item, index)) : [],
    updatedAt: new Date().toISOString(),
  };
  const existing = loadBattleHistory();
  const same = (item) => item.key === entry.key && item.format === entry.format && item.teamSignature === entry.teamSignature;
  const next = [entry, ...existing.filter((item) => !same(item))].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  saveBattleHistory(next);
  syncBattleHistoryToServer(entry);
}

function relevantBattleHistory(context = {}) {
  const key = battleHistoryKey(context);
  return loadBattleHistory()
    .filter((item) => item.key === key || item.teamStyle === context.intent?.teamStyle?.name || (context.intent?.rebuildFromGoal && item.buildIntent === context.buildIntent))
    .sort((a, b) => (a.winRate || 0) - (b.winRate || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 6)
    .map((item) => ({
      format: item.format,
      winRate: item.winRate,
      record: `${item.wins || 0}-${item.losses || 0}-${item.ties || 0}`,
      team: item.teamSignature,
      avoid: (item.failureReasons || []).slice(0, 3).join("；"),
      actionTags: Object.entries(item.actionTags || {}).map(([tag, count]) => `${tag}:${count}`).slice(0, 6).join("；"),
      badOpponents: (item.badOpponents || []).slice(0, 3).map((opponent) => `${opponent.title}:${opponent.result}`).join("；"),
      count: item.games || 0,
    }));
}

function recentTeamSignaturesForAvoidance(context = {}, limit = 8) {
  const key = battleHistoryKey(context);
  const goalKey = cnKey(context.userGoal || "");
  return loadBattleHistory()
    .filter((item) => item.teamSignature)
    .filter((item) => {
      if (item.key === key || item.teamStyle === context.intent?.teamStyle?.name || item.buildIntent === context.buildIntent) return true;
      return goalKey && cnKey(item.userGoal || "") === goalKey;
    })
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .map((item) => item.teamSignature)
    .filter(Boolean)
    .slice(0, limit);
}

function rememberAdviceFailure(advice, structure, context = state.aiLastContext || {}) {
  const warnings = (structure?.warnings || []).filter(Boolean).slice(0, 8);
  if (!warnings.length || Number(structure?.score || 100) >= 88) return;
  const key = failureMemoryKey(context);
  const existing = loadFailureMemory();
  const signature = warnings.slice(0, 3).join("|");
  const found = existing.find((item) => item.key === key && item.signature === signature);
  const entry = {
    key,
    signature,
    score: structure.score,
    warnings,
    userGoal: context.userGoal || "",
    format: context.format,
    teamStyle: context.intent?.teamStyle?.name || "",
    buildIntent: context.buildIntent || "",
    count: (found?.count || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  const next = [entry, ...existing.filter((item) => !(item.key === key && item.signature === signature))].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  saveFailureMemory(next);
}

function relevantFailureMemory(context = {}) {
  const key = failureMemoryKey(context);
  return loadFailureMemory()
    .filter((item) => item.key === key || item.teamStyle === context.intent?.teamStyle?.name || (context.intent?.rebuildFromGoal && item.buildIntent === context.buildIntent))
    .sort((a, b) => (b.count || 0) - (a.count || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 5)
    .map((item) => ({
      score: item.score,
      count: item.count || 1,
      warnings: item.warnings.slice(0, 5),
      avoid: item.warnings.slice(0, 3).map((warning) => warning.replace(/^单打|^双打/, "")).join("；"),
    }));
}

function adviceWarningCategory(warning = "") {
  const text = String(warning || "");
  const scope =
    text.startsWith("单打") ? "单打" :
    text.startsWith("双打") ? "双打" :
    text.startsWith("双打里") ? "双打" :
    "全局";
  const clean = text.replace(/^(单打|双打)/, "");
  const rules = [
    [/Mega|进化石/, "Mega 位规划"],
    [/高优先级|槽位|缺槽|missing|mustFix|理解层/, "理解层/缺槽未回应"],
    [/联动|行动链|主轴|副轴|安全上场|轮换|转场|进场答案/, "队伍行动链"],
    [/阶段路线|开局|中盘|终盘|收割/, "阶段路线"],
    [/对局分支|watch|主要威胁|处理顺序|首发|反首发/, "对局说明"],
    [/速度|控速|先制|高速/, "速度控制"],
    [/资源闭环|撒场|清场|状态|守住|集火|范围压力/, "资源闭环"],
    [/天气|晴天|雨天|雪天|沙暴/, "天气轴"],
    [/唱反调|目标|反制|克制/, "目标反制"],
    [/note|解释|plan|具体职责|可执行/, "解释质量"],
  ];
  const match = rules.find(([pattern]) => pattern.test(clean));
  return `${scope} ${match ? match[1] : "其他问题"}`;
}

function compactAdviceWarnings(warnings = [], limit = 8) {
  const groups = new Map();
  for (const warning of [...new Set(warnings.filter(Boolean))]) {
    const localized = localizeAdviceText(warning);
    const category = adviceWarningCategory(localized);
    const list = groups.get(category) || [];
    list.push(localized);
    groups.set(category, list);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-Hans"))
    .slice(0, limit)
    .map(([category, list]) => ({
      label: list.length > 1 ? `${category}：${list[0].replace(/^(单打|双打)/, "").replace(/[。.]$/, "")} 等 ${list.length} 条` : list[0],
      title: list.join("\n"),
      count: list.length,
    }));
}

function renderAIAdvice(data) {
  const advice = normalizeAdvice(data);
  state.aiLastAdvice = advice;
  if (!state.aiAdviceView || !advice?.[state.aiAdviceView]) state.aiAdviceView = state.format;
  if (!advice) return `<div class="ai-plain">${escapeHtml(data.text || "AI 没有返回内容。")}</div>`;
  const structure = evaluateTeamAdvice(advice);
  const styleWarnings = compactAdviceWarnings(adviceStyleWarnings(advice));
  const scoreClass = structure.score >= 85 ? "is-good" : structure.score >= 70 ? "is-warn" : "is-bad";
  const scoreLabel = structure.score === 0 ? "结构可信度 0/100（输出未达标）" : `结构可信度 ${structure.score}/100`;
  if (isUiLevel("beginner")) {
    const block = advice?.[state.aiAdviceView] || advice?.[state.format] || advice.single || {};
    const watch = Array.isArray(block.watch) ? block.watch.filter(Boolean).slice(0, 1) : [];
    const team = Array.isArray(block.team) ? block.team : [];
    return `
      <div class="ai-result ai-result-compact">
        <div class="ai-result-head">
          <div class="ai-result-summary">
            <p>${escapeHtml(advice.summary || "先看这版建议。")}</p>
            <span class="ai-structure-score ${scoreClass}" title="这是前端结构检查分，不是本地模拟胜率。">${escapeHtml(scoreLabel)}</span>
          </div>
        </div>
        <div class="ai-mini-plan">
          <strong>下一步</strong>
          <p>${escapeHtml(block.plan || "先用当前队伍或热门样本跑一版。")}</p>
        </div>
        ${renderBeginnerAdviceTeam(state.aiAdviceView, team)}
        ${watch.length ? `<div class="ai-tags">${watch.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
      </div>`;
  }
  return `
    <div class="ai-result">
      <div class="ai-result-head">
        <div class="ai-result-summary">
          <p>${escapeHtml(advice.summary || "建议队伍如下。")}</p>
          <span class="ai-structure-score ${scoreClass}" title="这是前端结构检查分，不是本地模拟胜率。">${escapeHtml(scoreLabel)}</span>
          ${structure.score === 0 ? `<small class="ai-score-help">AI 返回的队伍没有满足关键结构要求；可点击“重新生成”，或切换“详细/多方案”让模型补齐行动链。</small>` : ""}
        </div>
      <div class="ai-result-actions">
        <button class="btn-outline neutral compact" type="button" data-ai-battle-eval ${state.aiBattleBusy ? "disabled" : ""}>
          ${state.aiBattleBusy ? "模拟中..." : "本地模拟评测"}
        </button>
        <button class="btn-outline neutral compact" type="button" data-battle-review-open>对局回顾</button>
        <button class="btn-outline neutral compact" type="button" data-ai-retry>重新生成</button>
      </div>
      </div>
      ${styleWarnings.length ? `<div class="ai-tags warning">${styleWarnings.map((item) => `<span title="${escapeHtml(item.title)}">${escapeHtml(item.label)}</span>`).join("")}</div>` : ""}
      <div class="ai-view-tabs" role="tablist" aria-label="AI 建议视图">
        <button class="${state.aiAdviceView === "single" ? "is-active" : ""}" type="button" data-ai-view="single">单打方案</button>
        <button class="${state.aiAdviceView === "double" ? "is-active" : ""}" type="button" data-ai-view="double">双打方案</button>
      </div>
      <div class="ai-mode-grid">
        ${renderFormatAdvice("单打", "single", advice.single)}
        ${renderFormatAdvice("双打", "double", advice.double)}
      </div>
    </div>`;
}

function rerenderAIAdvice() {
  const output = $("#ai-output");
  if (!output || !state.aiLastAdvice) return;
  output.className = "ai-output has-structured-result";
  output.innerHTML = renderAIAdvice({ advice: state.aiLastAdvice });
  updateDocumentState();
  render();
}

function openBattleReview(format = state.aiAdviceView || state.format, entryId = null) {
  const entries = battleReviewEntries(format);
  state.battleReviewOpen = true;
  state.battleReviewFormat = format;
  state.battleReviewEntry = entries.find((entry) => entry.id === entryId) || entries[0] || null;
  render();
}

function closeBattleReview() {
  state.battleReviewOpen = false;
  render();
}

function renderBattleEvalBlock(format = state.aiAdviceView || state.format) {
  const record = state.aiBattleEval?.[format] || (state.aiBattleEval?.format === format ? state.aiBattleEval : null);
  if (!record || record.format !== format) return "";
  if (record.error) {
    return `<div class="ai-battle-eval is-error"><strong>本地模拟失败</strong><p>${escapeHtml(record.error)}</p></div>`;
  }
  const data = record.data;
  if (!data) return "";
  const results = Array.isArray(data.results) ? data.results : [];
  const played = results.filter((item) => ["win", "loss", "tie"].includes(item.result));
  const skipped = results.filter((item) => item.result === "skipped");
  const reviewCount = results.filter((item) => ["win", "loss", "tie", "skipped"].includes(item.result)).length;
  const topReasons = results.flatMap((item) => item.failureReasons || []).filter(Boolean).slice(0, 4);
  const rows = results.slice(0, 5).map((item) => {
    const label = item.result === "win" ? "胜" : item.result === "loss" ? "负" : item.result === "tie" ? "平" : "跳过";
    const turns = item.turns ? ` · ${item.turns} 回合` : "";
    return `<li><span>${escapeHtml(cleanBattleTitle(item.opponentTitle, "固定靶队"))}${item.sideLabel ? ` · ${escapeHtml(item.sideLabel)}` : ""}</span><strong>${escapeHtml(label)}${turns}</strong></li>`;
  });
  return `
    <div class="ai-battle-eval">
      <div class="ai-battle-summary">
        <strong>热门靶队本地模拟：${data.wins || 0}胜 ${data.losses || 0}负 ${data.ties || 0}平</strong>
        <span>胜率 ${data.winRate || 0}% · ${played.length || 0} 局${skipped.length ? ` · 跳过 ${skipped.length} 队` : ""}</span>
      </div>
      <div class="ai-battle-actions">
        <button class="btn-outline neutral compact" type="button" data-battle-review-open>对局回顾${reviewCount ? ` ${reviewCount}` : ""}</button>
      </div>
      ${rows.length ? `<ul>${rows.join("")}</ul>` : ""}
      ${topReasons.length ? `<div class="ai-tags warning">${topReasons.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
      ${data.note ? `<p>${escapeHtml(data.note)}</p>` : ""}
    </div>`;
}

function renderBattleReviewPanel() {
  const format = state.battleReviewFormat || state.aiAdviceView || state.format;
  const entries = battleReviewEntries(format);
  const selected = currentBattleReviewEntry();
  const resultLabel = (result) => {
    if (result === "win") return "胜";
    if (result === "loss") return "负";
    if (result === "tie") return "平";
    if (result === "skipped") return "跳过";
    return "未知";
  };
  const tabs = entries
    .map((entry) => `<button class="battle-review-tab ${selected?.id === entry.id ? "is-active" : ""}" type="button" data-battle-review-select="${escapeHtml(entry.id)}"><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(resultLabel(entry.result))} · ${escapeHtml(String(entry.turns || 0))} 回合</span></button>`)
    .join("");
  const details = selected ? renderBattleReviewEntry(selected) : `<p class="empty">没有可回顾的对局。</p>`;
  return `
    <div id="battle-review-root" class="battle-review-backdrop ${state.battleReviewOpen ? "is-open" : ""}" ${state.battleReviewOpen ? "" : "hidden"}>
      <section class="battle-review-panel" role="dialog" aria-modal="true" aria-labelledby="battle-review-title">
        <div class="battle-review-header">
          <div>
            <p class="eyebrow">Battle Review</p>
            <h2 id="battle-review-title">对局回顾</h2>
            <p class="section-note">查看每一场本地模拟的回合日志，用来定位非法选择、回合卡死和胜率异常。</p>
          </div>
          <div class="battle-review-actions">
            <button class="btn-outline neutral compact" type="button" data-battle-review-format="single">单打</button>
            <button class="btn-outline neutral compact" type="button" data-battle-review-format="double">双打</button>
            <button class="btn-close-palette" type="button" data-battle-review-close aria-label="关闭对局回顾">ESC</button>
          </div>
        </div>
        <div class="battle-review-body">
          <div class="battle-review-list">${tabs || `<p class="empty">当前格式还没有可回顾的本地模拟。</p>`}</div>
          ${details}
        </div>
      </section>
    </div>`;
}

function applyAIAdviceTeam(format = state.format) {
  const formatAdvice = state.aiLastAdvice?.[format] || {};
  const team = Array.isArray(formatAdvice.team) ? formatAdvice.team : [];
  const targetData = state.rawData.formats?.[format] || state.data;
  if (!team.length || !targetData?.pokemon) return;
  const byId = new Map(targetData.pokemon.map((mon) => [String(mon.id).toLowerCase(), mon]));
  const byName = new Map(targetData.pokemon.map((mon) => [String(mon.name).toLowerCase(), mon]));
  const bySlug = new Map(targetData.pokemon.map((mon) => [String(mon.slug).toLowerCase(), mon]));
  const next = [];
  const appliedConfigs = [];

  for (const item of team) {
    const keys = [item.id, item.name, item.slug].filter(Boolean).map((value) => String(value).toLowerCase());
    const mon = keys.map((key) => byId.get(key) || byName.get(key) || bySlug.get(key)).find(Boolean);
    if (mon && !next.some((existing) => existing.id === mon.id)) {
      next.push(mon);
      appliedConfigs.push(item);
    }
    if (next.length === 6) break;
  }

  if (next.length) {
    if (state.rawData.formats?.[format] && state.format !== format) {
      state.format = format;
      state.data = targetData;
      updateFormatButtons();
      updateMetaLabel();
      updateEditorOptions();
      renderTeamLibrary();
    }
    state.team = next;
    state.teamConfigs = {};
    appliedConfigs.forEach((item, index) => {
      if (next[index]) setEditableConfig(next[index], item);
    });
    state.importedTeam = null;
    render();
    saveDraft();
  }
}

function pokemonFromAdvice(item, format = state.format) {
  const targetData = state.rawData.formats?.[format] || state.data;
  if (!targetData?.pokemon) return null;
  const exactSlug = String(item?.slug || "").toLowerCase();
  if (exactSlug) {
    const bySlug = targetData.pokemon.find((mon) => String(mon.slug).toLowerCase() === exactSlug);
    if (bySlug) return bySlug;
  }
  const exactName = String(item?.name || "").toLowerCase();
  if (exactName) {
    const byName = targetData.pokemon.find((mon) => String(mon.name).toLowerCase() === exactName);
    if (byName) return byName;
  }
  const alias = TEAM_FORM_ALIASES.get(Number(item?.id)) || null;
  if (alias?.slug) {
    const byAlias = targetData.pokemon.find((mon) => String(mon.slug).toLowerCase() === String(alias.slug).toLowerCase());
    if (byAlias) return byAlias;
  }
  const keys = [item?.id, item?.name, item?.slug].filter(Boolean).map((value) => String(value).toLowerCase());
  return targetData?.pokemon?.find((mon) => keys.includes(String(mon.id).toLowerCase()) || keys.includes(String(mon.name).toLowerCase()) || keys.includes(String(mon.slug).toLowerCase())) || null;
}

function adviceItemFromEvent(event) {
  const card = event.target.closest("[data-ai-mon-format]");
  if (!card) return null;
  const format = card.dataset.aiMonFormat || state.format;
  const index = Number(card.dataset.aiMonIndex);
  const item = state.aiLastAdvice?.[format]?.team?.[index];
  return item ? { format, index, item } : null;
}

function applyAdvicePokemon(item, format = state.format, replace = false) {
  const mon = pokemonFromAdvice(item, format);
  if (!mon) return;
  if (state.rawData.formats?.[format] && state.format !== format) {
    state.format = format;
    state.data = state.rawData.formats[format];
    updateFormatButtons();
    updateMetaLabel();
    updateEditorOptions();
  }
  const existingIndex = state.team.findIndex((own) => own.id === mon.id || own.slug === mon.slug);
  if (existingIndex >= 0) {
    state.team[existingIndex] = mon;
  } else if (replace && state.team.length) {
    const replaced = state.team[state.team.length - 1];
    if (replaced) delete state.teamConfigs[configKey(replaced)];
    state.team[state.team.length - 1] = mon;
  } else if (state.team.length < 6) {
    state.team.push(mon);
  }
  setEditableConfig(mon, item);
  state.importedTeam = null;
  render();
  saveDraft();
}

function advicePokemonText(item = {}) {
  const moves = Array.isArray(item.moves) ? item.moves.filter(Boolean) : [];
  const mon = resolveAdvicePokemonMon(item, state.aiAdviceView || state.format) || fallbackAdvicePokemonMon(item, state.aiAdviceView || state.format) || pokemonFromAdvice(item, state.aiAdviceView || state.format) || state.data?.pokemon?.find((entry) => [entry.name, entry.slug, String(entry.id)].some((value) => String(value) === String(item.name || item.slug || item.id)));
  const pools = adviceConfigPoolsForMon(mon, state.aiAdviceView || state.format);
  const itemName = usableConfigValue(item.item, "items") && (!pools.items.size || pools.items.has(normalizedItemName(usableConfigValue(item.item, "items"))))
    ? usableConfigValue(item.item, "items")
    : usableConfigValue(pools.fallbackConfig?.item, "items");
  const ability = usableConfigValue(item.ability, "abilities") && (!pools.abilities.size || pools.abilities.has(normalizedItemName(usableConfigValue(item.ability, "abilities"))))
    ? usableConfigValue(item.ability, "abilities")
    : usableConfigValue(pools.fallbackConfig?.ability, "abilities");
  const nature = usableConfigValue(item.nature, "natures") && (!pools.natures.size || pools.natures.has(normalizedItemName(usableConfigValue(item.nature, "natures"))))
    ? usableConfigValue(item.nature, "natures")
    : usableConfigValue(pools.fallbackConfig?.nature, "natures");
  const evs = isPlaceholderConfigValue(item.evs) ? "" : item.evs;
  const cleanMoves = moves
    .map((move) => usableConfigValue(move, "moves"))
    .filter((move) => !pools.moves.size || pools.moves.has(normalizedItemName(move)));
  return [`${item.name || item.id}${itemName ? ` @ ${itemName}` : ""}`, ability ? `Ability: ${ability}` : "", `Level: ${item.level || "50"}`, evs ? `EVs: ${evs}` : "", nature ? `${nature} Nature` : "", ...cleanMoves.map((move) => `- ${move}`)].filter(Boolean).join("\n");
}

async function runBattleEvalForAdvice(options = {}) {
  if (state.aiBattleBusy || !state.aiLastAdvice) return;
  const format = options.format || state.aiAdviceView || state.format;
  const auto = Boolean(options.auto);
  const opponents =
    state.aiLastContext?.battleEvaluation?.fixedOpponentTeams?.[format] ||
    state.aiLastContext?.understanding?.fixedOpponentTeams?.[format] ||
    [];
  const teamText = adviceShowdownTeamText(format);
  if (!teamText || !opponents.length) {
    state.aiBattleEval = {
      ...(state.aiBattleEval || {}),
      [format]: {
        format,
        error: !teamText ? "当前建议无法匹配到可模拟的 Showdown 队伍文本。" : "当前 AI 上下文没有可用热池靶队。",
      },
    };
    if (!auto || format === state.aiAdviceView) rerenderAIAdvice();
    return;
  }

  state.aiBattleBusy = true;
  state.aiBattleEval = { ...(state.aiBattleEval || {}), [format]: { format, data: null } };
  if (auto && format !== state.aiAdviceView) {
    updateDocumentState();
  } else {
    rerenderAIAdvice();
  }
  try {
    const res = await fetch(aiApiUrl("/api/battle-eval"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format,
        teamText,
        opponents,
        opponentSource: "hot",
        gamesPerOpponent: 1,
        maxTurns: 80,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "本地模拟未能完成有效对局。");
    state.aiBattleEval = { ...(state.aiBattleEval || {}), [format]: { format, data } };
    rememberBattleEvaluation(format, data);
  } catch (err) {
    state.aiBattleEval = { ...(state.aiBattleEval || {}), [format]: { format, error: err.message || "本地模拟失败。" } };
  } finally {
    state.aiBattleBusy = false;
    if (!auto || format === state.aiAdviceView) rerenderAIAdvice();
  }
}

async function runAutomaticBattleEvaluations() {
  if (!state.aiLastAdvice || !state.aiLastContext) return;
  const formats = ["single", "double"].filter((format) => state.aiLastAdvice?.[format]?.team?.length);
  for (const format of formats) {
    await runBattleEvalForAdvice({ format, auto: true });
  }
}

function formatAIElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

function aiProgressValue(stage, elapsedMs, timeoutMs) {
  const ratio = timeoutMs > 0 ? Math.min(1, elapsedMs / timeoutMs) : 0;
  const ranges = {
    prepare: [4, 16],
    request: [18, 88],
    parse: [88, 94],
    correct: [54, 94],
    done: [100, 100],
  };
  const [start, end] = ranges[stage] || ranges.request;
  const eased = 1 - Math.pow(1 - ratio, 2);
  return Math.min(end, Math.max(start, Math.round(start + (end - start) * eased)));
}

function createAIProgress(output, { timeoutMs, promptMode, title }) {
  const startedAt = performance.now();
  const state = {
    stage: "prepare",
    title,
    detail: "正在整理队伍、环境与历史对战数据...",
  };
  const render = () => {
    const elapsedMs = performance.now() - startedAt;
    const percent = aiProgressValue(state.stage, elapsedMs, timeoutMs);
    output.innerHTML = `
      <div class="ai-progress-panel">
        <div class="ai-progress-head">
          <strong>${escapeHtml(state.title)}</strong>
          <span>${percent}%</span>
        </div>
        <div class="ai-progress-track" aria-label="${escapeHtml(state.title)} ${percent}%">
          <div class="ai-progress-fill" style="width: ${percent}%"></div>
        </div>
        <div class="ai-progress-meta">
          <span>${escapeHtml(state.detail)}</span>
          <span>${escapeHtml(formatAIElapsed(elapsedMs))} / ${escapeHtml(formatAIElapsed(timeoutMs))} · ${escapeHtml(promptModeLabel(promptMode))}</span>
        </div>
      </div>`;
  };
  const timer = window.setInterval(render, 500);
  render();
  return {
    setStage(stage, detail) {
      state.stage = stage;
      state.detail = detail;
      render();
    },
    stop() {
      window.clearInterval(timer);
    },
  };
}

function promptModeLabel(mode = "quick") {
  if (mode === "deep") return "详细";
  if (mode === "compare") return "多方案";
  return "快速";
}

async function generateAIAdvice(mode) {
  const output = $("#ai-output");
  if (!output) return;
  if (state.aiBusy) return;
  const userGoal = goalText();
  if (!state.team.length && !userGoal) {
    output.className = "ai-output is-error";
    output.textContent = "没有选择宝可梦时，请先写一个目标，例如“帮我想一个克制姆克鹰的阵容”。";
    return;
  }

  state.aiBusy = true;
  state.aiLastMode = mode;
  state.aiBattleEval = {};
  output.className = "ai-output is-loading";
  output.textContent = "正在整理队伍、环境与历史对战数据...";
  await new Promise((resolve) => window.setTimeout(resolve, 80));
  const previousAdvice = state.aiLastAdvice;
  const context = aiContext(mode);
  const requestContext = trimAIContextForRequest(context);
  const recentAvoid = recentTeamSignaturesForAvoidance(context);
  if (previousAdvice || recentAvoid.length) {
    requestContext.avoidPreviousTeams = {
      single: previousAdvice ? teamSignatureFromAdvice(previousAdvice, "single") : "",
      double: previousAdvice ? teamSignatureFromAdvice(previousAdvice, "double") : "",
      recent: recentAvoid,
      reason: "用户点击重新生成或再次请求时，应避免原样重复上一套建议队伍。",
    };
  }
  state.aiLastContext = context;
  const timeoutMs = aiRequestTimeoutMs(context.promptMode);
  const progress = createAIProgress(output, {
    timeoutMs,
    promptMode: context.promptMode,
    title: context.intent?.emptyTeamRequest ? "AI 正在按目标从零构筑阵容" : "AI 正在生成队伍配置",
  });

  try {
    saveAIConfig();
    const aiConfig = loadAIConfig();
    const requestAdvice = async (correction = null) => {
      progress.setStage(correction ? "correct" : "request", correction ? "AI 正在根据结构评分自动修正..." : "AI 请求已发送，正在等待模型返回...");
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(aiApiUrl("/api/team-advice"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...requestContext,
          correction,
          aiConfig: hasUsableAIConfig(aiConfig) ? aiConfig : null,
        }),
      }).finally(() => window.clearTimeout(timeout));
      progress.setStage("parse", "AI 已返回，正在解析配置与校验结构...");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `AI 服务错误：${res.status}`);
      return data;
    };

    let data = await requestAdvice();
    let advice = normalizeAdvice(data);
    let structure = advice ? evaluateTeamAdvice(advice, context) : null;
    if (shouldAutoCorrectAdvice(advice, structure)) {
      rememberAdviceFailure(advice, structure, context);
      progress.setStage("correct", `AI 已生成初稿，结构可信度 ${structure.score}/100；正在自动修正：${structure.warnings.slice(0, 2).join("；")}`);
      data = await requestAdvice(correctionPayloadForAdvice(advice, structure));
      advice = normalizeAdvice(data) || advice;
    }
    structure = advice ? evaluateTeamAdvice(advice, context) : null;
    rememberAdviceFailure(advice, structure, context);
    progress.stop();
    output.className = "ai-output has-structured-result";
    state.aiAdviceView = context.format;
    output.innerHTML = renderAIAdvice({ advice });
    updateDocumentState();
    void runAutomaticBattleEvaluations();
  } catch (err) {
    output.className = "ai-output is-error";
    const timeoutSeconds = Math.round(aiRequestTimeoutMs(state.aiLastContext?.promptMode || "quick") / 1000);
    const message = err.name === "AbortError" ? `AI 请求超过 ${timeoutSeconds} 秒未返回，已自动停止。可以切换“快速”、减少目标描述，或换用响应更快的模型。` : err.message;
    output.textContent = `${message}\n\n点击“配置 API”检查密钥、模型、余额或 OpenAI 兼容接口。`;
  } finally {
    progress.stop();
    state.aiBusy = false;
  }
}

function setFormat(format) {
  const nextData = state.rawData.formats?.[format];
  if (!nextData) return;
  saveDraft();
  state.format = format;
  state.data = nextData;
  state.team = [];
  state.teamConfigs = {};
  state.importedTeam = null;
  state.activeEditIndex = null;
  state.query = "";
  closePalette(false);
  const search = $("#search");
  if (search) search.value = "";
  updateFormatButtons();
  updateMetaLabel();
  updateEditorOptions();
  restoreDraft(format);
  renderDecorPokemon();
  renderTeamLibrary();
  render();
}

function updateFormatButtons() {
  document.querySelectorAll("[data-format]").forEach((button) => {
    const available = Boolean(state.rawData.formats?.[button.dataset.format]);
    button.hidden = !available;
    button.classList.toggle("active", button.dataset.format === state.format);
    button.textContent = formatLabel(button.dataset.format);
  });
}

function updateMetaLabel() {
  if (!state.data) return;
  $("#data-meta").textContent = `${state.data.season} · ${formatLabel(state.format)} · ${state.data.pokemon.length} 只 · 本地缓存 ${formatCacheTime(currentCacheTime())}`;
}

function fillDatalist(id, values) {
  const list = $(id);
  if (!list) return;
  list.innerHTML = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hans")).slice(0, 240).map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
}

function updateEditorOptions() {
  if (!state.data?.pokemon) return;
  fillDatalist("#move-options", state.data.pokemon.flatMap((mon) => mon.moves || []).map((item) => item.name));
  fillDatalist("#item-options", state.data.pokemon.flatMap((mon) => mon.items || []).map((item) => item.name));
  fillDatalist("#ability-options", state.data.pokemon.flatMap((mon) => mon.abilities || []).map((item) => item.name));
  fillDatalist("#nature-options", state.data.pokemon.flatMap((mon) => mon.natures || []).map((item) => item.name));
  fillDatalist("#type-options", TYPES);
  fillDatalist("#ball-options", ["精灵球", "高级球", "超级球", "大师球", "纪念球", "豪华球", "先机球", "计时球", "重复球", "巢穴球", "潜水球", "黑暗球", "治愈球", "速度球", "等级球", "诱饵球", "沉重球", "甜蜜球", "友友球", "月亮球", "梦境球", "究极球"]);
  fillDatalist("#language-options", ["CHS", "CHT", "ENG", "JPN", "KOR", "FRE", "GER", "ITA", "SPA"]);
}

function renderDecorPokemon() {
  const container = $("#decor-pokemon");
  if (!container || !state.data?.pokemon?.length) return;
  const pool = state.data.pokemon.filter((mon) => mon.sprite).slice(0, 80);
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, 6);
  const positions = [
    { side: "left", top: 18, x: 18, size: 128, facing: 1 },
    { side: "left", top: 48, x: -10, size: 160, facing: 1 },
    { side: "left", top: 78, x: 26, size: 118, facing: 1 },
    { side: "right", top: 24, x: 16, size: 146, facing: -1 },
    { side: "right", top: 56, x: -16, size: 168, facing: -1 },
    { side: "right", top: 84, x: 34, size: 124, facing: -1 },
  ];
  container.innerHTML = shuffled
    .map((mon, index) => {
      const pos = positions[index];
      const depth = 0.5 + index * 0.12;
      const duration = 6 + index * 0.8;
      const delay = -index * 0.7;
      return `
        <button class="decor-mon ${pos.side}" type="button" aria-label="和 ${escapeHtml(mon.name)} 互动" style="top:${pos.top}%;--decor-x:${pos.x}px;--decor-size:${pos.size}px;--decor-facing:${pos.facing};--decor-depth:${depth};--decor-duration:${duration}s;--decor-delay:${delay}s;">
          <span class="decor-action">加入队伍</span>
          <img src="${mon.sprite}" alt="">
          <span class="decor-bubble">${escapeHtml(mon.name)}</span>
        </button>`;
    })
    .join("");
  container.classList.remove("is-shuffling");
  requestAnimationFrame(() => {
    container.classList.add("is-shuffling");
    window.setTimeout(() => container.classList.remove("is-shuffling"), 700);
  });
}

function bindDecorMotion() {
  const container = $("#decor-pokemon");
  if (!container) return;
  let movingTimer = 0;
  container.addEventListener("click", (event) => {
    const mon = event.target.closest(".decor-mon");
    if (!mon) return;
    mon.classList.remove("is-reacting");
    void mon.offsetWidth;
    mon.classList.add("is-reacting");
    const name = mon.querySelector(".decor-bubble")?.textContent?.trim();
    const candidate = state.data?.pokemon?.find((item) => item.name === name);
    if (candidate) addPokemonToTeam(candidate, { replaceLast: state.team.length >= 6 });
    window.setTimeout(() => mon.classList.remove("is-reacting"), 700);
  });
  container.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const mon = event.target.closest(".decor-mon");
    if (!mon) return;
    event.preventDefault();
    mon.click();
  });
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.addEventListener("pointermove", (event) => {
    const x = (event.clientX / window.innerWidth - 0.5) * 52;
    const y = (event.clientY / window.innerHeight - 0.5) * 38;
    container.style.setProperty("--decor-drift-x", `${x.toFixed(2)}px`);
    container.style.setProperty("--decor-drift-y", `${y.toFixed(2)}px`);
    container.classList.add("is-moving");
    window.clearTimeout(movingTimer);
    movingTimer = window.setTimeout(() => container.classList.remove("is-moving"), 260);
  });
  window.addEventListener(
    "scroll",
    () => {
      container.style.setProperty("--decor-scroll-y", `${(window.scrollY * 0.08).toFixed(2)}px`);
    },
    { passive: true },
  );
}

function applyPreferences() {
  const theme = localStorage.getItem("champion-lab-theme") || "aurora";
  const fontScale = localStorage.getItem("champion-lab-font-scale") || "normal";
  state.uiLevel = loadUiLevel();
  document.body.dataset.theme = theme;
  document.body.dataset.fontScale = fontScale;
  document.body.dataset.uiLevel = state.uiLevel;
  document.body.classList.toggle("ui-beginner", isUiLevel("beginner"));
  document.body.classList.toggle("ui-intermediate", isUiLevel("intermediate"));
  document.body.classList.toggle("ui-advanced", isUiLevel("advanced"));
  const themeSelect = $("#theme-select");
  const fontSelect = $("#font-scale");
  const uiLevelSelect = $("#ui-level-select");
  if (themeSelect) themeSelect.value = theme;
  if (fontSelect) fontSelect.value = fontScale;
  if (uiLevelSelect) uiLevelSelect.value = state.uiLevel;
}

function setPreference(key, value) {
  localStorage.setItem(key, value);
  applyPreferences();
}

function availableTeamSeasons() {
  return [...new Set(state.teamLibrary.map((team) => team.season).filter(Boolean))].sort().reverse();
}

function teamSourceKind(team) {
  return team?.source === "OP.GG Replica Teams" ? "player" : "public";
}

function teamSourceLabel(kind) {
  return kind === "player" ? "玩家上传" : "公开热门";
}

function teamSeasonCount(season = state.teamSeasonFilter, format = state.format) {
  return state.teamLibrary.filter((team) => team.season === season && team.format === format).length;
}

function teamSourceCount(kind, { season = state.teamSeasonFilter, format = state.format } = {}) {
  return state.teamLibrary.filter((team) => team.format === format && team.season === season && teamSourceKind(team) === kind).length;
}

function availableTeamSources({ season = state.teamSeasonFilter, format = state.format } = {}) {
  const kinds = [...new Set(state.teamLibrary.filter((team) => team.season === season && team.format === format).map(teamSourceKind))];
  const order = ["public", "player"];
  return order.filter((kind) => kinds.includes(kind));
}

function ensureTeamSourceFilter() {
  const sources = availableTeamSources();
  if (!sources.length) {
    state.teamSourceFilter = "";
  } else if (!state.teamSourceFilter || !sources.includes(state.teamSourceFilter)) {
    state.teamSourceFilter = [...sources].sort((a, b) => teamSourceCount(b) - teamSourceCount(a))[0];
  }
  return sources;
}

function ensureTeamSeasonFilter() {
  const seasons = availableTeamSeasons();
  const currentSeason = state.data?.season || state.rawData?.season || "";
  if (!seasons.length) {
    state.teamSeasonFilter = "";
  } else if (!state.teamSeasonFilter || !seasons.includes(state.teamSeasonFilter)) {
    state.teamSeasonFilter = seasons.includes(currentSeason) ? currentSeason : seasons[0];
  }
  return seasons;
}

function currentLibraryTeams() {
  ensureTeamSeasonFilter();
  ensureTeamSourceFilter();
  const currentSeason = state.teamSeasonFilter || state.data?.season || state.rawData?.season || "";
  const currentSource = state.teamSourceFilter || "";
  return state.teamLibrary.filter(
    (team) =>
      team.format === state.format &&
      (!currentSeason || !team.season || team.season === currentSeason) &&
      (!currentSource || teamSourceKind(team) === currentSource),
  );
}

function previewMemberFor(member) {
  return pokemonForTeamMember(member, { allowFallback: false }) || member;
}

function renderTeamLibrary() {
  const select = $("#team-library-select");
  const seasonSelect = $("#team-season-select");
  const sourceSelect = $("#team-source-select");
  const preview = $("#team-library-preview");
  if (!select || !preview) return;
  const seasons = ensureTeamSeasonFilter();
  const sources = ensureTeamSourceFilter();
  if (seasonSelect) {
    seasonSelect.innerHTML = seasons.length
      ? seasons.map((season) => `<option value="${escapeHtml(season)}" ${season === state.teamSeasonFilter ? "selected" : ""}>${escapeHtml(season)} · ${teamSeasonCount(season)}</option>`).join("")
      : `<option value="">暂无赛季</option>`;
    seasonSelect.disabled = seasons.length <= 1;
  }
  if (sourceSelect) {
    sourceSelect.innerHTML = sources.length
      ? sources.map((source) => `<option value="${escapeHtml(source)}" ${source === state.teamSourceFilter ? "selected" : ""}>${escapeHtml(teamSourceLabel(source))} · ${teamSourceCount(source)}</option>`).join("")
      : `<option value="">暂无来源</option>`;
    sourceSelect.disabled = sources.length <= 1;
  }
  const teams = currentLibraryTeams();
  if (!teams.length) {
    select.innerHTML = `<option value="">暂无可导入队伍</option>`;
    preview.innerHTML = `<p class="empty">当前 ${escapeHtml(state.teamSeasonFilter || state.data?.season || "赛季")} · ${escapeHtml(teamSourceLabel(state.teamSourceFilter))} 暂无队伍缓存，运行 npm run fetch:teams 后会重新检查来源。</p>`;
    return;
  }
  if (!teams.some((team) => team.id === state.selectedTeamId)) state.selectedTeamId = teams[0].id;
  select.innerHTML = teams
    .map((team) => `<option value="${team.id}" ${team.id === state.selectedTeamId ? "selected" : ""}>${escapeHtml(team.title)} · ${teamSourceLabel(teamSourceKind(team))} · ${team.rentalCode || (team.rate ? `Rate ${team.rate}` : team.season)}</option>`)
    .join("");

  const team = teams.find((item) => item.id === state.selectedTeamId) || teams[0];
  const matched = team.members.filter((member) => pokemonForTeamMember(member)).length;
  const fullData = team.members.filter((member) => pokemonForTeamMember(member, { allowFallback: false })).length;
  const sourceLinks = [
    team.articleUrl ? { url: team.articleUrl, label: "查看文章", primary: true } : null,
    team.href ? { url: team.href, label: "原始来源" } : null,
    ...(team.sourceLinks || [])
      .filter((url) => url && url !== team.href && url !== team.articleUrl)
      .slice(0, 2)
      .map((url, index) => ({ url, label: `来源 ${index + 2}` })),
  ].filter(Boolean);
  preview.innerHTML = `
    <div class="team-preview-copy">
      <strong>${escapeHtml(team.title)}</strong>
      <div class="team-preview-tags">
        <span class="team-preview-chip">${escapeHtml(team.season)}</span>
        <span class="team-preview-chip">${escapeHtml(team.formatLabel)}</span>
        <span class="team-preview-chip team-preview-source">${escapeHtml(teamSourceLabel(teamSourceKind(team)))}</span>
        <span class="team-preview-chip team-preview-rate">${team.rate ? `Rate ${team.rate}` : "No rate"}</span>
        <span class="team-preview-chip team-preview-source-name">${escapeHtml(team.source || "Unknown source")}</span>
        ${team.rentalCode ? `<span class="team-preview-chip team-preview-rental">租借码 ${escapeHtml(team.rentalCode)}</span>` : ""}
        <span class="team-preview-chip team-preview-importable">可导入 ${matched}/${team.members.length}</span>
        ${fullData < team.members.length ? `<span class="team-preview-chip team-preview-full-data">完整数据 ${fullData}/${team.members.length}</span>` : ""}
      </div>
      ${sourceLinks.length ? `<div class="team-preview-links">${sourceLinks
        .map((link) => `<a class="team-preview-link ${link.primary ? "is-primary" : ""}" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`)
        .join("")}</div>` : ""}
    </div>
    <div class="team-preview-mons">
      ${team.members
        .map((member) => {
          const preview = previewMemberFor(member);
          const name = preview.name || member.name;
          return `<img src="${escapeHtml(preview.sprite || member.sprite || "")}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}">`;
        })
        .join("")}
    </div>`;
}

function importSelectedTeam() {
  const team = state.teamLibrary.find((item) => item.id === state.selectedTeamId);
  if (!team || !state.data) return;
  state.team = team.members.map(pokemonForTeamMember).filter(Boolean).slice(0, 6);
  state.teamConfigs = {};
  state.importedTeam = team;
  closePalette();
  render();
  saveDraft();
}

function renderSlots() {
  $("#team-slots").innerHTML = Array.from({ length: 6 }, (_, index) => {
    const mon = state.team[index];
    if (!mon) return `<button class="slot" type="button"><strong>SLOT ${index + 1}</strong></button>`;
    const config = editableConfigFor(mon);
    return `
      <div class="slot filled ${mon.isExternalMember ? "external-member" : ""}" data-edit-index="${index}" role="button" tabindex="0" aria-label="编辑 ${escapeHtml(mon.name)}">
        <button class="slot-remove" type="button" data-remove="${mon.slug}" aria-label="移除 ${escapeHtml(mon.name)}">×</button>
        <img src="${mon.sprite}" alt="${escapeHtml(mon.name)}">
        <strong>${escapeHtml(mon.name)}</strong>
        <small>${escapeHtml(config.item || config.ability || "点击编辑")}</small>
      </div>`;
  }).join("");
}

function updateDocumentState() {
  document.body.dataset.teamCount = String(state.team.length);
  document.body.dataset.uiLevel = state.uiLevel;
  document.body.classList.toggle("has-team", state.team.length > 0);
  document.body.classList.toggle("team-complete", state.team.length === 6);
  document.body.classList.toggle("has-ai-advice", Boolean(state.aiLastAdvice));
  document.body.classList.toggle("battle-review-open", Boolean(state.battleReviewOpen));
  document.body.classList.toggle("ui-beginner", isUiLevel("beginner"));
  document.body.classList.toggle("ui-intermediate", isUiLevel("intermediate"));
  document.body.classList.toggle("ui-advanced", isUiLevel("advanced"));
  $("#analysis-dashboard")?.classList.toggle("is-empty", state.team.length === 0);
}

function renderList() {
  const listEl = $("#pokemon-list");
  if (!listEl) return;
  if (!state.searchOpen) {
    listEl.innerHTML = "";
    return;
  }
  const q = state.query.trim().toLowerCase();
  const selected = new Set(state.team.map((p) => p.slug));
  const list = state.data.pokemon
    .filter((mon) => !q || mon.name.toLowerCase().includes(q) || mon.slug.toLowerCase().includes(q) || String(mon.id).includes(q))
    .slice(0, 80);
  listEl.innerHTML = list
    .map((mon) => {
      const disabled = selected.has(mon.slug) || state.team.length >= 6;
      return `<button class="pokemon-row" type="button" data-add="${mon.slug}" ${disabled ? "disabled" : ""}><span class="rank">#${mon.rank}</span><img src="${mon.sprite}" alt="${escapeHtml(mon.name)}"><span><strong>${escapeHtml(mon.name)}</strong><small>${escapeHtml(topNames(mon.moves, 2) || "暂无配置")}</small></span><span class="type-pill">${escapeHtml((mon.types || []).join("/"))}</span></button>`;
    })
    .join("");
}

function renderMetrics() {
  if (!state.team.length) {
    $("#avg-rank").textContent = "-";
    $("#meta-score").textContent = "-";
    $("#speed-line").textContent = "-";
    $("#matchup-score").textContent = "-";
    return;
  }
  const rankedTeam = state.team.filter((mon) => !mon.isExternalMember && Number.isFinite(Number(mon.rank)));
  const avgRank = rankedTeam.length ? rankedTeam.reduce((sum, mon) => sum + Number(mon.rank || 0), 0) / rankedTeam.length : null;
  const top20 = rankedTeam.filter((mon) => Number(mon.rank) <= 20).length;
  const speed = Math.max(...state.team.map((mon) => effectiveSpeed(mon).value));
  const knowledge = battleKnowledge();
  $("#avg-rank").textContent = avgRank === null ? "-" : avgRank.toFixed(1);
  $("#meta-score").textContent = knowledge.score >= 76 ? "高" : knowledge.score >= 54 ? "中" : "低";
  $("#meta-score").title = `规则状态评分 ${knowledge.score}/100；风险：${knowledge.risks.join("、") || "暂无明显风险"}`;
  $("#speed-line").textContent = String(speed || "-");
  const matchup = getMatchupReport(8);
  $("#matchup-score").textContent = String(matchup.score || "-");
  $("#matchup-score").title = matchup.summary;
}

function getTeamCompositionReport() {
  const team = state.team;
  if (!team.length) {
    return {
      style: "未成队",
      summary: "还没有队伍成员。",
      cores: [],
      winConditions: [],
      supportPlan: [],
      gaps: ["先选择 3 到 6 只宝可梦。"],
      buildPriorities: [],
    };
  }

  const profiles = team.map((mon) => {
    const moves = textOf(mon, "moves");
    const abilityText = textOf(mon, "abilities");
    const itemText = textOf(mon, "items");
    const roleTemplate = roleTemplateFor(mon);
    const atk = stat(mon, "攻击");
    const spa = stat(mon, "特攻");
    const spe = stat(mon, "速度");
    const bulk = stat(mon, "HP") + stat(mon, "防御") + stat(mon, "特防");
    const roles = getRoles(mon);
    const flags = {
      physical: atk >= 115 || MOVE_PATTERNS.setup.test(moves),
      special: spa >= 115 || MOVE_PATTERNS.setup.test(moves),
      fast: effectiveSpeed(mon).value >= 100 || spe >= 100,
      bulky: bulk >= 290,
      setup: MOVE_PATTERNS.setup.test(moves),
      speedControl: MOVE_PATTERNS.speedControl.test(moves),
      hazard: MOVE_PATTERNS.hazard.test(moves),
      removal: MOVE_PATTERNS.removal.test(moves),
      pivot: MOVE_PATTERNS.pivot.test(moves),
      priority: MOVE_PATTERNS.priority.test(moves),
      protect: MOVE_PATTERNS.protect.test(moves),
      fakeOut: MOVE_PATTERNS.fakeOut.test(moves),
      intimidate: MOVE_PATTERNS.intimidate.test(abilityText),
      redirection: MOVE_PATTERNS.redirection.test(moves),
      spread: MOVE_PATTERNS.spread.test(moves),
      groundImmune: mon.types?.includes("飞行") || /漂浮/.test(abilityText),
      choice: /讲究/.test(itemText),
      sustain: MOVE_PATTERNS.sustain.test(`${moves} ${itemText} ${abilityText}`) || /剩饭|再生力|たべのこし|さいせいりょく/.test(`${itemText} ${abilityText}`),
    };
    const score = (flags.physical || flags.special ? 3 : 0) + (flags.fast ? 2 : 0) + (flags.setup ? 2 : 0) + (flags.choice ? 1 : 0) + (roleTemplate ? 1 : 0) + (Number(mon.rank) <= 30 ? 1 : 0);
    return { mon, roles, flags, roleTemplate, nameMap: nameMapFor(mon), score };
  });

  const count = (flag) => profiles.filter((item) => item.flags[flag]).length;
  const offenseScore = count("fast") + count("setup") + count("priority") + count("choice") + count("physical") + count("special");
  const structureScore = count("pivot") + count("sustain") + count("groundImmune") + count("hazard") + count("removal");
  const doubleScore = count("protect") + count("fakeOut") + count("intimidate") + count("redirection") + count("spread");
  const style =
    state.format === "double"
      ? doubleScore >= 5
        ? "双打协作队"
        : offenseScore >= 6
          ? "双打进攻队"
          : "双打平衡队"
      : offenseScore >= 8
        ? "单打进攻队"
        : structureScore >= 5
          ? "单打平衡/轮转队"
          : "单打半攻队";

  const cores = profiles
    .filter((item) => item.flags.physical || item.flags.special || item.flags.setup || item.flags.speedControl || Number(item.mon.rank) <= 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => ({
      name: item.mon.name,
      reason: [
        item.flags.physical ? "物攻压力" : "",
        item.flags.special ? "特攻压力" : "",
        item.flags.setup ? "强化终盘" : "",
        item.flags.speedControl ? "控速" : "",
        item.flags.fast ? "高速" : "",
      ].filter(Boolean).join(" / ") || "环境核心",
    }));

  const archetypes = detectCoreArchetypes(profiles, state.format);

  const winConditions = [];
  const setup = profiles.find((item) => item.flags.setup);
  const fastest = [...profiles].sort((a, b) => effectiveSpeed(b.mon).value - effectiveSpeed(a.mon).value)[0];
  const priority = profiles.find((item) => item.flags.priority);
  if (setup) winConditions.push(`保护 ${setup.mon.name} 的强化窗口，先削弱其换入点再收尾。`);
  if (fastest) winConditions.push(`围绕 ${fastest.mon.name} 的速度线制造先手压制。`);
  if (priority) winConditions.push(`${priority.mon.name} 可作为残局先制收割点。`);

  const supportPlan = [];
  const speedControl = profiles.find((item) => item.flags.speedControl);
  const pivot = profiles.find((item) => item.flags.pivot);
  const hazard = profiles.find((item) => item.flags.hazard);
  const removal = profiles.find((item) => item.flags.removal);
  if (speedControl) supportPlan.push(`${speedControl.mon.name} 负责控速，让核心更稳定进攻。`);
  if (pivot) supportPlan.push(`${pivot.mon.name} 负责转场，把核心安全带上场。`);
  if (hazard) supportPlan.push(`${hazard.mon.name} 提供撒场压力。`);
  if (removal) supportPlan.push(`${removal.mon.name} 负责清场/除钉。`);
  if (state.format === "double") {
    const protectCount = count("protect");
    if (protectCount) supportPlan.push(`当前有 ${protectCount} 个守住位，可围绕保护和集火节奏展开。`);
  }

  const gaps = [];
  if (!count("speedControl")) gaps.push("缺少稳定控速。");
  if (!count("groundImmune")) gaps.push("缺少地面免疫/安全换入点。");
  if (!count("physical") || !count("special")) gaps.push("物攻/特攻压力不均衡。");
  if (state.format === "single") {
    if (!count("hazard")) gaps.push("单打缺少撒场压力。");
    if (!count("removal")) gaps.push("单打缺少清场/除钉手段。");
    if (!count("pivot") && !count("sustain")) gaps.push("换入链偏薄，核心容易被消耗。");
  } else {
    if (count("protect") < 3) gaps.push("双打守住数量偏少。");
    if (!count("fakeOut") && !count("intimidate") && !count("redirection")) gaps.push("双打缺少击掌/威吓/掩护一类站场辅助。");
    if (!count("spread")) gaps.push("双打缺少范围压制招式。");
  }

  const buildPriorities = gaps.slice(0, 4).map((gap) => {
    if (gap.includes("控速")) return "优先补顺风、电磁波、岩石封锁、黏黏网或戏法空间。";
    if (gap.includes("地面")) return "补飞行系、漂浮特性或能吃地面攻击的中转位。";
    if (gap.includes("物攻/特攻")) return "补另一侧输出，避免被单一防守端卡住。";
    if (gap.includes("撒场")) return "补隐形岩/撒菱/黏黏网。";
    if (gap.includes("除钉")) return "补高速旋转或清除浓雾。";
    if (gap.includes("守住")) return "双打配置至少让 3 只携带守住/看穿。";
    if (gap.includes("站场辅助")) return "补击掌奇袭、威吓、看我嘛、愤怒粉或广域防守。";
    return gap;
  });

  return {
    style,
    summary: `${style}：${archetypes.length ? `${archetypes[0].name}，` : ""}${cores.length ? `核心围绕 ${cores.map((item) => item.name).join("、")} 展开` : "核心尚不明确"}。`,
    beginnerSummary: team.length
      ? `${style}，先抓核心 ${cores[0]?.name || team[0]?.name || "成员"}，再补 ${gaps[0] || "速度/换入/终盘"}.`
      : "先选 3 到 6 只宝可梦，再看队伍怎么打。",
    intermediateSummary: team.length
      ? `${style}，短板是 ${gaps.slice(0, 2).join("、") || "暂无明显短板"}。`
      : "先导入队伍，再看短板和补强。",
    cores,
    archetypes,
    roleTemplates: profiles
      .filter((item) => item.roleTemplate)
      .map((item) => ({
        name: item.mon.name,
        roles: item.roleTemplate.roles,
        notes: item.roleTemplate.notes,
        nameMap: item.nameMap,
      })),
    winConditions: winConditions.slice(0, 3),
    supportPlan: supportPlan.slice(0, 4),
    gaps: gaps.slice(0, 6),
    buildPriorities: [...new Set(buildPriorities)].slice(0, 4),
    counts: {
      physical: count("physical"),
      special: count("special"),
      speedControl: count("speedControl"),
      pivot: count("pivot"),
      hazard: count("hazard"),
      removal: count("removal"),
      protect: count("protect"),
      support: count("fakeOut") + count("intimidate") + count("redirection"),
    },
  };
}

function detectCoreArchetypes(profiles, format) {
  const hasType = (type) => profiles.some((item) => item.mon.types?.includes(type));
  const hasFlag = (flag) => profiles.some((item) => item.flags[flag]);
  const hasMoveText = (pattern) => profiles.some((item) => pattern.test(textOf(item.mon, "moves")));
  const hasAbilityText = (pattern) => profiles.some((item) => pattern.test(textOf(item.mon, "abilities")));
  const hasItemText = (pattern) => profiles.some((item) => pattern.test(textOf(item.mon, "items")));
  const hasTemplate = (key) => profiles.some((item) => idKey(item.mon.slug) === key || idKey(item.nameMap.showdown) === key);
  const archetypes = [];

  if (hasItemText(/进化石|ナイト|mega/i)) {
    archetypes.push({
      name: "Mega 核心轴",
      reason: "队伍携带 Mega 石，需要围绕 Mega 位创造安全进场和清场窗口。",
      needs: ["保护 Mega 位血量", "补抗性换入", "避免多个 Mega 石冲突"],
    });
  }
  if (hasAbilityText(/日照|ひでり|drought/i) || hasMoveText(/大晴天|にほんばれ|sunny day/i) || hasTemplate("charizard")) {
    archetypes.push({
      name: "晴天进攻轴",
      reason: "队伍有晴天来源或晴天核心，适合放大火系/草系速度与输出。",
      needs: ["补水/岩石应对", "保护天气手", "准备非晴天时的第二路线"],
    });
  }
  if (hasAbilityText(/降雨|あめふらし|drizzle/i) || hasMoveText(/求雨|あまごい|rain dance/i)) {
    archetypes.push({
      name: "雨天速度轴",
      reason: "队伍具备雨天来源，适合围绕水系高压和雨天加速推进。",
      needs: ["补草/电抗性", "保护雨天回合", "准备反天气方案"],
    });
  }
  if (hasFlag("hazard") && (hasFlag("fast") || hasFlag("priority") || hasFlag("setup"))) {
    archetypes.push({
      name: "撒场进攻轴",
      reason: "有撒场压力和高速/先制/强化点，适合通过削血铺垫终盘。",
      needs: ["保住撒场收益", "补清场防反压", "明确终盘清理手"],
    });
  }
  if (hasFlag("pivot") && (hasFlag("bulky") || hasFlag("sustain"))) {
    archetypes.push({
      name: "轮转平衡轴",
      reason: "有转场和耐久中转，适合通过换入链消耗对手。",
      needs: ["避免被撒场拖垮", "补破盾或终盘点", "保持关键抗性血量"],
    });
  }
  if (format === "double" && (hasFlag("fakeOut") || hasFlag("intimidate") || hasFlag("redirection"))) {
    archetypes.push({
      name: "双打站场协作轴",
      reason: "具备击掌、威吓或掩护能力，适合围绕首回合节奏和核心输出展开。",
      needs: ["提高守住数量", "补范围输出", "规划首发组合"],
    });
  }
  if (format === "double" && hasFlag("speedControl")) {
    archetypes.push({
      name: "双打控速轴",
      reason: "有顺风、空间、电磁波或冰风等控速手段，核心应围绕控速回合行动。",
      needs: ["明确控速后谁输出", "防挑衅/击掌打断", "准备控速失效后的路线"],
    });
  }
  if (hasType("钢") && hasType("妖精")) {
    archetypes.push({
      name: "钢妖联防轴",
      reason: "钢与妖精能覆盖大量龙、恶、冰、妖精相关攻防压力。",
      needs: ["补火/地面应对", "保留钢系血量", "补针对水火核心的打点"],
    });
  }
  return archetypes.slice(0, 4);
}

function renderRoles() {
  const roles = new Map();
  state.team.forEach((mon) => getRoles(mon).forEach((role) => roles.set(role, (roles.get(role) || 0) + 1)));
  if (!roles.size) {
    $("#role-tags").innerHTML = `<p class="empty">选择宝可梦后显示队伍定位。</p>`;
    return;
  }
  const composition = getTeamCompositionReport();
  const compositionTags = [
    composition.style,
    ...composition.archetypes.slice(0, 2).map((item) => item.name),
    ...composition.cores.map((item) => `核心 ${item.name}`),
    ...composition.buildPriorities.slice(0, 2),
  ];
  $("#role-tags").innerHTML = [
    ...compositionTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`),
    ...[...roles.entries()].map(([role, count]) => `<span class="tag">${escapeHtml(role)} ${count}</span>`),
  ].join("");
}

function getSpeedThreats() {
  if (!state.team.length) return [];
  const ownMax = Math.max(...state.team.map((mon) => effectiveSpeed(mon).value));
  return state.data.pokemon
    .filter((mon) => !state.team.some((own) => own.id === mon.id))
    .map((mon) => ({ mon, eff: effectiveSpeed(mon) }))
    .filter(({ eff }) => eff.value > ownMax || eff.label !== "原速")
    .slice(0, 24)
    .map(({ mon, eff }) => ({
      mon,
      level: eff.label,
      note: `有效速度 ${eff.value}，${speedPresetNote(mon) ? `PokeCamp 速度线：${speedPresetNote(mon)}` : `常见配置：${topNames(mon.items, 2) || "暂无"}`}`,
    }));
}

function speedlineRows() {
  const data = currentPokeCampData();
  const groups = data?.speedline?.baseGroups || [];
  return groups
    .filter((group) => Number(group.baseSpeed) > 0 && group.pokemons?.length)
    .map((group) => ({
      baseSpeed: Number(group.baseSpeed),
      actualSpeed: level50Speed(group.baseSpeed),
      pokemons: group.pokemons,
    }))
    .sort((a, b) => b.actualSpeed - a.actualSpeed || b.baseSpeed - a.baseSpeed);
}

function renderSpeedlineTable() {
  const target = $("#speedline-table");
  if (!target) return;
  const rows = speedlineRows();
  if (!rows.length) {
    target.innerHTML = `<p class="empty">暂无速度线数据。运行 npm run fetch:knowledge 后会显示 PokeCamp 速度线。</p>`;
    return;
  }
  const ownMax = state.team.length ? Math.max(...state.team.map((mon) => effectiveSpeed(mon).value)) : 0;
  target.innerHTML = rows
    .map((row) => {
      const status = ownMax >= row.actualSpeed ? "ahead" : ownMax && ownMax >= row.actualSpeed - 10 ? "close" : "behind";
      const label = status === "ahead" ? "已压过" : status === "close" ? "接近" : "需控速";
      const presetText = `极速 ${row.actualSpeed} · 满速 ${level50Speed(row.baseSpeed, { nature: 1 })}`;
      return `
        <article class="speedline-row is-${status}">
          <div class="speedline-rank">
            <strong>${row.actualSpeed}</strong>
            <span>${label}</span>
            <em>种族值 ${row.baseSpeed}</em>
          </div>
          <div class="speedline-mons">
            ${row.pokemons
              .map(
                (mon) => `
                  <a class="speedline-mon" href="${escapeHtml(speedlineDetailUrl(mon))}" target="_blank" rel="noopener noreferrer" title="打开 ${escapeHtml(mon.name)}">
                    <img src="${escapeHtml(speedlinePokemonSprite(mon))}" alt="">
                    <span>${escapeHtml(mon.name)}</span>
                  </a>
                `,
              )
              .join("")}
          </div>
          <div class="speedline-note">${escapeHtml(presetText)}</div>
        </article>`;
    })
    .join("");
}

function renderSpeedThreats() {
  const threats = getSpeedThreats().slice(0, 6);
  $("#speed-threats").innerHTML = threats.length
    ? threats.map(({ mon, level, note }) => `<div class="threat-line"><strong>${escapeHtml(mon.name)}</strong><small>#${mon.rank} · ${escapeHtml(level)} · 原速 ${stat(mon, "速度")}</small><p>${escapeHtml(note)}</p></div>`).join("")
    : `<p class="empty">暂无明显速度威胁。</p>`;
}

function getOpponentConfigs() {
  const matchup = getMatchupReport(8);
  if (matchup.threats.length) {
    return matchup.threats.map((threat) => ({
      title: threat.name,
      risk: threat.level,
      note: `${threat.reasons.join("；")}。常见：${threat.commonMoves.map((item) => item.name).slice(0, 3).join(" / ") || "暂无"}。`,
      usage: threat.usage,
      show: true,
    }));
  }
  const ownTaunt = state.team.some((mon) => hasMove(mon, /挑衅|ちょうはつ|taunt/i));
  const ownSpeedControl = state.team.some((mon) => hasMove(mon, MOVE_PATTERNS.speedControl));
  const ownFakeOut = state.team.some((mon) => hasMove(mon, MOVE_PATTERNS.fakeOut));
  const ownGroundImmune = state.team.some((mon) => mon.types?.includes("飞行") || hasAbility(mon, /漂浮/));
  return [
    { title: "戏法空间", risk: ownTaunt ? "中" : "高", note: ownTaunt ? "有挑衅点，注意保护使用时机。" : "缺少直接阻止空间的手段。", show: true },
    { title: "顺风高速", risk: ownSpeedControl ? "中" : "高", note: ownSpeedControl ? "有控速手段，注意别被先手压制。" : "缺少控速时会被连续抢节奏。", show: true },
    { title: "威吓击掌", risk: state.format === "double" && !ownFakeOut ? "高" : "中", note: state.format === "double" ? "双打首回合要防节奏被拆。" : "单打主要关注威吓削弱物攻核心。", show: true },
    { title: "地面高压", risk: ownGroundImmune ? "中" : "高", note: ownGroundImmune ? "有地面免疫点，注意保护它。" : "缺少地面免疫，换人空间会受压。", show: true },
  ];
}

function renderOpponentConfigs() {
  const configs = getOpponentConfigs().slice(0, 6);
  $("#opponent-configs").innerHTML = configs.length
    ? configs.map((config) => `<div class="threat-line ${config.risk === "高" ? "danger" : ""}"><strong>${escapeHtml(config.title)}</strong><small>风险 ${escapeHtml(config.risk)}</small><p>${escapeHtml(config.note)}</p></div>`).join("")
    : `<p class="empty">选择队伍后显示风险。</p>`;
}

function renderTypeMap() {
  const counts = new Map(TYPES.map((type) => [type, 0]));
  state.team.forEach((mon) => (mon.types || []).forEach((type) => counts.set(type, (counts.get(type) || 0) + 1)));
  $("#type-map").innerHTML = state.team.length ? [...counts.entries()].map(([type, count]) => `<span class="tag ${count ? "active" : ""}">${type} ${count}</span>`).join("") : `<p class="empty">选择队伍后显示属性分布。</p>`;
}

function renderSets() {
  $("#sets").innerHTML = state.team.length
    ? state.team.map((mon) => {
        const config = editableConfigFor(mon);
        const role = mon.isExternalMember ? "外部队伍成员" : getRoles(mon).join(" / ") || "待定位";
        return `<div class="set-line set-line-real"><strong>${escapeHtml(mon.name)}</strong><small>${escapeHtml(role)}</small><dl><div><dt>道具</dt><dd>${escapeHtml(config.item || "暂无")}</dd></div><div><dt>特性</dt><dd>${escapeHtml(config.ability || "暂无")}</dd></div><div><dt>太晶/等级</dt><dd>${escapeHtml([config.teraType, config.level ? `Lv.${config.level}` : ""].filter(Boolean).join(" / ") || "暂无")}</dd></div><div><dt>招式</dt><dd>${escapeHtml(config.moves?.join(" / ") || "暂无")}</dd></div></dl></div>`;
      }).join("")
    : `<p class="empty">选择队伍后显示常见配置。</p>`;
}

function renderPlan() {
  const team = state.team;
  if (!team.length) {
    $("#game-plan").innerHTML = `<li>${escapeHtml(isUiLevel("beginner") ? "先选 3 到 6 只宝可梦，再看怎么打。" : "先选择 3 到 6 只宝可梦，再生成对局准备建议。")}</li>`;
    return;
  }
  const composition = getTeamCompositionReport();
  const byRank = [...team].filter((mon) => Number.isFinite(Number(mon.rank))).sort((a, b) => a.rank - b.rank);
  const anchors = byRank.length ? byRank.slice(0, 2) : team.slice(0, 2);
  const fastest = [...team].sort((a, b) => effectiveSpeed(b).value - effectiveSpeed(a).value)[0];
  const hazard = team.find((mon) => hasMove(mon, MOVE_PATTERNS.hazard));
  const removal = team.find((mon) => hasMove(mon, MOVE_PATTERNS.removal));
  const setup = team.find((mon) => hasMove(mon, MOVE_PATTERNS.setup));
  const speedControl = team.find((mon) => hasMove(mon, MOVE_PATTERNS.speedControl));
  const pivot = team.find((mon) => hasMove(mon, MOVE_PATTERNS.pivot));
  const priority = team.find((mon) => hasMove(mon, MOVE_PATTERNS.priority));
  const protect = team.filter((mon) => hasMove(mon, MOVE_PATTERNS.protect));
  const plans = [];
  plans.push(`阵容结构：${isUiLevel("beginner") ? composition.beginnerSummary : isUiLevel("intermediate") ? composition.intermediateSummary : composition.summary}`);
  plans.push(`核心路线：优先围绕 ${anchors.map((m) => m.name).join("、")} 建立输出或换入节奏。`);
  if (hazard) plans.push(`开局压力：${hazard.name} 可以铺场；${removal ? `${removal.name} 负责清场防止被反压。` : "队伍缺少清场手段，注意别被对面撒场滚雪球。"}`);
  else plans.push(state.format === "single" ? "单打缺少撒场点，主要依赖直接对攻、强化或轮转制造突破。" : "双打不依赖撒场，优先处理首回合站位、控速和集火目标。");
  if (speedControl) plans.push(`速度控制：${speedControl.name} 是主要控速点；让 ${fastest.name} 在控速后承担压制或收尾。`);
  else plans.push(`${fastest.name} 是当前最快有效速度点；没有稳定控速时，避免让它过早被消耗。`);
  if (setup) plans.push(`终盘路线：为 ${setup.name} 保留强化窗口，先削弱其常见换入点再尝试清场。`);
  else if (priority) plans.push(`终盘路线：${priority.name} 的先制招式适合收残，前中期重点压低对手血线。`);
  else plans.push("终盘路线不明显：建议补强化、先制或更明确的围巾/高速收尾位。");
  if (state.format === "double") {
    plans.push(protect.length >= 3 ? `双打节奏：已有 ${protect.length} 个守住位，可以围绕保护、换位和集火拆对面核心。` : `双打风险：守住数量偏少，容易被首回合集火或控速节奏惩罚。`);
  } else if (pivot) {
    plans.push(`轮转路线：${pivot.name} 可以用转场招式带核心安全上场，优先保留它的血量。`);
  } else {
    plans.push("单打换入链偏少，选出时要提前确认谁负责吃关键属性攻击。");
  }
  const planLimit = isUiLevel("beginner") ? 3 : isUiLevel("intermediate") ? 5 : 6;
  const plan = plans.slice(0, planLimit);
  $("#game-plan").innerHTML = plan.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function render() {
  updateDocumentState();
  renderHeroCopy();
  renderQuickstartCopy();
  renderSpeedlineSummary();
  renderSlots();
  renderList();
  renderTeamLibrary();
  renderSpeedlineTable();
  renderDataHealth();
  renderMetrics();
  renderRoles();
  renderSpeedThreats();
  renderOpponentConfigs();
  renderTypeMap();
  renderSets();
  renderPlan();
  renderShowdownExport();
  const existing = $("#battle-review-root");
  const next = renderBattleReviewPanel();
  if (existing) existing.outerHTML = next;
  else document.body.insertAdjacentHTML("beforeend", next);
}

function openTeamEditor(index) {
  const mon = state.team[index];
  const modal = $("#team-editor-backdrop");
  if (!mon || !modal) return;
  const config = editableConfigFor(mon);
  state.activeEditIndex = index;
  $("#team-editor-title").textContent = `编辑 ${mon.name}`;
  $("#edit-item").value = config.item || "";
  $("#edit-ability").value = config.ability || "";
  $("#edit-nature").value = config.nature || "";
  $("#edit-evs").value = config.evs || "";
  $("#edit-ivs").value = config.ivs || "";
  $("#edit-tera").value = config.teraType || "";
  $("#edit-level").value = config.level || "";
  $("#edit-gender").value = config.gender || "";
  $("#edit-ball").value = config.ball || "";
  $("#edit-language").value = config.language || "";
  $("#edit-shiny").checked = Boolean(config.shiny);
  [1, 2, 3, 4].forEach((moveIndex) => {
    const input = $(`#edit-move-${moveIndex}`);
    if (input) input.value = config.moves?.[moveIndex - 1] || "";
  });
  modal.hidden = false;
  document.body.classList.add("editor-open");
}

function closeTeamEditor() {
  $("#team-editor-backdrop")?.setAttribute("hidden", "");
  document.body.classList.remove("editor-open");
  state.activeEditIndex = null;
}

function saveTeamEditor() {
  const mon = state.team[state.activeEditIndex];
  if (!mon) return;
  setEditableConfig(mon, {
    item: $("#edit-item")?.value.trim(),
    ability: $("#edit-ability")?.value.trim(),
    nature: $("#edit-nature")?.value.trim(),
    evs: $("#edit-evs")?.value.trim(),
    ivs: $("#edit-ivs")?.value.trim(),
    teraType: $("#edit-tera")?.value.trim(),
    level: $("#edit-level")?.value.trim(),
    gender: $("#edit-gender")?.value,
    ball: $("#edit-ball")?.value.trim(),
    language: $("#edit-language")?.value.trim(),
    shiny: $("#edit-shiny")?.checked,
    moves: [1, 2, 3, 4].map((index) => $(`#edit-move-${index}`)?.value.trim() || ""),
  });
  state.showdownValidation = null;
  closeTeamEditor();
  render();
  saveDraft();
}

function openPalette() {
  const palette = $("#command-palette-backdrop");
  if (!palette) return;
  palette.hidden = false;
  document.body.classList.add("palette-open");
  state.searchOpen = true;
  renderList();
  window.setTimeout(() => $("#search")?.focus(), 0);
}

function closePalette(clearSearch = true) {
  const palette = $("#command-palette-backdrop");
  if (palette) palette.hidden = true;
  document.body.classList.remove("palette-open");
  state.searchOpen = false;
  if (clearSearch) {
    state.query = "";
    const input = $("#search");
    if (input) input.value = "";
  }
  renderList();
}

function bindEvents() {
  $("#ui-level-select")?.addEventListener("change", (event) => setUiLevel(event.target.value));
  $("#search")?.addEventListener("input", (event) => {
    state.query = event.target.value;
    state.searchOpen = true;
    renderList();
  });
  $("#clear-team")?.addEventListener("click", () => {
    state.team = [];
    state.teamConfigs = {};
    state.importedTeam = null;
    clearDraft();
    closeTeamEditor();
    closePalette(false);
    render();
  });
  $("#theme-select")?.addEventListener("change", (event) => setPreference("champion-lab-theme", event.target.value));
  $("#font-scale")?.addEventListener("change", (event) => setPreference("champion-lab-font-scale", event.target.value));
  $("#team-library-select")?.addEventListener("change", (event) => {
    state.selectedTeamId = event.target.value;
    renderTeamLibrary();
  });
  $("#team-season-select")?.addEventListener("change", (event) => {
    state.teamSeasonFilter = event.target.value;
    state.selectedTeamId = currentLibraryTeams()[0]?.id || "";
    renderTeamLibrary();
  });
  $("#team-source-select")?.addEventListener("change", (event) => {
    state.teamSourceFilter = event.target.value;
    state.selectedTeamId = currentLibraryTeams()[0]?.id || "";
    renderTeamLibrary();
  });
  $("#refresh-data")?.addEventListener("click", refreshData);
  $("#import-team-btn")?.addEventListener("click", importSelectedTeam);
  $("#copy-showdown")?.addEventListener("click", copyShowdownText);
  $("#copy-packed")?.addEventListener("click", copyPackedText);
  $("#validate-showdown")?.addEventListener("click", validateShowdownText);
  $("#download-showdown")?.addEventListener("click", downloadShowdownText);
  $("#download-json")?.addEventListener("click", downloadJsonDraft);
  $("#import-json-btn")?.addEventListener("click", () => $("#import-json")?.click());
  $("#import-json")?.addEventListener("change", (event) => importJsonDraft(event.target.files?.[0]));
  $("#ai-settings-toggle")?.addEventListener("click", () => {
    const panel = $("#ai-settings-panel");
    const button = $("#ai-settings-toggle");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    button?.setAttribute("aria-expanded", String(!panel.hidden));
  });
  $("#ai-provider")?.addEventListener("change", () => applyAIProviderPreset(true));
  $("#ai-model-select")?.addEventListener("change", updateModelInputVisibility);
  $("#ai-refresh-models")?.addEventListener("click", refreshAIModels);
  ["#ai-endpoint", "#ai-base-url", "#ai-model", "#ai-api-key"].forEach((selector) => {
    $(selector)?.addEventListener("input", updateAIConfigStatus);
    $(selector)?.addEventListener("change", updateAIConfigStatus);
  });
  $("#ai-save-config")?.addEventListener("click", saveAIConfig);
  $("#ai-test-config")?.addEventListener("click", testAIConfig);
  $("#ai-clear-config")?.addEventListener("click", clearAIConfig);
  $("#ai-build-config")?.addEventListener("click", () => generateAIAdvice("config"));
  $("#ai-complete-team")?.addEventListener("click", () => generateAIAdvice("complete-team"));
  $("#battle-review-btn")?.addEventListener("click", () => openBattleReview());
  $("#rule-allow-duplicate-items")?.addEventListener("change", saveRulePrefs);
  $("#rule-ignore-tera")?.addEventListener("change", saveRulePrefs);
  $("#refresh-status")?.addEventListener("click", refreshDataHealth);
  document.querySelectorAll("[data-format]").forEach((button) => button.addEventListener("click", () => setFormat(button.dataset.format)));
  $("#open-palette-btn")?.addEventListener("click", () => openPalette());
  $("#close-palette-btn")?.addEventListener("click", () => closePalette());
  document.querySelectorAll("[data-quickstart]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.quickstart;
      if (action === "import-team") {
        const teams = currentLibraryTeams();
        if (teams.length) {
          state.selectedTeamId = teams[0].id;
          importSelectedTeam();
        } else {
          openPalette();
        }
      } else if (action === "counter-target") {
        $("#ai-build-intent") && ($("#ai-build-intent").value = "counter-target");
        $("#ai-build-config")?.click();
      } else {
        openPalette();
      }
    });
  });
  $("#close-team-editor")?.addEventListener("click", closeTeamEditor);
  $("#cancel-team-editor")?.addEventListener("click", closeTeamEditor);
  $("#save-team-editor")?.addEventListener("click", saveTeamEditor);
  $("#team-editor-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "team-editor-backdrop") closeTeamEditor();
  });
  $("#command-palette-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "command-palette-backdrop") closePalette();
  });
  $("#battle-review-root")?.addEventListener("click", (event) => {
    if (event.target.id === "battle-review-root") closeBattleReview();
  });
  document.addEventListener("click", (event) => {
    if (event.target.id === "battle-review-root") closeBattleReview();
    const reviewOpen = event.target.closest("[data-battle-review-open]");
    if (reviewOpen) openBattleReview();
    const reviewClose = event.target.closest("[data-battle-review-close]");
    if (reviewClose) closeBattleReview();
    const reviewFormat = event.target.closest("[data-battle-review-format]")?.dataset.battleReviewFormat;
    if (reviewFormat) {
      state.battleReviewFormat = reviewFormat;
      const entries = battleReviewEntries(reviewFormat);
      state.battleReviewEntry = entries[0] || null;
      state.battleReviewOpen = true;
      render();
    }
    const reviewSelect = event.target.closest("[data-battle-review-select]")?.dataset.battleReviewSelect;
    if (reviewSelect) {
      state.battleReviewEntry = battleReviewEntries(state.battleReviewFormat).find((entry) => entry.id === reviewSelect) || null;
      render();
    }
  });
  $("#team-slots")?.addEventListener("click", (event) => {
    if (event.target.closest(".slot:not(.filled)")) openPalette();
    const editTarget = event.target.closest("[data-edit-index]");
    if (editTarget && !event.target.closest("[data-remove]")) openTeamEditor(Number(editTarget.dataset.editIndex));
  });
  $("#team-slots")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const editTarget = event.target.closest("[data-edit-index]");
    if (!editTarget) return;
    event.preventDefault();
    openTeamEditor(Number(editTarget.dataset.editIndex));
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
    }
    if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "r" && !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
      renderDecorPokemon();
    }
    if (event.key === "Escape" && !$("#battle-review-root")?.hidden) closeBattleReview();
    else if (event.key === "Escape" && !$("#team-editor-backdrop")?.hidden) closeTeamEditor();
    else if (event.key === "Escape" && !$("#command-palette-backdrop")?.hidden) closePalette();
  });
  document.addEventListener("click", (event) => {
    const add = event.target.closest("[data-add]")?.dataset.add;
    if (add && state.team.length < 6) {
      const mon = state.data.pokemon.find((p) => p.slug === add);
      if (addPokemonToTeam(mon)) {
        closePalette();
      }
    }
    const remove = event.target.closest("[data-remove]")?.dataset.remove;
    if (remove) {
      const mon = state.team.find((p) => p.slug === remove);
      if (mon) delete state.teamConfigs[configKey(mon)];
      state.team = state.team.filter((p) => p.slug !== remove);
      state.importedTeam = null;
      render();
      saveDraft();
    }
    const applyFormat = event.target.closest("[data-ai-apply]")?.dataset.aiApply;
    if (applyFormat) applyAIAdviceTeam(applyFormat);
    const viewFormat = event.target.closest("[data-ai-view]")?.dataset.aiView;
    if (viewFormat) {
      state.aiAdviceView = viewFormat;
      rerenderAIAdvice();
    }
    const adviceRef = adviceItemFromEvent(event);
    if (adviceRef && event.target.closest("[data-ai-apply-one]")) applyAdvicePokemon(adviceRef.item, adviceRef.format, false);
    if (adviceRef && event.target.closest("[data-ai-replace-one]")) applyAdvicePokemon(adviceRef.item, adviceRef.format, true);
    if (adviceRef && event.target.closest("[data-ai-copy-one]")) navigator.clipboard?.writeText(advicePokemonText(adviceRef.item));
    if (event.target.closest("[data-ai-battle-eval]")) runBattleEvalForAdvice();
    if (event.target.closest("[data-ai-retry]")) generateAIAdvice("new-team");
  });
}

async function init() {
  applyPreferences();
  loadRulePrefs();
  hydrateAIConfigForm();
  hydrateRulePrefs();
  await loadLocalData();
  await hydrateBattleHistory();
  const defaultFormat = state.rawData.defaultFormat || (state.rawData.formats.single ? "single" : Object.keys(state.rawData.formats)[0]);
  state.format = defaultFormat;
  state.data = state.rawData.formats[defaultFormat];
  restoreDraft();
  updateFormatButtons();
  updateMetaLabel();
  updateEditorOptions();
  renderDecorPokemon();
  bindEvents();
  bindDecorMotion();
  render();
}

init().catch((err) => {
  if (/正在等待启动抓取完成|champion-data/.test(err.message || "")) {
    waitForInitialData();
    return;
  }
  document.body.innerHTML = `<main class="topbar"><div><h1>数据未准备好</h1><p>${escapeHtml(err.message)}</p></div></main>`;
});
