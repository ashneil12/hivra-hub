import { expect, test } from "@playwright/test";

const REASON =
  "OpenCode cannot lead yet. This CLI has no MCP host the app can set for one chat. Switch the lead. This crew and its memory stay.";

test("the picker lists the CLIs that can lead, and a CLI that cannot says why", async ({ page }) => {
  await page.goto("/tests/browser/lead-cli.html");
  const notice = page.locator("[data-lead-cli-notice]");
  await expect(notice).toBeVisible();
  await expect(page.locator("[data-lead-cli-reason]")).toHaveText(REASON);
  await expect(notice).not.toContainText(/[–—]/);

  const picker = page.locator("[data-lead-cli-picker]");
  await expect(picker.locator("[data-lead-cli=claude]")).toHaveText("Claude Code");
  await expect(picker.locator("[data-lead-cli=codex]")).toHaveText("Codex");
  await expect(picker.locator("[data-lead-cli=opencode]")).toHaveCount(0);
  await expect(picker.locator("[data-lead-cli=cursor]")).toHaveCount(0);
  await expect(picker.locator("[data-lead-cli=grok]")).toHaveCount(0);
  await expect(picker.locator("[data-lead-cli=pi]")).toHaveCount(0);

  await picker.locator("[data-lead-cli=codex]").click();
  await expect(page.locator("[data-harness]")).toHaveText("codex");
  await expect(page.locator("[data-lead-cli-reason]")).toHaveCount(0);
  await expect(notice).toContainText("Choose the lead.");
  await expect(picker.locator("[data-lead-cli=codex]")).toHaveAttribute("aria-pressed", "true");
  await expect(picker.locator("[data-lead-cli=claude]")).toHaveAttribute("aria-pressed", "false");
  await expect(picker.locator("[data-lead-cli=claude]")).toBeVisible();
});
