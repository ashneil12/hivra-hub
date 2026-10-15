// Dev only: screenshots of the jobs, See options and Older work against the stub's jobs scenario.
//   node scripts/hub-stub-server.mjs --port 18868 --dev --jobs &   pnpm dev &
//   node scripts/hub-jobs-screens.mjs <outDir>
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: hub-jobs-screens.mjs <outDir>");
fs.mkdirSync(out, { recursive: true });
const STUB = "http://127.0.0.1:18868";
const control = (body) => fetch(`${STUB}/__stub/control`, { method: "POST", body: JSON.stringify(body) });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const shot = async (name) => {
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(out, name) });
  console.log("wrote", name);
};
await page.goto(`http://localhost:1420/hub-dev.html?stub=${STUB}`);
await page.waitForSelector('[data-hub-need="j:j_sender"]');
await shot("jobs-1-today-stuck-needs-you-looks-right.png");

// Being built for Hivra: every state, one row per job under its Lead
await page.locator('button[aria-label^="Hivra"]').first().click();
await page.locator("[data-hub-items] button", { hasText: "Being built" }).click();
await page.waitForSelector("[data-hub-worker]");
await shot("jobs-2-being-built-all-states.png");

// back on Today: the red row's See options sheet, then the hint box, then Ash's pick
await page.locator('button[aria-label^="Today"]').click();
await page.locator('[data-hub-need="j:j_sender"] button', { hasText: "See options" }).click();
await page.waitForSelector("[data-hub-options-sheet] [data-hub-option]");
await shot("jobs-3-see-options-sheet.png");
await page.locator('[data-hub-option="try_different"] button', { hasText: "Write a hint" }).click();
await page.locator("[data-hub-options-sheet] input").fill("Use the other email login and send the first ten only.");
await shot("jobs-4-try-it-a-different-way-hint.png");
await page.locator('[data-hub-option="try_different"] button', { hasText: "Send" }).click();
await page.waitForSelector('[data-hub-need="j:j_sender"][data-hub-need-done]');
await shot("jobs-5-picked-row-ticked-off.png");

// Being built again: the picked job moved on in place, a state changes and a job joins at the bottom, nothing re-sorts
await page.locator('button[aria-label^="Hivra"]').first().click();
await page.locator("[data-hub-items] button", { hasText: "Being built" }).click();
await page.waitForSelector("[data-hub-worker]");
await control({ op: "setJob", id: "j_mail", patch: { state: "checking", lastActiveAt: new Date().toISOString() }, kind: "hub.job.active" });
await control({ op: "addJob", job: { id: "j_late", projectId: "hivra", title: "Checking the waitlist form", lead: "hivra-lead", leadName: "Hivra lead" } });
await page.waitForSelector('[data-hub-worker="j_late"]');
await shot("jobs-6-being-built-live-update-in-place.png");

// Older and Later, open, in a project Inbox
await page.locator('button[aria-label^="Hivra"]').first().click();
await page.locator("button", { hasText: /^Inbox$/ }).first().click();
await page.locator("[data-hub-older] > button").click();
await shot("jobs-7-inbox-older-open.png");
await browser.close();
