import { expect, test } from "@playwright/test";

// WP-175 review 2 (MED 3, 4.2, 4.3): the desktop mode picker names each CLI's modes for what they do.
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/access-picker.html");
});

test("fx shows its honest name and offers Full access only", async ({ page }) => {
  const fx = page.locator('[data-fixture="fx"]');
  const trigger = fx.locator("[data-access-picker-trigger]");
  await expect(trigger).toHaveAttribute("aria-label", "fx approves its own requests");
  await trigger.click();
  const options = page.locator('[role="listbox"][aria-label="Access"] [role="option"]');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Full access");
  await expect(page.getByText("Auto-accept edits")).toHaveCount(0);
  await expect(page.getByText("An AI reviewer")).toHaveCount(0);
});

test("Antigravity's Auto is named for what it runs", async ({ page }) => {
  const ag = page.locator('[data-fixture="antigravity"]');
  const trigger = ag.locator("[data-access-picker-trigger]");
  await expect(trigger).toHaveAttribute("aria-label", "Default (no AI review)");
  await trigger.click();
  const options = page.locator('[role="listbox"][aria-label="Access"] [role="option"]');
  await expect(options).toHaveCount(4);
  await expect(options.nth(2)).toContainText("Default (no AI review)");
  await expect(page.getByText("An AI reviewer")).toHaveCount(0);
});
