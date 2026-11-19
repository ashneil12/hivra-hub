import { expect, test } from "@playwright/test";

const REASON = "Sent back: tests went stale after the last edit.";

test("a sent-back reason shows on the task card and in the inbox", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp145-sent-back.html");
  const fixing = page.locator("[data-crew-row='fixing']");
  await expect(fixing).toContainText("working");
  await expect(fixing).toContainText(REASON);
  await expect(fixing).not.toContainText("Finished, but its checks failed");

  const failed = page.locator("[data-crew-row='failed-row']");
  await expect(failed).toContainText("failed");
  await expect(failed).toContainText(REASON);

  const failure = page.locator("[data-failure]");
  await expect(failure).toHaveCount(1);
  await expect(failure).toContainText(REASON);
  await page.screenshot({ path: testInfo.outputPath("sent-back.png") });
});
