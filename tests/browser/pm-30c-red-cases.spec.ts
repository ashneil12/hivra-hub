import { expect, test } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 30c proof (the real app in a browser, not Ash's Mac; made-up data labelled Example:): Being built under the red
// rule with the cases frank raised on Ash's D5 words. A worker self-repair's retries ran out on and one whose key the
// provider rejected (sent with no error kind) are red Needs you with their reason and "Open Hivra lead's chat"; a stalled
// one its Lead has stays grey "With Hivra lead". Never "Stuck".
//   PM_PROOF_SPEC=pm-30c-red-cases.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs/on-r47 npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-30c";
let stub: { url: string; close(): Promise<void>; addJob(j: Record<string, unknown>): void };
const JOBS = [
  { id: "j_ex_export", title: "Example: export the save files" },
  { id: "j_ex_tests", title: "Example: run the signup tests" },
  { id: "j_ex_deploy", title: "Example: deploy the playtest page" },
];
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
  for (const j of JOBS) stub.addJob({ ...j, projectId: "hivra", lead: "hivra-lead", leadName: "Hivra lead", sourceRef: `ask:a_${j.id}` });
});
test.afterAll(async () => stub?.close());

function rows() {
  const now = Date.now();
  const failedLog = (n: number) => Array.from({ length: n }, (_, i) => ({ at: now - (40 - i * 8) * 60_000, by: "app", event: "settled", state: "failed" }));
  const base = (id: string, job: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, ownerSession: "ex-hivra-lead-chat", ownerMono: "hivra-lead", batchId: null, parentId: null, rootId: id,
    childSession: `ex-worker-${id}`, requestId: `r-${id}`, generation: 1, project: "hivra", title, brief: title, goal: null,
    askIds: [`a_${job}`], state: "running", errorClass: null, error: null, retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: now - 50 * 60_000, updatedAt: now - 60_000,
    settledAt: null, log: [], version: 1, mirroredVersion: 1, mirrorError: null, ...patch,
  });
  return [
    base("t-1", "j_ex_export", "Example: export the save files", {
      state: "failed", settledAt: now - 8 * 60_000, delivery: "delivered", error: "Claude exited with code 1", log: failedLog(4),
    }),
    base("t-2", "j_ex_tests", "Example: run the signup tests", { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 12 * 60_000 }),
    base("t-3", "j_ex_deploy", "Example: deploy the playtest page", {
      state: "failed", error: "API Error: 401 Unauthorized: invalid x-api-key", settledAt: now - 3 * 60_000,
    }),
  ];
}

test("Being built: out of retries and a rejected key are red Needs you; a stall stays grey With <Lead>", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.addInitScript((list) => localStorage.setItem("monocode:dev-delegations", JSON.stringify(list)), rows());
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 20_000 }).then(() => notNow.click(), () => undefined);
  await page.locator("[data-hub-surface]").waitFor({ timeout: 60_000 });
  await page.evaluate(() => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect({ project: "hivra", item: "inbox" }));
  await page.locator('[data-hub-item="being-built"]').click();
  await page.evaluate(() => (window as unknown as { __devDelegationsChanged?: () => void }).__devDelegationsChanged?.());
  const exportRow = page.locator('[data-hub-worker="j_ex_export"]');
  await expect(exportRow.locator("[data-hub-chip]")).toHaveText("Needs you", { timeout: 30_000 });
  await expect(exportRow.locator("[data-hub-circle=red]")).toHaveCount(1);
  await expect(exportRow.locator("[data-hub-job-reason]")).toHaveText("Out of retries: it crashed 4 times");
  await expect(exportRow.locator("[data-hub-job-needs] [data-hub-open-lead]")).toHaveText("Open Hivra lead's chat");
  const deploy = page.locator('[data-hub-worker="j_ex_deploy"]');
  await expect(deploy.locator("[data-hub-chip]")).toHaveText("Needs you");
  await expect(deploy.locator("[data-hub-circle=red]")).toHaveCount(1);
  await expect(deploy.locator("[data-hub-job-reason]")).toHaveText("Key rejected");
  await expect(deploy.locator("[data-hub-job-needs] [data-hub-open-lead]")).toHaveText("Open Hivra lead's chat");
  const tests = page.locator('[data-hub-worker="j_ex_tests"]');
  await expect(tests.locator("[data-hub-chip]")).toHaveText("With Hivra lead");
  await expect(tests.locator("[data-hub-circle=red]")).toHaveCount(0);
  const body = await page.locator("[data-hub-worker]").allInnerTexts();
  expect(body.join("\n")).not.toMatch(/\bStuck\b|x-api-key|401|exited with code/);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/pm-30c-red-cases-1512.png` });
});
