import { expect, test } from "@playwright/test";

// r94 (Critiquito b, PM spec): the working-agents card takes its own space at the foot of the sidebar; the rail scrolls
// in what is left above it and the card never sits over it, down to a short window.
for (const height of [800, 420, 300]) {
  test(`sidebar foot card never overlaps the rail at ${height}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1000, height });
    await page.goto("/tests/browser/sidebar-foot.html");
    const card = page.locator("[data-sidebar-foot-card]");
    await expect(card).toBeVisible();
    const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
    const rail = await box("[data-rail]");
    const foot = await box("[data-sidebar-foot-card]");
    const settings = await box("[data-settings]");
    // Stacked, never overlapping, all inside the window.
    expect(rail.y + rail.height).toBeLessThanOrEqual(foot.y + 0.5);
    expect(foot.y + foot.height).toBeLessThanOrEqual(settings.y + 0.5);
    expect(settings.y + settings.height).toBeLessThanOrEqual(height + 0.5);
    // The card's height comes off the rail, never all of it: the rail keeps room and scrolls.
    expect(foot.height).toBeLessThanOrEqual(height * 0.45 + 1);
    expect(rail.height).toBeGreaterThan(40);
    const scrolls = await page.locator("[data-rail]").evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrolls).toBe(true);
    // The topmost thing at the card's centre is the card itself, not a rail row.
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-sidebar-foot-card], [data-rail]")?.hasAttribute("data-sidebar-foot-card"), { x: foot.x + foot.width / 2, y: foot.y + foot.height / 2 });
    expect(hit).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sidebar-foot-${height}.png`) });
  });
}
