import { expect, test, type Page } from "@playwright/test";
import { openLocalHub } from "./localHub";

// WP-06: the rail mark, the work split, and the Lead's stuck cards. Being built and Today are gone, so this does not
// look for them. The rows are the ones the old stuck-workers spec seeded.

test.use({ viewport: { width: 1440, height: 900 } });

function rows(ownerSession: string) {
  const now = Date.now();
  const base = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
    id,
    ownerSession,
    ownerMono: "vg-game-lead",
    batchId: "turn-1",
    parentId: null,
    rootId: id,
    childSession: `app-${ownerSession}-${id}`,
    requestId: `r-${id}`,
    generation: 1,
    project: "vg-game",
    title,
    brief: title,
    goal: null,
    askIds: ["a_j_air"],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: now - 30 * 60_000 + Number(id.slice(2)) * 1000,
    updatedAt: now - 60_000,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 1,
    mirrorError: null,
    ...patch,
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

test("a stuck worker shows on the rail and in its Lead's chat", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("monocode:hub-onboarded", "1");
    localStorage.setItem("monocode:hub-setup-not-now", "1");
  });
  await openLocalHub(page);
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });

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
  // A hovered row trades its mark for its options button.
  await page.mouse.move(800, 300);

  const mark = rail(page).locator('[data-mono-stuck="3"]');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("data-mono-stuck-kind", "failed");
  await expect(rail(page).locator('button[aria-label*="1 working · 1 waiting · 1 needs you"]').first()).toBeAttached();
  const line = rail(page).locator('[data-mono-work="vg-game-lead"]');
  await expect(line.locator("[data-mono-work-split]")).toContainText("1 working · 1 waiting · 1 needs you");
  await expect(line).toHaveAttribute("data-mono-work-kind", "needs-you");
  await expect(rail(page).locator("[data-mono-children], [data-mono-child]")).toHaveCount(0);
  const children = page.locator(`[data-sub-chats="${ownerSession}"] [data-sub-chat]`);
  await expect(children).toHaveCount(6);
  await expect(page.locator(`[data-sub-chats="${ownerSession}"] [data-sub-chat][data-state=stalled]`)).toHaveAttribute(
    "aria-label",
    /No output for 9 min/,
  );

  // A stalled worker is folded ("1 worker stalled · Show") until Ash opens it. The failed and asking cards stay out.
  const fold = page.locator('[data-stuck-list="chat"] [data-stuck-stopped-fold]');
  await expect(fold).toContainText("1 worker stalled");
  await fold.getByRole("button", { name: "Show" }).click();
  const cards = page.locator('[data-stuck-list="chat"] [data-stuck-worker]');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute("data-stuck-kind", "stalled");
  await expect(cards.nth(0).locator("[data-stuck-line]")).toHaveText("No output for 9 min · still running the tests");
  await expect(cards.nth(1)).toHaveAttribute("data-stuck-kind", "failed");
  await expect(cards.nth(1).locator("[data-stuck-line]")).toHaveText("Out of credits");
  await expect(cards.nth(1).locator("[data-hub-open-lead]")).toHaveText("Open EXO lead's chat");
  await expect(cards.nth(2).locator("[data-stuck-line]")).toContainText("How long should the air dodge last?");
  const working = page.locator("[data-delegation-working]").first();
  await expect(working).toHaveText(
    "1 working: Wire the dodge input · 1 waiting: Pick the dodge timing · 1 with EXO lead: Run the movement tests",
  );
  // The stopped worker's card is on screen, so the red footer line is not drawn beside it.
  const playtest = cards.filter({ hasText: "Upload the playtest build" });
  await expect(playtest).toBeVisible();
  await expect(playtest.getByRole("button", { name: /^Open / })).toBeVisible();
  await expect(playtest.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect(page.locator("[data-delegation-needs-you]")).toHaveCount(0);
  await expect(line.locator("[data-mono-work-split]")).toContainText("1 needs you");
  await expect(working).toHaveAttribute("title", "Delegated 6: 1 working, 1 waiting, 1 with its Lead, 1 failed, 2 done");
});
