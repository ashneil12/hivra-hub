import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// PM redo proofs for themes (F3, PM-21) in the real app in a browser: hub-dev.html reading the stub Ash OS.
// One photo per screen. A browser preview only, not Ash's Mac.
//   PM_PROOF_SPEC=pm-themes.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-themes";
fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());
test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page) {
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => undefined);
}

const TIDE = JSON.stringify({ name: "Tide", scheme: "dark", hue: 200, saturation: 35, lightness: 10, opacity: 0.85, accent: "hsl(200 85% 70%)" });
async function openAppearance(page: Page) {
  await open(page);
  await page.getByRole("button", { name: /^Settings/ }).first().click();
  await page.getByRole("button", { name: "Appearance" }).first().click();
  await expect(page.locator("[data-theme-import]")).toBeVisible();
}

test("F3: a Mono's theme is checked, previewed, applied, and its Bot changes row has Undo", async ({ page }) => {
  await openAppearance(page);
  // A bad file first: every problem in plain words, nothing changes.
  await page.locator("[data-theme-paste]").click();
  await page.locator("[data-theme-json]").fill(JSON.stringify({ name: "Mud", hue: 30, saturation: 100, lightness: 40, opacity: 2, accent: "#34d399" }));
  await page.locator("[data-theme-check]").click();
  await expect(page.locator("[data-theme-problems] li")).toHaveCount(2);
  await page.locator("[data-theme-import]").scrollIntoViewIfNeeded();
  await shot(page, "f3-theme-problems");
  await page.locator("[data-theme-discard]").click();
  // Critiquito hands one in: Preview restyles the app, nothing saved.
  await page.evaluate((json) => (window as unknown as { __devOfferTheme(t: string, by?: string): void }).__devOfferTheme(json, "Critiquito"), TIDE);
  const hue = page.getByRole("slider", { name: "Hue" });
  await expect(hue).toHaveValue("240");
  await page.locator("[data-theme-preview]").click();
  await expect(page.locator("[data-theme-stop-preview]")).toBeVisible();
  // PM-21: the sliders show the previewed theme, held until it is applied or stopped, and go back on Stop preview.
  await expect(hue).toHaveValue("200");
  await expect(hue).toBeDisabled();
  await expect(page.getByRole("slider", { name: "Saturation" })).toHaveValue("35");
  await expect(page.getByRole("slider", { name: "Dark-mode lightness" })).toHaveValue("10");
  // Scrolled down to the sliders, the slim bar stays at the top with Stop preview and Apply.
  await page.getByRole("slider", { name: "Sidebar opacity" }).scrollIntoViewIfNeeded();
  const bar = page.locator("[data-theme-preview-bar]");
  await expect(bar).toHaveText(/Previewing Tide/);
  // Glass doesn't look selected while Tide is on show.
  await expect(page.locator('[data-scheme="glass"]')).toHaveAttribute("aria-pressed", "false");
  await expect(bar).toBeInViewport();
  // The sidebar's glass: its fill and a 24px blur, so text scrolling under it doesn't show through.
  await expect(bar).toHaveClass(/sidebar-glass/);
  expect(await bar.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("blur(24px)");
  await expect(page.locator("[data-theme-import]")).not.toBeInViewport();
  await shot(page, "f3-pm21-preview-bar-and-sliders");
  await bar.locator("[data-theme-bar-stop]").click();
  await expect(bar).toHaveCount(0);
  await expect(hue).toHaveValue("240");
  await expect(hue).toBeEnabled();
  // ...and on Discard.
  await page.locator("[data-theme-preview]").click();
  await expect(hue).toHaveValue("200");
  await page.locator("[data-theme-discard]").click();
  await expect(hue).toHaveValue("240");
  await expect(page.getByRole("slider", { name: "Saturation" })).toHaveValue("0");
  await page.evaluate((json) => (window as unknown as { __devOfferTheme(t: string, by?: string): void }).__devOfferTheme(json, "Critiquito"), TIDE);
  await page.locator("[data-theme-preview]").click();
  await page.locator("[data-theme-bar-apply]").click();
  await expect(page.locator('[data-scheme="custom-tide"]')).toHaveAttribute("aria-pressed", "true");
  // Applied: the sliders keep the theme and can be moved again.
  await expect(hue).toHaveValue("200");
  await expect(hue).toBeEnabled();
  // Its Bot changes row, with Undo.
  await page.getByRole("button", { name: /^Changes/ }).first().click();
  await page.getByRole("button", { name: "Bot changes" }).click();
  const row = page.getByText("Critiquito changed the theme from Glass to “Tide”");
  await expect(row).toBeVisible();
  await shot(page, "f3-bot-changes-undo");
  // Undo puts Glass back, and the sliders follow.
  const themeRow = page.locator("[data-hub-bot-change]", { has: page.getByText("Critiquito changed the theme from Glass to “Tide”") });
  await themeRow.locator("[data-hub-bot-change-undo]").click();
  await expect(themeRow.locator("[data-hub-bot-change-undone]")).toContainText("Undone: back to Glass.");
  await page.getByRole("button", { name: "Appearance" }).first().click();
  await expect(page.locator('[data-scheme="glass"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Hue" })).toHaveValue("240");
});
