import { expect, test } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 28 proof (the real app in a browser, not Ash's Mac; made-up data labelled Example:). Today: Since comes first and
// the update card sits under it; a card with nothing waiting has no "0 needs"; a Lead named for its project stands
// alone on Today's Being built rows; every "Open <Lead>'s chat" is on its own line under the reason. Hub's Being built
// names its Lead "Hub lead", never "ash-lead". The rail: OK on an add-Mono card is greyed out while the disk is full.
//   PM_PROOF_SPEC=pm-28-screens.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-28";
let stub: { url: string; close(): Promise<void>; addJob(j: Record<string, unknown>): void };
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
  stub.addJob({ id: "j_hub1", projectId: "hub", title: "Example: tidy the rail", lead: "ash-lead", leadName: "ash-lead" });
  stub.addJob({ id: "j_hub2", projectId: "hub", title: "Example: fix the footer", lead: "ash-lead", leadName: "ash-lead", state: "lead_gave_up", reason: "Example: the footer test needs your login" });
});
test.afterAll(async () => stub?.close());

const settle = async (page: import("@playwright/test").Page) => {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
};

test("Today and Hub's Being built", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  // The app hands a window a build on trial before its scripts run: the update card shows (the browser has no ship log).
  await page.addInitScript(() => ((window as unknown as Record<string, unknown>).__MONOCODE_APP__ = { ship: { holding: true, trial: { id: "example-build" } } }));
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(page.locator('[data-hub-need="j:j_sender"] [data-hub-open-lead]')).toHaveText("Open Hivra lead's chat", { timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 3000 }).then(() => notNow.click(), () => undefined);
  // Since first, the update card right under it.
  const order = await page.$$eval("[data-hub-surface-body] [data-hub-since], [data-hub-surface-body] [data-hub-ship], [data-hub-ship]", (els) =>
    els.map((e) => (e.hasAttribute("data-hub-ship") ? "ship" : "since")),
  );
  console.log(`pm-28 order: ${order.join(" > ")}`);
  expect(order[0]).toBe("since");
  // No card says "0 needs".
  for (const card of await page.locator("[data-hub-home-projects] > div").all()) await expect(card).not.toContainText(/\b0 needs?\b/);
  // Every Open <Lead>'s chat on its own line.
  const links = page.locator("[data-hub-open-lead='true']");
  expect(await links.count()).toBeGreaterThan(0);
  expect(await page.$$eval("[data-hub-open-lead='true']", (els) => els.every((l) => l.parentElement?.hasAttribute("data-hub-needs-link") && l.parentElement.children.length === 1))).toBe(true);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/pm-28-today-top-1512.png` });
  const todayJob = page.locator('[data-hub-today-job="j_sender"]');
  await todayJob.scrollIntoViewIfNeeded();
  await expect(todayJob.locator("[data-hub-today-job-where]")).toHaveText("Hivra lead · Needs you"); // not "Hivra · Hivra lead · Needs you"
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/pm-28-today-being-built-1512.png` });
  // Hub's Being built: Hub lead, never ash-lead.
  const hubCard = page.locator("[data-hub-home-projects] > div", { hasText: "MonoCode Hub" }).first();
  await hubCard.scrollIntoViewIfNeeded();
  await hubCard.getByRole("button", { name: "Being built", exact: true }).click();
  const row = page.locator('[data-hub-worker="j_hub2"]');
  await expect(row.locator("[data-hub-open-lead]")).toHaveText("Open Hub lead's chat", { timeout: 20_000 });
  await expect(page.locator('[data-hub-mono-jobs="Hub lead"]')).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("ash-lead");
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/pm-28-hub-being-built-1512.png` });
});

test("the rail: OK is greyed out while the disk is full, Not now stays", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto("/tests/browser/r27b-rail.html");
  const scout = page.locator("[data-soul-waiting-card]", { hasText: "Example: Scout" }).first();
  await scout.getByRole("button", { name: "OK", exact: true }).click({ timeout: 60_000 });
  await expect(scout.locator("[data-mono-soul-problems]")).toContainText("because the disk is full", { timeout: 10_000 });
  await expect(scout.locator("[data-soul-ok-waits-for-space]")).toBeDisabled();
  await expect(scout.getByRole("button", { name: "Not now" })).toBeEnabled();
  expect(await page.$$eval("[data-hub-open-lead='true']", (els) => els.every((l) => l.parentElement?.hasAttribute("data-hub-needs-link")))).toBe(true);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/pm-28-rail-1512.png`, clip: { x: 0, y: 0, width: 520, height: 700 } });
});
