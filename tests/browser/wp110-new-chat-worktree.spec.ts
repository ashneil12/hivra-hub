import { expect, test } from "@playwright/test";

const OFF = "Off. A new chat uses this folder.";
const ASK =
  "Ask. The composer offers a worktree, already switched on, for a git project.";
const ALWAYS = "Always. Every new chat in a git project starts in its own worktree.";
const ASK_LINE =
  "This new chat will start in its own worktree. Switch to this folder if you want to stay here.";

test("a new chat can start in its own worktree, and the header says where", async ({ page }) => {
  await page.goto("/tests/browser/wp110-new-chat-worktree.html");

  await expect(page.getByText("New chats and worktrees").first()).toBeVisible();
  await expect(page.getByText(OFF)).toBeVisible();
  await expect(page.getByText(ASK)).toBeVisible();
  await expect(page.getByText(ALWAYS)).toBeVisible();
  await expect(page.getByLabel(OFF)).toBeChecked();
  await expect(page.getByLabel(ASK)).not.toBeChecked();

  await expect(page.locator("[data-worktree-header]")).toHaveText("feature/main");
  await expect(page.locator("[data-new-chat-worktree-ask]")).toHaveCount(0);

  await page.getByLabel(ASK).check();
  await expect(page.getByLabel(ASK)).toBeChecked();
  await expect(page.locator("[data-new-chat-worktree-ask]")).toHaveText(ASK_LINE);

  await page.reload();
  await expect(page.getByLabel(ASK)).toBeChecked();
  await expect(page.locator("[data-new-chat-worktree-ask]")).toHaveText(ASK_LINE);
  await expect(page.locator("[data-worktree-header]")).toHaveText("feature/main");

  await page.getByLabel(ALWAYS).check();
  await expect(page.getByLabel(ALWAYS)).toBeChecked();
  await expect(page.locator("[data-new-chat-worktree-ask]")).toHaveCount(0);
  await expect(page.locator("[data-worktree-header]")).toHaveText("feature/main");

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
