import { expect, test } from "@playwright/test";
import fs from "node:fs";

// Round 30 proof (the real Today rows and Monos rail in a browser, not Ash's Mac; made-up data labelled Example:): no
// "Stuck" section or word; a failed worker its Lead has reads grey "With <Lead>" in plain words with "Open <Lead>'s chat"
// and Dismiss; only a credits refusal is red Needs you, and the rail counts only that ("1 needs you").
//   PM_PROOF_SPEC=pm-30-today.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-30";

test("Today and the rail follow the red rule: With <Lead> in grey, Needs you only for Ash", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto("/tests/browser/r30-today.html");
  const grey = page.locator('[data-hub-stuck-today="grey"] [data-stuck-worker="w-t-2"]');
  await expect(grey).toHaveCount(1, { timeout: 60_000 });
  await expect(grey.locator("[data-stuck-line]")).toHaveText("This worker was set to fail on purpose for a test");
  await expect(grey.locator("[data-stuck-open]")).toHaveText("Open Example: Hivra lead's chat");
  await expect(grey.locator("[data-stuck-dismiss]")).toHaveText("Dismiss");
  const red = page.locator('[data-hub-stuck-today="red"] [data-stuck-worker="w-t-4"]');
  await expect(red.locator("[data-stuck-line]")).toHaveText("Out of credits");
  await expect(red.locator("[data-hub-open-lead]")).toHaveText("Open Example: Nibbii lead's chat");
  const body = (await page.locator("body").innerText()) ?? "";
  expect(body).not.toMatch(/\bstuck\b|dev-faults|Open chat\b|\bfailed\b/i);
  await expect(page.locator("[data-proof-rail] [data-stuck-trigger]")).toHaveText(["1 needs you"]);
  const amber = await page.evaluate(() => [...document.querySelectorAll("*")].filter((e) => /amber/.test(e.getAttribute("class") ?? "")).length);
  expect(amber).toBe(0);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-30-today-red-rule-1512.png` });
});
