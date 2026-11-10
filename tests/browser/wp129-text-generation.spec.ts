import { expect, test } from "@playwright/test";

test("short text can use OpenRouter, and the coding agent is still the default", async ({ page }) => {
  await page.goto("/tests/browser/wp129-text-generation.html");

  const who = page.getByLabel("Who writes short text");
  await expect(page.getByText("Short text").first()).toBeVisible();
  await expect(who).toHaveValue("agent");
  await expect(page.getByLabel("Model")).toHaveCount(0);

  await who.selectOption({ label: "OpenRouter" });
  await expect(who).toHaveValue("openrouter");
  await expect(page.getByLabel("Model")).toHaveValue(/.+/);
  await expect(page.getByLabel("Address")).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel("Who writes short text")).toHaveValue("openrouter");
  await expect(page.getByLabel("Model")).toHaveValue(/.+/);

  await page.getByLabel("Who writes short text").selectOption({ label: "The coding agent" });
  await expect(page.getByLabel("Who writes short text")).toHaveValue("agent");
  await expect(page.getByLabel("Model")).toHaveCount(0);

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
  expect(text.toLowerCase()).not.toContain("api key");
});
