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

test("message times remain visible without hovering the message", async ({ page }) => {
  await page.goto("/tests/browser/mono-stream.html");
  await page.getByRole("button", { name: "Example: finish" }).click();
  await page.mouse.move(0, 0);
  const times = page.locator("time");
  await expect(times).toHaveCount(2);
  for (const time of await times.all()) {
    await expect(time).toBeVisible();
    expect(await time.evaluate((el) => {
      let opacity = 1;
      for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return opacity;
    })).toBeGreaterThan(0.9);
    expect(await time.getAttribute("title")).toBeTruthy();
  }
  await page.screenshot({ path: "target/coordination-message-times.png" });
});
