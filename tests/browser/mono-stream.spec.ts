import { expect, test } from "@playwright/test";

test("a reply is visible and grows before the turn ends, with and without Overview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/browser/mono-stream.html");
  const reply = page.locator('[data-chat-message="example-reply"]');
  await expect(reply).toBeVisible();
  await expect(reply).toContainText("first part of the reply");
  await page.getByRole("button", { name: "Example: next chunk" }).click();
  await expect(reply).toContainText("next chunk");
  await page.screenshot({
    path: "docs/hivra/work/proofs/chat-reliability/streaming-wide.png",
  });
  await page.getByRole("button", { name: "Example: toggle overview" }).click();
  await expect(reply).toBeVisible();
  expect(
    (await page.locator("[data-example-chat]").boundingBox())!.width,
  ).toBeCloseTo(864, 0);
  await page.screenshot({
    path: "docs/hivra/work/proofs/chat-reliability/streaming-overview.png",
  });
  await page.getByRole("button", { name: "Example: finish" }).click();
  await expect(reply).toContainText("next chunk");
});
