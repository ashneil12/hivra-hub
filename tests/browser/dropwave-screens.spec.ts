import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// The Dropwave screens, walked in the real frontend with the hub flag on. The other specs run the dev server, which
// has no hub flag, so these screens never show there. This one builds the design mockup (the real app as static
// files, example data only, every native call stubbed: docs/hivra/ux/MOCKUP.md), serves it, and walks the paths Ash
// found broken on 11 Nov (round 6): each test names the rule in docs/hivra/DESIGN.md it holds.
// The build takes about a minute; DROPWAVE_MOCKUP_BUILT=1 reuses target/mockup as it is.
const OUT = path.resolve("target/mockup");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

let server: http.Server;
let base = "";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  if (process.env.DROPWAVE_MOCKUP_BUILT !== "1" || !fs.existsSync(path.join(OUT, "mockup.html"))) {
    const built = spawnSync("node", ["scripts/mockup-build.mjs"], { stdio: "inherit" });
    expect(built.status, "npm run mockup:build").toBe(0);
  }
  server = http.createServer((req, res) => {
    const file = path.join(OUT, decodeURIComponent((req.url ?? "/").split("?")[0]));
    if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
});

async function home(page: Page, query = "?reset") {
  await page.goto(`${base}/mockup.html${query}`);
  await expect(page.locator("[data-home]")).toBeVisible({ timeout: 60_000 });
}

const homeTile = (page: Page) => page.locator("[data-hub-home] button").first();
const project = (page: Page, name: string) => page.locator(`[data-hub-strip] button[title^="${name}"]`).first();
const firstMate = (page: Page, name: string) => page.locator("[data-mono-rail-list]").getByText(name, { exact: true }).first();

test("Home is its own place: its Chief of Staff keeps Home lit and nothing from a project shows", async ({ page }) => {
  await home(page);
  // Visit a project first, so there is a "last project" to leak.
  await project(page, "Hivra").click();
  await expect(page.locator("[data-hub-items]")).toBeVisible();
  await homeTile(page).click();
  await expect(page.locator("[data-hub-items]")).toHaveCount(0);
  await expect(page.locator("[data-mono-rail-list]")).toHaveCount(0);

  await page.locator("[data-hub-top-nav] button").nth(1).click();
  await expect(page.locator("[data-session-composer]:visible").first()).toBeVisible();
  await expect(homeTile(page)).toHaveAttribute("aria-current", /.+/);
  await expect(page.locator("[data-hub-items]")).toHaveCount(0);
  await expect(page.locator("[data-hub-top-project]")).toHaveCount(0);
});

test("Pages opens on the project in view, and on everything from Home", async ({ page }) => {
  await home(page);
  await page.getByRole("button", { name: "Pages", exact: true }).first().click();
  await expect(page.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");

  await project(page, "Hivra").click();
  await page.getByRole("button", { name: "Pages", exact: true }).first().click();
  await expect(page.getByRole("tab", { name: "Hivra" })).toHaveAttribute("aria-selected", "true");
});

test("New chat beside a first mate is another chat with that first mate", async ({ page }) => {
  await home(page);
  await project(page, "Hivra").click();
  await firstMate(page, "Hivra lead").click();
  await page.getByRole("button", { name: "New chat" }).first().click();

  // The first mate stays the open one in the sidebar, and the new chat says who it is with.
  await expect(page.locator('[data-mono-rail-list] [aria-current="true"]')).toContainText("Hivra lead");
  const box = page.locator("textarea:visible, [contenteditable='true']:visible").last();
  await box.click();
  await page.keyboard.type("Example: can you look at the waitlist page copy?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Example reply from Hivra lead").first()).toBeVisible({ timeout: 30_000 });
  // Its row in the chat list carries the first mate's name where a model name would sit.
  const rows = page.locator("[data-session-card]").filter({ hasText: "Hivra lead" });
  await expect(rows).toHaveCount(2);
  await expect(page.locator('[data-mono-rail-list] [aria-current="true"]')).toContainText("Hivra lead");
});

test("Compare models closes on a click away and shows a tick box on every row", async ({ page }) => {
  await home(page);
  await project(page, "Hivra").click();
  await firstMate(page, "Hivra lead").click();
  await page.locator('button[aria-label="Compare models"]:visible').first().click();
  const panel = page.locator("[data-fan-out-panel]");
  await expect(panel).toBeVisible();
  const boxes = panel.getByRole("checkbox");
  expect(await boxes.count()).toBeGreaterThan(1);
  await boxes.nth(0).click();
  await expect(boxes.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(boxes.nth(1)).toHaveAttribute("aria-checked", "false");

  await page.mouse.click(700, 250);
  await expect(panel).toHaveCount(0);
  // Escape closes it too.
  await page.locator('button[aria-label="Compare models"]:visible').first().click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("a team's settings are in Settings, Teams, not in its chat", async ({ page }) => {
  await home(page);
  await project(page, "Hivra").click();
  await page.locator('[data-hub-item="leadership-team"]').first().click();
  await expect(page.getByText("In this chat")).toBeVisible();
  await expect(page.locator("[data-hub-room-responder]")).toHaveCount(0);
  await expect(page.locator("[data-hub-room-lead]")).toHaveCount(0);

  await page.getByRole("button", { name: /^Settings/ }).first().click();
  await page.getByRole("button", { name: "Teams", exact: true }).click();
  const row = page.locator("[data-hub-project-team]").filter({ hasText: "Hivra" });
  await expect(row.locator("[data-hub-project-team-summary]")).toContainText("Everyone answers");
  await row.locator("[data-hub-project-team-toggle]").click();
  await expect(row.locator("[data-hub-room-responder]")).toHaveValue("everyone");
  await row.locator("[data-hub-room-responder]").selectOption("lead");
  await expect(row.locator("[data-hub-project-team-summary]")).toContainText("The lead answers");
  await expect(row.locator("[data-hub-room-lead]")).toBeVisible();
});

test("the Inbox leads with the Needs you list, each row with its own answer", async ({ page }) => {
  await home(page);
  await page.getByRole("button", { name: /^Inbox/ }).first().click();
  const needs = page.locator("[data-inbox-needs]");
  await expect(needs).toBeVisible();
  const count = Number(await needs.getAttribute("data-inbox-needs"));
  expect(count).toBeGreaterThan(0);
  await expect(needs.locator("[data-inbox-need]")).toHaveCount(count);
  await expect(needs.locator("[data-needs-answer]").first()).toBeVisible();
  // The red count beside Inbox is the same list.
  await expect(page.getByRole("button", { name: `Inbox, ${count} need you` })).toBeVisible();
});

test("first run: Dropwave's words, the Chief of Staff recommended but not ticked, and a short tour", async ({ page }) => {
  await page.goto(`${base}/mockup.html?reset&onboarding`);
  const card = page.locator("[data-hub-onboarding]");
  await expect(card).toBeVisible({ timeout: 60_000 });
  const notNow = page.locator("[data-hub-onboarding-not-now]");
  if (await notNow.isVisible().catch(() => false)) {
    // The setup checks cannot pass in a browser: this walk is about the choices after them.
    await page.reload();
    await expect(card).toBeVisible({ timeout: 60_000 });
  }
  if ((await card.getAttribute("data-step")) === "setup") test.skip(true, "this build shows the setup checks first, which need the native app");
  await expect(card).toContainText("your first mates do it");
  await expect(card).not.toContainText(/\bMonos?\b/);
  await page.locator("[data-hub-onboarding-name]").fill("Sam");
  await page.locator("[data-hub-onboarding-next]").click();

  const starters = page.locator("[data-hub-onboarding-starter]");
  await expect(starters.first()).toContainText("Chief of Staff");
  await expect(starters.first().locator("[data-hub-onboarding-tag]")).toHaveText("Recommended");
  for (const box of await starters.all()) await expect(box).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-hub-onboarding-team]")).toContainText("None are added unless you tick them");
  await page.locator("[data-hub-onboarding-project]").fill("Field notes");
  await page.locator("[data-hub-onboarding-next]").click();
  await page.locator("[data-hub-onboarding-next]").click();

  await expect(card).toHaveAttribute("data-step", "done");
  await expect(page.locator("[data-hub-onboarding-tour]")).toContainText("Home");
  await expect(page.locator("[data-hub-onboarding-tour]")).toContainText("You didn't add one");
  await expect(page.locator("[data-hub-onboarding-done]")).toHaveText("Open Field notes");
});
