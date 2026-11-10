import { expect, test } from "@playwright/test";

const NOTE = "2 files named in .worktreeinclude are in this worktree.";
const WARNING = "Could not copy .env into this worktree.";

test("the chat header says when include files were copied", async ({ page }) => {
  await page.goto("/tests/browser/wp138-worktree-include.html");

  const headers = page.locator("[data-worktree-header]");
  await expect(headers).toHaveCount(2);
  await expect(headers.nth(0)).toHaveText("feature/main");
  await expect(headers.nth(1)).toHaveText("feature/main");
  await expect(page.locator("[data-worktree-include]")).toHaveText(NOTE);
  await expect(page.locator("[data-worktree-include-warning]")).toHaveText(WARNING);

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
  expect(text).not.toContain("SECRET-VALUE-do-not-leak");
});
