import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Round 19 proofs, a browser preview only (not Ash's Mac):
// - Ash 21 Oct, width: Pages and a project's own Today (G1: its Inbox; a fresh load opens the stub's first project)
//   fill the window at 1280, 1920 and 2560 wide, with modest side padding.
// - Ash 21 Oct, team: a fresh install's onboarding shows the default team (names kept, a role line under each) and
//   no pre-load option; nothing of Ash's. Round 20: the team is the four, Critiquito an unticked add-on (pm-20-review).
//   PM_PROOF_SPEC=pm-19-width-team.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-19";
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

/** How much of its scroll area a surface's main column fills, and its side padding. */
const fill = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const area = el.parentElement!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(el).paddingLeft);
    return { share: box.width / area.width, pad, width: Math.round(box.width) };
  });

const SIZES = [
  { name: "1280", width: 1280, height: 800 },
  { name: "1920", width: 1920, height: 1080 },
  { name: "2560", width: 2560, height: 1440 },
];

for (const size of SIZES) {
  test(`Today and Pages fill the width at ${size.width}x${size.height}`, async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width: size.width, height: size.height });
    await open(page);
    // G1: a fresh load already selects the stub's first project's Inbox — its own Today fills the main column.
    const today = page.locator("[data-hub-surface-body]").first();
    await expect(today).toBeVisible({ timeout: 30_000 });
    const t = await fill(page, "[data-hub-surface-body]");
    expect(t.share).toBeGreaterThan(0.99);
    expect(t.pad).toBeGreaterThanOrEqual(24);
    expect(t.pad).toBeLessThanOrEqual(32);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/pm-19-today-${size.name}.png` });

    await page.getByRole("button", { name: /^Pages/ }).first().click();
    const newButton = page.locator("[data-pages-new-button]").first();
    if (await newButton.isVisible().catch(() => false)) await newButton.click();
    await page.getByLabel("Describe the page").fill("plan my week, with a calendar");
    await page.getByLabel("Send to a Mono").click();
    await expect(page.locator("[data-block-calendar]").first()).toBeVisible({ timeout: 30_000 });
    const p = await fill(page, "[data-pages-preview], [data-pages-open]");
    expect(p.share).toBeGreaterThan(0.99);
    expect(p.pad).toBeGreaterThanOrEqual(24);
    expect(p.pad).toBeLessThanOrEqual(32);
    await page.mouse.move(5, 450);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/pm-19-pages-${size.name}.png` });
  });
}

test("fresh install onboarding: our team with a role line under each name, and no pre-load", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/hub-dev.html?onboarding");
  await expect(page.locator("[data-hub-onboarding]")).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.locator("[data-hub-onboarding-name]").fill("Sam");
  await page.locator("[data-hub-onboarding-next]").click();
  const text = () => page.evaluate(() => document.body.innerText);
  await expect.poll(text).toMatch(/Team setup/);
  const body = await text();
  for (const [name, role] of [["Chief of Staff", "Business partner"], ["Projects Manager", "Screens and board"], ["frank", "Memory and checks"], ["Alfred", "Team setup"]]) {
    expect(body).toContain(name);
    expect(body).toContain(role);
  }
  expect(body).not.toMatch(/pre-load|saved team/i);
  expect(body).not.toMatch(/\bAsh\b|Hivra|Nibbii/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-19-onboarding-team.png` });
});
