import { test } from "@playwright/test";
import { assertStarterTicks, openOnboarding, skipAddsNobody, tickedBecomesOrdinaryMono } from "./starterOnboarding";

// WP-05: a fresh install's onboarding offers the five starter templates, the Chief of Staff ticked, the rest unticked.
// Skip with nothing ticked adds nobody.
// Ticking one adds an ordinary Mono. There is no pre-load. A browser preview only: not Ash's Mac.
// PM_PROOF_SPEC=pm-17-team-pack.spec.ts npx playwright test -c tests/browser/pm-screens.config.ts

test.use({ viewport: { width: 1440, height: 900 } });

test("fresh install onboarding: no pre-load, only the Chief of Staff ticked", async ({ page }) => {
  await openOnboarding(page);
  await page.locator("[data-hub-onboarding-next]").click();
  await assertStarterTicks(page);
  await skipAddsNobody(page);
  await tickedBecomesOrdinaryMono(page);
});
