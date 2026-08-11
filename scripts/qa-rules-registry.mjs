import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const DRIFT_SOURCE = `data:text/plain,${encodeURIComponent(`
export const Formats = [
  {
    name: '[Gen 9 Champions] BSS Reg M-B',
    mod: 'gen9',
    ruleset: ['Flat Rules', 'VGC Timer'],
  },
];
`)}`;

async function request(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  return { status: response.status, body: await response.json() };
}

async function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before readiness:\n${output}`);
    try {
      await request(port, "/api/rules/active");
      return { child, output: () => output };
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  child.kill();
  throw new Error(`Server did not become ready:\n${output}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolvePromise) => child.once("close", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 3000)),
  ]);
}

async function testActiveRegistry() {
  const port = 4291;
  const registryRoot = await mkdtemp(join(tmpdir(), "champion-forge-rules-active-"));
  const server = await startServer(port, { RULE_REGISTRY_ROOT: registryRoot });
  try {
    const active = await request(port, "/api/rules/active");
    assert.equal(active.status, 200);
    assert.equal(active.body.status, "ACTIVE");
    assert.equal(active.body.canOperate, true);
    assert.equal(active.body.active.length, 2);
    const single = active.body.active.find((item) => item.battleType === "single");
    const double = active.body.active.find((item) => item.battleType === "double");
    assert.ok(single?.rulesetId);
    assert.ok(double?.rulesetId);

    const history = await request(port, "/api/rules/history");
    assert.equal(history.status, 200);
    assert.ok(history.body.history.some((item) => item.rulesetId === single.rulesetId));

    const validation = await request(port, "/api/validate-team", {
      method: "POST",
      body: JSON.stringify({ format: "single", text: "" }),
    });
    assert.equal(validation.status, 200);
    assert.equal(validation.body.rulesetId, single.rulesetId);
    assert.equal(validation.body.showdownFormatId, single.showdownFormatId);

    const build = await request(port, "/api/team-build", {
      method: "POST",
      body: JSON.stringify({ format: "single", goalConstraints: { unavailablePokemon: [{ name: "QA unavailable Pokemon" }] } }),
    });
    assert.equal(build.status, 422);
    assert.equal(build.body.rulesetId, single.rulesetId);
    assert.equal(build.body.showdownFormatId, single.showdownFormatId);

    const stale = await request(port, "/api/validate-team", {
      method: "POST",
      body: JSON.stringify({ format: "single", rulesetId: "champions-single-old-deadbeef", text: "" }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "RULESET_MISMATCH");

    const mismatch = await request(port, "/api/validate-team", {
      method: "POST",
      body: JSON.stringify({ format: "single", rulesetId: double.rulesetId, text: "" }),
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, "FORMAT_RULESET_MISMATCH");

    const synced = await request(port, "/api/rules/sync", { method: "POST" });
    assert.equal(synced.status, 200);
    assert.equal(synced.body.status, "ACTIVE");
  } finally {
    await stopServer(server.child);
    await rm(registryRoot, { recursive: true, force: true });
  }
}

async function testRuleDriftStopsBuilds() {
  const port = 4292;
  const registryRoot = await mkdtemp(join(tmpdir(), "champion-forge-rules-drift-"));
  const server = await startServer(port, { SHOWDOWN_FORMATS_SOURCE: DRIFT_SOURCE, RULE_REGISTRY_ROOT: registryRoot });
  try {
    const active = await request(port, "/api/rules/active");
    assert.equal(active.body.status, "RULE_DRIFT");
    assert.equal(active.body.canOperate, false);
    assert.ok(active.body.differences.length > 0);

    const build = await request(port, "/api/team-build", {
      method: "POST",
      body: JSON.stringify({ format: "single" }),
    });
    assert.equal(build.status, 503);
    assert.equal(build.body.code, "RULE_REGISTRY_NOT_ACTIVE");
  } finally {
    await stopServer(server.child);
    await rm(registryRoot, { recursive: true, force: true });
  }
}

await testActiveRegistry();
await testRuleDriftStopsBuilds();
console.log("Rules registry QA passed.");
