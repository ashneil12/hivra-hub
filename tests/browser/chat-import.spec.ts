import { expect, test } from "@playwright/test";

test("past chats are found, grouped by project and brought in", async ({ page }) => {
  await page.goto("/tests/browser/chat-import.html");
  await page.locator("[data-chat-import-find]").click();
  await expect(page.locator("[data-chat-import-found]")).toContainText("Found 22 chats in 5 folders.");
  // A worktree's chats fold into its repo.
  const shop = page.locator('[data-chat-import-group="/Users/example/Projects/shop-app"]');
  await expect(shop).toContainText("Includes 1 worktree of this repo");
  await expect(shop).toContainText("Looks like shop-app-v2, shop-app-old.");
  // A folder the app already has goes into that project.
  await expect(page.locator('[data-chat-import-group="/Users/example/Projects/recipes"]')).toContainText(
    "Already a project here, so they go into it",
  );
  // A gone folder with no look-alike waits for a pick.
  const scratch = page.locator('[data-chat-import-group="/Users/example/Old/scratch"]');
  await expect(scratch.locator("[data-chat-import-take]")).toBeDisabled();
  await expect(page.locator("[data-chat-import-go]")).toHaveText("Bring in 20 chats");

  await shop.locator("[data-chat-import-merge]").click();
  await expect(page.locator("[data-chat-import-go]")).toHaveText("Bring in 20 chats");

  await page.locator('[data-chat-import-since="month"]').click();
  await expect(page.locator('[data-chat-import-since="month"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-chat-import-found]")).toContainText("Found 15 chats in 3 folders.");

  await page.locator("[data-chat-import-go]").click();
  await expect(page.locator("[data-chat-import-result]")).toContainText("Brought in 13 chats");
  await expect(page.locator("[data-chat-import-result]")).toContainText("2 chats where you wrote only once were left out");
});

test("bringing in runs in the background and can be stopped", async ({ page }) => {
  await page.goto("/tests/browser/chat-import.html?slow");
  await page.locator("[data-chat-import-find]").click();
  await page.locator("[data-chat-import-go]").click();
  await expect(page.locator("[data-chat-import-progress]")).toContainText("You can keep using the app while this runs.");
  await page.locator("[data-chat-import-cancel]").click();
  await expect(page.locator("[data-chat-import-result]")).toContainText("Stopped.");
});
