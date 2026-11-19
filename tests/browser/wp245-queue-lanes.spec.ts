import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp245-queue-lanes.html";
const SHOTS = process.env.WP245_SHOTS;

test("every queued message says why it waits, and a question to three first mates comes back as one block", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pageUrl);
  await page.evaluate(() => (window as unknown as { __wp245Ask: () => void }).__wp245Ask());
  if (SHOTS === "before") {
    await page.waitForTimeout(2_500);
    await page.screenshot({ path: "docs/hivra/work/shots/wp-245/before.png" });
    return;
  }

  const worker = page.locator('[data-proof-queue="Example: a worker that waits on your approval"]');
  await expect(worker.locator("[data-queue-wait]")).toHaveText(["Waiting for your approval", "Behind 1 message", "Behind 2 messages"]);
  const limited = page.locator('[data-proof-queue="Example: a chat at its usage limit"]');
  await expect(limited.locator("[data-queue-wait]")).toHaveText([/^Usage limit until (14:00|0?2:00\sPM)$/]);

  const room = page.locator("[data-proof-room]");
  // Ada answers first, but her answer waits for the others: it shows as held, not as a posted message.
  await expect(room.locator("[data-hub-msg-held]")).toHaveCount(1, { timeout: 5_000 });
  await expect(room.getByText("Waiting for the others to answer").first()).toBeVisible();
  // Ed never answers: after the wait, Ada's and Bo's answers land together and the room names who didn't answer.
  await expect(room.getByText("No answer from Ed within 2 seconds.")).toBeVisible({ timeout: 5_000 });
  await expect(room.locator("[data-hub-msg-gather]")).toHaveCount(2);
  await expect(room.locator("[data-hub-msg-held]")).toHaveCount(0);
  if (browserName === "chromium" && SHOTS === "after") await page.screenshot({ path: "docs/hivra/work/shots/wp-245/after.png" });
});
