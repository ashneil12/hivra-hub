import { expect, test } from "@playwright/test";

test("each installed tool shows its own sign-ins and the app's extra connections", async ({ page }) => {
  await page.goto("/tests/browser/model-connections.html");
  const omp = page.locator('[data-connection-row="omp"]');
  await expect(omp.getByText("Extra connections")).toBeVisible();
  await expect(omp.locator('[data-connection-source="claudeLogin"]')).toHaveAttribute("data-ready", "true");
  await expect(omp.locator('[data-connection-source="xai"]')).toHaveAttribute("data-ready", "true");
  await expect(omp.locator('[data-connection-source="openrouter"]')).toHaveAttribute("data-ready", "false");
  const claude = page.locator('[data-connection-row="claude"]');
  await expect(claude.getByText("Its own")).toBeVisible();
  await expect(page.locator('[data-connection-row="cursor"]').getByText("Runs only on its own account.")).toBeVisible();
  await expect(page.getByText(/^Not installed:/)).toBeVisible();
});

test("with nothing installed it says so in one line", async ({ page }) => {
  await page.goto("/tests/browser/model-connections.html?none");
  await expect(page.getByText("No coding tools are installed yet.")).toBeVisible();
  await expect(page.locator("[data-connection-row]")).toHaveCount(0);
});
