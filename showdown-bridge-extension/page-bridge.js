(() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const result = (ok, message) => {
    window.dispatchEvent(new CustomEvent("champion-lab-import-result", { detail: JSON.stringify({ ok, message }) }));
    if (ok) window.alert("Champion Lab 队伍已导入 Showdown 队伍库。");
  };

  const importTeam = async (payload) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const modernTeams = window.PS?.teams;
      if (modernTeams?.unshift && modernTeams?.save) {
        modernTeams.unshift({
          name: payload.name || "Champion Lab Team",
          format: payload.formatId || "gen9championsvgc2026regmb",
          folder: "",
          packedTeam: payload.packedTeam,
          iconCache: null,
          isBox: false,
          key: "",
        });
        modernTeams.save();
        result(true, "Imported into the modern team storage.");
        return;
      }
      const legacyStorage = window.Storage;
      if (legacyStorage?.teams && legacyStorage?.saveTeams) {
        legacyStorage.teams.unshift({
          name: payload.name || "Champion Lab Team",
          format: payload.formatId || "gen9championsvgc2026regmb",
          folder: "",
          team: payload.packedTeam,
          capacity: 6,
          iconCache: "",
        });
        legacyStorage.saveTeams();
        result(true, "Imported into the legacy team storage.");
        return;
      }
      await sleep(250);
    }
    result(false, "Pokemon Showdown team storage did not become available.");
  };

  window.addEventListener("champion-lab-import", (event) => {
    let payload = event.detail;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    if (!payload?.packedTeam) return;
    void importTeam(payload);
  });
  document.documentElement.dataset.championLabBridgeReady = "true";
  window.dispatchEvent(new Event("champion-lab-bridge-ready"));
})();
