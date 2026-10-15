// Dev only: before/after screenshots of the hub for the wiring work.
//   before = the app at the front-end commit (examples dev page), after = the hub reading a stub server through the
//   app's real transport. Needs: a stub (`node scripts/hub-stub-server.mjs --port 18868 --dev`), vite for "after" on
//   :1420, and (optional) vite for "before" on :1430 from a checkout of 243da88.
//   node scripts/hub-wiring-screens.mjs <outDir>
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: hub-wiring-screens.mjs <outDir>");
fs.mkdirSync(out, { recursive: true });
const AFTER = "http://localhost:1420/hub-dev.html";
const BEFORE = "http://localhost:1430/hub-dev.html";
const STUB = "http://127.0.0.1:18868";

const browser = await chromium.launch();
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, name) });
  console.log("wrote", name);
};
async function open(url, { init } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  await page.goto(url);
  return { page, context };
}
const control = (body) => fetch(`${STUB}/__stub/control`, { method: "POST", body: JSON.stringify(body) });

// ---- before: the example data at the front-end commit ----------------------------------------------------------------
if (process.argv.includes("--before")) {
  let { page, context } = await open(BEFORE);
  await page.waitForSelector("text=Example: play Areas 1 and 2");
  await shot(page, "before-1-today.png");
  await page.click('button[aria-label^="Operator OS"]');
  await page.click("text=Inbox >> nth=0");
  await page.waitForSelector("text=Example: approve the Q4 hiring plan");
  await shot(page, "before-2-inbox-with-needs.png");
  await context.close();

  // a clean first launch: the dev page's own switch for example data is held off
  ({ page, context } = await open(BEFORE, {
    init: () => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k !== "monocode:hub-examples") set.call(this, k, v);
      };
      localStorage.removeItem("monocode:hub-examples");
    },
  }));
  await page.waitForSelector("[data-hub-today-empty]");
  await shot(page, "before-3-empty-clean-launch.png");
  await context.close();
}

// ---- after: Ash OS (the stub) through the real transport ---------------------------------------------------------------
{
  let { page, context } = await open(`${AFTER}?stub=${STUB}`);
  await page.waitForSelector("text=Example: play Areas 1 and 2");
  await shot(page, "after-1-today.png");

  await page.click('button[aria-label^="Harness"]'); // no code folder: opens on its own Inbox
  await page.waitForSelector("text=Example: approve the Q4 hiring plan");
  await shot(page, "after-2-inbox-with-needs-and-later.png");

  // a Need answered somewhere else: it ticks itself off where it stands, nothing moves
  await control({ op: "doneNeed", id: "q5", reason: "answered" });
  await page.waitForSelector('[data-hub-need="q5"][data-hub-need-done]');
  await shot(page, "after-3-need-ticked-itself-off.png");

  // a new Need arrives at the bottom without a reload
  await control({ op: "addNeed", need: { id: "q30", projectId: "ash", title: "Example: new arrival from the live feed", why: "Arrived while the page was open.", rank: 0 } });
  await page.waitForSelector('[data-hub-need="q30"]');
  await shot(page, "after-4-new-need-arrived-live.png");
  await context.close();

  // Ash OS isn't running: nothing is listening there
  ({ page, context } = await open(`${AFTER}?stub=http://127.0.0.1:1`));
  await page.waitForSelector("[data-hub-down]");
  await shot(page, "after-5-ash-os-not-running.png");
  await context.close();
}
await browser.close();
