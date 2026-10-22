import { expect, test } from "@playwright/test";

// "Keep one long chat" in a Mono's settings: folded lines say how many messages they stand for ("N earlier messages"),
// open into the two lines they were made from, and "Fold" closes them. Screenshots go to LONG_CHAT_PROOF_DIR.
const SHOTS = process.env.LONG_CHAT_PROOF_DIR;
test.use({ viewport: { width: 720, height: 760 } });

test("a folded block opens to its halves and folds again", async ({ page }) => {
  await page.goto("/tests/browser/long-chat.html");
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, null, { timeout: 60_000 });
  const first = page.locator("[data-long-chat-view] > [data-tree-line]").first();
  const label = first.getByRole("button").first();
  await expect(label).toHaveText(/^\d+ earlier messages$/);
  await expect(page.getByText(/\d+x/)).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/long-chat-folded.png`, fullPage: true });
  await label.click();
  await expect(label).toHaveText("Fold");
  await expect(first.locator("[data-tree-line]")).toHaveCount(2);
  const inner = first.locator("[data-tree-line]").first().getByRole("button").first();
  if (await inner.count()) await inner.click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/long-chat-opened.png`, fullPage: true });
  await label.click();
  await expect(label).toHaveText(/^\d+ earlier messages$/);
});
