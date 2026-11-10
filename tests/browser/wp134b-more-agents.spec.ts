import { expect, test } from "@playwright/test";

test("More agents stays off until it is switched on", async ({ page }) => {
  await page.goto("/tests/browser/wp134b-more-agents.html");

  const toggle = page.getByRole("switch", { name: "More agents" });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("Off until you switch it on.")).toBeVisible();

  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(page.getByRole("switch", { name: "More agents" })).toBeChecked();

  await page.getByRole("switch", { name: "More agents" }).click();
  await page.reload();
  await expect(page.getByRole("switch", { name: "More agents" })).not.toBeChecked();

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
