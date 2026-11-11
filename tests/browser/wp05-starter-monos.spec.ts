import { expect, test } from "@playwright/test";

// WP-05: a fresh start offers the starter Monos, all unticked. Ticking one is a choice, not a special team.
test.use({ viewport: { width: 1440, height: 900 } });

const IDS = ["coordinator", "design-review", "planner", "record-keeper", "team-steward"] as const;

test("a fresh start offers the starter Monos, none of them ticked", async ({ page }) => {
  await page.goto("/hub-dev.html?onboarding");
  const onboarding = page.locator("[data-hub-onboarding]");
  await expect(onboarding).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await expect(page.getByText("What should your team call you?")).toBeVisible();
  await page.locator("[data-hub-onboarding-next]").click();
  await expect(page.locator("[data-hub-onboarding-team]")).toContainText("None are added unless you tick them");
  await expect(page.locator("[data-hub-onboarding-starter]")).toHaveCount(IDS.length);
  for (const id of IDS) {
    await expect(page.locator(`[data-hub-onboarding-starter="${id}"]`)).toHaveAttribute("aria-checked", "false");
  }
  // The old named team is not offered. The coordinator template itself is named Chief of Staff in Dropwave, so that
  // name is expected on its row and no longer part of this check.
  await expect(onboarding).not.toContainText(/projects manager|critiquito|alfred/i);
  await expect(page.locator('[data-hub-onboarding-starter="coordinator"]')).toContainText("Chief of Staff");
  await page.locator('[data-hub-onboarding-starter="coordinator"]').click();
  await expect(page.locator('[data-hub-onboarding-starter="coordinator"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-hub-onboarding-starter="planner"]')).toHaveAttribute("aria-checked", "false");
});
