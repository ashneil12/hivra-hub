import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { openLocalHub } from "./localHub";
import { assertStarterTicks, openOnboarding, skipAddsNobody, tickedBecomesOrdinaryMono } from "./starterOnboarding";

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

test("a Page preview has no watermark; the bar says it is a preview", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  await page.getByRole("button", { name: /^Hubs/ }).first().click();
  // WP-01: the list (ready-made pages are there from the start) with its New page button, or the ask box when
  // there are no pages yet. Wait for one of them instead of checking before the view has rendered.
  await expect(page.locator("[data-pages-list], [data-pages-new]").first()).toBeVisible();
  if (await page.locator("[data-pages-list]").count()) await page.locator("[data-pages-new-button]").first().click();
  // WP-04 moved building a page to the Mono's chat (BUILD_MOVED); the app's dev keyword stub stands in for that
  // build here, as in agents-page, so the preview it draws is what this checks.
  await page.evaluate(() => localStorage.setItem("monocode:pages-dev-stub", "1"));
  await page.getByLabel("Describe the hub").fill("plan my week, with a calendar");
  await page.getByLabel("Send to a Mono").click();
  await expect(page.locator("[data-block-calendar]").first()).toBeVisible({ timeout: 30_000 });
  const frame = page.locator("[data-pages-preview-frame]").first();
  expect(await frame.evaluate((el) => [...el.querySelectorAll("span")].some((s) => s.textContent === "Preview"))).toBe(false);
  await expect(page.locator("[data-pages-preview-note]")).toContainText("This is a preview.");
  await page.mouse.move(5, 450);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/pm-20-pages-nowatermark.png` });
});

test("onboarding: the five starter Monos, only the Chief of Staff ticked, and skip with none ticked adds nobody", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOnboarding(page);
  await page.locator("[data-hub-onboarding-next]").click();
  await assertStarterTicks(page);
  const rail = page.locator("[data-mono-rail]").first();
  await expect(rail.getByText("Critiquito")).toHaveCount(0);
  expect(await page.evaluate(() => /\bAsh\b|pre-load|Critiquito/i.test(document.body.innerText))).toBe(false);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-20-onboarding-critiquito-optional.png` });
  await skipAddsNobody(page);
  await tickedBecomesOrdinaryMono(page);
});
