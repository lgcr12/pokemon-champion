import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { CredentialVault } from "./credential-vault.mjs";

const ACCOUNT_ROOT = process.env.SHOWDOWN_ACCOUNT_ROOT || resolve(".cache", "showdown-account");
const STATE_PATH = join(ACCOUNT_ROOT, "state.json");
const PROFILE_PATH = join(ACCOUNT_ROOT, "browser");
const DEFAULT_PROFILE_PATH = join(PROFILE_PATH, "Default");
const PREFERENCES_PATH = join(DEFAULT_PROFILE_PATH, "Preferences");
const PASSWORD_STORE_FILES = ["Login Data", "Login Data-journal", "Login Data For Account", "Login Data For Account-journal"];
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

export function classifyRegistrationIssue(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (/IP .*locked|locked due to being a proxy|disable any proxies|proxy or vpn/i.test(normalized)) {
    return { code: "SHOWDOWN_IP_LOCKED", status: "LOCKED", message: "Showdown 已拒绝当前代理或 VPN 网络。请切换到正常网络后删除本地配置并重试。" };
  }
  if (/too many (?:accounts|registrations)|register(?:ing)? too (?:many|quickly)|try again later|rate.?limit/i.test(normalized)) {
    return { code: "SHOWDOWN_RATE_LIMITED", status: "LOCKED", message: "Showdown 暂时限制了当前网络的注册请求。请稍后再试，不要重复创建账号。" };
  }
  if (/captcha|what is this pokemon|pok[eé]mon.*(?:incorrect|wrong)|incorrect.*pok[eé]mon/i.test(normalized)) {
    return { code: "CAPTCHA_INVALID", status: "WAITING_FOR_HUMAN_VERIFICATION", message: "宝可梦识别答案未通过。请在 Showdown 官方窗口更正答案后再继续。" };
  }
  if (/already registered|username.*(?:taken|exists|registered)|name.*(?:taken|registered)/i.test(normalized)) {
    return { code: "USERNAME_TAKEN", status: "FAILED", message: "该用户名已被其他账号注册。请删除本地配置并重新生成用户名。" };
  }
  if (/passwords? do not match|confirm.*password/i.test(normalized)) {
    return { code: "PASSWORD_MISMATCH", status: "WAITING_FOR_HUMAN_VERIFICATION", message: "官方页面报告密码确认不一致。系统已安全重填密码，请再次提交。" };
  }
  if (/password.*(?:short|weak|invalid|must|require)/i.test(normalized)) {
    return { code: "PASSWORD_REJECTED", status: "FAILED", message: "Showdown 未接受生成的密码。请删除本地配置后重新注册。" };
  }
  return { code: "SHOWDOWN_REJECTED", status: "WAITING_FOR_HUMAN_VERIFICATION", message: "Showdown 未接受本次注册。请在官方窗口检查红色错误提示，修正后再继续。" };
}

export class ShowdownAccountManager {
  constructor() {
    this.vault = new CredentialVault({ root: ACCOUNT_ROOT });
    this.context = null;
    this.workflow = null;
    this.lastRejectedCaptcha = "";
    this.credentialStored = false;
    this.state = {
      status: "UNCONFIGURED",
      username: "",
      message: "尚未配置专用账号。",
      verificationCode: "",
      candidates: [],
      updatedAt: null,
    };
  }

  async initialize() {
    this.credentialStored = await this.vault.exists().catch(() => false);
    try {
      const saved = JSON.parse(await readFile(STATE_PATH, "utf8"));
      this.state = { ...this.state, ...saved };
      if (!STATES.has(this.state.status)) this.state.status = "FAILED";
      if (this.state.status === "READY" && !this.credentialStored) {
        await this.update({ status: "FAILED", message: "账号凭据缺失，请删除本地配置后重新注册。" });
      }
      if (["REGISTERING", "VERIFYING_ACCOUNT"].includes(this.state.status)) {
        await this.update({
          status: "WAITING_FOR_HUMAN_VERIFICATION",
          verificationCode: "BROWSER_ACTION_REQUIRED",
          message: "注册流程曾被中断。请重新打开 Showdown 验证窗口继续。",
        });
      }
      if (this.state.status === "WAITING_FOR_HUMAN_VERIFICATION" && !this.state.verificationCode) {
        await this.update({
          verificationCode: "BROWSER_ACTION_REQUIRED",
          message: "请重新打开 Showdown 验证窗口，完成官方宝可梦识别后继续。",
        });
      }
    } catch {}
    return this.publicState();
  }

  publicState() {
    return {
      status: this.state.status,
      username: this.state.username,
      message: this.state.message,
      verificationCode: this.state.verificationCode || "",
      candidates: this.state.candidates || [],
      updatedAt: this.state.updatedAt,
      browserOpen: Boolean(this.context),
      credentialStored: this.credentialStored,
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
    this.credentialStored = true;
    await this.update({ status: "REGISTERING", username: selected, candidates: options, verificationCode: "", message: "正在打开 Showdown 官方注册页面。" });
    this.workflow = this.runRegistration().finally(() => { this.workflow = null; });
    return this.publicState();
  }

  async ensureBrowser() {
    if (this.context) return this.context;
    await this.hardenBrowserProfile();
    this.context = await chromium.launchPersistentContext(PROFILE_PATH, {
      headless: false,
      viewport: { width: 1120, height: 760 },
      args: ["--disable-save-password-bubble"],
    });
    this.context.on("close", () => { this.context = null; });
    return this.context;
  }

  async hardenBrowserProfile() {
    await mkdir(DEFAULT_PROFILE_PATH, { recursive: true });
    for (const filename of PASSWORD_STORE_FILES) {
      await rm(join(DEFAULT_PROFILE_PATH, filename), { force: true });
    }
    let preferences = {};
    try {
      preferences = JSON.parse(await readFile(PREFERENCES_PATH, "utf8"));
    } catch {}
    preferences.credentials_enable_service = false;
    preferences.profile = {
      ...(preferences.profile || {}),
      password_manager_enabled: false,
    };
    await writeFile(PREFERENCES_PATH, JSON.stringify(preferences), "utf8");
  }

  async registrationPage() {
    if (!this.context) return null;
    return this.context.pages().at(-1) || null;
  }

  async bringToFront(page) {
    await page.bringToFront().catch(() => {});
    await page.evaluate(() => window.focus()).catch(() => {});
  }

  async inspectRegistrationPage(page) {
    const popup = page.locator(".ps-popup").last();
    const popupVisible = await popup.isVisible().catch(() => false);
    if (!popupVisible) return { popupVisible: false, errorText: "", captchaVisible: false, captchaValue: "", submitVisible: false };
    const captcha = popup.locator('input[name="captcha"]').first();
    const submit = popup.locator('button[type="submit"], button[name="register"], button:has-text("Register")').last();
    return {
      popupVisible: true,
      errorText: await popup.locator(".error").first().innerText().catch(() => ""),
      captchaVisible: await captcha.isVisible().catch(() => false),
      captchaValue: await captcha.inputValue().catch(() => ""),
      submitVisible: await submit.isVisible().catch(() => false),
    };
  }

  async fillRegistrationPasswords(page) {
    const popup = page.locator(".ps-popup").last();
    const passwordInput = popup.locator('input[name="password"], input[type="password"]').first();
    if (!(await passwordInput.isVisible().catch(() => false))) return false;
    const password = await this.vault.load();
    await passwordInput.fill(password);
    const confirm = popup.locator('input[name="cpassword"], input[name="password2"], input[type="password"]').nth(1);
    if (await confirm.isVisible().catch(() => false)) await confirm.fill(password);
    return true;
  }

  async fillPasswordRotationFields(page) {
    const popup = page.locator(".ps-popup").last();
    const password = await this.vault.load();
    const newPassword = popup.locator('input[name="password"]').first();
    const confirmation = popup.locator('input[name="cpassword"]').first();
    await newPassword.waitFor({ state: "visible", timeout: 15000 });
    await newPassword.fill(password);
    await confirmation.fill(password);
  }

  async waitForHumanVerification(page, code = "CAPTCHA_REQUIRED", message = "请在 Showdown 官方窗口完成宝可梦识别，完成后回到这里继续。") {
    await this.bringToFront(page);
    return this.update({ status: "WAITING_FOR_HUMAN_VERIFICATION", verificationCode: code, message });
  }

  async handlePageIssue(page, text) {
    const issue = classifyRegistrationIssue(text);
    if (!issue) return null;
    if (["CAPTCHA_INVALID", "PASSWORD_MISMATCH"].includes(issue.code)) {
      const state = await this.inspectRegistrationPage(page);
      if (issue.code === "CAPTCHA_INVALID") this.lastRejectedCaptcha = state.captchaValue.trim();
      await this.fillRegistrationPasswords(page).catch(() => false);
      await this.bringToFront(page);
    }
    await this.update({ status: issue.status, verificationCode: issue.code, message: issue.message });
    return this.publicState();
  }

  async submitRegistration(page) {
    await this.fillRegistrationPasswords(page);
    const before = await this.inspectRegistrationPage(page);
    const captchaValue = before.captchaValue.trim();
    if (before.captchaVisible && !captchaValue) {
      return this.waitForHumanVerification(page);
    }
    if (before.errorText) {
      const issue = classifyRegistrationIssue(before.errorText);
      if (issue?.code === "CAPTCHA_INVALID" && captchaValue === this.lastRejectedCaptcha) {
        return this.waitForHumanVerification(page, issue.code, issue.message);
      }
      if (issue && !["CAPTCHA_INVALID", "PASSWORD_MISMATCH"].includes(issue.code)) {
        return this.handlePageIssue(page, before.errorText);
      }
    }
    if (!before.submitVisible) {
      return this.waitForHumanVerification(page, "FORM_NOT_READY", "Showdown 注册表单尚未就绪。请检查官方窗口后再继续。");
    }
    const submit = page.locator(".ps-popup").last().locator('button[type="submit"], button[name="register"], button:has-text("Register")').last();
    await submit.click();
    await page.waitForTimeout(1800);
    if (await registered(this.state.username)) return this.verify();
    const after = await this.inspectRegistrationPage(page);
    if (after.errorText) return this.handlePageIssue(page, after.errorText);
    return this.waitForHumanVerification(page, "OFFICIAL_CONFIRMATION_PENDING", "注册请求已提交，但官方尚未确认。请检查 Showdown 窗口中的状态后重试。");
  }

  async chooseUsername(page) {
    const accountButton = page.locator('button[name="login"]:visible, .username:visible, .header-username:visible').first();
    await accountButton.waitFor({ state: "visible", timeout: 30000 });
    await accountButton.click();
    const popup = page.locator(".ps-popup").last();
    const usernameInput = popup.locator('input[name="username"], input[name="user"]').first();
    if (!(await usernameInput.isVisible().catch(() => false))) {
      const chooseName = popup.locator('button[name="login"], button:has-text("Choose name"), button:has-text("选择用户名")').last();
      await chooseName.waitFor({ state: "visible", timeout: 15000 });
      await chooseName.click();
    }
    const loginPopup = page.locator(".ps-popup").last();
    const loginInput = loginPopup.locator('input[name="username"], input[name="user"]').first();
    await loginInput.waitFor({ state: "visible", timeout: 15000 });
    await loginInput.fill(this.state.username);
    await loginInput.press("Enter");
    await page.waitForTimeout(1200);
  }

  async openRegistrationForm(page) {
    const existingPassword = page.locator(".ps-popup").last().locator('input[name="password"], input[type="password"]').first();
    if (await existingPassword.isVisible().catch(() => false)) return;
    const optionsButton = page.locator('button[name="openOptions"]:visible, button[aria-label="Options"]:visible, button[title="Options"]:visible').first();
    await optionsButton.waitFor({ state: "visible", timeout: 15000 });
    await optionsButton.click();
    const popup = page.locator(".ps-popup").last();
    const registerButton = popup.locator('button[name="register"], button:has-text("Register"), button:has-text("注册")').first();
    await registerButton.waitFor({ state: "visible", timeout: 15000 });
    await registerButton.click();
  }

  async runRegistration() {
    try {
      const context = await this.ensureBrowser();
      const page = context.pages()[0] || await context.newPage();
      await page.goto(PLAY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await this.chooseUsername(page);

      const popupText = await page.locator(".ps-popup").last().innerText().catch(() => "");
      const initialIssue = classifyRegistrationIssue(popupText);
      if (["LOCKED", "FAILED"].includes(initialIssue?.status)) return this.handlePageIssue(page, popupText);

      await this.openRegistrationForm(page);
      const passwordInput = page.locator(".ps-popup").last().locator('input[name="password"], input[type="password"]').first();
      await passwordInput.waitFor({ state: "visible", timeout: 15000 });
      await this.fillRegistrationPasswords(page);

      const captcha = page.locator(".ps-popup").last().locator('iframe[src*="captcha" i], .g-recaptcha, [data-sitekey], input[name*="captcha" i]').first();
      if (await captcha.isVisible().catch(() => false)) {
        return this.waitForHumanVerification(page);
      }
      return this.submitRegistration(page);
    } catch (error) {
      await this.update({ status: "FAILED", verificationCode: "BROWSER_WORKFLOW_FAILED", message: `注册流程失败：${error.message}` });
    }
  }

  async verify() {
    await this.update({ status: "VERIFYING_ACCOUNT", message: "正在验证账号注册状态。" });
    if (await registered(this.state.username)) {
      this.lastRejectedCaptcha = "";
      await this.update({ status: "READY", verificationCode: "", message: "专用 Showdown 账号已连接。" });
      if (this.context) await this.context.close().catch(() => {});
      return this.publicState();
    }
    const page = await this.registrationPage();
    if (page) {
      const pageState = await this.inspectRegistrationPage(page);
      if (pageState.errorText) return this.handlePageIssue(page, pageState.errorText);
      if (pageState.captchaVisible && !pageState.captchaValue.trim()) return this.waitForHumanVerification(page);
    }
    await this.update({ status: "WAITING_FOR_HUMAN_VERIFICATION", verificationCode: "OFFICIAL_CONFIRMATION_PENDING", message: "官方尚未确认注册，请检查 Showdown 验证窗口后重试。" });
    return this.publicState();
  }

  async continue() {
    if (!this.state.username) throw Object.assign(new Error("尚未开始账号注册。"), { status: 409, code: "ACCOUNT_UNCONFIGURED" });
    if (["EXISTING_ACCOUNT_LOGIN_REQUIRED", "OLD_PASSWORD_REQUIRED_FOR_ROTATION"].includes(this.state.verificationCode)) {
      return this.continueCredentialRepair();
    }
    if (await registered(this.state.username)) return this.verify();
    if (this.state.status === "LOCKED") throw Object.assign(new Error("Showdown 已锁定当前代理 IP。请切换到正常网络后删除本地配置并重试。"), { status: 423, code: "SHOWDOWN_IP_LOCKED" });
    if (this.state.status === "FAILED") {
      await this.focus();
      return this.publicState();
    }
    const page = await this.registrationPage();
    if (page) return this.submitRegistration(page);
    await this.focus();
    return this.publicState();
  }

  async focus() {
    if (!this.state.username) throw Object.assign(new Error("尚未开始账号注册。"), { status: 409, code: "ACCOUNT_UNCONFIGURED" });
    const page = await this.registrationPage();
    if (page && this.state.status !== "FAILED") {
      await this.bringToFront(page);
      return this.publicState();
    }
    if (!this.workflow) {
      await this.update({ status: "REGISTERING", verificationCode: "", message: "正在重新打开 Showdown 官方验证窗口。" });
      this.workflow = this.runRegistration().finally(() => { this.workflow = null; });
    }
    return this.publicState();
  }

  async rotatePendingCredential() {
    if (!this.state.username) throw Object.assign(new Error("尚未开始账号注册。"), { status: 409, code: "ACCOUNT_UNCONFIGURED" });
    if (this.state.status === "READY" || await registered(this.state.username)) {
      throw Object.assign(new Error("账号已经注册，不能使用待注册凭据轮换。"), { status: 409, code: "ACCOUNT_ALREADY_REGISTERED" });
    }
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    await this.hardenBrowserProfile();
    await this.vault.save(generatePassword());
    this.credentialStored = true;
    this.lastRejectedCaptcha = "";
    await this.update({
      status: "WAITING_FOR_HUMAN_VERIFICATION",
      verificationCode: "BROWSER_ACTION_REQUIRED",
      message: "待注册凭据已安全轮换，正在重新打开官方验证窗口。",
    });
    return this.focus();
  }

  async accountSession(page) {
    return page.evaluate(() => ({
      userid: window.app?.user?.get("userid") || "",
      named: Boolean(window.app?.user?.get("named")),
      registered: Boolean(window.app?.user?.get("registered")),
    })).catch(() => ({ userid: "", named: false, registered: false }));
  }

  async reconcileRegisteredAccount() {
    if (!this.state.username) throw Object.assign(new Error("尚未开始账号注册。"), { status: 409, code: "ACCOUNT_UNCONFIGURED" });
    const context = await this.ensureBrowser();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(PLAY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);
    let session = await this.accountSession(page);
    if (session.registered && session.userid === toUserid(this.state.username)) return this.preparePasswordRotation(page);
    await this.chooseUsername(page);
    session = await this.accountSession(page);
    if (session.registered && session.userid === toUserid(this.state.username)) return this.preparePasswordRotation(page);
    const loginPassword = page.locator(".ps-popup").last().locator('input[name="password"]').first();
    if (await loginPassword.isVisible().catch(() => false)) {
      await this.bringToFront(page);
      return this.update({
        status: "WAITING_FOR_HUMAN_VERIFICATION",
        verificationCode: "EXISTING_ACCOUNT_LOGIN_REQUIRED",
        message: "账号已存在。请只在 Showdown 官方窗口输入现有密码并登录，然后回到这里继续。",
      });
    }
    await this.bringToFront(page);
    return this.update({
      status: "WAITING_FOR_HUMAN_VERIFICATION",
      verificationCode: "ACCOUNT_REGISTRATION_NOT_CONFIRMED",
      message: "Showdown 当前会话仍将该用户名视为未注册。请确认注册成功提示后再重试。",
    });
  }

  async preparePasswordRotation(page) {
    const session = await this.accountSession(page);
    if (!session.registered || session.userid !== toUserid(this.state.username)) {
      await this.bringToFront(page);
      return this.update({
        status: "WAITING_FOR_HUMAN_VERIFICATION",
        verificationCode: "EXISTING_ACCOUNT_LOGIN_REQUIRED",
        message: "尚未检测到已注册账号登录。请在 Showdown 官方窗口登录后继续。",
      });
    }
    const optionsButton = page.locator('button[name="openOptions"]:visible, button[aria-label="Options"]:visible, button[title="Options"]:visible').first();
    await optionsButton.waitFor({ state: "visible", timeout: 15000 });
    await optionsButton.click();
    const changePassword = page.locator(".ps-popup").last().locator('button[name="changepassword"], button:has-text("Password")').first();
    await changePassword.waitFor({ state: "visible", timeout: 15000 });
    await changePassword.click();
    const oldPassword = page.locator(".ps-popup").last().locator('input[name="oldpassword"]').first();
    await oldPassword.waitFor({ state: "visible", timeout: 15000 });
    await this.fillPasswordRotationFields(page);
    await this.bringToFront(page);
    return this.update({
      status: "WAITING_FOR_HUMAN_VERIFICATION",
      verificationCode: "OLD_PASSWORD_REQUIRED_FOR_ROTATION",
      message: "请只在 Showdown 的 Old password 中输入现有密码；新密码已由 DPAPI 安全填写。",
    });
  }

  async continueCredentialRepair() {
    const page = await this.registrationPage();
    if (!page) return this.reconcileRegisteredAccount();
    if (this.state.verificationCode === "EXISTING_ACCOUNT_LOGIN_REQUIRED") {
      const session = await this.accountSession(page);
      if (session.registered && session.userid === toUserid(this.state.username)) return this.preparePasswordRotation(page);
      await this.bringToFront(page);
      return this.update({
        status: "WAITING_FOR_HUMAN_VERIFICATION",
        verificationCode: "EXISTING_ACCOUNT_LOGIN_REQUIRED",
        message: "尚未检测到登录成功。请在 Showdown 官方窗口完成登录后继续。",
      });
    }
    return this.submitPasswordRotation(page);
  }

  async submitPasswordRotation(page) {
    const popup = page.locator(".ps-popup").last();
    const popupText = await popup.innerText().catch(() => "");
    if (/password was successfully changed/i.test(popupText)) return this.finishCredentialRepair();
    const oldPassword = popup.locator('input[name="oldpassword"]').first();
    if (!(await oldPassword.isVisible().catch(() => false))) return this.preparePasswordRotation(page);
    if (!(await oldPassword.evaluate((input) => input.value.length > 0))) {
      await this.bringToFront(page);
      return this.update({
        status: "WAITING_FOR_HUMAN_VERIFICATION",
        verificationCode: "OLD_PASSWORD_REQUIRED_FOR_ROTATION",
        message: "请在 Showdown 官方页面填写 Old password，然后回到这里继续。",
      });
    }
    await this.fillPasswordRotationFields(page);
    await popup.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(1800);
    const resultPopup = page.locator(".ps-popup").last();
    const resultText = await resultPopup.innerText().catch(() => "");
    if (/password was successfully changed/i.test(resultText)) return this.finishCredentialRepair();
    const errorText = await resultPopup.locator(".error").first().innerText().catch(() => "");
    await this.fillPasswordRotationFields(page).catch(() => {});
    await this.bringToFront(page);
    return this.update({
      status: "WAITING_FOR_HUMAN_VERIFICATION",
      verificationCode: "OLD_PASSWORD_REQUIRED_FOR_ROTATION",
      message: errorText ? "Showdown 未接受现有密码，请在官方页面重新输入后继续。" : "官方尚未确认密码轮换，请检查 Showdown 窗口后重试。",
    });
  }

  async finishCredentialRepair() {
    this.lastRejectedCaptcha = "";
    await this.update({ status: "READY", verificationCode: "", message: "Showdown 账号已连接，官方密码与本地 DPAPI 凭据一致。" });
    if (this.context) await this.context.close().catch(() => {});
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
    this.credentialStored = false;
    await rm(PROFILE_PATH, { recursive: true, force: true });
    await rm(STATE_PATH, { force: true });
    this.lastRejectedCaptcha = "";
    this.state = { status: "UNCONFIGURED", username: "", message: "尚未配置专用账号。", verificationCode: "", candidates: [], updatedAt: new Date().toISOString() };
    return this.publicState();
  }
}

export const showdownAccount = new ShowdownAccountManager();
