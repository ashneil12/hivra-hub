import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp162-programme-update.html";

test("the update starts off, and turning it on sends the command", async ({ page }) => {
  await page.goto(pageUrl);
  const toggle = page.getByRole("switch", { name: "Update conflicting packages from main" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Nothing is merged or rebased")).toBeVisible();
  await expect(page.getByRole("button", { name: "Merge" })).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("body")).toHaveAttribute("data-last-command", "programme_update_settings_set");
  await expect(page.locator("body")).toHaveAttribute("data-last-flag", "true");
});

test("rebase says an already pushed branch is left as it is", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByRole("button", { name: "Rebase" })).toBeVisible();
  await expect(page.getByText("already on the remote is left as it is")).toBeVisible();
});

test("a late reply for the previous project does not overwrite the current one", async ({ page }) => {
  await page.goto(pageUrl);
  await page.getByRole("button", { name: "Slow project" }).click();
  await page.getByRole("button", { name: "Other project" }).click();
  const toggle = page.getByRole("switch", { name: "Update conflicting packages from main" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Merge" })).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => (window as unknown as { releaseStale: () => void }).releaseStale());
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("button", { name: "Rebase" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Merge" })).toHaveAttribute("aria-pressed", "true");
});
