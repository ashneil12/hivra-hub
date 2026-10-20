import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Stuck workers everywhere Ash looks (H4; Ash 20 Oct: "easy to see when a subagent is stuck both from the main agent and
// from other parts of the UI, being able to respond quickly or go into the chat"). The real app in a browser
// (hub-dev.html: the hub reads the stub Ash OS through its real transport), with the EXO lead's delegation rows seeded
// as delegations.rs would return them: one worker running, one asking its Lead, one stalled, one failed on a billing
// refusal, two done. Each surface is checked and photographed: the Monos rail (folded sub-chats, the Mono's mark, the
// split), the Lead's chat (a card per stuck worker, the rollup line), Being built (the job reads Stuck though a sibling
// runs, Open chat) and Today (the Stuck section).

const SHOTS = process.env.STUCK_PROOF_DIR ?? "test-results/stuck-workers";
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // The "Try the new layout" offer sits over the top right corner; it isn't part of this.
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  // Rows fade in (hub-fade-in, opacity only): photograph them settled.
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

function rows(ownerSession: string) {
  const now = Date.now();
  const base = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, ownerSession, ownerMono: "vg-game-lead", batchId: "turn-1", parentId: null, rootId: id, childSession: `app-${ownerSession}-${id}`,
    requestId: `r-${id}`, generation: 1, project: "vg-game", title, brief: title, goal: null, askIds: ["a_j_air"], state: "running",
    errorClass: null, error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null, delivery: "pending",
    deliveryMessage: null, createdAt: now - 30 * 60_000 + Number(id.slice(2)) * 1000, updatedAt: now - 60_000, settledAt: null,
    log: [], version: 1, mirroredVersion: 1, mirrorError: null, ...patch,
  });
  return [
    base("t-1", "Wire the dodge input"),
    base("t-2", "Pick the dodge timing", {
      state: "question",
      pendingQuestion: "How long should the air dodge last? [0.25 s (Recommended) | 0.4 s]",
      log: [{ at: now - 40_000, by: "worker", event: "asked" }],
    }),
    base("t-3", "Run the movement tests", { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 9 * 60_000 }),
    base("t-4", "Upload the playtest build", { state: "failed", errorClass: "billing", error: "402 Payment Required", settledAt: now - 2 * 60_000 }),
    base("t-5", "Read the dodge rules", { state: "completed", settledAt: now - 20 * 60_000, delivery: "acknowledged" }),
    base("t-6", "Find the jump handler", { state: "completed", settledAt: now - 25 * 60_000, delivery: "acknowledged" }),
  ];
}

async function seed(page: Page, ownerSession: string) {
  await page.evaluate((list) => {
    localStorage.setItem("monocode:dev-delegations", JSON.stringify(list));
    (window as unknown as { __devDelegationsChanged(): void }).__devDelegationsChanged();
  }, rows(ownerSession));
}

const rail = (page: Page) => page.locator("[data-mono-rail]").first();
const leadRow = (page: Page) => rail(page).locator('button[aria-label^="EXO lead"]').first();

test("a stuck worker shows on the rail, in its Lead's chat, in Being built and on Today, answerable from each", async ({ page }) => {
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });

  // Open the EXO lead's chat, so it has a chat the rows belong to.
  await leadRow(page).click();
  const ownerSession = await expect
    .poll(
      () =>
        page.evaluate(() => {
          const roster = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>;
          return roster.find((m) => m.id === "vg-game-lead")?.sessionId ?? "";
        }),
      { timeout: 15_000 },
    )
    .not.toBe("")
    .then(() =>
      page.evaluate(() => {
        const roster = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>;
        return roster.find((m) => m.id === "vg-game-lead")!.sessionId!;
      }),
    );
  await seed(page, ownerSession);

  // The rail: the Mono carries the most urgent mark (red: a failure), its sub-chats opened by themselves (something is
  // stuck), and its status splits what is out.
  const mark = rail(page).locator('[data-mono-stuck="3"]');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("data-mono-stuck-kind", "failed");
  await expect(rail(page).locator('button[aria-label*="1 working · 1 asking · 2 stuck"]').first()).toBeAttached();
  const children = rail(page).locator('[data-mono-children="vg-game-lead"] [data-mono-child]');
  await expect(children).toHaveCount(6);
  await expect(rail(page).locator("[data-mono-child][data-state=stalled]")).toHaveAttribute("aria-label", /No output for 9 min/);

  // The Lead's chat: a card per stuck worker over the composer, oldest first, and the rollup line.
  const cards = page.locator('[data-stuck-list="chat"] [data-stuck-worker]');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute("data-stuck-kind", "stalled");
  await expect(cards.nth(0).locator("[data-stuck-line]")).toHaveText("No output for 9 min · still running npm test");
  await expect(cards.nth(1).locator("[data-stuck-line]")).toHaveText("Failed: billing refused");
  await expect(cards.nth(2).locator("[data-stuck-line]")).toContainText("How long should the air dodge last?");
  // The Lead's line names what is out (leadFlow.ts), the stuck ones too; its count is on hover.
  const line = page.locator("[data-delegation-working]").first();
  await expect(line).toHaveText(
    "1 working: Wire the dodge input · 1 asking: Pick the dodge timing · 2 stuck: Run the movement tests, Upload the playtest build",
  );
  await expect(line).toHaveAttribute("title", "Delegated 6: 1 working, 1 asking, 1 stuck, 1 failed, 2 done");
  await shot(page, "1-lead-chat-and-rail");

  // Folding the sub-chats holds until something new is stuck; the fold still says what is stuck.
  await rail(page).locator('[data-mono-children-toggle="vg-game-lead"]').click();
  await expect(children).toHaveCount(0);
  await expect(rail(page).locator('[data-mono-children-toggle="vg-game-lead"]')).toHaveText("6 sub-chats · 3 stuck");
  await shot(page, "2-rail-folded");

  // Being built: the job reads Stuck with the failed worker's reason though a sibling runs, and opens its chat.
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });
  await seed(page, ownerSession);
  const select = (selection: { project: string; item: string }) =>
    page.evaluate((sel) => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect(sel), selection);
  await select({ project: "vg-game", item: "being-built" });
  const job = page.locator('[data-hub-worker="j_air"]');
  await expect(job.locator("[data-hub-job-state]")).toHaveAttribute("data-hub-job-state", "stuck", { timeout: 15_000 });
  await expect(job.locator("[data-hub-job-reason]")).toHaveText("Failed: billing refused");
  await expect(job.locator('[data-hub-stuck-action="open"]')).toHaveText("Open chat");
  await expect(page.locator('[data-hub-worker="j_format"] [data-hub-job-state]')).toHaveAttribute("data-hub-job-state", "waiting");
  await shot(page, "3-being-built");

  // Today: the Stuck section above Waiting on you, every stuck worker with its project and Lead, answerable there.
  await select({ project: "today", item: "inbox" });
  const today = page.locator("[data-hub-stuck]");
  await expect(today).toBeVisible({ timeout: 15_000 });
  await expect(today.locator("[data-stuck-worker]")).toHaveCount(3);
  await expect(today.locator("[data-stuck-where]").first()).toHaveText("EXO · EXO lead · Run the movement tests");
  await expect(today.locator('[data-stuck-kind="asking"] [data-stuck-reply]')).toBeVisible();
  await expect(today.locator('[data-stuck-kind="failed"] [data-stuck-dismiss]')).toBeVisible();
  await shot(page, "4-today");

  // Dismissing the failure takes it off every surface; the rest stay.
  await today.locator('[data-stuck-kind="failed"] [data-stuck-dismiss]').click();
  await expect(today.locator("[data-stuck-worker]")).toHaveCount(2);
  await expect(rail(page).locator("[data-mono-stuck]")).toHaveAttribute("data-mono-stuck-kind", "stalled");
});
