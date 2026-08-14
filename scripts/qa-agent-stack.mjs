import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentController } from "../server/agent-controller.mjs";
import { CredentialVault } from "../server/credential-vault.mjs";
import { classifyRegistrationIssue } from "../server/showdown-account.mjs";

const ROOT = resolve(".");
assert.equal(classifyRegistrationIssue("The Pokémon you entered is incorrect.").code, "CAPTCHA_INVALID");
assert.equal(classifyRegistrationIssue("Your IP is locked due to being a proxy.").status, "LOCKED");
assert.equal(classifyRegistrationIssue("This username is already registered.").code, "USERNAME_TAKEN");
const python = resolve(".venv", "Scripts", "python.exe");
const policyQa = spawnSync(python, [resolve("scripts", "qa-agent-policy.py")], { cwd: ROOT, encoding: "utf8" });
assert.equal(policyQa.status, 0, policyQa.stderr || policyQa.stdout);

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/rules/active`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error("Server readiness timeout.");
}

async function json(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  return { status: response.status, body: await response.json() };
}

const tempRoot = await mkdtemp(join(tmpdir(), "champion-forge-agent-"));
try {
  const vault = new CredentialVault({ root: join(tempRoot, "vault") });
  await vault.save("qa-secret-A7!");
  assert.equal(await vault.load(), "qa-secret-A7!");
  await vault.clear();

  const controller = new AgentController();
  assert.equal((await controller.status()).status, "IDLE");
  assert.ok(Array.isArray((await controller.replays()).items));
  assert.ok(Array.isArray((await controller.models()).items));
  assert.ok(Array.isArray((await controller.ratings()).items));
  const sidecar = controller.child;
  const sidecarExit = once(sidecar, "exit");
  controller.shutdown();
  await sidecarExit;
  assert.ok(sidecar.killed || sidecar.exitCode !== null || sidecar.signalCode, "sidecar process did not terminate");

  const port = 4293;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RULE_REGISTRY_ROOT: join(tempRoot, "rules"),
      SHOWDOWN_ACCOUNT_ROOT: join(tempRoot, "account"),
      AGENT_DATA_ROOT: join(tempRoot, "agent-data"),
    },
    stdio: "ignore",
  });
  try {
    await waitForServer(port, child);
    const account = await json(port, "/api/agent/account/status");
    assert.equal(account.status, 200);
    assert.equal(account.body.status, "UNCONFIGURED");

    const agent = await json(port, "/api/agent/status");
    assert.equal(agent.status, 200);
    assert.equal(agent.body.status, "IDLE");

    const ratings = await json(port, "/api/agent/ratings");
    assert.equal(ratings.status, 200);
    assert.ok(Array.isArray(ratings.body.items));

    const startGate = await json(port, "/api/agent/start", {
      method: "POST",
      body: JSON.stringify({ format: "double" }),
    });
    assert.equal(startGate.status, 400);
    assert.equal(startGate.body.code, "AUTOMATION_ACK_REQUIRED");

    const trainGate = await json(port, "/api/agent/train", {
      method: "POST",
      body: JSON.stringify({ format: "single" }),
    });
    assert.equal(trainGate.status, 422);
    assert.equal(trainGate.body.status, "insufficient_data");

    const rules = await json(port, "/api/rules/active");
    const singleRuleset = rules.body.active.find((item) => item.battleType === "single");
    assert.ok(singleRuleset?.rulesetId, "single ruleset was not available for policy training QA");
    const traceRoot = join(tempRoot, "agent-data", "traces", singleRuleset.rulesetId);
    await mkdir(traceRoot, { recursive: true });
    const writeTrace = async (index, policyVersion = "structured-visible-state-v1") => {
      const trace = {
        schemaVersion: 1,
        rulesetId: singleRuleset.rulesetId,
        battleType: "single",
        battleId: `qa-battle-${index}`,
        policyVersion,
        startedAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        finishedAt: `2026-01-01T00:${String(index).padStart(2, "0")}:30.000Z`,
        result: index % 2 ? "win" : "loss",
        events: [{ type: "agent-action", command: index % 2 ? "/choose move 1" : "/choose switch 2" }],
      };
      await writeFile(join(traceRoot, `qa-trace-${index}.json`), `${JSON.stringify(trace)}\n`, "utf8");
    };
    for (let index = 1; index <= 6; index += 1) await writeTrace(index);
    const trainingBody = JSON.stringify({ format: "single", rulesetId: singleRuleset.rulesetId, baseVersion: "structured-visible-state-v1" });
    const firstTraining = await json(port, "/api/agent/train", { method: "POST", body: trainingBody });
    assert.equal(firstTraining.status, 200);
    assert.equal(firstTraining.body.status, "trained");
    assert.ok(firstTraining.body.policy.trainingFingerprint);
    const repeatedTraining = await json(port, "/api/agent/train", { method: "POST", body: trainingBody });
    assert.equal(repeatedTraining.status, 200);
    assert.equal(repeatedTraining.body.status, "no_new_data");
    assert.equal(repeatedTraining.body.existingVersion, firstTraining.body.policy.version);

    await writeTrace(7, "replay-import");
    const replayOnlyTraining = await json(port, "/api/agent/train", { method: "POST", body: trainingBody });
    assert.equal(replayOnlyTraining.body.status, "no_new_data");
    for (let index = 8; index <= 12; index += 1) await writeTrace(index);
    const incrementalTraining = await json(port, "/api/agent/train", { method: "POST", body: trainingBody });
    assert.equal(incrementalTraining.body.status, "trained");
    assert.notEqual(incrementalTraining.body.policy.trainingFingerprint, firstTraining.body.policy.trainingFingerprint);
    const models = await json(port, `/api/agent/models?rulesetId=${encodeURIComponent(singleRuleset.rulesetId)}`);
    assert.equal(models.status, 200);
    assert.equal(models.body.challengers.length, 2, "model registry should expose one card per unique training fingerprint");

    const promoteGate = await json(port, "/api/agent/promote", {
      method: "POST",
      body: JSON.stringify({ format: "single", version: "unverified-challenger" }),
    });
    assert.equal(promoteGate.status, 409);
    assert.equal(promoteGate.body.code, "MODEL_NOT_READY");
  } finally {
    child.kill("SIGTERM");
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Agent stack QA passed.");
