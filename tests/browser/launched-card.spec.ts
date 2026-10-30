import { expect, test } from "@playwright/test";

// r94 (item 3): live in s15 SCRIPTED 8c60 the project chip on a narrow worker card was cut in half by the card's
// clipped edge and read as an empty pill. At any chat width the chip is either whole inside the card, with the
// project's name, or not drawn.
for (const width of [260, 300, 360, 480, 700]) {
  test(`worker card project chip is whole or absent at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: Math.max(width + 40, 400), height: 200 });
    await page.goto(`/tests/browser/launched-card.html?w=${width}`);
    const card = page.locator("[data-launched-session]");
    await expect(card).toBeVisible();
    const cardBox = (await card.boundingBox())!;
    const stalled = (await page.locator("[data-stalled]").boundingBox())!;
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(stalled.x + 0.5);
    const chip = page.locator("[data-launched-project]");
    if (await chip.isVisible()) {
      const box = (await chip.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width - 1);
      // Its name shows at least its first letters.
      const name = chip.locator("span.truncate");
      expect(((await name.boundingBox())?.width ?? 0)).toBeGreaterThan(12);
    }
    if (width >= 480) await expect(chip).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`launched-card-${width}.png`) });
  });
}
