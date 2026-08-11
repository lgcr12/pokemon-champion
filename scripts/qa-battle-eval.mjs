const baseUrl = (process.env.QA_BASE_URL || "http://127.0.0.1:4174").replace(/\/$/, "");

// M-3 configuration data uses compact Champion stat notation. The evaluator
// must convert it before Showdown parses the team, otherwise every member gets
// silently simulated with 0 EVs.
const teamText = `Garchomp @ Clear Amulet
Ability: Rough Skin
Level: 50
EVs: H2/A32/S32
Jolly Nature
- Earthquake
- Dragon Claw
- Rock Slide
- Protect

Incineroar @ Sitrus Berry
Ability: Intimidate
Level: 50
EVs: H32/B12/D20/S4
Careful Nature
- Flare Blitz
- Knock Off
- Fake Out
- Parting Shot

Amoonguss @ Rocky Helmet
Ability: Regenerator
Level: 50
EVs: H32/B16/D16
Relaxed Nature
- Spore
- Rage Powder
- Pollen Puff
- Protect

Rillaboom @ Assault Vest
Ability: Grassy Surge
Level: 50
EVs: H28/A28/B4/S4
Adamant Nature
- Fake Out
- Grassy Glide
- Wood Hammer
- U-turn

Flutter Mane @ Booster Energy
Ability: Protosynthesis
Level: 50
EVs: H4/C28/S32
Timid Nature
- Moonblast
- Shadow Ball
- Dazzling Gleam
- Protect

Dragonite @ Lum Berry
Ability: Multiscale
Level: 50
EVs: H4/A28/S32
Jolly Nature
- Extreme Speed
- Dragon Claw
- Stomping Tantrum
- Protect`;

const response = await fetch(`${baseUrl}/api/battle-eval`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    format: "double",
    teamText,
    opponents: [{ id: "ev-mirror", title: "EV 转换镜像靶队", showdownText: teamText }],
    opponentSource: "fixed",
    gamesPerOpponent: 1,
    maxTurns: 35,
  }),
});
const data = await response.json().catch(() => ({}));
const failures = [];
if (response.status !== 422 || data.code !== "EXACT_FORMAT_ILLEGAL") {
  failures.push("traditional Showdown EV teams must be rejected instead of being silently simulated with a generic or custom format");
}

const buildResponse = await fetch(`${baseUrl}/api/team-build`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    format: "double",
    intent: "new-team",
    userGoal: "双打雨天铝钢桥龙",
    goalConstraints: { themes: ["rain"], requiredPokemon: [{ slug: "archaludon", name: "铝钢桥龙" }] },
  }),
});
const build = await buildResponse.json().catch(() => ({}));
const strictTeamText = (build.team || []).map((member) => [
  `${member.slug} @ ${member.item}`,
  `Ability: ${member.ability}`,
  "Level: 50",
  member.evs ? `EVs: ${member.evs}` : "",
  member.nature ? `${member.nature} Nature` : "",
  ...(member.moves || []).map((move) => `- ${move}`),
].filter(Boolean).join("\n")).join("\n\n");
const strictBattleResponse = await fetch(`${baseUrl}/api/battle-eval`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    format: "double",
    teamText: strictTeamText,
    opponents: [{ id: "strict-mirror", title: "严格构筑镜像靶队", showdownText: strictTeamText }],
    opponentSource: "fixed",
    gamesPerOpponent: 1,
    maxTurns: 35,
  }),
});
const strictBattle = await strictBattleResponse.json().catch(() => ({}));
const strictActionErrors = (strictBattle.results || []).flatMap((result) => result.actions?.errors || []);
const strictRecoveries = (strictBattle.results || []).flatMap((result) => result.actions?.recoveries || []);
if (!buildResponse.ok || !build.ok || (build.team || []).length !== 6) failures.push("strict builder did not return a six-member M-3 rain Archaludon team");
if (!strictBattleResponse.ok || !strictBattle.ok || Number(strictBattle.games || 0) !== 2) failures.push("strict M-3 team did not complete both mirrored simulations");
if (strictActionErrors.length || strictRecoveries.length) failures.push(`strict M-3 simulation had target or action recovery errors: ${[...strictActionErrors, ...strictRecoveries].join(" | ")}`);
if (strictBattle.rulesEngine?.id !== "gen9championsvgc2026regmb" || !strictBattle.rulesEngine?.exact) {
  failures.push(`strict M-3 simulation did not use exact Champions M-B rules: ${strictBattle.rulesEngine?.id || "missing"}`);
}

const bridgeResponse = await fetch(`${baseUrl}/api/showdown-bridge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ format: "double", name: "QA Bridge", teamText: strictTeamText }),
});
const bridge = await bridgeResponse.json().catch(() => ({}));
const bridgeFetch = bridge.token
  ? await fetch(`${baseUrl}/api/showdown-bridge?token=${encodeURIComponent(bridge.token)}`).then((res) => res.json().catch(() => ({})))
  : {};
if (!bridgeResponse.ok || !bridge.ok || bridge.rulesEngine?.id !== "gen9championsvgc2026regmb" || !bridgeFetch.payload?.packedTeam) {
  failures.push("one-click Showdown bridge did not issue a verified M-B packed team payload");
}
if (bridge.token) {
  await fetch(`${baseUrl}/api/showdown-bridge/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bridge.token }),
  });
}

const feedbackBuildResponse = await fetch(`${baseUrl}/api/team-build`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    format: "double",
    intent: "new-team",
    userGoal: "双打雨天铝钢桥龙",
    goalConstraints: { themes: ["rain"], requiredPokemon: [{ slug: "archaludon", name: "铝钢桥龙" }] },
    battleHistory: [{ winRate: 0, feedbackSignals: "missing-speed-control;missing-protect", avoid: "实战负于控速队" }],
  }),
});
const feedbackBuild = await feedbackBuildResponse.json().catch(() => ({}));
const feedbackPriorities = feedbackBuild.buildReport?.feedback?.priorities || [];
if (!feedbackBuildResponse.ok || !feedbackBuild.ok || feedbackBuild.buildMethod === "sample" || !feedbackPriorities.includes("speed") || !feedbackPriorities.includes("protect")) {
  failures.push("strict builder did not consume eligible battle feedback as a soft rebuild priority");
}

console.log(JSON.stringify({ ok: failures.length === 0, failures, rejectedLegacyTeam: { status: response.status, code: data.code }, strictBuildTeam: (build.team || []).map((member) => member.slug), strictGames: strictBattle.games, rulesEngine: strictBattle.rulesEngine, bridgeRulesEngine: bridge.rulesEngine, feedbackPriorities, strictActionErrors, strictRecoveries }, null, 2));
if (failures.length) process.exitCode = 1;
