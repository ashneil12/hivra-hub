import { test } from "@playwright/test";
import { assertStartersUnticked, openOnboarding, skipAddsNobody, tickedBecomesOrdinaryMono } from "./starterOnboarding";

// WP-05: a fresh install's onboarding offers the five starter templates, all unticked. Skip adds nobody.
// Ticking one adds an ordinary Mono. There is no pre-load. A browser preview only: not Ash's Mac.
// PM_PROOF_SPEC=pm-17-team-pack.spec.ts npx playwright test -c tests/browser/pm-screens.config.ts

test.use({ viewport: { width: 1440, height: 900 } });

test("fresh install onboarding: no pre-load, starter Monos unticked", async ({ page }) => {
  await openOnboarding(page);
  await page.locator("[data-hub-onboarding-next]").click();
  await assertStartersUnticked(page);
  await skipAddsNobody(page);
  await tickedBecomesOrdinaryMono(page);
});
