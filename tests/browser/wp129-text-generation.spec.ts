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

test("Other models shows an address only for a proxy or a custom model", async ({ page }) => {
  const saved = [
    { id: "xai-1", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4" },
    { id: "or-2", name: "Proxy", provider: "openrouter", baseUrl: "https://proxy.example.com/v1", modelId: "x-ai/grok-4" },
    { id: "c-1", name: "Mine", provider: "custom", baseUrl: "https://llm.example.org/v1", modelId: "m" },
  ];
  await page.addInitScript((list) => localStorage.setItem("monocode:custom-models", JSON.stringify(list)), saved);
  await page.goto("/tests/browser/wp129-text-generation.html?others");

  await expect(page.getByRole("group", { name: "Other models" })).toBeVisible();
  await expect(page.locator('[data-saved-address="or-2"]')).toHaveText("https://proxy.example.com/v1");
  await expect(page.locator('[data-saved-address="c-1"]')).toHaveText("https://llm.example.org/v1");
  await expect(page.locator('[data-saved-address="xai-1"]')).toHaveCount(0);

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});

test("short text shows a saved proxy address for a named provider, and no address on the default", async ({ page }) => {
  await page.goto("/tests/browser/wp129-text-generation.html");
  await page.evaluate(() =>
    localStorage.setItem(
      "monocode.textGeneration",
      JSON.stringify({ provider: "openrouter", model: "x-ai/grok-4", baseUrl: "https://proxy.example.com/v1" }),
    ),
  );
  await page.reload();
  await expect(page.getByLabel("Who writes short text")).toHaveValue("openrouter");
  await expect(page.locator("[data-saved-address]")).toHaveText("https://proxy.example.com/v1");

  await page.evaluate(() =>
    localStorage.setItem(
      "monocode.textGeneration",
      JSON.stringify({ provider: "openrouter", model: "x-ai/grok-4", baseUrl: "https://openrouter.ai/api/v1" }),
    ),
  );
  await page.reload();
  await expect(page.getByLabel("Who writes short text")).toHaveValue("openrouter");
  await expect(page.locator("[data-saved-address]")).toHaveCount(0);
});
