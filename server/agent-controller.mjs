import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_PYTHON = process.env.CHAMPION_SIDECAR_PYTHON || resolve(".venv", "Scripts", "python.exe");
const LAPLACE_ROOT = process.env.LAPLACE_ROOT || resolve("..", "Laplace-Pokemon-Showdown-AI");
const LAPLACE_PYTHON = process.env.CHAMPION_LAPLACE_PYTHON || resolve(".laplace-venv", "Scripts", "python.exe");
const SIDECAR = resolve("sidecar", "main.py");

export class AgentController {
  constructor() {
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.buffer = "";
    this.lastError = "";
    this.pythonPath = "";
  }

  available(policy = "structured") {
    const python = policy === "laplace" ? LAPLACE_PYTHON : DEFAULT_PYTHON;
    return existsSync(python) && existsSync(SIDECAR);
  }

  async ensureSidecar(policy = "structured") {
    const requestedPolicy = String(policy || "structured").toLowerCase().startsWith("laplace") ? "laplace" : "structured";
    const python = requestedPolicy === "laplace" ? LAPLACE_PYTHON : DEFAULT_PYTHON;
    if (this.child && this.child.exitCode === null && this.pythonPath === python) return this.ready;
    if (this.child && this.child.exitCode === null && this.pythonPath !== python) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
      this.ready = null;
      this.buffer = "";
    }
    if (!this.available(requestedPolicy)) {
      const detail = requestedPolicy === "laplace"
        ? `Laplace 环境未安装：${LAPLACE_PYTHON}；请确认 LAPLACE_ROOT=${LAPLACE_ROOT}`
        : "Python sidecar 未安装。请运行 .venv\\Scripts\\python.exe -m pip install -r sidecar\\requirements.txt。";
      throw Object.assign(new Error(detail), { status: 503, code: "SIDECAR_UNAVAILABLE" });
    }
    this.ready = new Promise((resolvePromise, reject) => {
      const child = spawn(python, [SIDECAR], {
        cwd: resolve("."),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          LAPLACE_ROOT,
        },
      });
      this.child = child;
      this.pythonPath = python;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Python sidecar startup timed out."));
      }, 15000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.onData(chunk, (message) => {
        if (message.event === "ready") {
          clearTimeout(timer);
          resolvePromise(message.state);
        }
      }));
      child.stderr.on("data", (chunk) => {
        this.lastError = String(chunk).replace(/password|assertion|cookie|authorization/gi, "[redacted]").slice(-2000);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        for (const pending of this.pending.values()) pending.reject(new Error(`Python sidecar exited (${code}).`));
        this.pending.clear();
      });
    });
    return this.ready;
  }

  onData(chunk, onEvent = () => {}) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines.filter(Boolean)) {
      try {
        const message = JSON.parse(line);
        if (message.event) onEvent(message);
        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(Object.assign(new Error(message.error || "Sidecar command failed."), { code: message.code || "SIDECAR_ERROR", status: 502 }));
        }
      } catch {}
    }
  }

  async command(command, payload = {}, timeoutMs = 15000) {
    await this.ensureSidecar(command === "start" ? payload.policy : this.pythonPath === LAPLACE_PYTHON ? "laplace" : "structured");
    const id = randomUUID();
    const response = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Sidecar ${command} timed out.`), { status: 504, code: "SIDECAR_TIMEOUT" }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
    return response;
  }

  async status() {
    const state = await this.command("status");
    return {
      ...state,
      sidecarPid: this.child?.pid || null,
      sidecarError: this.lastError || "",
    };
  }
  start(payload) { return this.command("start", payload, 30000); }
  stop() { return this.command("stop"); }
  replays(rulesetId = "") { return this.command("replays", { rulesetId }); }
  models(rulesetId = "") { return this.command("models", { rulesetId }); }
  ratings(rulesetId = "", showdownFormatId = "") { return this.command("ratings", { rulesetId, showdownFormatId }); }
  promote(payload) { return this.command("promote", payload); }

  shutdown() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.buffer = "";
    if (child && child.exitCode === null) {
      child.stdin.end();
      child.kill();
    }
  }
}

export const agentController = new AgentController();
