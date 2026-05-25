import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.APP_URL || "http://127.0.0.1:4174";

await mkdir("docs", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.waitForSelector("#team-slots", { timeout: 30000 });

async function addPokemon(count = 6) {
  for (let i = 0; i < count; i += 1) {
    await page.click("#open-palette-btn");
    await page.waitForSelector(".pokemon-row:not([disabled])", { timeout: 10000 });
    await page.locator(".pokemon-row:not([disabled])").first().click();
    await page.waitForTimeout(220);
  }
}

await addPokemon(6);
await page.waitForTimeout(800);

await page.screenshot({ path: "docs/screenshot-dashboard.png", fullPage: true });

await page.locator(".team-builder").screenshot({ path: "docs/screenshot-workbench.png" });
await page.locator(".ai-builder").screenshot({ path: "docs/screenshot-ai.png" });
await page.locator(".export-panel").screenshot({ path: "docs/screenshot-export.png" });
await page.locator("#analysis-dashboard").screenshot({ path: "docs/screenshot-analysis.png" });

await browser.close();
