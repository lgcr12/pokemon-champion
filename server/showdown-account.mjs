import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CredentialVault } from "./credential-vault.mjs";

const ACCOUNT_ROOT = process.env.SHOWDOWN_ACCOUNT_ROOT || resolve(".cache", "showdown-account");
const STATE_PATH = join(ACCOUNT_ROOT, "state.json");
const PROFILE_PATH = join(ACCOUNT_ROOT, "browser");
const USER_API = "https://pokemonshowdown.com/users";
const PLAY_URL = "https://play.pokemonshowdown.com/";
const STATES = new Set(["UNCONFIGURED", "CHECKING_NAME", "REGISTERING", "WAITING_FOR_HUMAN_VERIFICATION", "VERIFYING_ACCOUNT", "READY", "LOCKED", "FAILED"]);

function toUserid(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18);
}

function safePrefix(value = "ChampionForge") {
  const prefix = String(value || "ChampionForge").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  return prefix || "ChampionForge";
}

function generatePassword() {
  return `${randomBytes(12).toString("base64url")}!aA7`;
}

async function registered(username) {
  const id = toUserid(username);
  if (!id) return false;
  try {
    const response = await fetch(`${USER_API}/${id}.json`, { signal: AbortSignal.timeout(10000), headers: { accept: "application/json" } });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return Boolean(data?.registertime || data?.username);
  } catch (error) {
    if (/HTTP 404/.test(error.message)) return false;
    throw new Error(`Unable to check Showdown username availability: ${error.message}`);
  }
}

export class ShowdownAccountManager {
  constructor() {
    this.vault = new CredentialVault({ root: ACCOUNT_ROOT });
    this.context = null;
    this.workflow = null;
    this.state = {
      status: "UNCONFIGURED",
      username: "",
      message: "尚未配置专用账号。",
      candidates: [],
      updatedAt: null,
    };
  }

  async initialize() {
    try {
      const saved = JSON.parse(await readFile(STATE_PATH, "utf8"));
      this.state = { ...this.state, ...saved };
      if (!STATES.has(this.state.status)) this.state.status = "FAILED";
      if (this.state.status === "READY" && !(await this.vault.exists())) {
        await this.update({ status: "FAILED", message: "账号凭据缺失，请删除本地配置后重新注册。" });
      }
    } catch {}
    return this.publicState();
  }

  publicState() {
    return {
      status: this.state.status,
      username: this.state.username,
      message: this.state.message,
      candidates: this.state.candidates || [],
      updatedAt: this.state.updatedAt,
      browserOpen: Boolean(this.context),
      credentialStored: this.state.status === "READY" || this.state.status === "WAITING_FOR_HUMAN_VERIFICATION" || this.state.status === "REGISTERING" || this.state.status === "VERIFYING_ACCOUNT",
    };
  }

  async update(patch) {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    await mkdir(ACCOUNT_ROOT, { recursive: true });
    const persisted = { ...this.state };
    delete persisted.candidates;
    await writeFile(STATE_PATH, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    return this.publicState();
  }

  async candidates(prefix = "ChampionForge") {
    const base = safePrefix(prefix);
    const values = [];
    for (let attempt = 0; attempt < 12 && values.length < 4; attempt += 1) {
      const suffix = randomBytes(2).readUInt16BE(0).toString(36).toUpperCase().slice(0, 4);
      const candidate = `${base}${suffix}`.slice(0, 18);
      if (!values.includes(candidate) && !(await registered(candidate))) values.push(candidate);
    }
    return values;
  }

  async bootstrap({ prefix = "ChampionForge", username = "" } = {}) {
    if (this.state.status !== "UNCONFIGURED" && this.state.username) throw Object.assign(new Error("当前工作区已经配置专用账号，请先删除本地账号配置。"), { status: 409, code: "ACCOUNT_ALREADY_CONFIGURED" });
    await this.update({ status: "CHECKING_NAME", message: "正在检查用户名。" });
    const options = await this.candidates(prefix);
    const selected = String(username || options[0] || "").trim();
    if (!toUserid(selected) || selected.length > 18) throw Object.assign(new Error("用户名必须包含字母或数字，且不超过 18 个字符。"), { status: 400, code: "INVALID_USERNAME" });
    if (await registered(selected)) throw Object.assign(new Error("该 Showdown 用户名已被注册。"), { status: 409, code: "USERNAME_TAKEN", candidates: options });
    await this.vault.save(generatePassword());
    await this.update({ status: "REGISTERING", username: selected, candidates: options, message: "正在打开 Showdown 官方注册页面。" });
    this.workflow = this.runRegistration().finally(() => { this.workflow = null; });
    return this.publicState();
  }

  async ensureBrowser() {
    if (this.context) return this.context;
    await mkdir(PROFILE_PATH, { recursive: true });
    this.context = await chromium.launchPersistentContext(PROFILE_PATH, {
      headless: false,
      viewport: { width: 1120, height: 760 },
    });
    this.context.on("close", () => { this.context = null; });
    return this.context;
  }

  async runRegistration() {
    try {
      const context = await this.ensureBrowser();
      const page = context.pages()[0] || await context.newPage();
      await page.goto(PLAY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      const password = await this.vault.load();
      const chooseName = page.locator('button[name="login"], button:has-text("Choose name"), button:has-text("选择用户名")').first();
      await chooseName.waitFor({ state: "visible", timeout: 30000 });
      await chooseName.click();
      const usernameInput = page.locator('input[name="username"], input[name="user"], input[placeholder*="name" i]').first();
      await usernameInput.fill(this.state.username);
      await usernameInput.press("Enter");
      await page.waitForTimeout(1200);

      const popupText = await page.locator(".ps-popup").last().innerText().catch(() => "");
      if (/IP .*locked|locked due to being a proxy|disable any proxies/i.test(popupText)) {
        await this.update({ status: "LOCKED", message: "Showdown 已拒绝当前代理 IP。请关闭代理或切换到正常家庭网络后删除本地配置并重试。" });
        return;
      }

      const registerButton = page.locator('button[name="register"], button:has-text("Register"), button:has-text("注册")').first();
      if (await registerButton.isVisible().catch(() => false)) await registerButton.click();
      const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
      await passwordInput.waitFor({ state: "visible", timeout: 15000 });
      await passwordInput.fill(password);
      const confirm = page.locator('input[name="cpassword"], input[name="password2"], input[type="password"]').nth(1);
      if (await confirm.isVisible().catch(() => false)) await confirm.fill(password);

      const captcha = page.locator('iframe[src*="captcha" i], .g-recaptcha, [data-sitekey], input[name*="captcha" i]').first();
      if (await captcha.isVisible().catch(() => false)) {
        await this.update({ status: "WAITING_FOR_HUMAN_VERIFICATION", message: "请在已打开的 Showdown 官方页面完成人机验证，然后点击继续。" });
        return;
      }
      const submit = page.locator('button[type="submit"], button[name="register"], button:has-text("Register")').last();
      if (await submit.isVisible().catch(() => false)) await submit.click();
      await page.waitForTimeout(2500);
      await this.verify();
    } catch (error) {
      await this.update({ status: "FAILED", message: `注册流程失败：${error.message}` });
    }
  }

  async verify() {
    await this.update({ status: "VERIFYING_ACCOUNT", message: "正在验证账号注册状态。" });
    if (await registered(this.state.username)) {
      await this.update({ status: "READY", message: "专用 Showdown 账号已连接。" });
      if (this.context) await this.context.close().catch(() => {});
      return this.publicState();
    }
    await this.update({ status: "WAITING_FOR_HUMAN_VERIFICATION", message: "官方尚未确认注册，请在浏览器完成验证后重试。" });
    return this.publicState();
  }

  async continue() {
    if (!this.state.username) throw Object.assign(new Error("尚未开始账号注册。"), { status: 409, code: "ACCOUNT_UNCONFIGURED" });
    if (await registered(this.state.username)) return this.verify();
    if (this.state.status === "LOCKED") throw Object.assign(new Error("Showdown 已锁定当前代理 IP。请切换到正常网络后删除本地配置并重试。"), { status: 423, code: "SHOWDOWN_IP_LOCKED" });
    if (this.context) {
      const page = this.context.pages().at(-1);
      if (page) {
        const submit = page.locator('button[type="submit"], button[name="register"], button:has-text("Register")').last();
        if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {});
        await page.waitForTimeout(2500);
        return this.verify();
      }
    }
    if (!this.workflow) this.workflow = this.runRegistration().finally(() => { this.workflow = null; });
    return this.publicState();
  }

  async credential() {
    if (this.state.status !== "READY") throw Object.assign(new Error("Showdown 账号尚未就绪。"), { status: 409, code: "ACCOUNT_NOT_READY" });
    return { username: this.state.username, password: await this.vault.load() };
  }

  async clear() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    await this.vault.clear();
    await rm(PROFILE_PATH, { recursive: true, force: true });
    await rm(STATE_PATH, { force: true });
    this.state = { status: "UNCONFIGURED", username: "", message: "尚未配置专用账号。", candidates: [], updatedAt: new Date().toISOString() };
    return this.publicState();
  }
}

export const showdownAccount = new ShowdownAccountManager();
