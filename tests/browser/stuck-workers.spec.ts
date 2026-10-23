import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Stuck workers everywhere Ash looks (H4; Ash 20 Oct: "easy to see when a subagent is stuck both from the main agent and
// from other parts of the UI, being able to respond quickly or go into the chat"), under the r30/r51 red rule — red is
// only "Needs you" (what Ash must sort); what its Lead or a retry is handling reads "With EXO lead" or "waiting",
// never "Stuck". The real app in a browser (hub-dev.html: the hub reads the stub Ash OS through its real transport),
// with the EXO lead's delegation rows seeded as delegations.rs would return them: one worker running, one asking its
// Lead, one stalled, one failed on a billing refusal, two done. Each surface is checked and photographed: the Monos
// rail (the Mono's mark and one line with the split, never its sub-chats: Ash, 20 Oct, they live in its coding team),
// the Lead's chat (a card per stuck worker, the rollup line), its coding team (the sub-chats under the Lead, opened by
// the stuck ones), Being built (the job's row carries the red Needs you and "Open EXO lead's chat" though a sibling
// runs) and the project's own Today (G1: its Inbox; its Needs you section).

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
  // The pointer leaves the Lead's row it clicked (the rail stays put now that the Lead opens in its coding team): a
  // hovered row trades its mark for its options button.
  await page.mouse.move(800, 300);

  // The rail: the Mono carries the most urgent mark (a failure) and one line splitting what is out — what works, what
  // waits on its Lead (the question is its Lead's, never "stuck"), and only what needs Ash, red; its sub-chats are
  // never listed there (they live in its coding team).
  const mark = rail(page).locator('[data-mono-stuck="3"]');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("data-mono-stuck-kind", "failed");
  await expect(rail(page).locator('button[aria-label*="1 working · 1 waiting · 1 needs you"]').first()).toBeAttached();
  const line = rail(page).locator('[data-mono-work="vg-game-lead"]');
  // The line never says "stuck" (r30b): waiting is the worker its Lead answers, needs you is the billing refusal.
  await expect(line.locator("[data-mono-work-split]")).toContainText("1 working · 1 waiting · 1 needs you");
  await expect(line).toHaveAttribute("data-mono-work-kind", "needs-you");
  await expect(rail(page).locator("[data-mono-children], [data-mono-child]")).toHaveCount(0);
  // In its coding team, beside its chat: its sub-chats under it, opened by themselves since something is stuck.
  const children = page.locator(`[data-sub-chats="${ownerSession}"] [data-sub-chat]`);
  await expect(children).toHaveCount(6);
  await expect(page.locator("[data-sub-chat][data-state=stalled]")).toHaveAttribute("aria-label", /No output for 9 min/);

  // The Lead's chat: a card per stuck worker over the composer, oldest first — the stalled one its Lead's, the billing
  // refusal a red Needs you with its plain reason, the question its Lead's to answer — and the rollup line.
  const cards = page.locator('[data-stuck-list="chat"] [data-stuck-worker]');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute("data-stuck-kind", "stalled");
  await expect(cards.nth(0).locator("[data-stuck-line]")).toHaveText("No output for 9 min · still running the tests");
  await expect(cards.nth(1)).toHaveAttribute("data-stuck-kind", "failed");
  await expect(cards.nth(1).locator("[data-stuck-line]")).toHaveText("Out of credits");
  await expect(cards.nth(1).locator("[data-hub-open-lead]")).toHaveText("Open EXO lead's chat");
  await expect(cards.nth(2).locator("[data-stuck-line]")).toContainText("How long should the air dodge last?");
  // The Lead's line names what is out (leadFlow.ts): working, waiting on it, with it — and only what needs Ash, in
  // the red span of its own; the count is on hover.
  const working = page.locator("[data-delegation-working]").first();
  await expect(working).toHaveText(
    "1 working: Wire the dodge input · 1 waiting: Pick the dodge timing · 1 with EXO lead: Run the movement tests",
  );
  await expect(page.locator("[data-delegation-needs-you]").first()).toContainText("1 needs you: Upload the playtest build");
  await expect(working).toHaveAttribute("title", "Delegated 6: 1 working, 1 waiting, 1 with its Lead, 1 failed, 2 done");
  await shot(page, "1-lead-chat-and-rail");

  // Folding the sub-chats in the coding team holds until something new is stuck; the fold still says what is out —
  // waiting, with its Lead, needs you, never "stuck" (r30b).
  await page.locator(`[data-sub-chats-toggle="${ownerSession}"]`).click();
  await expect(children).toHaveCount(0);
  await expect(page.locator(`[data-sub-chats-toggle="${ownerSession}"]`)).toContainText("6 sub-chats · 1 waiting · 1 with EXO lead · 1 needs you");
  // The rail's line still says what is out.
  await expect(line.locator("[data-mono-work-split]")).toContainText("1 working · 1 waiting · 1 needs you");
  await shot(page, "2-coding-team-folded");

  // Being built: the job's row carries the red Needs you with the failed worker's plain reason and "Open EXO lead's
  // chat" under it (r27b/r51; no separate Open chat button) though a sibling runs.
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });
  await seed(page, ownerSession);
  const select = (selection: { project: string; item: string }) =>
    page.evaluate((sel) => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect(sel), selection);
  await select({ project: "vg-game", item: "being-built" });
  const job = page.locator('[data-hub-worker="j_air"]');
  await expect(job.locator("[data-hub-job-state]")).toHaveAttribute("data-hub-job-state", "stuck", { timeout: 15_000 });
  await expect(job.locator("[data-hub-job-state]")).toContainText("Needs you");
  await expect(job.locator("[data-hub-job-reason]")).toHaveText("Out of credits");
  await expect(job.locator("[data-hub-job-needs] [data-hub-open-lead]")).toHaveText("Open EXO lead's chat");
  await expect(job.locator("[data-hub-stuck-action]")).toHaveCount(0);
  await expect(page.locator('[data-hub-worker="j_format"] [data-hub-job-state]')).toHaveAttribute("data-hub-job-state", "waiting");
  await shot(page, "3-being-built");

  // EXO's own Today (G1: a project's Inbox): its Needs you section carries only what Ash must sort — the failed worker,
  // with its Lead named where it sits (the Lead's name already says the project: "EXO lead", not "EXO · EXO lead").
  // The asking worker is its Lead's to relay (D5) and the stalled one sits with Being built: neither is on Today.
  await page.locator('[data-hub-item="being-built"]').first().click();
  await select({ project: "vg-game", item: "inbox" });
  const today = page.locator('[data-hub-stuck-today="red"]');
  await expect(today).toBeVisible({ timeout: 15_000 });
  await expect(today.locator("[data-stuck-worker]")).toHaveCount(1);
  await expect(today.locator("[data-stuck-where]").first()).toHaveText("EXO lead · Upload the playtest build");
  await expect(today.locator('[data-stuck-kind="asking"]')).toHaveCount(0);
  await expect(today.locator('[data-stuck-kind="failed"] [data-stuck-dismiss]')).toBeVisible();
  await shot(page, "4-today");

  // Dismissing the failure takes it off every surface; the rest stay.
  await today.locator('[data-stuck-kind="failed"] [data-stuck-dismiss]').click();
  await expect(today.locator("[data-stuck-worker]")).toHaveCount(0);
  await expect(rail(page).locator("[data-mono-stuck]")).toHaveAttribute("data-mono-stuck-kind", "stalled");
});
