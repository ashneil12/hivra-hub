import { expect, test } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 30b proof (the real app in a browser, not Ash's Mac; made-up data labelled Example:): Being built under the red
// rule. Three Example jobs, each with this app's worker under it: a test fault with a file path (its Lead's: grey "With
// Hivra lead", one plain line, "Open Hivra lead's chat"), a stalled one (also its Lead's), and one refused for credits
// (the red Needs you, "Out of credits", the link on its own line). Never "Stuck" or "Open chat".
//   PM_PROOF_SPEC=pm-30b-being-built.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-30b";
let stub: { url: string; close(): Promise<void>; addJob(j: Record<string, unknown>): void };
const JOBS = [
  { id: "j_ex_readme", title: "Example: tidy the README setup steps" },
  { id: "j_ex_tests", title: "Example: run the signup tests" },
  { id: "j_ex_publish", title: "Example: publish the playtest page" },
];
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
  for (const j of JOBS) stub.addJob({ ...j, projectId: "hivra", lead: "hivra-lead", leadName: "Hivra lead", sourceRef: `ask:a_${j.id}` });
});
test.afterAll(async () => stub?.close());

function rows() {
  const now = Date.now();
  const base = (id: string, job: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, ownerSession: "ex-hivra-lead-chat", ownerMono: "hivra-lead", batchId: null, parentId: null, rootId: id,
    childSession: `ex-worker-${id}`, requestId: `r-${id}`, generation: 1, project: "hivra", title, brief: title, goal: null,
    askIds: [`a_${job}`], state: "running", errorClass: null, error: null, retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: now - 30 * 60_000, updatedAt: now - 60_000,
    settledAt: null, log: [], version: 1, mirroredVersion: 1, mirrorError: null, ...patch,
  });
  return [
    base("t-1", "j_ex_readme", "Example: tidy the README setup steps", {
      state: "failed", settledAt: now - 9 * 60_000, delivery: "delivered",
      error: "Test fault: this worker was set to fail on purpose for a test (dev-faults/fail-next-workers)",
    }),
    base("t-2", "j_ex_tests", "Example: run the signup tests", { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 12 * 60_000 }),
    base("t-3", "j_ex_publish", "Example: publish the playtest page", {
      state: "failed", errorClass: "billing", error: "Billing refused (402): Insufficient credits", settledAt: now - 3 * 60_000,
    }),
  ];
}

test("Being built follows the red rule: grey With <Lead>, red Needs you only for Ash, never Stuck", async ({ page }) => {
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
  const readme = page.locator('[data-hub-worker="j_ex_readme"]');
  await expect(readme.locator("[data-hub-chip]")).toHaveText("With Hivra lead", { timeout: 30_000 });
  await expect(readme.locator("[data-hub-job-reason]")).toHaveText("This worker was set to fail on purpose for a test");
  await expect(readme.locator('[data-hub-stuck-action="open"]')).toHaveText("Open Hivra lead's chat");
  const tests = page.locator('[data-hub-worker="j_ex_tests"]');
  await expect(tests.locator("[data-hub-chip]")).toHaveText("With Hivra lead");
  const publish = page.locator('[data-hub-worker="j_ex_publish"]');
  await expect(publish.locator("[data-hub-chip]")).toHaveText("Needs you");
  await expect(publish.locator("[data-hub-circle=red]")).toHaveCount(1);
  await expect(publish.locator("[data-hub-job-reason]")).toHaveText("Out of credits");
  await expect(publish.locator("[data-hub-job-needs] [data-hub-open-lead]")).toHaveText("Open Hivra lead's chat");
  const body = await page.locator("[data-hub-worker]").allInnerTexts();
  expect(body.join("\n")).not.toMatch(/\bStuck\b|Open chat\b|dev-faults|402/);
  // The longer "Open <Lead>'s chat" never runs into the time beside it.
  for (const id of ["j_ex_readme", "j_ex_tests"]) {
    const row = page.locator(`[data-hub-worker="${id}"]`);
    const open = await row.locator('[data-hub-stuck-action="open"]').boundingBox();
    const time = await row.locator("[data-hub-last-active]").boundingBox();
    expect(open!.x).toBeGreaterThanOrEqual(time!.x + time!.width - 1);
  }
  await readme.scrollIntoViewIfNeeded();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/pm-30b-being-built-1512.png` });
});
