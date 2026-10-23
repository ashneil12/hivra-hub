import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 30h proof (the real app in a browser, not Ash's Mac; made-up data labelled Example:), from the blind D5 run on
// r49: app workers with no Ash OS job are listed on Being built (their rows aren't sent to Ash OS). One is running. One
// failed, its Lead has read the failure (delivered) and its Lead's chat isn't running a turn, with no retry: red
// "Needs you" with the plain reason and "Open Hivra lead's chat", not grey "With Hivra lead" forever.
// r51: "its Lead's chat isn't running a turn" is something the app knows only of a chat this window holds
// (delegationStore.ts knownChats — an unknown chat is never taken as "not busy"), so the workers' Lead is the Hivra
// lead's own chat, opened from the rail, not an invented id.
//   PM_PROOF_SPEC=pm-30h-lead-done-red.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs/on-r47 npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-30h";
let stub: { url: string; close(): Promise<void> };
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());

function rows(owner: string) {
  const now = Date.now();
  const base = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, ownerSession: owner, ownerMono: "hivra-lead", batchId: null, parentId: null, rootId: id,
    childSession: `ex-worker-${id}`, requestId: `r-${id}`, generation: 1, project: "hivra", title, brief: title, goal: null,
    askIds: [], state: "running", errorClass: null, error: null, retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: now - 6 * 60_000, updatedAt: now - 30_000,
    settledAt: null, log: [], version: 1, mirroredVersion: 1, mirrorError: null, ...patch,
  });
  return [
    base("h-run", "Example: tidy the README setup steps"),
    base("h-faq", "Example: fix the outdated FAQ", {
      createdAt: now - 9 * 60_000, state: "failed", settledAt: now - 4 * 60_000, delivery: "delivered", error: "Stopped with an error.",
      log: [{ at: now - 4 * 60_000, by: "app", event: "settled", state: "failed" }, { at: now - 3 * 60_000, by: "app", event: "delivered" }],
    }),
  ];
}

/** The Hivra lead's chat, held by this window and idle: open it from the rail, then read the id the roster records. */
async function leadChatId(page: Page): Promise<string> {
  // The rail lists only the selected project's Monos (MonoRailSection's projectFilter), and a fresh page auto-selects
  // the stub's first project (vg-game): select hivra first or its Lead's row is never in the rail.
  await page.evaluate(() => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect({ project: "hivra", item: "inbox" }));
  const row = page.locator("[data-mono-rail]").first().locator('button[aria-label^="Hivra lead"]').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const idOf = () =>
    page.evaluate(
      () =>
        (JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>).find(
          (m) => m.id === "hivra-lead",
        )?.sessionId ?? "",
    );
  await expect.poll(idOf, { timeout: 15_000 }).not.toBe("");
  return idOf();
}

test("Being built lists app workers; a failed one whose Lead is done is red Needs you", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 20_000 }).then(() => notNow.click(), () => undefined);
  await page.locator("[data-hub-surface]").waitFor({ timeout: 60_000 });
  const owner = await leadChatId(page);
  await page.evaluate((list) => {
    localStorage.setItem("monocode:dev-delegations", JSON.stringify(list));
    (window as unknown as { __devDelegationsChanged?: () => void }).__devDelegationsChanged?.();
  }, rows(owner));
  // leadChatId's rail click left the Lead's 1:1 covering the main area (monoCovers): __devHubSelect only stores a
  // selection behind that cover, and a reload would drop the chat from knownChats, which r51's "lead is done" reads.
  // Ash's way to Being built is the rail item itself: its onPick closes the Mono view (HubProjectItems, App.tsx).
  await page.locator('[data-hub-item="being-built"]').click();
  const running = page.locator('[data-hub-worker="app:h-run"]');
  await expect(running).toContainText("Example: tidy the README setup steps", { timeout: 30_000 });
  const faq = page.locator('[data-hub-worker="app:h-faq"]');
  await expect(faq.locator("[data-hub-chip]")).toHaveText("Needs you");
  await expect(faq.locator("[data-hub-circle=red]")).toHaveCount(1);
  await expect(faq.locator("[data-hub-job-reason]")).toHaveText("Stopped with an error.");
  await expect(faq.locator("[data-hub-job-needs] [data-hub-open-lead]")).toHaveText("Open Hivra lead's chat");
  expect(`${await faq.innerText()}\n${await running.innerText()}`).not.toMatch(/\bStuck\b|With Hivra lead/);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/pm-30h-lead-done-red-1512.png` });
});
