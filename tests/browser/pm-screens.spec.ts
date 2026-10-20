import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// B6 and A9 in the real app in a browser (hub-dev.html reading the stub Ash OS): the EXO lead has one worker running and
// three stuck (asking, stalled, failed). "3 stuck" on its rail line opens a panel of those workers, each with why, a
// reply box and Open chat. The Monos section folds, the header still says what is out, its "3 stuck" opens the same
// panel, and the fold survives a reload. Photographed at each step. A browser preview only: not Ash's Mac.

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

test("'3 stuck' opens its workers to answer; the folded Monos section still says what is out", async ({ page }) => {
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });
  await leadRow(page).click();
  let ownerSession = "";
  await expect
    .poll(
      async () =>
        (ownerSession = await page.evaluate(() => {
          const roster = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>;
          return roster.find((m) => m.id === "vg-game-lead")?.sessionId ?? "";
        })),
      { timeout: 15_000 },
    )
    .not.toBe("");
  // Fresh load on Today, with the rows seeded, as Ash would come back to it.
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });
  await seed(page, ownerSession);
  await select(page, { project: "today", item: "inbox" });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.mouse.move(800, 300);

  // B6: the stuck part of the line opens the panel.
  const line = rail(page).locator('[data-mono-work="vg-game-lead"]');
  await expect(line.locator("[data-mono-work-split]")).toHaveText("1 working · 3 stuck");
  await line.locator("[data-stuck-trigger]").click();
  const panel = page.locator("[data-stuck-panel]");
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-stuck-worker]")).toHaveCount(3);
  await expect(panel.locator("[data-stuck-reply]").first()).toBeVisible();
  await expect(panel.locator("[data-stuck-open]").first()).toHaveText("Open chat");
  await panel.locator('[data-stuck-kind="stalled"] [data-stuck-reply]').fill("Skip the flaky test and carry on");
  await shot(page, "1-rail-stuck-panel");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // Today shows the same stuck workers with the same reply.
  await expect(page.locator("[data-hub-stuck] [data-stuck-worker]")).toHaveCount(3, { timeout: 15_000 });
  await shot(page, "2-today-stuck");

  // A9: fold the section; the header keeps the summary, and its stuck part opens every Mono's stuck workers.
  const toggle = rail(page).getByRole("button", { name: "Collapse Monos" });
  await toggle.click();
  await expect(rail(page).getByRole("button", { name: "Expand Monos" })).toHaveAttribute("aria-expanded", "false");
  const summary = rail(page).locator("[data-mono-rail-summary]");
  await expect(summary).toHaveAttribute("title", "1 working · 1 asking · 2 stuck");
  await shot(page, "3-monos-folded");
  await summary.locator("[data-stuck-trigger]").click();
  await expect(panel.locator("[data-stuck-worker]")).toHaveCount(3);
  await shot(page, "4-monos-folded-stuck-panel");
  await page.keyboard.press("Escape");

  // The fold survives a reload (the app's preferences).
  await page.reload();
  await expect(rail(page).getByRole("button", { name: "Expand Monos" })).toBeVisible({ timeout: 30_000 });
  await seed(page, ownerSession);
  await select(page, { project: "today", item: "inbox" });
  await expect(rail(page).locator("[data-mono-rail-summary]")).toBeVisible({ timeout: 15_000 });
  await shot(page, "5-monos-folded-after-reload");
});
