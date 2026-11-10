import { expect, test } from "@playwright/test";

test("a switch says what will not travel, and stays quiet when everything does", async ({ page }) => {
  await page.goto("/tests/browser/wp126-skill-switch.html");

  const drops = page.locator("[data-drops]");
  await expect(drops).toContainText("This will not be visible to Codex: review-only.");
  await expect(page.locator("[data-travels] [data-skill-switch-notice]")).toHaveCount(0);
  const miss = page.locator("[data-miss]");
  await expect(miss).toContainText("Reading this project timed out. Try again.");
  await expect(miss.getByRole("button", { name: "Try again" })).toBeVisible();

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
