import { expect, test } from "@playwright/test";

const RULE = "one short plain-English paragraph";

test("the switch is on, and turning it off removes the ending from the contract and the session", async ({ page }) => {
  await page.goto("/tests/browser/plain-english.html");
  const toggle = page.getByRole("switch", { name: "Plain-English endings" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-session]")).toContainText(RULE);
  await expect(page.locator("[data-contract]")).toContainText(RULE);
  await expect(page.getByText("Replies end with one short paragraph in plain words about what happened and what it means.")).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-session]")).not.toContainText(RULE);
  await expect(page.locator("[data-contract]")).not.toContainText(RULE);
  await expect(page.locator("[data-contract]")).toContainText("Never write to a project");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-session]")).toContainText(RULE);
  await expect(page.locator("[data-contract]")).toContainText(RULE);
});
