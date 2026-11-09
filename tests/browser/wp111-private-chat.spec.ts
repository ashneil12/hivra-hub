import { expect, test } from "@playwright/test";

test("a chat can be marked private, and the label follows", async ({ page }) => {
  await page.goto("/tests/browser/wp111-private-chat.html");

  await expect(page.getByRole("button", { name: "Private" })).toBeVisible();
  await expect(page.getByText("Private", { exact: true })).toHaveCount(1);

  await page.getByRole("button", { name: "Private" }).click();
  await expect(page.locator("[data-private-chat]")).toHaveText("Private");
  await expect(page.getByRole("button", { name: "Not private" })).toBeVisible();

  await page.getByRole("button", { name: "Not private" }).click();
  await expect(page.locator("[data-private-chat]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Private" })).toBeVisible();
});
