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

// WP-89 follow-up: the CLI a Mono asked for isn't installed here, so the card says which one and what the worker runs
// on instead, beside the line that names the CLI it did start on.
test("worker card says when the CLI it asked for isn't installed, and what it runs on", async ({ page }) => {
  await page.goto("/tests/browser/launched-card.html?f=1");
  const card = page.locator("[data-launched-session]");
  await expect(card).toBeVisible();
  await expect(card.locator("[data-launched-ran]")).toHaveText(
    "Runs on Claude Code, Sonnet 5, High effort (set for this Mono)",
  );
  await expect(card.locator("[data-launched-fallback]")).toHaveText(
    "Codex isn't installed here, so this worker runs on Claude Code.",
  );
  await expect(card).toHaveAttribute(
    "title",
    /Codex isn't installed here, so this worker runs on Claude Code\./,
  );
});

// r95 (PM, worker card a): no engine chip, and the job's name is never cut off: at narrow widths a long one wraps onto
// a second line, whole, inside the card.
const LONG = "Reject a negative bump and show the tally count";
for (const width of [260, 300, 360]) {
  test(`worker card shows the full job name at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: Math.max(width + 40, 400), height: 200 });
    await page.goto(`/tests/browser/launched-card.html?w=${width}&t=${encodeURIComponent(LONG)}`);
    const card = page.locator("[data-launched-session]");
    await expect(card).toBeVisible();
    await expect(page.locator("[data-launched-model]")).toHaveCount(0);
    const title = page.locator("[data-launched-title]");
    await expect(title).toHaveText(LONG);
    const m = await title.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight, h: el.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight), overflow: cs.textOverflow, ws: cs.whiteSpace };
    });
    // Not clipped across or down, and no ellipsis.
    expect(m.overflow).not.toBe("ellipsis");
    expect(m.ws).toBe("normal");
    expect(m.sw).toBeLessThanOrEqual(m.cw + 1);
    expect(m.sh).toBeLessThanOrEqual(m.ch + 1);
    // Wrapped rather than squeezed onto one line, and fully inside the card.
    expect(m.h).toBeGreaterThan(m.lh * 1.5);
    const t = (await title.boundingBox())!;
    const c = (await card.boundingBox())!;
    expect(t.y).toBeGreaterThanOrEqual(c.y);
    expect(t.y + t.height).toBeLessThanOrEqual(c.y + c.height);
    expect(t.x + t.width).toBeLessThanOrEqual(c.x + c.width);
    await page.screenshot({ path: testInfo.outputPath(`launched-card-title-${width}.png`) });
  });
}
