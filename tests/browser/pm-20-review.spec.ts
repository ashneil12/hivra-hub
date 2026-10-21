import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 20 review fixes, a browser preview only (not Ash's Mac): Today's project sections side by side above ~1800px,
// no diagonal "Preview" watermark on a Page preview, and Critiquito offered unticked in onboarding (Ash 14 Oct).
//   PM_PROOF_SPEC=pm-20-review.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-20";
type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());

async function open(page: Page) {
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => undefined);
}

test("Today at 2560 wide: project sections in two columns", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await open(page);
  await page.locator('[data-hub-strip] button[title="Today, all projects"]').click();
  const sections = page.locator("[data-hub-today-projects] > section");
  await expect(sections.nth(1)).toBeVisible({ timeout: 30_000 });
  const xs = await sections.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(xs).size).toBe(2);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/pm-20-today-2560.png` });
  // At 1440 wide, one column.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  const narrow = await sections.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
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
