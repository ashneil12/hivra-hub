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

test("Hubs opens on the project in view, and on everything from Home", async ({ page }) => {
  await home(page);
  await page.getByRole("button", { name: "Hubs", exact: true }).first().click();
  await expect(page.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");

  await project(page, "Hivra").click();
  await page.getByRole("button", { name: "Hubs", exact: true }).first().click();
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

test("a first mate's chat list is its own: no chats with anyone else until Everyone is picked", async ({ page }) => {
  await home(page);
  await project(page, "Hivra").click();
  await firstMate(page, "Hivra lead").click();
  // The row on top is the first mate's main chat, dressed like its other chats: no pin, its name on the top line.
  const top = page.locator("[data-coding-team-lead]:visible").first();
  await expect(top).toContainText("Hivra lead");
  await expect(top).toContainText("Main chat");
  await expect(top.locator("svg.lucide-pin")).toHaveCount(0);

  // A second chat with the Hivra lead.
  await page.getByRole("button", { name: "New chat" }).first().click();
  const box = page.locator("textarea:visible, [contenteditable='true']:visible").last();
  await box.click();
  await page.keyboard.type("Example: can you look at the waitlist page copy?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Example reply from Hivra lead").first()).toBeVisible({ timeout: 30_000 });
  const leadRows = page.locator("[data-session-card]:visible").filter({ hasText: "Hivra lead" });
  await expect(leadRows).toHaveCount(2);

  // The Chief of Staff's chat for this project: only the Chief of Staff's chats, none with the Hivra lead.
  await page.locator("[data-hub-top-nav] button").nth(1).click();
  await expect(top).toContainText("Chief of Staff");
  const scope = page.locator("[data-chat-scope]:visible").first();
  await expect(scope).toHaveAttribute("data-chat-scope", "own");
  await expect(scope.locator('[data-chat-scope-option="own"]')).toHaveAttribute("aria-pressed", "true");
  await expect(leadRows).toHaveCount(0);

  // Everyone: the Hivra lead's main chat and its second chat are listed too.
  await scope.locator('[data-chat-scope-option="all"]').click();
  await expect(scope).toHaveAttribute("data-chat-scope", "all");
  await expect(leadRows).toHaveCount(2);
  await expect(page.locator("[data-coding-team-other]:visible")).toContainText("Hivra lead");

  // Back to the Chief of Staff's own chats, and the same holds on the Hivra lead's side.
  await scope.locator('[data-chat-scope-option="own"]').click();
  await expect(leadRows).toHaveCount(0);
  await firstMate(page, "Hivra lead").click();
  await expect(top).toContainText("Hivra lead");
  await expect(leadRows).toHaveCount(2);
  await expect(page.locator("[data-session-card]:visible").filter({ hasText: "Chief of Staff" })).toHaveCount(0);
});

test("the plus beside First mates makes a new one for this project, or adds one already made", async ({ page }) => {
  await home(page);
  await project(page, "Hivra").click();
  await page.locator("[data-new-first-mate]:visible").first().click();
  const panel = page.getByRole("dialog", { name: "New first mate" });
  await expect(panel).toBeVisible();
  // Nothing is made until it has a name.
  await expect(panel.getByRole("button", { name: "Create" })).toBeDisabled();
  // Milo works on SafeTube only, so Hivra can take Milo on. Iris is on Hivra already, and leads stay with their project.
  const existing = panel.locator("[data-new-first-mate-existing]");
  await expect(existing).toContainText("Milo");
  await expect(existing).not.toContainText("Iris");
  await expect(existing).not.toContainText("lead");
  await expect(existing).not.toContainText("Chief of Staff");

  await panel.getByLabel("First mate's name").fill("Example mate");
  await panel.getByLabel("What it looks after").fill("Runs the launch");
  await panel.getByRole("button", { name: "Create" }).click();
  await expect(panel).toHaveCount(0);
  // It is on Hivra's list under its name, and its chat is the open one.
  const made = page.locator('[data-mono-rail-list] [aria-current="true"]');
  await expect(made).toContainText("Example mate");
  await expect(made).toContainText("Runs the launch");
  await expect(page.locator("[data-session-composer]:visible").first()).toBeVisible();

  // It was made for Hivra only. SafeTube can add it from the ones already made.
  await project(page, "SafeTube").click();
  await expect(page.locator("[data-mono-rail-list]").getByText("Example mate", { exact: true })).toHaveCount(0);
  await page.locator("[data-new-first-mate]:visible").first().click();
  await panel.locator('[data-new-first-mate-existing] button').filter({ hasText: "Example mate" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-mono-rail-list]").getByText("Example mate", { exact: true })).toHaveCount(1);
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
  // The Inbox's own list. The sidebar's count beside Inbox carries the same data-inbox-needs mark (WP-210), so the bare
  // attribute matches two elements once that count has painted; other regions' names contain "Needs you" too.
  const needs = page.locator("section[data-inbox-needs]");
  await expect(needs).toBeVisible();
  const count = Number(await needs.getAttribute("data-inbox-needs"));
  expect(count).toBeGreaterThan(0);
  await expect(needs.locator("[data-inbox-need]")).toHaveCount(count);
  await expect(needs.locator("[data-needs-answer]").first()).toBeVisible();
  // The red count beside Inbox is the same list.
  await expect(page.getByRole("button", { name: `Inbox, ${count} need you` })).toBeVisible();
});

// Ash, 11 Nov: "it's more like an All and then Ask and then GitHub", and a row "doesn't actually bring me to anything".
test("the Inbox shows All, only Asks or one source, and a row opens its card with its answers and a reply box", async ({ page }) => {
  await home(page);
  await page.getByRole("button", { name: /^Inbox/ }).first().click();
  const inbox = page.getByRole("region", { name: "Inbox" });
  const tabs = inbox.getByRole("tablist", { name: "Inbox source" });
  const needs = inbox.locator("[data-inbox-needs]");
  const items = inbox.locator("[data-inbox-source-heading]");
  // All: the asks and the work items, each under its own heading.
  await expect(tabs.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
  await expect(needs).toBeVisible();
  await expect(items).toContainText("GitHub");
  // GitHub: the work items alone, with their own search.
  await tabs.getByRole("tab", { name: "GitHub" }).click();
  await expect(needs).toHaveCount(0);
  await expect(inbox.getByRole("textbox", { name: "Filter inbox" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "GitHub" })).toHaveAttribute("aria-selected", "true");
  // Asks: the asks alone, the first one open beside the list.
  await tabs.getByRole("tab", { name: "Asks" }).click();
  await expect(needs).toBeVisible();
  await expect(inbox.getByRole("textbox", { name: "Filter inbox" })).toHaveCount(0);
  await expect(inbox.locator("[data-need-detail]")).toBeVisible();
  // A question's row opens its card and stays in the Inbox: the ask, who asked, its answer, its chat and a reply box.
  const row = needs.locator("[data-inbox-need='question']").filter({ hasText: "Which take for the boss music?" });
  await row.locator("button").first().click();
  await expect(row).toHaveAttribute("data-selected", "true");
  const card = inbox.locator("[data-need-detail]");
  await expect(card.locator("[data-need-kind]")).toHaveText("Question");
  await expect(card.locator("[data-need-sentence]")).toHaveText("Which take for the boss music?");
  await expect(card.locator("[data-need-from]")).toContainText("EXO lead");
  await expect(card.locator("[data-need-answer]").first()).toHaveText("Take A: drums first");
  await expect(card.locator("[data-need-open]")).toHaveText("Open chat");
  await expect(card.getByRole("textbox", { name: "Reply to EXO lead" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("inbox-ask-card.png") });
  // The choice is kept: back in the Inbox it is still on Asks. All brings the work items back.
  await page.reload();
  await expect(page.locator("[data-home]")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Inbox/ }).first().click();
  await expect(tabs.getByRole("tab", { name: "Asks" })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "All" }).click();
  await expect(items).toBeVisible();
});

// Ash, 11 Nov: "Open chat lands on the latest message, not the exact one. needs fixing." The chat goes on for three
// more turns after the ask, in a window too short to show both ends.
test("Open chat on an Inbox card lands on the message that asked, not on the chat's latest one", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 560 });
  await home(page);
  await page.getByRole("button", { name: /^Inbox/ }).first().click();
  const inbox = page.getByRole("region", { name: "Inbox" });
  await inbox.getByRole("tablist", { name: "Inbox source" }).getByRole("tab", { name: "Asks" }).click();
  const row = inbox.locator("[data-inbox-need='question']").filter({ hasText: "Which take for the boss music?" });
  await row.locator("button").first().click();
  await inbox.locator("[data-need-detail] [data-need-open]").click();
  const asked = page.locator('[data-transcript-search-current="true"]');
  await expect(asked).toContainText("Which take for the boss music?", { timeout: 15_000 });
  await expect(asked).toBeInViewport();
  await expect(page.getByText("I'll tell you when the build is up.")).not.toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("open-chat-on-the-ask.png") });
});

// Ash, 11 Nov: onboarding "doesn't carry you through a proper setup flow". One thing a step, said back at the end.
test("first run: one thing a step (project, first mates, tools), the Chief of Staff recommended and ticked, and a short tour", async ({ page }) => {
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

  // The project, alone on its step.
  await expect(card).toHaveAttribute("data-step", "start");
  await expect(page.locator("[data-hub-onboarding-starter]")).toHaveCount(0);
  await page.locator("[data-hub-onboarding-project]").fill("Field notes");
  await page.locator("[data-hub-onboarding-next]").click();

  // Its first mates: each says what it does in full, and the ticked ones join the project.
  await expect(card).toHaveAttribute("data-step", "team");
  const starters = page.locator("[data-hub-onboarding-starter]");
  await expect(starters.first()).toContainText("Chief of Staff");
  await expect(starters.first().locator("[data-hub-onboarding-tag]")).toHaveText("Recommended");
  await expect(starters.first()).toHaveAttribute("aria-checked", "true");
  for (const box of (await starters.all()).slice(1)) await expect(box).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-hub-onboarding-team]")).toContainText("Chief of Staff is ticked to get you started");
  await expect(page.locator("[data-hub-onboarding-team]")).toContainText("They join Field notes.");
  await page.locator('[data-hub-onboarding-starter="planner"]').click();
  await page.screenshot({ path: test.info().outputPath("onboarding-first-mates.png") });
  await page.locator("[data-hub-onboarding-next]").click();

  // The coding tools, then the look.
  await expect(card).toHaveAttribute("data-step", "tools");
  await expect(page.locator("[data-hub-onboarding-cli]").first()).toBeVisible();
  await page.locator("[data-hub-onboarding-next]").click();
  await expect(card).toHaveAttribute("data-step", "theme");
  await page.locator("[data-hub-onboarding-next]").click();

  await expect(card).toHaveAttribute("data-step", "done");
  await expect(page.locator("[data-hub-onboarding-summary]")).toContainText("Project: Field notes");
  await expect(page.locator("[data-hub-onboarding-summary]")).toContainText("First mates: Chief of Staff, Planner");
  await page.screenshot({ path: test.info().outputPath("onboarding-done.png") });
  await expect(page.locator("[data-hub-onboarding-tour]")).toContainText("Home");
  await expect(page.locator("[data-hub-onboarding-tour]")).not.toContainText("You didn't add one");
  await expect(page.locator("[data-hub-onboarding-done]")).toHaveText("Open Field notes");
});

// Ash, 12 Nov: a new person brings their Claude Code and Codex chats over, in parts. First run only starts the sweep
// and lets them in; the sidebar calls them back to choose what comes in and, later, for the suggested rules.
test("first run: bring my chats over is one step that starts the sweep and lets the person in", async ({ page }) => {
  const shot = (name: string) =>
    process.env.CHAT_IMPORT_SHOTS ? path.resolve("docs/hivra/work/shots/onboarding-chat-import", name) : test.info().outputPath(name);
  await page.goto(`${base}/mockup.html?reset&onboarding`);
  const card = page.locator("[data-hub-onboarding]");
  await expect(card).toBeVisible({ timeout: 60_000 });
  const notNow = page.locator("[data-hub-onboarding-not-now]");
  if (await notNow.isVisible().catch(() => false)) {
    await page.reload();
    await expect(card).toBeVisible({ timeout: 60_000 });
  }
  if ((await card.getAttribute("data-step")) === "setup") test.skip(true, "this build shows the setup checks first, which need the native app");
  await page.locator("[data-hub-onboarding-next]").click();
  await expect(card).toHaveAttribute("data-step", "start");
  const count = page.locator("[data-hub-onboarding-count]");
  const before = await count.textContent();
  await card.getByRole("button", { name: /Bring my chats over/ }).click();
  // Choosing it adds its own step; the other starts never see it.
  await expect(count).not.toHaveText(before ?? "");
  await expect(page.locator("[data-hub-onboarding-project]")).toHaveCount(0);
  await page.screenshot({ path: shot("after-1-start.png") });
  await page.locator("[data-hub-onboarding-next]").click();

  await expect(card).toHaveAttribute("data-step", "chats");
  await expect(card.getByRole("heading", { name: "Bring your chats over" })).toBeVisible();
  await expect(card).toContainText("A card in the sidebar calls you back to choose what comes in");
  await expect(page.locator("[data-hub-onboarding-chats-finding]")).toContainText("Found 426 chats so far.");
  const learn = page.locator("[data-hub-onboarding-learn]");
  await expect(learn).toHaveAttribute("aria-checked", "true");
  await expect(learn).toContainText("nothing changes until you save a rule");
  await page.screenshot({ path: shot("after-2-chats-step.png") });
  await page.locator("[data-hub-onboarding-next]").click();

  await expect(card).toHaveAttribute("data-step", "team");
  await page.locator("[data-hub-onboarding-next]").click();
  await page.locator("[data-hub-onboarding-next]").click();
  await page.locator("[data-hub-onboarding-next]").click();
  await expect(card).toHaveAttribute("data-step", "done");
  await expect(page.locator("[data-hub-onboarding-chats-finding]")).toHaveCount(0);
  await expect(page.locator("[data-hub-onboarding-summary]")).toContainText("Chats: being found now; you choose what comes in next");
  await expect(page.locator("[data-hub-onboarding-done]")).toContainText("Start using");
  await page.screenshot({ path: shot("after-3-done.png") });
  await page.locator("[data-hub-onboarding-done]").click();
  // Straight into the app: nothing waits on the chats.
  await expect(card).toHaveCount(0);

  // Part two: the sidebar calls the person back once the chats are found.
  const rail = page.locator("[data-import-rail-card]");
  await expect(rail).toContainText("Your chats are found", { timeout: 15_000 });
  await expect(rail).toContainText("426 chats. Choose what comes in");
  await page.screenshot({ path: shot("after-4-called-back.png") });
  await rail.locator("[data-import-rail-open]").click();
  const setup = page.locator('[data-import-setup][data-part="choose"]');
  await expect(setup.getByRole("heading", { name: "Choose what comes in" })).toBeVisible();
  await expect(setup.locator("[data-chat-import-found]")).toContainText("Found 426 chats in 4 folders.");
  // A folder that is gone goes into its look-alike that is still here.
  await expect(setup.locator('[data-chat-import-group="/Users/example/Old/shop-app-old"] [data-chat-import-into]')).toHaveValue("/Users/example/Projects/shop-app");
  await page.screenshot({ path: shot("after-5-choose.png") });
  await setup.locator("[data-chat-import-go]").click();
  await expect(setup).toHaveCount(0);
  // The chats come in behind the app; then the card calls the person back for the suggested rules (examples here).
  await expect(rail).toContainText("5 suggested rules are ready", { timeout: 60_000 });
  await rail.locator("[data-import-rail-open]").click();
  const rules = page.locator('[data-import-setup][data-part="rules"]');
  await expect(rules.locator("[data-import-setup-rule]")).toHaveCount(5);
  await page.screenshot({ path: shot("after-6-rules.png") });
  await rules.getByRole("button", { name: "Save 5 rules" }).click();
  await expect(rail).toHaveCount(0);

  // Ash, 12 Nov: the chats are filed under the Chief of Staff of the project they landed in, not under its Lead,
  // and one project's chats never show in another's.
  await page.getByRole("navigation", { name: "Projects" }).first().getByRole("button", { name: "recipes", exact: true }).click();
  await page.getByRole("button", { name: "Chief of Staff for recipes" }).click();
  const list = page.getByRole("complementary").first();
  await expect(list.getByText("Example: Fix the checkout total").first()).toBeVisible();
  await page.screenshot({ path: shot("after-7-chief-of-staff.png") });
  await page.getByRole("button", { name: /^recipes lead/ }).first().click();
  await expect(list.getByText("Main chat")).toBeVisible();
  await expect(list.getByText(/^Example: /)).toHaveCount(0);
  await page.getByRole("navigation", { name: "Projects" }).first().getByRole("button", { name: /^EXO/ }).first().click();
  await page.getByRole("button", { name: "Chief of Staff for EXO" }).click();
  await expect(list.getByText("Main chat")).toBeVisible();
  await expect(list.getByText("Example: Fix the checkout total")).toHaveCount(0);
});
