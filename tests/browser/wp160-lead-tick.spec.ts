import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp160-lead-tick.html";

test("Lead tick and Ship on green are off by default, and turn on one at a time", async ({ page }) => {
  await page.goto(pageUrl);
  const card = page.locator("#fresh [data-lead-tick]");
  const tick = card.getByRole("switch", { name: "Lead tick" });
  await expect(tick).toHaveAttribute("aria-checked", "false");
  await expect(card.getByRole("switch", { name: "Ship on green" })).toHaveCount(0);

  await tick.click();
  await expect(tick).toHaveAttribute("aria-checked", "true");
  const minutes = card.getByRole("spinbutton", { name: "Minutes between ticks" });
  await expect(minutes).toHaveValue("15");
  const ship = card.getByRole("switch", { name: "Ship on green" });
  await expect(ship).toHaveAttribute("aria-checked", "false");
  await expect(card.locator("[data-ship-on-green-help]")).toHaveText("Off: green pull requests wait for you.");
  await expect(card.locator("[data-lead-tick-open-only]")).toContainText("Runs only while Hivra is open.");

  await ship.click();
  await expect(ship).toHaveAttribute("aria-checked", "true");
  await expect(card.locator("[data-ship-on-green-help]")).toContainText("Packages parked for a security check are never merged.");

  // Kept in the store, not only on screen.
  const kept = await page.evaluate(() =>
    (window as unknown as { leadTickStore: { settingFor(f: string): unknown } }).leadTickStore.settingFor("/code/app"),
  );
  expect(kept).toEqual({ enabled: true, intervalMinutes: 15, shipOnGreen: true });
});

test("the interval never goes under 5 minutes", async ({ page }) => {
  await page.goto(pageUrl);
  const card = page.locator("#fresh [data-lead-tick]");
  await card.getByRole("switch", { name: "Lead tick" }).click();
  const minutes = card.getByRole("spinbutton", { name: "Minutes between ticks" });
  await minutes.fill("2");
  await minutes.press("Enter");
  await expect(minutes).toHaveValue("5");
  await minutes.fill("30");
  await minutes.press("Enter");
  await expect(minutes).toHaveValue("30");
  const kept = await page.evaluate(() =>
    (window as unknown as { leadTickStore: { settingFor(f: string): { intervalMinutes: number } } }).leadTickStore.settingFor("/code/app")
      .intervalMinutes,
  );
  expect(kept).toBe(30);
});

test("says plainly when a closed app missed ticks", async ({ page }) => {
  await page.goto(pageUrl);
  const card = page.locator("#missed [data-lead-tick]");
  await expect(card.locator("[data-lead-tick-last]")).toContainText("Started WP-201.");
  await expect(card.locator("[data-lead-tick-missed]")).toContainText("No tick ran for 3 hours.");
  await expect(card.locator("[data-lead-tick-missed]")).toContainText("only while Hivra is open");
  const text = await card.innerText();
  expect(text).not.toMatch(/[–—]/);
});
