import { expect, test } from "@playwright/test";

test("queued worker titles keep readable width beside controls", async ({
  page,
}) => {
  await page.goto("/tests/browser/chat-reliability.html?width=380");
  const title = page.locator("[data-launched-title]");
  await expect(title).toBeVisible();
  await page.screenshot({
    path: "docs/hivra/work/proofs/chat-reliability/worker-after.png",
  });
  expect((await title.boundingBox())!.width).toBeGreaterThan(140);
});

test("finished asks are tucked away, an owner can finish one, and quotes identify the source", async ({
  page,
}) => {
  await page.goto("/tests/browser/chat-reliability.html");
  await expect(page.locator('[data-asked="handled"]')).not.toBeVisible();
  const open = page.locator('[data-asked="open"]').first();
  await open.hover();
  await open.getByRole("button", { name: /Quote in the chat/ }).click();
  await expect(page.getByRole("textbox")).toHaveValue(/example-chat.*open/s);
  await open.getByRole("button", { name: /Mark done/ }).click();
  await expect(page.locator('[data-asked="open"]')).toHaveCount(0);
  await page.getByText("Finished (2)", { exact: true }).click();
  await expect(page.locator('[data-asked="handled"]')).toHaveCount(2);
});

for (const width of [560, 1100]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`readable queued card and quiet failure notice at ${width}px in ${colorScheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme });
      await page.goto(
        `/tests/browser/chat-reliability.html?width=${Math.min(width, 640)}&scheme=${colorScheme}`,
      );
      const title = page.locator("[data-launched-title]");
      await expect(title).toBeVisible();
      expect((await title.boundingBox())!.width).toBeGreaterThan(140);
      await expect(
        page.locator("[data-background-result] summary"),
      ).toContainText("timed out");
      await expect(
        page.locator("[data-background-result] pre"),
      ).not.toBeVisible();
      await page.screenshot({
        path: `docs/hivra/work/proofs/chat-reliability/${width}-${colorScheme}.png`,
      });
    });
  }
}
