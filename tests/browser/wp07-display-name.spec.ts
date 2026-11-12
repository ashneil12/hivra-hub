import { expect, test } from "@playwright/test";

test("the words a person reads say Hivra, not the bundle name", async ({ page }) => {
  await page.goto("/tests/browser/wp07-display-name.html");

  const daily = page.locator("[data-daily-footer] [data-build-stamp]");
  await expect(daily).toHaveText(/^Hivra 0\.16\.0 · built .*2026/);
  await expect(daily).not.toContainText(" @ ");

  const dev = page.locator("[data-dev-footer] [data-build-stamp]");
  await expect(dev).toContainText("Hivra 0.16.0");
  await expect(dev).toContainText("dev copy wt-a");
  await expect(dev).not.toContainText("MonoCode");

  const ribbon = page.locator("[data-dev-ribbon]");
  await expect(ribbon).toContainText("DEV");
  await expect(ribbon).toHaveAttribute("aria-label", /Hivra dev copy wt-a: hub\/1b-identity @ 09141d8-dirty/);

  await expect(page.getByText("Hivra checks the four things a chat needs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start using Hivra" })).toBeVisible();
  await expect(page.locator("#root")).not.toContainText("MonoCode");
});
