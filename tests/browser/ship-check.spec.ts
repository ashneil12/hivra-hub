import { expect, test } from "@playwright/test";

test("the ship check card offers a run when nothing has been checked yet", async ({ page }) => {
  await page.goto("/tests/browser/ship-check.html?state=none");
  await expect(page.locator("[data-ship-check-run]")).toBeVisible();
  await expect(page.locator("[data-ship-check-list]")).toHaveCount(0);
});

test("a passed ship check shows the version it covered, what was tested and what was not", async ({ page }) => {
  await page.goto("/tests/browser/ship-check.html?state=passed");
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();
  await expect(page.getByText(/3f2a9c1/)).toBeVisible();
  await expect(page.locator("[data-ship-check-list='tested'] li")).toHaveCount(4);
  await expect(page.locator("[data-ship-check-list='not-tested'] li")).toHaveCount(1);
});

test("running the ship check again replaces a failed result with the new one", async ({ page }) => {
  await page.goto("/tests/browser/ship-check.html?state=failed");
  await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  await page.locator("[data-ship-check-run]").click();
  await expect(page.getByText("Passed", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __shipCheckCalls: string[] }).__shipCheckCalls)).toEqual(["run"]);
});
