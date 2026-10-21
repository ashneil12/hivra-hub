import { expect, test } from "@playwright/test";
import fs from "node:fs";

// G5 proof, round 18, updated round 19: a fresh install's onboarding (hub-dev.html?onboarding, empty storage, no Ash OS)
// asks what the team should call you, and offers no pre-load (Ash 21 Oct). No "Ash" in any of it. The round 18 photos
// of the plain team and the pre-load (pm-18-onboarding-plain-team.png, pm-18-onboarding-preload-picked.png) are
// history now; round 19's pm-19-onboarding-team.png shows the team. A browser preview only: not Ash's Mac.
// PM_PROOF_SPEC=pm-18-user-name.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-18";
test.use({ viewport: { width: 1440, height: 900 } });

test("fresh install onboarding: your name, and no pre-load", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/hub-dev.html?onboarding");
  const onboarding = page.locator("[data-hub-onboarding]");
  await expect(onboarding).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await expect(page.getByText("What should your team call you?")).toBeVisible();
  await page.locator("[data-hub-onboarding-name]").fill("Sam");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/pm-18-onboarding-name.png` });
  const noAsh = async () => expect(await page.evaluate(() => /\bAsh\b/.test(document.body.innerText))).toBe(false);
  await noAsh();

  await page.locator("[data-hub-onboarding-next]").click();
  await expect(page.getByText("Pre-load a saved team")).toHaveCount(0);
  await expect(page.getByText("Business partner").first()).toBeVisible(); // the role line under Chief of Staff
  const line = page.locator("[data-hub-onboarding-dashboards]");
  const box = await line.boundingBox();
  expect(box && box.height).toBeLessThan(24); // one line: "Org / ops" doesn't wrap
  await noAsh();
});

test("Settings → General: the same name, to change later", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/hub-dev.html?onboarding");
  await expect(page.locator("[data-hub-onboarding]")).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.locator("[data-hub-onboarding-name]").fill("Sam");
  await page.locator("[data-hub-onboarding-skip]").click();
  await expect(page.locator("[data-hub-onboarding]")).toHaveCount(0);
  await page.getByRole("button", { name: /^Settings/ }).first().click();
  await page.getByRole("button", { name: "General" }).first().click();
  const field = page.locator("[data-user-name]");
  await expect(field).toHaveValue("Sam");
  await expect(page.getByText("What should your team call you?").first()).toBeVisible();
  await field.fill("Sam Lee");
  expect(await page.evaluate(() => localStorage.getItem("monocode:hub-user-name"))).toBe("Sam Lee");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-18-settings-name.png` });
});
