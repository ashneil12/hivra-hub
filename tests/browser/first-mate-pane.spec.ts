import { expect, test } from "@playwright/test";
import { CLIS_NOT_OFFERED, LEAD_STRIP_REASON } from "./leadCliStrip";


type PaneWindow = Window & { __lastModelChange?: { sessionId: string; harness: string; model: string } };

// The real SessionPane hosts a first-mate chat on OpenCode. The strip offers only Claude Code (ticked at first launch
// and able to lead; Codex can lead but was not ticked, Cursor and Pi were ticked but cannot lead), and its pick reaches
// App.tsx as an ordinary model change on this chat's id.
test("the real pane shows the lead strip only on a CLI that cannot lead, and its pick switches this chat", async ({ page }) => {
  await page.goto("/tests/browser/first-mate-pane.html");
  const notice = page.locator("[data-lead-cli-notice]");
  await expect(notice).toBeVisible();
  await expect(page.locator("[data-lead-cli-reason]")).toHaveText(LEAD_STRIP_REASON);

  const picker = page.locator("[data-lead-cli-picker]");
  await expect(picker.locator("[data-lead-cli=claude]")).toHaveText("Claude Code");
  await expect(picker.locator("[data-lead-cli]")).toHaveCount(1);
  for (const cli of CLIS_NOT_OFFERED) {
    await expect(picker.locator(`[data-lead-cli=${cli}]`)).toHaveCount(0);
  }

  await picker.locator("[data-lead-cli=claude]").click();
  await expect(page.locator("[data-harness]")).toHaveText("claude");
  // The pane's pick is the app's model change on this chat, on the new CLI.
  const change = await page.evaluate(() => (window as PaneWindow).__lastModelChange);
  expect(change?.sessionId).toBe("lead-chat");
  expect(change?.harness).toBe("claude");
  // This chat can lead now, so its strip has gone.
  await expect(page.locator("[data-lead-cli-notice]")).toHaveCount(0);
});

test("the real pane lets Ash dismiss the strip, and keeps it dismissed for that chat", async ({ page }) => {
  await page.goto("/tests/browser/first-mate-pane.html");
  const notice = page.locator("[data-lead-cli-notice]");
  await expect(notice).toBeVisible();
  await notice.locator("[data-lead-cli-dismiss]").click();
  await expect(notice).toHaveCount(0);
  // The chat itself carries on, still on the CLI it had.
  await expect(page.locator("[data-harness]")).toHaveText("opencode");
  await page.reload();
  await expect(page.locator("[data-harness]")).toHaveText("opencode");
  await expect(notice).toHaveCount(0);
});
