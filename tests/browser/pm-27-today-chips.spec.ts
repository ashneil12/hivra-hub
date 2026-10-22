import { expect, test } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 27 proof (the real app in a browser, hub-dev.html reading the stub Ash OS; not Ash's Mac; made-up data labelled
// Example:): on Today, the job its Lead gave up on is the one red Needs you; the backup its Lead has reads a grey
// "With Hivra lead"; the sound files still fixing themselves read a grey "Retrying". No red Stuck anywhere.
//   PM_PROOF_SPEC=pm-27-today-chips.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-27";
let stub: { url: string; close(): Promise<void> };
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());

test("r27: red is only Needs you; Retrying and With <Lead> are grey", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  const sound = page.locator('[data-hub-chip="Retrying"]').first();
  await expect(sound).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 3000 }).then(() => notNow.click(), () => undefined);
  await expect(page.locator('[data-hub-chip="With Hivra lead"]').first()).toBeVisible();
  const reds = await page.$$eval("[data-hub-circle=red]", (els) => els.map((e) => e.textContent || e.getAttribute("aria-label")));
  console.log(`pm-27 red chips: ${reds.join(", ")}`);
  expect(reds.length).toBeGreaterThan(0);
  expect(new Set(reds)).toEqual(new Set(["Needs you"]));
  expect(await page.locator("[data-hub-circle] >> text=Stuck").count()).toBe(0);
  await page.locator('[data-hub-chip="Needs you"]').first().scrollIntoViewIfNeeded();
  await sound.scrollIntoViewIfNeeded();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/pm-27-today-chips-1512.png` });
});
