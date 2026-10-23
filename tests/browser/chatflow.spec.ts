import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// The chat-flow fixes (hub/9-chatflow) in the real app in a browser (hub-dev.html: the hub reads the stub Ash OS through
// its real transport) with a stand-in for the Claude CLI behind the real Claude adapter (src/dev/fakeClaudeBackend.ts,
// ?fakeClaude): the EXO lead asks Ash a question and his typed words answer it; EXO's own Today counts what waits on him
// like its strip badge; a 402 makes the Lead "can't answer: Out of credits" (the red Needs you) on the rail, Today and
// Being built, and a new message in its chat brings it back. Each state is photographed.
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
/**
 * Leave the Mono's chat for a hub view, as Ash does (G1: there is no all-projects Today; a project is the unit of the
 * hub, "inbox" is its own Today): pick a project item — its onPick closes the 1:1 — then set the view wanted.
 */
const select = async (page: Page, selection: { project: string; item: string }) => {
  const devSelect = () =>
    page.evaluate((sel) => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect(sel), selection);
  await devSelect();
  // A Mono's 1:1 covers the main area until a project item is picked (HubProjectItems onPick → closeChromeViews).
  // "inbox" isn't an item, so the pick lands a sibling view and the selection is set again behind it.
  const item = page.locator(`[data-hub-item="${selection.item === "inbox" ? "being-built" : selection.item}"]`).first();
  if (await item.isVisible().catch(() => false)) {
    await item.click();
    await devSelect();
  }
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
    // Waiting on you is fed by the app's noteChats, which only runs in the Hub bundle (IS_HUB_BUNDLE): the dev page
    // can't write it itself, so seed the entry the live "Which sharing model…" ask below would write — EXO's project,
    // its lead's chat, the gate's choice verdict — and Today + the strip badge read it like any other.
    localStorage.setItem(
      "monocode:hub-waiting-chats",
      JSON.stringify({
        "dev-seed-exo-question": {
          source: "ask",
          question: "Which sharing model should Tally build?",
          more: 0,
          pick: "Private unless shared",
          redLine: false,
          sessionId: "dev-seed-exo-question",
          cwd: "",
          title: "EXO lead",
          monoId: "vg-game-lead",
          askedAt: Date.now(),
          gate: { kind: "choice", reason: "Asks Ash to choose, and says which option it recommends." },
        },
      }),
    );
  });
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}&fakeClaude`);
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });

  // 1. The Lead asks Ash with AskUserQuestion.
  await leadRow(page).click();
  await next(page, "ask");
  await send(page, "have a worker add sharing to tallies now. go");
  await expect(page.locator("[data-question-form]").first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "1-lead-asks");

  // EXO's own Today (G1: a project's Inbox): Waiting on you has the question, and EXO's strip badge counts it.
  await select(page, { project: "vg-game", item: "inbox" });
  await expect(page.locator("[data-hub-waiting-chat]")).toHaveCount(1, { timeout: 15_000 });
  const badge = await page.locator('[data-hub-strip] button[aria-label^="EXO"] span.hub-count-badge').first().textContent();
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
  await expect(failed).toHaveAttribute("data-mono-failed-chip", "Needs you");
  await expect(failed.locator("[data-hub-needs-reason]")).toHaveText("Out of credits");
  await expect(failed.locator("[data-hub-open-lead]")).toHaveText("Open EXO lead's chat");
  await expect(rail(page).locator('[data-mono-status="failed"]').first()).toBeAttached();
  await shot(page, "4-rail-and-chat-out-of-credits");

  await select(page, { project: "vg-game", item: "inbox" });
  const card = page.locator('[data-mono-failure="vg-game-lead"]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator("[data-mono-failure-line]")).toContainText("EXO lead can't answer: Out of credits");
  // Only Ash can fix it: the red Needs you chip, its chat one click away; Try again stays in the chat (r51).
  await expect(card).toHaveAttribute("data-mono-failure-tone", "red");
  await expect(card.locator("[data-hub-chip]")).toHaveText("Needs you");
  await expect(card.locator("[data-hub-open-lead]")).toHaveText("Open EXO lead's chat");
  await expect(card.locator("[data-mono-failure-retry]")).toHaveCount(0);
  // The provider's raw words stay behind Details (the chat, kept mounted out of sight, still has its own error line).
  await expect(page.locator("text=openrouter.ai >> visible=true")).toHaveCount(0);
  await card.locator("[data-mono-failure-details]").click();
  await expect(card.locator("[data-mono-failure-detail]")).toContainText("Insufficient credits");
  await shot(page, "5-today-cant-answer");

  await select(page, { project: "vg-game", item: "being-built" });
  await expect(page.locator('[data-hub-failed-monos] [data-mono-failure="vg-game-lead"]')).toBeVisible({ timeout: 15_000 });
  await shot(page, "6-being-built-cant-answer");

  // 4. Only Ash can fix it: the Needs you opens the Lead's chat (r51 — Try again is in its chat, not on the row), and
  // a new message re-runs the turn; every surface is clear.
  await page.locator('[data-mono-failure="vg-game-lead"] [data-hub-open-lead]').click();
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
  await next(page, "reply");
  await send(page, "credits are back, pick it up");
  await select(page, { project: "vg-game", item: "inbox" });
  await expect(page.locator('[data-mono-failure="vg-game-lead"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(rail(page).locator('[data-mono-failed="vg-game-lead"]')).toHaveCount(0);
  // It sent Ash's new words, not a bare "continue" (which takes up whatever the Lead was on before).
  const last = await fake<string>(page, "prompts.at(-1).text");
  expect(last).toContain("credits are back, pick it up");
  expect(last).not.toContain("Continue from where you left off");
  await shot(page, "7-after-try-again");
});

test("the Working tray lists only running work, each worker under its task title", async ({ page }) => {
  await page.goto("/tests/browser/working-tray.html");
  await expect(page.locator("#after [data-live-agent-card]")).toHaveCount(2, { timeout: 15_000 });
  const tray = await page.evaluate(() => (window as unknown as { tray: { before: [string, boolean][]; after: [string, boolean][] } }).tray);
  // Before: the finished chat listed as Done; every title reads plain now — no harness label, no "[MonoCode …]" tag
  // (r51/r52's listTitle cleans them everywhere, the old rows included).
  expect(tray.before.some(([, done]) => done)).toBe(true);
  expect(tray.before.every(([title]) => !title.startsWith("[MonoCode") && !title.startsWith("claude ·"))).toBe(true);
  // After: running work only, under each task's title.
  expect(tray.after).toEqual([
    ["Prove delete end to end, then review", false],
    ["Tally weekly reset timezone safety", false],
  ]);
  await expect(page.locator("#after")).not.toContainText("[MonoCode brief");
  await shot(page, "8-working-tray");
});
