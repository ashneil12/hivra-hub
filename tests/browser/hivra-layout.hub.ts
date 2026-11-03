import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// WP-03: Hivra has one layout (Classic; src/features/hub/model/hivraLayout.ts). The real app in a browser with the Hub
// flag (hivra-layout.config.ts sets VITE_MONOCODE_HUB=1) reading the stub through its real transport, with Focused
// stored the way an earlier build or upstream's Settings left it: the app still opens in Classic, offers no layout
// switch or invitation, and every main Hub screen renders there. Each screen is photographed.
//
//   npx playwright test -c tests/browser/hivra-layout.config.ts

const SHOTS = process.env.HIVRA_LAYOUT_PROOF_DIR ?? "test-results/hivra-layout";

type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());
test.use({ viewport: { width: 1440, height: 900 } });

async function shot(page: Page, name: string, engine: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png` });
}

async function expectClassic(page: Page) {
  await expect(page.locator("html")).not.toHaveClass(/\blayout-inset\b/);
  await expect(page.locator(".inset-shell, .inset-sidebar")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Try the Focused layout" })).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Focused, stored: Hivra ignores it.
    localStorage.setItem("monocode.insetLayout", "1");
    // The first-launch cards are their own specs' business.
    localStorage.setItem("monocode:hub-onboarded", "1");
    localStorage.setItem("monocode:hub-setup-not-now", "1");
  });
});

test("opens in Classic with Focused stored, and every main Hub screen renders there", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const engine = info.project.name;

  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  await expectClassic(page);
  // Classic's project rail and its sidebar, side by side.
  const rail = page.getByRole("navigation", { name: "Projects" });
  await expect(rail).toHaveCount(2);
  const sidebar = rail.nth(1);

  const screens: Array<[string, (page: Page) => Locator]> = [
    ["Inbox", (p) => p.getByRole("region", { name: "Inbox" })],
    ["Coding team", (p) => p.getByRole("main").getByRole("heading", { name: "EXO lead" })],
    ["Leadership team", (p) => p.getByPlaceholder("Message EXO's leadership team")],
    ["Builds & playtests", (p) => p.getByText("No builds of EXO yet.")],
    ["Being built", (p) => p.getByText("Example: adding the air dodge").first()],
    ["Decisions", (p) => p.getByRole("region", { name: "Decisions" })],
    ["Pages", (p) => p.getByRole("region", { name: "Pages" })],
    ["Notes", (p) => p.getByRole("region", { name: "Notes" })],
    ["Automations", (p) => p.getByRole("heading", { name: "New automation" })],
  ];
  for (const [name, shown] of screens) {
    await sidebar.getByRole("button", { name, exact: true }).click();
    await expect(shown(page)).toBeVisible({ timeout: 15_000 });
    await expectClassic(page);
    await shot(page, name.toLowerCase().replace(/[^a-z]+/g, "-"), engine);
  }

  // Settings > Appearance: no Layout switch, the rest of the Layout group stays, and search can't find it.
  await sidebar.getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const railMode = page.getByRole("radiogroup", { name: "Collapsed project rail" });
  await railMode.scrollIntoViewIfNeeded();
  await expect(railMode).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Layout", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-setting-id="inset-layout"], #inset-layout')).toHaveCount(0);
  await expect(page.getByText("Focused adds a project switcher")).toHaveCount(0);
  await expectClassic(page);
  await shot(page, "settings-appearance", engine);

  const search = page.getByRole("combobox", { name: "Search settings" });
  const results = page.getByRole("listbox", { name: "Settings search results" });
  await search.fill("focused");
  await expect(results).toContainText("No matching settings");
  await search.fill("layout");
  await expect(results.getByRole("option").first()).toBeVisible();
  // The Appearance page itself still matches "layout"; the switch's own row ("Layout", Appearance) doesn't.
  await expect(results.getByRole("option", { name: /^Layout\s*Appearance$/ })).toHaveCount(0);

  // A reload keeps it, whatever is stored.
  await page.reload();
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  await expectClassic(page);
  expect(await page.evaluate(() => localStorage.getItem("monocode.insetLayout"))).toBe("1");

  expect(errors).toEqual([]);
});
