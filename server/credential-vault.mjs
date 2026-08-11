import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const POWERSHELL = process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";

const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($encoded)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`Windows DPAPI operation failed (${code}): ${stderr.trim() || "unknown error"}`));
    });
    child.stdin.end(String(input || ""), "utf8");
  });
}

export class CredentialVault {
  constructor({ root = resolve(".cache", "showdown-account") } = {}) {
    this.root = root;
    this.path = join(root, "credential.bin");
  }

  async save(password) {
    if (process.platform !== "win32") throw new Error("Credential storage currently requires Windows DPAPI.");
    const cipher = (await runPowerShell(PROTECT_SCRIPT, password)).trim();
    if (!cipher) throw new Error("DPAPI returned an empty credential.");
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, cipher, { encoding: "utf8", mode: 0o600 });
  }

  async load() {
    if (process.platform !== "win32") throw new Error("Credential storage currently requires Windows DPAPI.");
    const cipher = (await readFile(this.path, "utf8")).trim();
    return runPowerShell(UNPROTECT_SCRIPT, cipher);
  }

  async exists() {
    try {
      await readFile(this.path);
      return true;
    } catch {
      return false;
    }
  }

  async clear() {
    await rm(this.path, { force: true });
  }
}
