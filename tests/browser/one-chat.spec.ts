import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// One chat (Ash, 13 Nov: "Chief of Staff is just really literally just one main chat ... full port one chat for
// everything"), walked in the real frontend with the hub flag on. Like dropwave-screens.spec.ts it builds the design
// mockup (the real app as static files, example data only, every native call stubbed: docs/hivra/ux/MOCKUP.md) and
// serves it. The build takes about a minute; DROPWAVE_MOCKUP_BUILT=1 reuses target/mockup as it is.
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

async function home(page: Page) {
  await page.goto(`${base}/mockup.html?reset`);
  await expect(page.locator("[data-home]")).toBeVisible({ timeout: 60_000 });
}

const homeTile = (page: Page) => page.locator("[data-hub-home] button").first();
const project = (page: Page, name: string) => page.locator(`[data-hub-strip] button[title^="${name}"]`).first();
const firstMate = (page: Page, name: string) => page.locator("[data-mono-rail-list]").getByText(name, { exact: true }).first();
/** The Chief of Staff's row, pinned first in every sidebar. */
const chiefRow = (page: Page) => page.locator("[data-chief-pinned] button").first();
const oneChat = (page: Page) => page.locator('[data-session-drop="mockup-chat-chief"]');
const chatsToggle = (page: Page) => page.getByRole("button", { name: /^Toggle Session Sidebar/ });

test("one chat: the Chief of Staff is pinned first on Home and in a project, and every way in opens the same chat", async ({ page }) => {
  await home(page);
  // Pinned first, above Home, with nothing nested under it.
  await expect(page.locator("[data-hub-top-nav] button").first()).toContainText("Chief of Staff");
  await chiefRow(page).click();
  await expect(oneChat(page)).toBeVisible();
  // No list of its chats beside it and nothing that starts another. (The example data has one chat from before, so
  // the toggle for "Earlier chats" is there, shut.)
  await expect(page.locator("[data-sidebar-chats-header]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);

  // Home's box: the message lands in the one chat, not in a new chat.
  await homeTile(page).click();
  await page.getByRole("textbox", { name: "Ask" }).first().fill("Example: what is left before Tuesday?");
  await page.getByRole("textbox", { name: "Ask" }).first().press("Enter");
  await expect(oneChat(page)).toBeVisible();
  await expect(oneChat(page).getByText("Example: what is left before Tuesday?")).toBeVisible();

  // A project: the same row is first there too, the project's own Chief of Staff row is gone, and the project's home
  // box sends into the same chat with the project named.
  await project(page, "EXO").click();
  await expect(page.locator("[data-hub-top-nav] button")).toHaveCount(2);
  await expect(page.locator("[data-hub-top-nav] button").first()).toContainText("Chief of Staff");
  await page.getByRole("textbox", { name: "Ask" }).first().fill("Example: is the boss arena lit yet?");
  await page.getByRole("textbox", { name: "Ask" }).first().press("Enter");
  await expect(oneChat(page)).toBeVisible();
  await expect(oneChat(page).getByText("About EXO: Example: is the boss arena lit yet?")).toBeVisible();
  await expect(oneChat(page).getByText("Example: what is left before Tuesday?")).toBeVisible();

  await project(page, "EXO").click();
  await chiefRow(page).click();
  await expect(oneChat(page)).toBeVisible();
  await expect(page.locator("[data-sidebar-chats-header]")).toHaveCount(0);
});

test("one chat: Catch me up sits beside Side question and posts one card; the next one only covers what came since", async ({ page }) => {
  await home(page);
  await chiefRow(page).click();
  const button = page.locator("[data-catch-me-up]:visible");
  await expect(button).toHaveCount(1);
  await expect(page.locator("[data-side-question]:visible")).toHaveCount(1);
  await button.click();
  const card = page.locator("[data-catch-up]").first();
  await expect(card.locator("[data-catch-up-summary]")).toHaveText("2 jobs finished, 3 decided for you, 4 need you, 7 still running.");
  await expect(card.locator("[data-catch-up-job]")).toHaveCount(2);
  await expect(card.locator("[data-catch-up-decided]")).toHaveCount(3);
  await expect(card.locator('[data-catch-up-need="open"]')).toHaveCount(4);
  // A row that needs him opens its own card where it is.
  await card.getByRole("button", { name: /^Answer: Which waitlist headline/ }).click();
  await expect(card.locator("[data-need-detail]")).toBeVisible();

  // Nothing came back in between, so the second card says so and repeats no finished job.
  await page.waitForTimeout(1100);
  await button.click();
  const second = page.locator("[data-catch-up]").nth(1);
  await expect(second.locator("[data-catch-up-summary]")).toHaveText("Nothing new came back: 4 need you, 7 still running.");
  await expect(second.locator("[data-catch-up-job]")).toHaveCount(0);

  // A first mate's chat has no such button.
  await project(page, "Hivra").click();
  await firstMate(page, "Hivra lead").click();
  await expect(page.locator("[data-catch-me-up]:visible")).toHaveCount(0);
});

test("one chat: a chat the Chief of Staff had before stays reachable under Earlier chats, with no New chat", async ({ page }) => {
  await home(page);
  await chiefRow(page).click();
  await chatsToggle(page).click();
  const header = page.locator("[data-sidebar-chats-header]");
  await expect(header).toContainText("Earlier chats");
  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
  await page.getByText("parents' newsletter wording").first().click();
  await expect(page.locator('[data-session-drop="mockup-chat-chief-earlier"]')).toBeVisible();
  // It is still a chat with the Chief of Staff, so its row stays lit, and nothing beside it starts another.
  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
  await chiefRow(page).click();
  await expect(oneChat(page)).toBeVisible();
  await expect(header).toHaveCount(0);
});

test("a chat says how many side questions it has kept, and they come back as tabs", async ({ page }) => {
  await home(page);
  await project(page, "EXO").click();
  await firstMate(page, "EXO lead").click();
  const side = page.locator("[data-side-question]:visible").first();
  await expect(side.locator("[data-side-question-saved]")).toHaveText("1 saved");
  await side.click();
  await expect(page.getByRole("tablist", { name: "Side questions" }).getByRole("tab").first()).toContainText("Example: which rooms are in Area 3");
});
