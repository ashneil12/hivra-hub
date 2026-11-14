import { expect, test } from "@playwright/test";
test("Home has visible loading and timeout feedback, and past asks do not show a red current heading", async ({ page }) => {
  await page.goto("/tests/browser/coordination-followups.html");
  await expect(page.getByRole("status")).toHaveText("Loading Home…");
  await expect(page.getByText("Earlier requests (1)")).toBeVisible();
  await expect(page.getByText("Example: no new worker report yet: 0 of 1 jobs finished; 1 running.")).toBeVisible();
  await expect(page.getByRole("heading", {name: "Needs you now"})).toHaveCount(0);
  await expect(page.getByText("Earlier request: Example: an earlier question")).not.toBeVisible();
  await page.getByRole("button", {name: "Example: native read times out"}).click();
  await expect(page.getByText("Couldn't load home. Trying again.")).toBeVisible();
  await page.screenshot({ path: "target/coordination-home-loading.png" });
});
