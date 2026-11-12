import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp253-usage.html";

test("estimates turns with no reported price at list prices, and never a model with no listed price", async ({ page }) => {
  await page.goto(pageUrl);
  const usage = page.locator("#usage");
  const today = usage.getByRole("region", { name: "Today" });
  // Sonnet 4.6 through Cursor: 100k in at $3 and 10k out at $15 per million is $0.45.
  await expect(today).toContainText("About $0.45 at list prices for 1 turn with no reported cost");
  // Opus 5.5's 400k cache reads at $0.20 instead of $4 per million saved $1.52.
  await expect(today).toContainText("cache saved about $1.52.");
  const engines = usage.getByRole("table", { name: "By engine" });
  await expect(engines.getByRole("row", { name: /Cursor/ })).toContainText("About $0.45 at list prices");
  await expect(engines.getByRole("row", { name: /Codex/ })).toContainText("Cost not reported by this engine");
  // The page says once that these figures are not the bill.
  expect(await usage.getByText(/not your bill/).count()).toBe(1);
});

test("shows no estimate line when there are no turns", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.locator("#empty")).not.toContainText("list prices");
});
