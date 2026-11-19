import { expect, test } from "@playwright/test";

test("the share item is there, and a share that does not go through says so in the menu", async ({ page }) => {
  await page.goto("/tests/browser/wp80-project-menu.html");

  const share = page.getByRole("menuitem", { name: "Share with my team" });
  await expect(share).toBeVisible();
  await share.click();

  // Nothing is shared in a browser, so the menu stays open with the reason in it.
  const notice = page.getByRole("alert");
  await expect(notice).toBeVisible();
  await expect(notice).not.toHaveText("");
  await expect(page.getByRole("menuitem", { name: "Share with my team" })).toBeVisible();

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
