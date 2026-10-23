import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// B6 and A9 in the real app in a browser (hub-dev.html reading the stub Ash OS), under the r30/r51 red rule: the EXO
// lead has one worker running, one waiting on it (its question is its Lead's, never "stuck"), one stalled its Lead is
// handling, and one only Ash can sort (a billing refusal). "1 needs you" on its rail line opens a panel of just that:
// the failed worker with its plain reason, Dismiss, and "Open EXO lead's chat" — a red row's answer is its Lead's
// chat, not a reply box. The Monos section folds, the header still says what is out, its "N needs you" opens every
// Lead's needs-you rows, and the fold survives a reload. Photographed at each step. A browser preview only: not
// Ash's Mac.

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-screens";
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

function rows(ownerSession: string) {
  const now = Date.now();
  const base = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, ownerSession, ownerMono: "vg-game-lead", batchId: "turn-1", parentId: null, rootId: id, childSession: `app-${ownerSession}-${id}`,
    requestId: `r-${id}`, generation: 1, project: "vg-game", title, brief: title, goal: null, askIds: [], state: "running",
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
const select = (page: Page, selection: { project: string; item: string }) =>
  page.evaluate((sel) => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect(sel), selection);
// The roster mints a fresh sessionId on every load, so a chat binds rows by their ownerSession only when it is the
// current one: re-read it after each navigation, then seed.
async function leadSession(page: Page): Promise<string> {
  let sessionId = "";
  await expect
    .poll(
      async () =>
        (sessionId = await page.evaluate(() => {
          const roster = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>;
          return roster.find((m) => m.id === "vg-game-lead")?.sessionId ?? "";
        })),
      { timeout: 15_000 },
    )
    .not.toBe("");
  return sessionId;
}

test("'1 needs you' opens what needs Ash; the folded Monos section still says what is out", async ({ page }) => {
  // Open the Lead's chat once so the roster mints this load's sessionId, seed its rows against it, then land on
  // EXO's own Today (G1: a project's Inbox is its Today) as Ash would come back to it.
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });
  await leadRow(page).click();
  const ownerSession = await leadSession(page);
  await seed(page, ownerSession);
  await page.locator('[data-hub-item="being-built"]').first().click();
  await select(page, { project: "vg-game", item: "inbox" });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.mouse.move(800, 300);

  // B6: the needs-you part of the line opens the panel — working, waiting on its Lead, then only what needs Ash.
  const line = rail(page).locator('[data-mono-work="vg-game-lead"]');
  await expect(line.locator("[data-mono-work-split]")).toContainText("1 working · 1 waiting");
  const trigger = line.locator("[data-stuck-trigger]");
  await expect(trigger).toHaveText("1 needs you");
  await trigger.click();
  const panel = page.locator("[data-stuck-panel]");
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-stuck-panel-title]")).toHaveText("EXO lead");
  await expect(panel).toContainText("1 needs you");
  // Only what Ash must sort (r51): the billing refusal, its plain reason, Dismiss, and "Open EXO lead's chat" — a red
  // row's answer is the Lead's chat, so it carries no reply box and no "Open chat" button.
  await expect(panel.locator("[data-stuck-worker]")).toHaveCount(1);
  const failedRow = panel.locator('[data-stuck-kind="failed"]');
  await expect(failedRow).toContainText("Needs you");
  await expect(failedRow.locator("[data-stuck-line]")).toHaveText("Out of credits");
  await expect(failedRow.locator("[data-hub-open-lead]")).toHaveText("Open EXO lead's chat");
  await expect(failedRow.locator("[data-stuck-dismiss]")).toHaveText("Dismiss");
  await expect(failedRow.locator("[data-stuck-reply]")).toHaveCount(0);
  await shot(page, "1-rail-needs-you-panel");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // EXO's Today shows the same needs-you card; the stalled worker its Lead is handling never reaches it.
  await expect(page.locator('[data-hub-stuck-today="red"] [data-stuck-worker]')).toHaveCount(1, { timeout: 15_000 });
  await shot(page, "2-today-needs-you");

  // The stalled worker is still answerable where Ash sees it: its card sits in the Lead's chat, reply box and all.
  await leadRow(page).click();
  await page.locator('[data-stuck-kind="stalled"] [data-stuck-reply]').first().fill("Skip the flaky test and carry on");
  await shot(page, "2b-lead-chat-worker-reply");
  // Back to EXO's own Today: pick a project item (it closes the 1:1 cover), then its Inbox.
  await page.locator('[data-hub-item="being-built"]').first().click();
  await select(page, { project: "vg-game", item: "inbox" });

  // A9: fold the section; the header keeps this project's summary, and its needs-you part opens the needs-you rows
  // (G1 scopes the rail to the selected project, so only EXO's failed worker counts here).
  const toggle = rail(page).getByRole("button", { name: "Collapse Monos" });
  await toggle.click();
  await expect(rail(page).getByRole("button", { name: "Expand Monos" })).toHaveAttribute("aria-expanded", "false");
  const summary = rail(page).locator("[data-mono-rail-summary]");
  await expect(summary).toHaveAttribute("title", "1 working · 1 waiting · 1 needs you");
  await shot(page, "3-monos-folded");
  await summary.locator("[data-stuck-trigger]").click();
  await expect(panel.locator("[data-stuck-panel-title]")).toHaveText("Monos");
  await expect(panel).toContainText("1 needs you");
  await expect(panel.locator("[data-stuck-worker]")).toHaveCount(1);
  await shot(page, "4-monos-folded-needs-you-panel");
  await page.keyboard.press("Escape");

  // The fold survives a reload (the app's preferences); the rail keys rows by ownerMono, so re-seeding as-is is
  // enough here (only the folded summary is asserted below).
  await page.reload();
  await expect(rail(page).getByRole("button", { name: "Expand Monos" })).toBeVisible({ timeout: 30_000 });
  await seed(page, ownerSession);
  await select(page, { project: "vg-game", item: "inbox" });
  await expect(rail(page).locator("[data-mono-rail-summary]")).toBeVisible({ timeout: 15_000 });
  await shot(page, "5-monos-folded-after-reload");
});
