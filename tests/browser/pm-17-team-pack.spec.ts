import { expect, test } from "@playwright/test";
import fs from "node:fs";

// G5 proof: a fresh install's onboarding (hub-dev.html?onboarding, empty storage, no Ash OS) starts with a plain
// team, and a saved team is there to pre-load. A browser preview only: not Ash's Mac.
// PM_PROOF_SPEC=pm-17-team-pack.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-17";
test.use({ viewport: { width: 1440, height: 900 } });

test("fresh install onboarding: a plain team, Ash's team only as a pre-load", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/hub-dev.html?onboarding");
  const onboarding = page.locator("[data-hub-onboarding]");
  await expect(onboarding).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.locator("[data-hub-onboarding-next]").click();
  await expect(page.getByText("A plain team")).toBeVisible();
  await expect(page.getByText("Pre-load a saved team")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("monocode:hub-team-pack"))).toBe("plain");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/pm-17-onboarding-plain-team.png` });
  await page.getByText("Pre-load a saved team").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-17-onboarding-preload-picked.png` });
});
