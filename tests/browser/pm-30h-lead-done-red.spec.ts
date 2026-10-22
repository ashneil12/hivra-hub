import { expect, test } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 30h proof (the real app in a browser, not Ash's Mac; made-up data labelled Example:), from the blind D5 run on
// r49: app workers with no Ash OS job are listed on Being built (their rows aren't sent to Ash OS). One is running. One
// failed, its Lead has read the failure (delivered) and its Lead's chat isn't running a turn, with no retry: red
// "Needs you" with the plain reason and "Open Hivra lead's chat", not grey "With Hivra lead" forever.
//   PM_PROOF_SPEC=pm-30h-lead-done-red.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs/on-r47 npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-30h";
let stub: { url: string; close(): Promise<void> };
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());

function rows() {
  const now = Date.now();
  const base = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, ownerSession: "ex-hivra-lead-chat", ownerMono: "hivra-lead", batchId: null, parentId: null, rootId: id,
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

test("Being built lists app workers; a failed one whose Lead is done is red Needs you", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.addInitScript((list) => localStorage.setItem("monocode:dev-delegations", JSON.stringify(list)), rows());
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 20_000 }).then(() => notNow.click(), () => undefined);
  const card = page.locator("[data-hub-home-projects] > div", { hasText: "Hivra" }).first();
  await card.scrollIntoViewIfNeeded({ timeout: 60_000 });
  await card.getByRole("button", { name: "Being built", exact: true }).click();
  await page.evaluate(() => (window as unknown as { __devDelegationsChanged?: () => void }).__devDelegationsChanged?.());
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
