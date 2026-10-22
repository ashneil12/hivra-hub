import { expect, test } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 27b proof (the real app in a browser, not Ash's Mac; made-up data labelled Example:). Red "Needs you" is any job
// or Lead problem only Ash can fix, and every one shows its reason and "Open <Lead>'s chat": on Today, Being built and
// the Monos rail. A failed turn that comes right by itself is a grey "Can't answer"; stuck marks are grey, never amber.
// The backup's chip and its sent line name the same Lead.
//   PM_PROOF_SPEC=pm-27b-needs-you.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-27b";
let stub: { url: string; close(): Promise<void> };
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());

const noAmber = async (page: import("@playwright/test").Page) =>
  expect(await page.locator("[class*='amber-']").count()).toBe(0);

test("Today and Being built: every red Needs you has its reason and its Lead's chat; one Lead name on the backup", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  const need = page.locator('[data-hub-need="j:j_sender"]');
  await expect(need.locator("[data-hub-open-lead]")).toHaveText("Open Hivra lead's chat", { timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 3000 }).then(() => notNow.click(), () => undefined);
  await expect(page.locator("[data-hub-sent]").first()).toHaveText(/^Sent to Hivra lead at .* · Got it$/);
  for (const red of await page.locator("[data-hub-circle=red]").all()) await expect(red).toHaveText("Needs you");
  await noAmber(page);
  await need.scrollIntoViewIfNeeded();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-27b-today-1512.png` });
  // Today's Being built list.
  const todayJob = page.locator('[data-hub-today-job="j_sender"]');
  await todayJob.scrollIntoViewIfNeeded();
  await expect(todayJob.locator("[data-hub-open-lead]")).toHaveText("Open Hivra lead's chat");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/pm-27b-today-being-built-1512.png` });
  // Hivra's Being built.
  await page.evaluate(() => (window as unknown as { __hubSelect?: (s: unknown) => void }).__hubSelect?.({ project: "hivra", item: "being-built" }));
  if (!(await page.locator('[data-hub-worker="j_sender"]').count())) {
    await todayJob.locator("button").first().click();
  }
  const row = page.locator('[data-hub-worker="j_sender"]');
  await expect(row.locator("[data-hub-open-lead]")).toHaveText("Open Hivra lead's chat", { timeout: 20_000 });
  await expect(page.locator('[data-hub-worker="j_backup"] [data-hub-job-sent]')).toHaveText(/^Sent to Hivra lead at .* · Got it$/);
  await expect(page.locator('[data-hub-worker="j_backup"] [data-hub-chip]')).toHaveText("With Hivra lead");
  await noAmber(page);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-27b-being-built-1512.png` });
});

test("the rail: Needs you with the reason and Open <Lead>'s chat; Can't answer grey; the OK problems red only when Ash must fix", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto("/tests/browser/r27b-rail.html");
  const red = page.locator('[data-mono-failed="ex-hivra-lead"]');
  await expect(red.locator("[data-hub-chip]")).toHaveText("Needs you", { timeout: 60_000 });
  await expect(red.locator("[data-hub-needs-reason]")).toHaveText("Out of credits");
  await expect(red.locator("[data-hub-open-lead]")).toHaveText("Open Example: Hivra lead's chat");
  const grey = page.locator('[data-mono-failed="ex-nibbii-lead"]');
  await expect(grey).toHaveAttribute("data-mono-failed-chip", "Can't answer");
  await expect(grey.locator("[data-hub-circle=red]")).toHaveCount(0);
  // OK on both waiting Monos: Ledger's file couldn't be read (grey), Scout's OK failed outright (Needs you).
  for (const name of ["Example: Ledger", "Example: Scout"]) {
    const box = page.locator("[data-souls-waiting] > *", { hasText: name }).first();
    await box.getByRole("button", { name: "OK", exact: true }).click();
  }
  await expect(page.locator('[data-mono-soul-problem="needs-you"]').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-mono-soul-problem="grey"]').first()).toBeVisible();
  const problems = await page.$$eval("[data-mono-soul-problem]", (els) => els.map((e) => `${e.getAttribute("data-mono-soul-problem")}: ${e.textContent}`));
  console.log(`pm-27b soul problems: ${problems.join(" | ")}`);
  await noAmber(page);
  expect(await page.locator(".text-red-400, .bg-red-400").count()).toBeLessThanOrEqual(1); // the failed Lead's own dot
  await red.locator("[data-hub-open-lead]").click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", "ex-hivra-lead");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  await page.locator("[data-proof-rail]").screenshot({ path: `${SHOTS}/pm-27b-rail.png` });
  await page.screenshot({ path: `${SHOTS}/pm-27b-rail-1512.png`, clip: { x: 0, y: 0, width: 520, height: 700 } });
});
