import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.APP_URL || "http://127.0.0.1:4174";
const outputDir = "docs/social";

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1 });

await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.waitForSelector("#team-slots", { timeout: 30000 });

async function addPokemon(count = 6) {
  for (let i = 0; i < count; i += 1) {
    await page.click("#open-palette-btn");
    await page.waitForSelector(".pokemon-row:not([disabled])", { timeout: 10000 });
    await page.locator(".pokemon-row:not([disabled])").first().click();
    await page.waitForTimeout(180);
  }
}

await addPokemon(6);
await page.waitForTimeout(600);

await page.screenshot({ path: `${outputDir}/01-home-full.png`, fullPage: true });
await page.locator(".hero-panel").screenshot({ path: `${outputDir}/02-hero.png` });
await page.locator(".team-builder").screenshot({ path: `${outputDir}/03-team-builder.png` });
await page.locator(".team-library").screenshot({ path: `${outputDir}/04-hot-teams.png` });
await page.locator(".ai-builder").screenshot({ path: `${outputDir}/05-ai-builder.png` });

await page.click("#ai-settings-toggle");
await page.waitForSelector("#ai-settings-panel", { state: "visible" });
await page.locator(".ai-builder").screenshot({ path: `${outputDir}/06-ai-settings.png` });

await page.locator(".export-panel").screenshot({ path: `${outputDir}/07-export-check.png` });
await page.locator(".data-health").screenshot({ path: `${outputDir}/08-data-health.png` });
await page.locator("#analysis-dashboard").screenshot({ path: `${outputDir}/09-analysis.png` });

const mobile = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true });
await mobile.goto(baseUrl, { waitUntil: "networkidle" });
await mobile.waitForSelector("#team-slots", { timeout: 30000 });
await mobile.screenshot({ path: `${outputDir}/10-mobile-home.png`, fullPage: true });

await browser.close();
