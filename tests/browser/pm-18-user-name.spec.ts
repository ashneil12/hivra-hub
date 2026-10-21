import { expect, test } from "@playwright/test";
import fs from "node:fs";

// G5 proof, round 18: a fresh install's onboarding (hub-dev.html?onboarding, empty storage, no Ash OS) asks what the
// team should call you, the sidebar behind the card follows the team picked, and the pre-load reads "a saved team".
// No "Ash" in any of it. A browser preview only: not Ash's Mac.
// PM_PROOF_SPEC=pm-18-user-name.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-18";
test.use({ viewport: { width: 1440, height: 900 } });

test("fresh install onboarding: your name, a plain team in the sidebar, a saved team as a pre-load", async ({ page }) => {
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
  await expect(page.getByText("A plain team")).toBeVisible();
  await expect(page.getByText("Pre-load a saved team")).toBeVisible();
  await expect(page.getByText("Souls and starting facts")).toBeVisible();
  await expect(page.getByText("Talks with you first").first()).toBeVisible();
  await expect(page.getByText("Business partner")).toHaveCount(0);
  const line = page.locator("[data-hub-onboarding-dashboards]");
  const box = await line.boundingBox();
  expect(box && box.height).toBeLessThan(24); // one line: "Org / ops" doesn't wrap
  await noAsh();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-18-onboarding-plain-team.png` });

  await page.getByText("Pre-load a saved team").click();
  await page.waitForTimeout(400);
  await noAsh();
  await page.screenshot({ path: `${SHOTS}/pm-18-onboarding-preload-picked.png` });
  expect(await page.evaluate(() => localStorage.getItem("monocode:hub-team-pack"))).toBe("plain"); // nothing until Continue
});
