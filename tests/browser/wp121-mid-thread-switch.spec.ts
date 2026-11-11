import { expect, test } from "@playwright/test";

const CONTINUE = "Continue this chat with Codex";
const RECAP = "Start a new chat with a recap, because fx cannot resume";

test("a mid-thread switch says whether this chat continues", async ({ page }) => {
  await page.goto("/tests/browser/wp121-mid-thread-switch.html");

  await expect(page.getByText("Mid-thread switch").first()).toBeVisible();

  const header = page.locator("[data-mid-thread-switch='header']");
  const composer = page.locator("[data-mid-thread-switch='composer']");
  await expect(header).toHaveCount(2);
  await expect(composer).toHaveCount(2);
  await expect(header.nth(0)).toHaveText(CONTINUE);
  await expect(composer.nth(0)).toHaveText(CONTINUE);
  await expect(header.nth(1)).toHaveText(RECAP);
  await expect(composer.nth(1)).toHaveText(RECAP);

  await expect(page.locator("[data-switch-marker]")).toHaveCount(1);
  await expect(page.locator("[data-switch-marker]")).toHaveText("Switched to Codex");
  await expect(page.getByRole("separator", { name: "Switched to Codex" })).toBeVisible();

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).toContain(CONTINUE);
  expect(text).toContain(RECAP);
});
