import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// The chat-flow fixes (hub/9-chatflow) in the real app in a browser (hub-dev.html: the hub reads the stub Ash OS through
// its real transport) with a stand-in for the Claude CLI behind the real Claude adapter (src/dev/fakeClaudeBackend.ts,
// ?fakeClaude): the EXO lead asks Ash a question and his typed words answer it; Today's card counts what waits on him
// like its strip badge; a 402 makes the Lead "can't answer: Out of credits" on the rail, Today and Being built, and Try
// again brings it back. Each state is photographed.
//   STUCK_PROOF_PORT=1498 PROOF_SPEC=chatflow.spec.ts npx playwright test -c tests/browser/stuck-workers.config.ts

const SHOTS = process.env.STUCK_PROOF_DIR ?? "test-results/chatflow";
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());
test.use({ viewport: { width: 1440, height: 900 } });

const rail = (page: Page) => page.locator("[data-mono-rail]").first();
const leadRow = (page: Page) => rail(page).locator('button[aria-label^="EXO lead"]').first();
const composer = (page: Page) => page.getByLabel("Message EXO lead");
const fake = <T,>(page: Page, read: string) => page.evaluate((code) => new Function(`return window.__fakeClaude.${code}`)() as T, read);
const next = (page: Page, what: string) => page.evaluate((w) => (window as unknown as { __fakeClaude: { next: string[] } }).__fakeClaude.next.push(w), what);
/** Leave the Mono's chat for a hub view, as Ash does: Today on the strip, then the view. */
const select = async (page: Page, selection: { project: string; item: string }) => {
  await page.locator('[data-hub-strip] button[title="Today, all projects"]').click();
  await page.evaluate((sel) => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect(sel), selection);
};
const send = async (page: Page, text: string) => {
  await composer(page).fill(text);
  await composer(page).press("Enter");
};

test("a typed answer reaches the question; Today counts it; a failed turn shows everywhere with Try again", async ({ page }) => {
  // The Monos run on Claude here (the stand-in CLI), as Ash's do.
  await page.addInitScript(() => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
  });
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}&fakeClaude`);
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });

  // 1. The Lead asks Ash with AskUserQuestion.
  await leadRow(page).click();
  await next(page, "ask");
  await send(page, "have a worker add sharing to tallies now. go");
  await expect(page.locator("[data-question-form]").first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "1-lead-asks");

  // Today: Waiting on you has the question, and EXO's card counts it like its strip badge.
  await select(page, { project: "today", item: "inbox" });
  await expect(page.locator("[data-hub-waiting-chat]")).toHaveCount(1, { timeout: 15_000 });
  const exoCard = page.locator("[data-hub-home-projects] > div").filter({ has: page.getByRole("button", { name: "EXO", exact: true }) });
  const badge = await page.locator('[data-hub-strip] button[aria-label^="EXO"] span.hub-count-badge').first().textContent();
  await expect(exoCard.locator("[data-hub-card-needs]")).toHaveText(`${badge} ${badge === "1" ? "need" : "needs"}`);
  expect(Number(badge)).toBeGreaterThan(0);
  await shot(page, "2-today-waiting-and-count");

  // 2. Ash types his answer in the Lead's chat, as he would: it answers the question, never queues behind it.
  await leadRow(page).click();
  await send(page, "private by default. the owner turns sharing on per tally");
  await expect.poll(() => fake<number>(page, "answers.length"), { timeout: 15_000 }).toBe(1);
  expect(await fake(page, "answers[0]")).toMatchObject({
    behavior: "allow",
    answers: { "Which sharing model should Tally build?": "private by default. the owner turns sharing on per tally" },
  });
  await expect(page.getByText("Going with your answer: private by default.", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-question-form]")).toHaveCount(0);
  // Only the first prompt went to Claude: the answer was not a message of its own.
  expect(await fake<number>(page, "prompts.length")).toBe(1);
  await shot(page, "3-typed-answer-went-in");

  // 3. The Lead's next turn hits the CLI's recorded 402: a state on the rail, Today and Being built.
  await next(page, "402");
  await send(page, "status? one line");
  const failed = rail(page).locator('[data-mono-failed="vg-game-lead"]');
  await expect(failed).toBeVisible({ timeout: 15_000 });
  await expect(failed).toHaveAttribute("data-mono-failed-tone", "red");
  await expect(failed.locator("[data-mono-failed-reason]")).toHaveText("Out of credits");
  await expect(rail(page).locator('[data-mono-status="failed"]').first()).toBeAttached();
  await shot(page, "4-rail-and-chat-out-of-credits");

  await select(page, { project: "today", item: "inbox" });
  const card = page.locator('[data-mono-failure="vg-game-lead"]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator("[data-mono-failure-line]")).toContainText("EXO lead can't answer: Out of credits");
  // The provider's raw words stay behind Details (the chat, kept mounted out of sight, still has its own error line).
  await expect(page.locator("text=openrouter.ai >> visible=true")).toHaveCount(0);
  await card.locator("[data-mono-failure-details]").click();
  await expect(card.locator("[data-mono-failure-detail]")).toContainText("Insufficient credits");
  await shot(page, "5-today-cant-answer");

  await select(page, { project: "vg-game", item: "being-built" });
  await expect(page.locator('[data-hub-failed-monos] [data-mono-failure="vg-game-lead"]')).toBeVisible({ timeout: 15_000 });
  await shot(page, "6-being-built-cant-answer");

  // 4. Try again (from Today): the turn goes again and answers; every surface is clear.
  await select(page, { project: "today", item: "inbox" });
  await next(page, "reply");
  await page.locator('[data-mono-failure="vg-game-lead"] [data-mono-failure-retry]').click();
  await expect(page.locator('[data-mono-failure="vg-game-lead"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(rail(page).locator('[data-mono-failed="vg-game-lead"]')).toHaveCount(0);
  // It sent the failed message again, not a bare "continue" (which takes up whatever the Lead was on before).
  const last = await fake<string>(page, "prompts.at(-1).text");
  expect(last.trim().endsWith("status? one line")).toBe(true);
  expect(last).not.toContain("Continue from where you left off");
  await shot(page, "7-after-try-again");
});

test("the Working tray lists only running work, each worker under its task title", async ({ page }) => {
  await page.goto("/tests/browser/working-tray.html");
  await expect(page.locator("#after [data-live-agent-card]")).toHaveCount(2, { timeout: 15_000 });
  const tray = await page.evaluate(() => (window as unknown as { tray: { before: [string, boolean][]; after: [string, boolean][] } }).tray);
  // Before: the finished chat listed as Done, a worker named "[MonoCode brief from …".
  expect(tray.before.some(([, done]) => done)).toBe(true);
  expect(tray.before.some(([title]) => title.startsWith("[MonoCode brief from"))).toBe(true);
  // After: running work only, under each task's title.
  expect(tray.after).toEqual([
    ["Prove delete end to end, then review", false],
    ["Tally weekly reset timezone safety", false],
  ]);
  await expect(page.locator("#after")).not.toContainText("[MonoCode brief");
  await shot(page, "8-working-tray");
});
