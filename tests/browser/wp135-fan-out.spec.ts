import { expect, test } from "@playwright/test";

test("the composer can compare one prompt on up to four models", async ({ page }) => {
  await page.goto("/tests/browser/wp135-fan-out.html");

  await page.getByRole("button", { name: "Compare models" }).click();
  await expect(page.locator("[data-fan-out-cap]")).toContainText("You can compare up to 4 models.");

  await page.getByRole("checkbox", { name: "Claude: one" }).check();
  await page.getByRole("checkbox", { name: "Codex: two" }).check();
  await page.getByRole("checkbox", { name: "Cursor: three" }).check();
  await page.getByRole("checkbox", { name: "Pi: four" }).check();
  await expect(page.getByRole("checkbox", { name: "Hermes: five" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Hermes: five" })).not.toBeChecked();

  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.locator("[data-fan-out-paid]")).toContainText("Each chat can use a paid turn.");
  await expect(page.locator("[data-fan-out-paid]")).toContainText("4");

  await page.getByRole("button", { name: "Start chats" }).click();
  await expect(page.locator("[data-fan-out-started]")).toHaveText("Started 4 chats");
  await expect(page.locator("[data-fan-out-panel]")).toHaveCount(0);

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});

test("a compare that cannot give two chats their own worktree starts nothing and says so", async ({ page }) => {
  await page.goto("/tests/browser/wp135-fan-out.html?worktrees=reject");

  await page.getByRole("button", { name: "Compare models" }).click();
  await page.getByRole("checkbox", { name: "Claude: one" }).check();
  await page.getByRole("checkbox", { name: "Codex: two" }).check();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Start chats" }).click();

  await expect(page.locator("[data-fan-out-panel]")).toContainText("could get their own worktree");
  await expect(page.locator("[data-fan-out-started]")).toHaveText("No chats yet");

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
});

async function startTwo(page: import("@playwright/test").Page, query: string) {
  await page.goto(`/tests/browser/wp135-fan-out.html${query}`);
  await page.getByRole("button", { name: "Compare models" }).click();
  await page.getByRole("checkbox", { name: "Claude: one" }).check();
  await page.getByRole("checkbox", { name: "Codex: two" }).check();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Start chats" }).click();
}

test("a compare that could only make one worktree gives that worktree back", async ({ page }) => {
  await startTwo(page, "?worktrees=one");

  await expect(page.locator("[data-fan-out-panel]")).toContainText("could get their own worktree");
  await expect(page.locator("[data-fan-out-panel]")).not.toContainText("left in place");
  await expect(page.locator("[data-fan-out-started]")).toHaveText("No chats yet");
  await expect(page.locator("[data-fan-out-on-disk]")).toHaveText("No worktrees on disk");
});

test("a compare says plainly when a worktree it made could not be given back", async ({ page }) => {
  await startTwo(page, "?worktrees=stuck");

  await expect(page.locator("[data-fan-out-panel]")).toContainText("could get their own worktree");
  await expect(page.locator("[data-fan-out-panel]")).toContainText(
    "One worktree made for it could not be removed and was left in place. Remove it in Settings, under Worktrees.",
  );
  await expect(page.locator("[data-fan-out-started]")).toHaveText("No chats yet");
  await expect(page.locator("[data-fan-out-on-disk]")).toHaveText("1 worktrees on disk");

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
});

test("a compare that could not be saved starts nothing and gives its worktrees back", async ({ page }) => {
  await startTwo(page, "?save=fail");

  await expect(page.locator("[data-fan-out-panel]")).toContainText("could not be saved, so no chats were started");
  await expect(page.locator("[data-fan-out-started]")).toHaveText("No chats yet");
  await expect(page.locator("[data-fan-out-on-disk]")).toHaveText("No worktrees on disk");
});
