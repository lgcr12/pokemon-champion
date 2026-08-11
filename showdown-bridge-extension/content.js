(() => {
  const token = new URLSearchParams(location.search).get("champion-lab-import")?.trim() || "";
  if (!token) return;

  // Fetches from the extension world retain the extension's localhost permission.
  // The Showdown page itself must only receive the already-verified payload.
  const complete = () => fetch("http://127.0.0.1:4174/api/showdown-bridge/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => {});

  window.addEventListener("champion-lab-import-result", (event) => {
    let result = event.detail || {};
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {
        result = {};
      }
    }
    if (!result.ok) return;
    history.replaceState(null, "", location.pathname);
    complete();
  }, { once: true });

  let started = false;
  const startImport = () => {
    if (started) return;
    started = true;
    fetch(`http://127.0.0.1:4174/api/showdown-bridge?token=${encodeURIComponent(token)}`)
      .then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok || !data?.ok || !data.payload) throw new Error(data?.error || "Import token is unavailable.");
        // Content scripts and the page run in different JS worlds. Serialize the
        // payload so the page never receives an inaccessible extension object.
        window.dispatchEvent(new CustomEvent("champion-lab-import", { detail: JSON.stringify(data.payload) }));
      })
      .catch((error) => {
        console.warn("Champion Lab import bridge could not load a team.", error);
        window.dispatchEvent(new CustomEvent("champion-lab-import-result", {
          detail: JSON.stringify({ ok: false, message: error?.message || "无法读取本地导入令牌。" }),
        }));
      });
  };

  window.addEventListener("champion-lab-bridge-ready", startImport, { once: true });
  if (document.documentElement.dataset.championLabBridgeReady === "true") startImport();
})();
