import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const tempRoot = await mkdtemp(join(tmpdir(), "champion-forge-account-flow-"));
process.env.SHOWDOWN_ACCOUNT_ROOT = tempRoot;
const { ShowdownAccountManager } = await import(`../server/showdown-account.mjs?qa=${Date.now()}`);
const manager = new ShowdownAccountManager();
manager.state.username = "ChampionForgeQA";
await manager.vault.save("fixture-secret-A7!");
manager.credentialStored = true;
assert.equal(manager.publicState().credentialStored, true);
const defaultProfile = join(tempRoot, "browser", "Default");
await mkdir(defaultProfile, { recursive: true });
await writeFile(join(defaultProfile, "Preferences"), JSON.stringify({ credentials_enable_service: true, profile: { password_manager_enabled: true, keep: "value" } }));
await writeFile(join(defaultProfile, "Login Data"), "fixture");
await manager.hardenBrowserProfile();
const preferences = JSON.parse(await readFile(join(defaultProfile, "Preferences"), "utf8"));
assert.equal(preferences.credentials_enable_service, false);
assert.equal(preferences.profile.password_manager_enabled, false);
assert.equal(preferences.profile.keep, "value");
await assert.rejects(readFile(join(defaultProfile, "Login Data")), { code: "ENOENT" });
await manager.update({ status: "REGISTERING", username: manager.state.username });
const restoredManager = new ShowdownAccountManager();
const restoredState = await restoredManager.initialize();
assert.equal(restoredState.status, "WAITING_FOR_HUMAN_VERIFICATION");
assert.equal(restoredState.verificationCode, "BROWSER_ACTION_REQUIRED");
assert.equal(restoredState.credentialStored, true);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`
    <button class="username" id="account">Guest</button><button name="openOptions" id="options">Options</button>
    <main id="popups"></main>
    <script>
      const popups = document.querySelector('#popups');
      const account = document.querySelector('#account');
      let named = false;
      const popup = html => { popups.innerHTML = '<section class="ps-popup">' + html + '</section>'; };
      account.addEventListener('click', () => {
        popup('<button name="login">Choose name</button>');
      });
      document.querySelector('#options').addEventListener('click', () => {
        if (named) popup('<button name="register">Register</button>');
      });
      popups.addEventListener('click', event => {
        if (event.target.name === 'login') popup('<form id="login"><input name="username"></form>');
        if (event.target.name === 'register') popup('<form><input name="password" type="password"><input name="cpassword" type="password"><input name="captcha"><button type="submit">Register</button></form>');
      });
      popups.addEventListener('submit', event => {
        if (event.target.id !== 'login') return;
        event.preventDefault();
        named = true;
        account.textContent = event.target.elements.username.value;
        popups.innerHTML = '';
      });
    </script>
  `);

  await manager.chooseUsername(page);
  assert.equal(await page.locator("#account").innerText(), manager.state.username);
  await manager.openRegistrationForm(page);
  await manager.fillRegistrationPasswords(page);
  const formState = await page.locator(".ps-popup").last().evaluate((popup) => ({
    passwordFilled: popup.querySelector('input[name="password"]').value.length > 0,
    confirmationMatches: popup.querySelector('input[name="password"]').value === popup.querySelector('input[name="cpassword"]').value,
    captchaEmpty: popup.querySelector('input[name="captcha"]').value === "",
  }));
  assert.deepEqual(formState, { passwordFilled: true, confirmationMatches: true, captchaEmpty: true });
  await page.locator("#popups").evaluate((popups) => {
    popups.innerHTML = '<section class="ps-popup"><form><input name="oldpassword" type="password"><input name="password" type="password"><input name="cpassword" type="password"><button type="submit">Change password</button></form></section>';
  });
  await manager.fillPasswordRotationFields(page);
  const rotationState = await page.locator(".ps-popup").last().evaluate((popup) => ({
    oldPasswordEmpty: popup.querySelector('input[name="oldpassword"]').value === "",
    newPasswordFilled: popup.querySelector('input[name="password"]').value.length > 0,
    confirmationMatches: popup.querySelector('input[name="password"]').value === popup.querySelector('input[name="cpassword"]').value,
  }));
  assert.deepEqual(rotationState, { oldPasswordEmpty: true, newPasswordFilled: true, confirmationMatches: true });
} finally {
  await browser.close();
  await manager.vault.clear();
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Showdown account flow QA passed.");
