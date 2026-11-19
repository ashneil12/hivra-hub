import { expect, test } from "@playwright/test";

// WP-176. Set a measured-cost limit, see the line, see the pause in Needs you, raise it, and the waiting builder starts.
// The cost is a fixture. This does not call a billed API.
test.use({ viewport: { width: 1100, height: 760 } });

test("a spend limit shows its line, holds a new builder, and lets it start once the limit is raised", async ({ page }) => {
  await page.goto("/tests/browser/wp176-spend-limit.html");
  const spend = page.locator("[data-spend-line]");
  await expect(spend).toHaveText("No spend limit is set.");
  await expect(page.locator("[data-home-line='builders']")).toHaveCount(0);

  const amount = page.locator("[data-spend-amount]");
  await amount.fill("50");
  await amount.blur();
  await expect(spend).toContainText("Spent $50 of $50 this month (100%). New builders pause at $50.");
  expect(await spend.innerText()).not.toMatch(/[—–]/);
  expect(await spend.innerText()).not.toMatch(/your bill/i);

  await page.locator("#launch").click();
  await expect(page.locator("body")).toHaveAttribute("data-admission", "spend");
  const line = page.locator("[data-home-section='needs-you'] [data-home-line='builders']");
  await expect(line).toContainText("Spend limit reached for hivra: $50 of $50 this month.");
  await expect(line.getByRole("button", { name: "Raise limit" })).toBeVisible();
  expect(await line.innerText()).not.toMatch(/[—–]/);

  await line.getByRole("button", { name: "Raise limit" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-opened",
    JSON.stringify({ kind: "settings", section: "crew", anchor: "spend-limit" }),
  );

  await page.locator("#pump").click();
  await expect(page.locator("body")).toHaveAttribute("data-started", "0");
  await expect(line).toBeVisible();

  await amount.fill("80");
  await amount.blur();
  await expect(spend).toContainText("Spent $50 of $80 this month");
  await page.locator("#pump").click();
  await expect(page.locator("body")).toHaveAttribute("data-started", "1");
  await expect(page.locator("[data-home-line='builders']")).toHaveCount(0);
});
