// Dev only: screenshots of the hub reading the REAL Ash OS through scripts/hub-live-proxy.mjs (read-only).
//   node scripts/hub-live-proxy.mjs &    # holds the key; the page never sees it
//   pnpm dev                             # vite on :1420
//   node scripts/hub-live-screens.mjs <outDir>
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
const prefix = process.argv.includes("--prefix") ? process.argv[process.argv.indexOf("--prefix") + 1] : "live";
if (!out) throw new Error("usage: hub-live-screens.mjs <outDir>");
fs.mkdirSync(out, { recursive: true });
const URL = "http://localhost:1420/hub-dev.html?live=http://127.0.0.1:18869";
const PROJECTS = [
  ["vg-game", "EXO", "exo"],
  ["hub", "MonoCode Hub", "hub"],
  ["hivra", "Hivra", "hivra"],
  ["nibbii", "Nibbii", "nibbii"],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
page.on("pageerror", (e) => problems.push(String(e)));
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, name.replace(/^live-/, `${prefix}-`)), ...opts });
  console.log("wrote", name.replace(/^live-/, `${prefix}-`));
};

await page.goto(URL);
await page.waitForSelector("[data-hub-need]", { timeout: 30000 });
await page.waitForSelector("h2:text-matches(\"^Since \")", { timeout: 60000 });
if (await page.locator("[data-hub-since-pending]").count()) {
  await shot("live-0-today-since-pending.png");
  await page.waitForSelector("[data-hub-since]", { timeout: 60000 });
}
await shot("live-1-today.png");
// Since, close up
const since = await page.locator("section", { has: page.locator("h2:text-matches(\"^Since \")") }).first().boundingBox();
if (since) await shot("live-2-since.png", { clip: { x: 268, y: 40, width: 1012, height: Math.min(200, since.height + 60) } });
console.log("since text:", (await page.locator("section", { has: page.locator("h2:text-matches(\"^Since \")") }).first().innerText()).replace(/\n+/g, " | ").slice(0, 700));

for (const [id, label, slug] of PROJECTS) {
  await page.locator(`button[aria-label^="${label}"]`).first().click();
  await page.locator("button", { hasText: /^Inbox$/ }).first().click();
  await page.waitForSelector("[data-hub-need]");
  const rows = await page.locator("[data-hub-need]").count();
  const later = (await page.locator("[data-hub-later] > button").first().innerText().catch(() => "")) || "";
  const older = (await page.locator("[data-hub-older] > button").first().innerText().catch(() => "")) || "";
  const items = await page.locator("[data-hub-items] button").allInnerTexts();
  console.log(id, { rows, later, older, sidebar: items });
  await shot(`live-3-inbox-${slug}.png`);
  if (id === "vg-game") {
    if (await page.locator("[data-hub-later] > button").count()) await page.locator("[data-hub-later] > button").first().click();
    if (await page.locator("[data-hub-older] > button").count()) await page.locator("[data-hub-older] > button").first().click();
    await page.waitForTimeout(300);
    await shot("live-4-inbox-exo-later-and-older-open.png", { fullPage: false });
  }
}
// Being built on a real project (jobs are not live yet: it should say nothing is being built)
await page.locator(`button[aria-label^="Hivra"]`).first().click();
await page.locator("[data-hub-items] button", { hasText: "Being built" }).click();
await page.waitForTimeout(500);
await shot("live-5-being-built-hivra.png");
console.log("console errors:", problems.filter((p) => !/ERR_INCOMPLETE_CHUNKED_ENCODING/.test(p)));
await browser.close();
