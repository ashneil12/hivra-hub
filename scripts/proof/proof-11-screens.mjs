// The isolated ledger uses the id "hivra" because the strip shows only Ash's four projects.
// Proof only: screenshots of a real Ash OS job (isolated ledger, no models) in Being built, working then Done.
//   npx vite --port 1420 &   node scripts/proof/proof-11-screens.mjs <outDir>
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { startIsolatedAshOs } from "./ashosIsolated.mjs";

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const svc = await startIsolatedAshOs({ port: 18921, dev: true });
const call = async (action, value) => {
  const r = await (await fetch(`${svc.base}/api/${action}`, { method: "POST", headers: { Authorization: `Bearer ${svc.token}` }, body: JSON.stringify(value) })).json();
  if (!r.ok) throw new Error(`${action}: ${r.error}`);
  return r.result;
};
const lead = (v) => call("ash-hub-job", { ...v, _caller: { mono_id: "hivra-lead", role: "lead" } });
await call("ash-hub-project-create", { name: "Hivra", project_id: "hivra", one_line: "Hivra (proof copy, throwaway ledger)", code: false });
await call("ash-hub-mono-project-add", { mono_id: "hivra-lead", project_id: "hivra", role: "lead" });
const a = (await lead({ action: "start", project: "hivra", title: "Write the proof file" })).job.id;
const b2 = (await lead({ action: "start", project: "hivra", title: "Check the proof file", ref: "check" })).job.id;
await lead({ action: "checking", job_id: b2, note: "reading it back" });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await page.goto(`http://127.0.0.1:1420/hub-dev.html?stub=${svc.base}`);
await page.locator('button[aria-label^="Hivra"]').first().click();
await page.locator("[data-hub-items] button", { hasText: "Being built" }).click();
await page.waitForSelector(`[data-hub-worker="${a}"]`);
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, "being-built-workers.png") });
const sidebar = await page.locator("[data-hub-items]").innerText().catch(() => "");
console.log("sidebar mentions a job title:", /proof file/i.test(sidebar));
await lead({ action: "done", job_id: a, evidence: "wrote proof.txt and read it back" });
await lead({ action: "done", job_id: b2, evidence: "sha256 matched" });
await page.waitForFunction((id) => !!document.querySelector(`[data-hub-worker="${id}"]`)?.textContent?.match(/Done|ago|:\d\d/), a, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, "job-done.png") });
console.log(await page.locator("main, body").first().innerText());
console.log("models", JSON.stringify(await svc.state()));
await browser.close();
await svc.stop();
