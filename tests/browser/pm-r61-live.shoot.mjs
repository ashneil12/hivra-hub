// Round 61 proof: drives tests/browser/pm-r61-live.html with a simulated stream and shoots each state at 1920 wide.
// node tests/browser/pm-r61-live.shoot.mjs <baseURL> <outDir>
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:1461";
const out = process.argv[3] ?? "/workspace/pm-r61-live";
const log = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name, crop) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  if (crop) {
    const el = page.locator(crop).first();
    if (await el.count()) await el.screenshot({ path: `${out}/${name}-crop.png` });
  }
  const line = await page.locator("[data-live-activity]").allTextContents();
  const typing = await page.locator("[data-hub-typing]").allTextContents();
  const runner = await page.locator("[data-live-runner]").count();
  const stalled = await page.locator("[data-live-activity-stalled]").count();
  log.push(`${name}: line=${JSON.stringify(line)} typing=${JSON.stringify(typing)} runner=${runner} stalled=${stalled}`);
};
const drive = (fn, arg) => page.evaluate(fn, arg);

// ---- Leadership room ----
await page.goto(`${base}/tests/browser/pm-r61-live.html?view=room`);
await page.waitForSelector("[data-hub-typing]");
await wait(3200);
await shot("r61-01-room-busy-thinking", "[data-hub-typing]");
await drive(() => window.__r61.step({ key: "tool:r1", label: "Reading src/app.tsx", since: Date.now() - 14_000, lastEventAt: Date.now() }));
await wait(400);
await shot("r61-02-room-step-reading", "[data-hub-typing]");
await drive(() => {
  window.__r61.write("Example: the Tally build is green on main. I'm running the checks on the date picker fix now.");
  window.__r61.step({ key: "tool:c1", label: "Running a check", since: Date.now() - 6_000, lastEventAt: Date.now() });
});
await wait(1200);
await shot("r61-03-room-step-check-live-message", "[data-hub-msg-draft]");
await drive(() => window.__r61.step({ key: "tool:w1", label: "Waiting on a worker", since: Date.now() - 62_000, lastEventAt: Date.now() }));
await wait(400);
await shot("r61-04-room-step-worker", "[data-hub-msg-draft]");
// Simulated: the stream's last event 61s ago (the real 60s wait is shot in the Mono chat below).
await drive(() => window.__r61.step({ key: "tool:w1", label: "Waiting on a worker", since: Date.now() - 125_000, lastEventAt: Date.now() - 61_000 }));
await wait(400);
await shot("r61-05-room-stall", "[data-hub-msg-draft]");
await drive(() => window.__r61.land("Example: the Tally build is green on main and the date picker fix passed its checks. Nothing needs you."));
await wait(1200);
await shot("r61-06-room-reply-landed");

// ---- A Mono's 1:1 (coding work, inline) ----
const user = { id: "u1", role: "user", text: "Example: fix the date picker on the Tally screen and run the checks.", startedAt: Date.now() };
await page.goto(`${base}/tests/browser/pm-r61-live.html?view=mono`);
await page.waitForSelector("[data-live-activity]");
await wait(2200);
await shot("r61-07-mono-busy-thinking", "[data-mono-work]");
const read = { id: "r1", role: "tool", text: "Read", tool: { kind: "read", status: "in_progress", preview: { kind: "file", path: "/repo/src/features/tally/DatePicker.tsx" } } };
await drive((b) => window.__r61.blocks(b), [user, read]);
await wait(3200);
await shot("r61-08-mono-step-reading", "[data-transcript-turn]:last-of-type");
const check = { id: "c1", role: "tool", text: "npm test -- DatePicker", tool: { kind: "execute", status: "in_progress" } };
await drive((b) => window.__r61.blocks(b), [user, { ...read, tool: { ...read.tool, status: "completed" } }, check]);
await wait(6200);
await shot("r61-09-mono-step-check-sprite", "[data-transcript-turn]:last-of-type");
// A real stall: nothing new from the stream for over a minute.
await wait(61_500);
await shot("r61-10-mono-stall-real-61s", "[data-transcript-turn]:last-of-type");
await drive((b) => window.__r61.blocks(b, false), [
  { ...user, durationMs: 75_000 },
  { ...read, tool: { ...read.tool, status: "completed" } },
  { ...check, tool: { ...check.tool, status: "completed" } },
  { id: "a1", role: "assistant", text: "Example: fixed. The date picker now keeps the chosen month, and its tests pass." },
]);
await wait(1200);
await shot("r61-11-mono-reply-landed");

// ---- A coding team's chat ----
await page.goto(`${base}/tests/browser/pm-r61-live.html?view=team`);
await page.waitForSelector("[data-transcript-turn]");
const agentRun = { id: "w1", role: "tool", text: "Task", tool: { kind: "agent", title: "Task: fix the date picker", status: "in_progress" } };
await drive((b) => window.__r61.blocks(b), [user, { ...read, tool: { ...read.tool, status: "completed" } }, agentRun]);
await wait(4200);
await shot("r61-12-coding-team-worker-sprite", "[data-transcript-turn]:last-of-type");
await drive((b) => window.__r61.blocks(b), [user, { ...read, tool: { ...read.tool, status: "completed" } }, { ...agentRun, tool: { ...agentRun.tool, status: "completed" } }, check]);
await wait(3200);
await shot("r61-13-coding-team-check-sprite", "[data-transcript-turn]:last-of-type");
// Reduced motion: the runner stands still.
const rm = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
const p2 = await rm.newPage();
await p2.goto(`${base}/tests/browser/pm-r61-live.html?view=team`);
await p2.waitForSelector("[data-transcript-turn]");
await p2.evaluate((b) => window.__r61.blocks(b), [user, check]);
await p2.waitForSelector(".live-runner-sprite");
const anim = await p2.evaluate(() => getComputedStyle(document.querySelector(".live-runner-sprite")).animationName);
const animOn = await page.evaluate(() => getComputedStyle(document.querySelector(".live-runner-sprite")).animationName);
log.push(`reduced-motion sprite animation=${anim}; normal=${animOn}`);
await p2.screenshot({ path: `${out}/r61-14-coding-team-reduced-motion.png` });
await browser.close();
console.log(log.join("\n"));
