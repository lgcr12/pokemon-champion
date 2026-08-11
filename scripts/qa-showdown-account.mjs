import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const tempRoot = await mkdtemp(join(tmpdir(), "champion-forge-account-flow-"));
process.env.SHOWDOWN_ACCOUNT_ROOT = tempRoot;
const { ShowdownAccountManager } = await import(`../server/showdown-account.mjs?qa=${Date.now()}`);
const manager = new ShowdownAccountManager();
manager.state.username = "ChampionForgeQA";
await manager.vault.save("fixture-secret-A7!");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`
    <button class="username" id="account">Guest</button>
    <main id="popups"></main>
    <script>
      const popups = document.querySelector('#popups');
      const account = document.querySelector('#account');
      let named = false;
      const popup = html => { popups.innerHTML = '<section class="ps-popup">' + html + '</section>'; };
      account.addEventListener('click', () => {
        if (named) popup('<button name="register">Register</button>');
        else popup('<button name="login">Choose name</button>');
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
} finally {
  await browser.close();
  await manager.vault.clear();
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Showdown account flow QA passed.");
