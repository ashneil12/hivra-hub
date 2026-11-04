import { expect, test } from "@playwright/test";

test("a deleted chat shows in the trash and can be restored", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/trash.html");
  await expect(page.getByText("Trash is empty")).toBeVisible();

  await page.getByRole("button", { name: "Delete chat" }).click();
  await expect(page.getByText("Notes about the plan")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("trashed-chat.png") });

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await expect(page.getByText("Notes about the plan")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("restored.png") });
});
