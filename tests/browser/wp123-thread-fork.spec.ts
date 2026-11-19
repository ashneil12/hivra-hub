import { expect, test, type Page } from "@playwright/test";

const DIRTY =
  "error: Your local changes to the following files would be overwritten by checkout:\n\tfile.txt\nPlease commit your changes or stash them before you switch branches.";

/** The confirm dialog covers the page, so these boxes cannot take a pointer click. */
async function setBox(page: Page, selector: string, checked: boolean) {
  const box = page.locator(selector);
  await box.evaluate((el, next) => {
    const input = el as HTMLInputElement;
    if (input.checked !== next) input.click();
  }, checked);
  if (checked) await expect(box).toBeChecked();
  else await expect(box).not.toBeChecked();
}

const setRefuse = (page: Page, checked: boolean) => setBox(page, "[data-refuse-worktree]", checked);

test("fork from a message or the palette, with or without a worktree", async ({ page }) => {
  await page.goto("/tests/browser/wp123-thread-fork.html");

  await expect(page.getByRole("heading", { name: "Fork a chat" })).toBeVisible();
  await expect(page.locator("[data-palette-blocked]")).toHaveText("Open a chat first");
  await expect(page.locator("[data-palette-fork]")).toHaveText("Fork from here");
  await expect(page.locator("[data-original-message]")).toHaveText(["First", "Answer", "Later"]);

  await page.locator("[data-fork-from-here='u1']").click();
  const box = page.locator("[data-thread-fork-worktree]");
  await expect(box).toBeChecked();
  // The dialog covers the page, so these controls are set without a pointer hit.
  await page.getByLabel("New chat worktree").selectOption("off", { force: true });
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.locator("[data-thread-fork-confirm]").click();

  await expect(page.locator("[data-original-message]")).toHaveText(["First", "Answer", "Later"]);
  await expect(page.locator("[data-fork-chat]")).toHaveCount(1);
  await expect(page.locator("[data-fork-message]")).toHaveText(["First"]);
  await expect(page.locator("[data-fork-worktree]")).toHaveText("");
  await expect(page.locator("[data-created-paths]")).toHaveText("");

  await page.locator("[data-fork-from-here='u1']").click();
  await expect(box).not.toBeChecked();
  await box.check();
  await setRefuse(page, true);
  await page.locator("[data-thread-fork-confirm]").click();
  await expect(page.locator("[role=alert]")).toHaveText(DIRTY);
  await expect(page.locator("[data-fork-chat]")).toHaveCount(1);

  await setRefuse(page, false);
  await page.locator("[data-thread-fork-confirm]").click();
  await expect(page.locator("[data-fork-chat]")).toHaveCount(2);
  await expect(page.locator("[data-fork-worktree]").last()).toHaveText("C:\\work\\my notes\\wt");
  await expect(page.locator("[data-created-paths]")).toHaveText("C:\\work\\my notes");

  await page.locator("[data-palette-fork]").click();
  await page.locator("[data-thread-fork-confirm]").click();
  await expect(page.locator("[data-fork-chat]")).toHaveCount(3);
  await expect(page.locator("[data-fork-chat]").last().locator("[data-fork-message]")).toHaveText([
    "First",
    "Answer",
    "Later",
  ]);

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});

test("the confirm says when the chat's uncommitted changes were not copied, and the fork stays", async ({ page }) => {
  await page.goto("/tests/browser/wp123-thread-fork.html");
  await page.locator("[data-fork-from-here='u1']").click();
  await expect(page.locator("[data-thread-fork-worktree]")).toBeChecked();
  await setBox(page, "[data-not-copied]", true);
  await page.locator("[data-thread-fork-confirm]").click();

  const note = page.locator("[data-thread-fork-notice]");
  await expect(note).toHaveText("Uncommitted changes in this chat's worktree weren't copied.");
  await expect(page.locator("[data-fork-chat]")).toHaveCount(1);
  await expect(page.locator("[data-fork-worktree]")).toHaveText("C:\\work\\my notes\\wt");
  await expect(page.locator("[role=alert]")).toHaveCount(0);
  await expect(page.locator("[data-thread-fork-confirm]")).toHaveCount(0);
  const dialog = await page.locator("[data-thread-fork-dialog]").innerText();
  expect(dialog).not.toMatch(/[—–]/);

  await page.locator("[data-thread-fork-done]").click();
  await expect(page.locator("[data-thread-fork-dialog]")).toHaveCount(0);
  await expect(page.locator("[data-fork-chat]")).toHaveCount(1);
  await expect(page.locator("[data-removed-paths]")).toHaveText("");
});

test("cancelling while the worktree is made takes the worktree back and opens no chat", async ({ page }) => {
  await page.goto("/tests/browser/wp123-thread-fork.html");
  await page.locator("[data-fork-from-here='u1']").click();
  await expect(page.locator("[data-thread-fork-worktree]")).toBeChecked();
  await setBox(page, "[data-hold-worktree]", true);
  await page.locator("[data-thread-fork-confirm]").click();
  await expect(page.locator("[data-created-paths]")).toHaveText("C:\\work\\my notes");

  await page.locator("[data-thread-fork-cancel]").click();
  await expect(page.locator("[data-thread-fork-dialog]")).toHaveCount(0);
  await expect(page.locator("[data-removed-paths]")).toHaveText("");
  await page.locator("[data-release-worktree]").click();
  await expect(page.locator("[data-removed-paths]")).toHaveText("C:\\work\\my notes\\wt");
  await expect(page.locator("[data-fork-chat]")).toHaveCount(0);
});
