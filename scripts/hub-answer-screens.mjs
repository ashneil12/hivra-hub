// Dev only: screenshots of the question sheet and the project Leads.
//   live:  node scripts/hub-live-proxy.mjs --port 18870 (read-only)  ·  stub: node scripts/hub-stub-server.mjs --port 18868 --dev
//   node scripts/hub-answer-screens.mjs <outDir>
// Never presses Send (or any quick answer) on live data: only the stub's send path is pressed.
import { chromium } from "@playwright/test";
import path from "node:path";

const out = process.argv[2];
const LIVE = "http://localhost:1420/hub-dev.html?live=http://127.0.0.1:18870";
const STUB = "http://localhost:1420/hub-dev.html?stub=http://127.0.0.1:18868";
const browser = await chromium.launch();
const shot = async (page, name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, name) });
  console.log("wrote", name);
};
const fresh = async (url) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(url);
  await page.waitForSelector("[data-hub-need]", { timeout: 60000 });
  return page;
};

// ---- live (read-only) -------------------------------------------------------------------------------------------------
{
  const page = await fresh(LIVE);
  await page.locator('button[aria-label^="EXO"]').first().click(); // opens EXO's Coding team
  await page.waitForTimeout(1500);
  const monos = await page.locator("text=EXO lead").count();
  console.log("EXO lead visible in the Coding team:", monos > 0);
  await shot(page, "leads-1-live-exo-coding-team.png");
  await page.locator("button", { hasText: /^Inbox$/ }).first().click();
  const row = page.locator('[data-hub-need^="q:"]').first();
  await row.locator("button", { hasText: "See options" }).click();
  await page.waitForSelector('[data-hub-sheet="See options"]');
  await page.waitForTimeout(1500);
  console.log("live sheet:", (await page.locator('[data-hub-sheet="See options"]').innerText()).replace(/\n+/g, " | ").slice(0, 300));
  await shot(page, "answer-1-live-question-sheet.png");
  await page.keyboard.press("Escape");
}

// ---- stub: the full sheet and the send path ------------------------------------------------------------------------------
{
  const page = await fresh(STUB);
  await page.locator('[data-hub-need="q2"] button', { hasText: "See options" }).click();
  await page.waitForSelector("[data-hub-question-option]");
  await page.locator("[data-hub-question-option]").nth(1).click();
  await shot(page, "answer-2-stub-question-with-options.png");
  await page.locator("[data-hub-send]").click();
  await page.waitForSelector('[data-hub-need="q2"] [data-hub-sending]');
  await shot(page, "answer-3-stub-row-sending.png");
  await page.waitForSelector('[data-hub-need="q2"][data-hub-need-done]', { timeout: 15000 });
  await shot(page, "answer-4-stub-row-ticked-with-receipt.png");
  await fetch("http://127.0.0.1:18868/__stub/control", {
    method: "POST",
    body: JSON.stringify({ op: "addNeed", need: { id: "q:qx", projectId: "hivra", title: "Example: archive the old waitlist?", why: "My suggestion: Park it for later.", actionType: "see_options", actionTarget: "question:qx" } }),
  });
  await page.waitForSelector('[data-hub-need="q:qx"]');
  await page.locator('[data-hub-need="q:qx"] button', { hasText: "See options" }).click();
  await page.waitForSelector("[data-hub-recommendation]");
  await shot(page, "answer-5-stub-question-without-options.png");
  await page.locator('[data-hub-quick="park"]').click();
  await page.waitForSelector('[data-hub-need="q:qx"][data-hub-need-done]');
  await shot(page, "answer-6-stub-not-now-receipt.png");
  await page.locator('[data-hub-need="q4"] button', { hasText: "Open" }).click();
  await page.waitForSelector("[data-hub-detail]");
  await shot(page, "answer-7-stub-open-ask-details.png");
}
await browser.close();
