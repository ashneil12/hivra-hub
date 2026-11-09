import { expect, test } from "@playwright/test";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
const HOME = "/Users/ada";

test("copy diagnostics masks a key and a home path", async ({ page }) => {
  await page.goto("/tests/browser/wp104-diagnostics.html");

  await expect(page.getByRole("button", { name: "Copy diagnostics" })).toBeVisible();
  await page.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied. Paste it into a message.");

  const copied = await page.locator("[data-copied]").textContent();
  expect(copied).toContain("Version: 9.9.9");
  expect(copied).toContain("System: test os");
  expect(copied).toContain("~/Library/logs");
  expect(copied).not.toContain(KEY);
  expect(copied).not.toContain(HOME);
  expect(copied).toContain("[secret removed]");
});
