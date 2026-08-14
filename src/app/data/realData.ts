export const INITIAL_TEAM = [
  { id: "pelipper", name: "Pelipper", localizedName: "大嘴鸥", dex: "279", role: "天气启动 / 速度控制", item: "Focus Sash", itemLabel: "气势披带", ability: "Drizzle", abilityLabel: "降雨", stats: "H1/C32/S32", types: ["水", "飞行"], sprite: 279, locked: true, tone: "water", moves: ["Weather Ball", "Hurricane", "Tailwind", "Protect"], moveLabels: ["气象球", "暴风", "顺风", "守住"] },
  { id: "archaludon", name: "Archaludon", localizedName: "铝钢桥龙", dex: "1018", role: "雨天炮台", item: "Leftovers", itemLabel: "吃剩的东西", ability: "Stamina", abilityLabel: "持久力", stats: "H25/B3/C6/D25/S7", types: ["钢", "龙"], sprite: 1018, locked: false, tone: "steel", moves: ["Flash Cannon", "Dragon Pulse", "Electro Shot", "Protect"], moveLabels: ["加农光炮", "龙之波动", "电光束", "守住"] },
  { id: "sinistcha", name: "Sinistcha", localizedName: "来悲粗茶", dex: "1013", role: "空间启动 / 掩护辅助", item: "Colbur Berry", itemLabel: "刺耳果", ability: "Hospitality", abilityLabel: "款待", stats: "H32/B2/C1/D30/S1", types: ["草", "幽灵"], sprite: 1013, locked: false, tone: "grass", moves: ["Matcha Gotcha", "Trick Room", "Protect", "Rage Powder"], moveLabels: ["刷刷茶炮", "戏法空间", "守住", "愤怒粉"] },
  { id: "incineroar", name: "Incineroar", localizedName: "炽焰咆哮虎", dex: "727", role: "轮转辅助", item: "Chople Berry", itemLabel: "莲蒲果", ability: "Intimidate", abilityLabel: "威吓", stats: "H32/B11/D20/S3", types: ["火", "恶"], sprite: 727, locked: false, tone: "fire", moves: ["Flare Blitz", "Throat Chop", "Fake Out", "Parting Shot"], moveLabels: ["闪焰冲锋", "地狱突刺", "击掌奇袭", "抛下狠话"] },
  { id: "basculegion", name: "Basculegion", localizedName: "幽尾玄鱼", dex: "902", role: "高速终盘", item: "Choice Scarf", itemLabel: "讲究围巾", ability: "Adaptability", abilityLabel: "适应力", stats: "A32/B1/S32", types: ["水", "幽灵"], sprite: 902, locked: false, tone: "water", moves: ["Flip Turn", "Aqua Jet", "Wave Crash", "Last Respects"], moveLabels: ["快速折返", "水流喷射", "波动冲", "扫墓"] },
  { id: "venusaur", name: "Venusaur", localizedName: "妙蛙花", dex: "3", role: "Mega 耐久输出", item: "Venusaurite", itemLabel: "妙蛙花进化石", ability: "Chlorophyll", abilityLabel: "叶绿素", stats: "H32/B9/C10/D8/S7", types: ["草", "毒"], sprite: 3, locked: false, tone: "grass", moves: ["Sludge Bomb", "Leech Seed", "Earth Power", "Protect"], moveLabels: ["污泥炸弹", "寄生种子", "大地之力", "守住"] },
];

export function normalizeTeamMember(member: any, index = 0) {
  const known = INITIAL_TEAM.find((item) => item.id === member?.id || item.name === member?.name || item.sprite === member?.sprite);
  return {
    ...(known || {}),
    ...member,
    id: member?.id || member?.slug || member?.name || `slot-${index}`,
    name: member?.name || member?.species || member?.slug || known?.name || `成员 ${index + 1}`,
    localizedName: member?.localizedName || member?.nameCN || known?.localizedName || member?.name || member?.slug || "未命名",
    sprite: member?.sprite || member?.dex || known?.sprite || member?.id || "unknown",
    itemLabel: member?.itemLabel || known?.itemLabel || member?.item || "未记录",
    abilityLabel: member?.abilityLabel || known?.abilityLabel || member?.ability || "未记录",
    moves: member?.moves || known?.moves || [],
    moveLabels: member?.moveLabels || known?.moveLabels || member?.moves || [],
    types: member?.types || known?.types || [],
    locked: Boolean(member?.locked ?? known?.locked),
  };
}
