import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp90-names.html";

test("each stack shows its own name and the fake services it runs", async ({ page }) => {
  await page.goto(pageUrl);
  const stacks = page.getByRole("region", { name: "Worktree stacks" });
  await expect(stacks.getByText("main-wp-90.localhost")).toBeVisible();
  await expect(stacks.getByText("github-wp-90.localhost (fake github)")).toBeVisible();
  await expect(stacks.getByText("stripe-wp-90.localhost (fake stripe)")).toBeVisible();
  await expect(stacks.getByText("main-wp-91.localhost")).toBeVisible();
  await expect(stacks.getByText("Tests use fake GitHub and Stripe")).toBeVisible();
  await expect(stacks.getByText("Reaches the real internet")).toBeVisible();
});

test("the task card opens the worktree's named address", async ({ page }) => {
  await page.goto(pageUrl);
  const task = page.getByRole("article", { name: "Task 1" });
  await expect(task.getByRole("link", { name: "Open the running app" })).toHaveAttribute(
    "href",
    "http://shop-wp-90.localhost:7400",
  );
  const stacks = page.getByRole("region", { name: "Worktree stacks" });
  await expect(stacks.getByRole("link", { name: "Open the running app" })).toHaveCount(2);
});

test("a stack with no fake service does not claim one", async ({ page }) => {
  await page.goto(pageUrl);
  const stacks = page.getByRole("region", { name: "Worktree stacks" });
  const second = stacks.locator("li").filter({ hasText: "hivra-sbbbb2222" });
  await expect(second.getByText(/\(fake/)).toHaveCount(0);
  await expect(second.getByText("No outside services")).toHaveCount(0);
});
