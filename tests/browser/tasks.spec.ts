import { expect, test } from "@playwright/test";

// WP-70. A person sees the work's activity, that it needs them, and their own comment.
test.use({ viewport: { width: 960, height: 640 } });

test("a task shows its work and keeps a comment", async ({ page }) => {
  await page.goto("/tests/browser/tasks.html");
  await expect(page.getByText("recorded")).toBeVisible();
  await expect(page.getByText("Needs you")).toBeVisible();
  await page.getByLabel("Comment").fill("Please look");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByText("Please look")).toBeVisible();
});
