import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp118-sparse-checkout.html";

test("the sparse checkout switch starts off", async ({ page }) => {
  await page.goto(pageUrl);
  const section = page.getByRole("region", { name: "Sparse checkout" }).first();
  const toggle = section.getByRole("switch", {
    name: "Use a sparse checkout for new worktrees on this project",
  });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(
    section.getByText(
      "Off keeps ordinary git worktrees. This does not change the main checkout.",
    ),
  ).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});

test("an unreadable saved setting stays off", async ({ page }) => {
  await page.goto(pageUrl);
  const section = page.getByRole("region", { name: "Sparse checkout" }).nth(1);
  await expect(
    section.getByText("The saved setting can't be read, so sparse checkout stays off."),
  ).toBeVisible();
  await expect(section.getByRole("switch")).toHaveAttribute("aria-checked", "false");
});
