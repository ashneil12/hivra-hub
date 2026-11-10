import { expect, test } from "@playwright/test";
import { CLIS_NOT_OFFERED, LEAD_STRIP_REASON } from "./leadCliStrip";


test("the strip offers only a chosen CLI that can lead, and goes once this CLI can lead", async ({ page }) => {
  await page.goto("/tests/browser/lead-cli.html");
  const notice = page.locator("[data-lead-cli-notice]");
  await expect(notice).toBeVisible();
  await expect(page.locator("[data-lead-cli-reason]")).toHaveText(LEAD_STRIP_REASON);
  await expect(notice).not.toContainText(/[–—]/);

  const picker = page.locator("[data-lead-cli-picker]");
  // Claude Code was ticked at first launch and can lead. Codex can lead too, but Ash never ticked it.
  await expect(picker.locator("[data-lead-cli=claude]")).toHaveText("Claude Code");
  await expect(picker.locator("[data-lead-cli]")).toHaveCount(1);
  for (const cli of CLIS_NOT_OFFERED) {
    await expect(picker.locator(`[data-lead-cli=${cli}]`)).toHaveCount(0);
  }

  await picker.locator("[data-lead-cli=claude]").click();
  await expect(page.locator("[data-harness]")).toHaveText("claude");
  // The current CLI can lead now, so the strip has nothing to say and goes.
  await expect(notice).toHaveCount(0);
});

test("a chat already leading on a capable CLI shows no strip", async ({ page }) => {
  await page.goto("/tests/browser/lead-cli.html");
  await page.locator("[data-set-harness=claude]").click();
  await expect(page.locator("[data-harness]")).toHaveText("claude");
  await expect(page.locator("[data-lead-cli-notice]")).toHaveCount(0);
});

test("Ash can dismiss the strip, and it stays dismissed for the chat after a reload", async ({ page }) => {
  await page.goto("/tests/browser/lead-cli.html");
  const notice = page.locator("[data-lead-cli-notice]");
  await expect(notice).toBeVisible();
  await notice.locator("[data-lead-cli-dismiss]").click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-harness]")).toHaveText("opencode");
  await expect(notice).toHaveCount(0);
});
