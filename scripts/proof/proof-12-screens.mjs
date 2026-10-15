// Proof only: screenshots of the Sign in row (waiting on the Keychain, then On this Mac) and a Bot changes row before
// and after Undo. Runs against the dev page; the Keychain and the Mono file are stand-ins injected into the page's own
// modules (a browser has neither). The real Keychain round trip is the Rust test hub_keychain.
//   npx vite --port 1420 &   node scripts/proof/proof-12-screens.mjs <outDir>
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => localStorage.setItem("monocode:hub-keychain-test", "1"));
const page = await ctx.newPage();
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, name) }); console.log("wrote", name); };
await page.goto("http://127.0.0.1:1420/hub-dev.html");
await page.waitForTimeout(2000);

await page.evaluate(async () => {
  const c = await import("/src/features/hub/model/connectors.ts");
  const items = new Map();
  window.__release = null;
  c.setConnectorKeychain({
    store: async (s, a, x) => { await new Promise((r) => (window.__release = r)); items.set(`${s}|${a}`, x); window.__stored = s; },
    exists: async (s, a) => items.has(`${s}|${a}`),
    remove: async (s, a) => items.delete(`${s}|${a}`),
  });
  c.setConnectorLoginFlow(async () => ({ account: "dummy@example.invalid", secret: "not-a-real-secret" }));
  c.addConnectors([{ id: "github", name: "GitHub", projectId: "hivra" }]);
});
await page.locator('button[aria-label^="Today"]').first().click();
await page.waitForSelector('[data-hub-take-look="connector:github"]');
await shot("signin-1-before.png");
await page.locator('[data-hub-take-look="connector:github"]').click();
await page.waitForSelector('[data-hub-signin-state="waiting"]');
await shot("signin-2-waiting-on-keychain.png");
await page.evaluate(() => window.__release());
await page.waitForSelector('[data-hub-signin-state="on-this-mac"]');
await shot("signin-3-on-this-mac.png");
console.log("stored under", await page.evaluate(() => window.__stored));

await page.evaluate(async () => {
  const b = await import("/src/features/hub/model/botChanges.ts");
  const before = "# Soul\n\n- Write release notes in 12 steps.\n";
  const after = "# Soul\n\n- Write release notes in 8 steps.\n";
  const disk = new Map([["frank|SOUL.md", after]]);
  window.__disk = disk;
  b.setBotFiles({
    read: async (m, f) => ({ text: disk.get(`${m}|${f}`) ?? null, hash: String((disk.get(`${m}|${f}`) ?? "").length) }),
    write: async (m, f, t) => { disk.set(`${m}|${f}`, t); return String(t.length); },
  });
  b.recordBotChange({ id: "proof-rc1", bot: "frank", day: "Today", line: "frank shortened how it writes release notes",
    now: "12 steps", after: "8 steps", monoId: "frank", file: "SOUL.md", beforeText: before, afterText: after });
});
await page.locator("button", { hasText: /^Settings/ }).first().click();
await page.locator("button", { hasText: /^Changes$/ }).first().click();
await page.locator("button", { hasText: "Bot changes" }).first().click();
const row = page.locator("[data-hub-bot-change]", { hasText: "frank shortened how it writes release notes" });
await row.locator("button", { hasText: "frank shortened" }).click();
await shot("botchange-1-before-undo.png");
await row.locator("button", { hasText: "Undo" }).click();
await row.locator("text=Undone").waitFor();
await shot("botchange-2-after-undo.png");
console.log("frank SOUL.md now:", JSON.stringify(await page.evaluate(() => window.__disk.get("frank|SOUL.md"))));
await browser.close();
