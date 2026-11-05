import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp87-stacks.html";

test("two stacks have different ports and stop one at a time", async ({ page }) => {
  await page.goto(pageUrl);
  const stacks = page.getByRole("region", { name: "Worktree stacks" });
  await expect(stacks.getByText("hivra-saaaa1111")).toBeVisible();
  await expect(stacks.getByText("hivra-sbbbb2222")).toBeVisible();
  await expect(stacks.getByRole("link", { name: "Open the running app" })).toHaveCount(2);
  await expect(stacks.getByRole("link").nth(0)).toHaveAttribute("href", "http://127.0.0.1:22010");
  await expect(stacks.getByRole("link").nth(1)).toHaveAttribute("href", "http://127.0.0.1:22020");
  await stacks.getByRole("button", { name: "Stop" }).first().click();
  await expect(stacks.getByText("Stopped", { exact: true })).toHaveCount(1);
  await expect(stacks.getByText("Running", { exact: true })).toHaveCount(2);
  await expect(stacks.getByText("hivra-sbbbb2222")).toBeVisible();
});

test("a stale stack stays until remove is tapped", async ({ page }) => {
  await page.goto(pageUrl);
  const clean = page.getByRole("region", { name: "Clean up" });
  await expect(clean.getByText("Stacks whose worktree is gone")).toBeVisible();
  await expect(clean.getByText("/tmp/gone")).toBeVisible();
  await expect(clean.getByRole("button", { name: "Remove" })).toBeVisible();
  await clean.getByRole("button", { name: "Remove" }).click();
  await expect(clean.getByText("/tmp/gone")).toHaveCount(0);
  await expect(clean.getByText("Stacks whose worktree is gone")).toHaveCount(0);
});

test("a project with no stack shows nothing", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByRole("region", { name: "No stack" })).toHaveCount(0);
  await expect(page.locator("#undeclared")).toBeEmpty();
});

test("the task card links only a local url", async ({ page }) => {
  await page.goto(pageUrl);
  const local = page.getByRole("article", { name: "Task 1" });
  await expect(local.getByRole("link", { name: "Open the running app" })).toHaveAttribute(
    "href",
    "http://127.0.0.1:22010",
  );
  const remote = page.getByRole("article", { name: "Task 2" });
  await expect(remote.getByRole("link", { name: "Open the running app" })).toHaveCount(0);
  const stacks = page.getByRole("region", { name: "Worktree stacks" });
  await expect(stacks.getByText("hivra-sdddd4444")).toBeVisible();
  await expect(stacks.getByRole("link")).toHaveCount(2);
});
