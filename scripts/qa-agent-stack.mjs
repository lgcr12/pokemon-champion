import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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

    const startGate = await json(port, "/api/agent/start", {
      method: "POST",
      body: JSON.stringify({ format: "double" }),
    });
    assert.equal(startGate.status, 400);
    assert.equal(startGate.body.code, "AUTOMATION_ACK_REQUIRED");
  } finally {
    child.kill("SIGTERM");
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Agent stack QA passed.");
