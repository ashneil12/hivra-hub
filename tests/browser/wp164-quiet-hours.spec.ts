import { expect, test } from "@playwright/test";

test("quiet hours hold routine notices and still show approvals", async ({ page }) => {
  await page.goto("/tests/browser/wp164-quiet-hours.html");
  const toggle = page.getByRole("switch", { name: "Quiet hours" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByLabel("Quiet hours start")).toHaveValue("22:00");
  await expect(page.getByLabel("Quiet hours end")).toHaveValue("08:00");
  await expect(page.locator("[data-finished-night]")).toHaveText("shown");
  await expect(page.locator("[data-approval-night]")).toHaveText("shown");
  await expect(page.locator("[data-failed-night]")).toHaveText("shown");
  await expect(page.getByText(/^Finished-agent banners wait until the window ends/)).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-finished-night]")).toHaveText("held");
  await expect(page.locator("[data-approval-night]")).toHaveText("shown");
  await expect(page.locator("[data-approval-muted]")).toHaveText("held");
  await expect(page.locator("[data-failed-night]")).toHaveText("shown");
  await expect(page.locator("[data-failed-muted]")).toHaveText("held");
  await expect(page.locator("[data-finished-day]")).toHaveText("shown");

  await page.getByLabel("Quiet hours end").fill("23:00");
  await expect(page.locator("[data-finished-night]")).toHaveText("shown");

  await page.getByLabel("Quiet hours start").fill("23:00");
  await page.getByLabel("Quiet hours end").fill("08:00");
  await expect(page.locator("[data-finished-night]")).toHaveText("held");

  await page.reload();
  await expect(page.getByRole("switch", { name: "Quiet hours" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Quiet hours start")).toHaveValue("23:00");
  await expect(page.getByLabel("Quiet hours end")).toHaveValue("08:00");
  await expect(page.locator("[data-finished-night]")).toHaveText("held");
  await expect(page.locator("[data-approval-night]")).toHaveText("shown");
  await expect(page.locator("[data-failed-night]")).toHaveText("shown");
});
