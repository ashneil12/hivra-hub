import { expect, test } from "@playwright/test";

test("the skills panel says what will not travel to another CLI", async ({ page }) => {
  await page.goto("/tests/browser/wp126-skills-parity.html");

  await expect(page.getByRole("heading", { name: "What each CLI loads" })).toBeVisible();
  const claude = page.locator("[data-cli='claude']");
  const codex = page.locator("[data-cli='codex']");
  const cursor = page.locator("[data-cli='cursor']");
  await expect(claude).toContainText("review");
  await expect(claude).toContainText("This will not be visible to Codex or Cursor.");
  await expect(claude).toContainText("CLAUDE.md points at AGENTS.md.");
  await expect(codex).toContainText("shared");
  await expect(codex).toContainText("This will not be visible to Claude Code.");
  await expect(cursor).toContainText("shared");

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
