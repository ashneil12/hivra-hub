import { expect, test } from "@playwright/test";

// G5, round 17, updated round 19 (Ash 21 Oct): a fresh install's onboarding (hub-dev.html?onboarding, empty storage,
// no Ash OS) offers no pre-load; Ash's team arrives by importing his export. The team behind the card is the leadership
// team. Its round 17 photos (pm-17-onboarding-*.png) show the old pre-load and are kept only as history.
// A browser preview only: not Ash's Mac.
// PM_PROOF_SPEC=pm-17-team-pack.spec.ts npx playwright test -c tests/browser/pm-screens.config.ts

test.use({ viewport: { width: 1440, height: 900 } });

test("fresh install onboarding: no pre-load, the leadership team behind it", async ({ page }) => {
  await page.goto("/hub-dev.html?onboarding");
  const onboarding = page.locator("[data-hub-onboarding]");
  await expect(onboarding).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.locator("[data-hub-onboarding-next]").click();
  await expect(page.getByText("Pre-load a saved team")).toHaveCount(0);
  await expect(page.getByText("Critiquito").first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("monocode:hub-team-pack"))).toBe("plain");
});
