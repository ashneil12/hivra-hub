import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { openLocalHub } from "./localHub";

// Round 20 review fixes, a browser preview only (not Ash's Mac): a project's own Today keeps its ask rows in one
// column even at 2560 wide (G1 took away the all-projects board and its 1800px two-column grid; the single shrinkable
// column is what keeps long titles off the right edge), no diagonal "Preview" watermark on a Page preview, and
// Critiquito offered unticked in onboarding (Ash 14 Oct).
//   PM_PROOF_SPEC=pm-20-review.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-20";

async function open(page: Page) {
  await openLocalHub(page);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => undefined);
}

test("Today at 2560 wide: the ask rows stay in one column", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await open(page);
  // G1: Hivra's own Today (it has the asks); its needs list is one column, no per-project grid.
  await page.evaluate(() => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect({ project: "hivra", item: "inbox" }));
  const list = page.locator("[data-hub-today-projects]").first();
  await expect(list).toBeVisible({ timeout: 30_000 });
  const layout = await list.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      display: style.display,
      direction: style.flexDirection,
      rows: [...el.children].map((e) => ({ left: Math.round(e.getBoundingClientRect().left) })).filter((r) => r.left > 0),
    };
  });
  expect(layout.display).toBe("flex");
  expect(layout.direction).toBe("column");
  expect(layout.rows.length).toBeGreaterThan(0);
  expect(new Set(layout.rows.map((r) => r.left)).size).toBe(1);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/pm-20-today-2560.png` });
  // At 1440 wide, the same single column.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  const narrow = await list.evaluate((el) => [...el.children].map((e) => Math.round(e.getBoundingClientRect().left)).filter((l) => l > 0));
  expect(new Set(narrow).size).toBe(1);
});

test("a Page preview has no watermark; the bar says it is a preview", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  await page.getByRole("button", { name: /^Pages/ }).first().click();
  const newButton = page.locator("[data-pages-new-button]").first();
  if (await newButton.isVisible().catch(() => false)) await newButton.click();
  await page.getByLabel("Describe the page").fill("plan my week, with a calendar");
  await page.getByLabel("Send to a Mono").click();
  await expect(page.locator("[data-block-calendar]").first()).toBeVisible({ timeout: 30_000 });
  const frame = page.locator("[data-pages-preview-frame]").first();
  expect(await frame.evaluate((el) => [...el.querySelectorAll("span")].some((s) => s.textContent === "Preview"))).toBe(false);
  await expect(page.locator("[data-pages-preview-note]")).toContainText("This is a preview.");
  await page.mouse.move(5, 450);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/pm-20-pages-nowatermark.png` });
});

test("onboarding: the team is the four, Critiquito optional and unticked", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/hub-dev.html?onboarding");
  await expect(page.locator("[data-hub-onboarding]")).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.locator("[data-hub-onboarding-next]").click();
  await expect(page.locator("[data-hub-onboarding-team]")).toHaveText("Chief of Staff, Projects Manager, frank and Alfred.");
  await expect(page.locator("[data-hub-onboarding-addon]")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-hub-onboarding-addon]")).toContainText("Also add Critiquito");
  const rail = page.locator("[data-mono-rail]").first();
  await expect(rail.getByText("Critiquito")).toHaveCount(0);
  expect(await page.evaluate(() => /\bAsh\b|pre-load/i.test(document.body.innerText))).toBe(false);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-20-onboarding-critiquito-optional.png` });
});
