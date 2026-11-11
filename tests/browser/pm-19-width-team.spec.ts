import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { openLocalHub } from "./localHub";
import { assertStarterTicks, openOnboarding, skipAddsNobody, tickedBecomesOrdinaryMono } from "./starterOnboarding";

// Round 19 proofs, a browser preview only (not Ash's Mac):
// - Ash 21 Oct, width: Pages and the project's coding team (WP-06: that chat replaced Today)
//   fill the window at 1280, 1920 and 2560 wide, with modest side padding.
// - Ash 21 Oct, team: a fresh install's onboarding shows the default team (names kept, a role line under each) and
//   no pre-load option; nothing of Ash's. Round 20: the team is the four, Critiquito an unticked add-on (pm-20-review).
//   PM_PROOF_SPEC=pm-19-width-team.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-19";

async function open(page: Page) {
  await openLocalHub(page);
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
  test(`the coding team and Pages fill the width at ${size.width}x${size.height}`, async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width: size.width, height: size.height });
    await open(page);
    // WP-06: a fresh load opens the first project's coding team. The workspace pane behind it is an
    // empty hidden drop, so the width is the Lead chat that is actually on screen.
    const chat = page.locator('[data-mono-view][aria-hidden="false"] [data-session-drop]');
    await expect(chat).toBeVisible({ timeout: 30_000 });
    const t = await fill(page, '[data-mono-view][aria-hidden="false"] [data-session-drop]');
    expect(t.share).toBeGreaterThan(0.99);
    const pad = await chat.locator("[data-session-composer]").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    expect(pad).toBeGreaterThanOrEqual(24);
    expect(pad).toBeLessThanOrEqual(32);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/pm-19-coding-team-${size.name}.png` });

    await page.getByRole("button", { name: /^Hubs/ }).first().click();
    // WP-01: the list (ready-made pages are there from the start) with its New page button, or the ask box when
    // there are no pages yet. Wait for one of them instead of checking before the view has rendered.
    await expect(page.locator("[data-pages-list], [data-pages-new]").first()).toBeVisible();
    if (await page.locator("[data-pages-list]").count()) await page.locator("[data-pages-new-button]").first().click();
    // WP-04 moved building a page to the Mono's chat (BUILD_MOVED); the app's dev keyword stub stands in for that
  // build here, as in agents-page, so the preview it draws is what this checks.
  await page.evaluate(() => localStorage.setItem("monocode:pages-dev-stub", "1"));
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
  await openOnboarding(page);
  await page.locator("[data-hub-onboarding-name]").fill("Sam");
  await page.locator("[data-hub-onboarding-next]").click();
  await assertStarterTicks(page);
  const text = () => page.evaluate(() => document.body.innerText);
  await expect.poll(text).toMatch(/Only ticked ones are added/);
  const body = await text();
  for (const [name, role] of [
    ["Chief of Staff", "The first mono you talk to about work."],
    ["Planner", "Keeps the board: owner, state, evidence."],
    ["Record keeper", "Checks plans against what was said."],
    ["Team steward", "One owner for each job. No spare seats."],
    ["Design review", "Looks at a screen and ranks what to fix."],
  ]) {
    expect(body).toContain(name);
    expect(body).toContain(role);
  }
  expect(body).not.toMatch(/pre-load|saved team/i);
  expect(body).not.toMatch(/\bAsh\b|Hivra|Nibbii/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-19-onboarding-team.png` });
  await skipAddsNobody(page);
  await tickedBecomesOrdinaryMono(page);
});
