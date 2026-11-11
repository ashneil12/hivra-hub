import { expect, test } from "@playwright/test";

test("a refused secret names its line, and one click allows that line", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  await expect(page.getByText("Blocked: a possible secret is on line 12 of src/config.rs.")).toBeVisible();
  await expect(page.getByText("The value is not shown.").first()).toBeVisible();
  await page.getByRole("button", { name: "Allow this line" }).first().click();
  await expect(page.getByText("Allowed. The next push checks this line again and lets it through.")).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __allowCalls: unknown[] }).__allowCalls);
  expect(calls).toEqual([{ repo: "/srv/project", file: "src/config.rs", line: 12 }]);
});

test("a commit message finding has no allow button, since it has no file line", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  await expect(page.getByText("Possible secret in a commit message:2.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow this line" })).toHaveCount(1);
});

test("Settings lists the allowed lines, and Remove takes one out", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  await expect(page.getByRole("heading", { name: "Allowed lines (secret check)" })).toBeVisible();
  await expect(page.locator("[data-allow-row]")).toHaveCount(2);
  await page.locator("[data-allow-row]").first().getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("[data-allow-row]")).toHaveCount(1);
  await expect(page.getByText("src/fixture.rs")).toBeVisible();
});

test("the guard's words use no em or en dashes", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/[\u2013\u2014]/);
});
