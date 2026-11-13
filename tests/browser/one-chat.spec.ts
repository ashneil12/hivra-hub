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

// Ash, 13 Nov: Needs you "only gives you one option ... How can you actually send your own reply there ... I didn't
// even know you can click on it", and "the animation for it can be better".
test("one chat: a Needs you row opens under itself with every answer, and the answer is seen to land", async ({ page }) => {
  await home(page);
  await chiefRow(page).click();
  await page.locator('[data-chief-chip="needs"]').click();
  const list = page.locator("[data-chief-needs]");
  const row = list.locator("[data-inbox-need]").filter({ hasText: "Which waitlist headline?" });
  await expect(row.locator("[data-need-summary]")).toContainText("2 answers · Suggested: Ship more, decide less");
  const opener = row.getByRole("button", { name: /Which waitlist headline\?\. Open to answer\./ });
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await opener.click();
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  const card = row.locator("[data-need-detail]");
  await expect(card.locator("[data-need-choice]")).toHaveCount(2);
  await expect(card.locator("[data-need-choice][data-suggested]")).toContainText("Ship more, decide less");
  await expect(card.getByRole("textbox", { name: "Reply to Hivra lead" })).toHaveAttribute("placeholder", /^Or answer in your own words/);
  await page.screenshot({ path: test.info().outputPath("needs-open.png") });
  await card.locator('[data-need-choice="a"]').click();
  await expect(list.locator("[data-need-answered]")).toHaveText("Answered: Your agents, one captain. Hivra lead has it.");
  await expect(list.locator("[data-inbox-need]").filter({ hasText: "Which waitlist headline?" })).toHaveCount(0);

  // His own words answer another question the same way.
  const boss = list.locator("[data-inbox-need]").filter({ hasText: "Which take for the boss music?" });
  await boss.getByRole("button", { name: /Open to answer/ }).click();
  await boss.getByRole("textbox", { name: "Reply to EXO lead" }).fill("Example: try both in the playtest");
  await boss.getByRole("button", { name: "Send" }).click();
  await expect(list.locator("[data-need-answered]")).toHaveText("Answered: Example: try both in the playtest. EXO lead has it.");
});

// Ash, 13 Nov: "everything here, you should be able to like quote it in the chat ... whether it's working, needs you,
// or you asked".
test("one chat: any Needs you, You asked or Working row quotes into the chat's box, not sent", async ({ page }) => {
  await home(page);
  await chiefRow(page).click();
  const box = page.locator("textarea[placeholder^='Ask, build']:visible");
  await page.locator('[data-chief-chip="working"]').click();
  const job = page.locator("[data-chief-job]").filter({ hasText: "Light the Area 3 boss arena" });
  await job.hover();
  await job.getByRole("button", { name: /^Quote in the chat/ }).click();
  await expect(page.locator("[data-chief-working]")).toHaveCount(0);
  await expect(box).toHaveValue("> Working · EXO · EXO lead: Light the Area 3 boss arena (Working)\n\n");

  await page.locator('[data-chief-chip="needs"]').click();
  const need = page.locator("[data-chief-needs] [data-inbox-need]").filter({ hasText: "Which take for the boss music?" });
  await need.hover();
  await need.getByRole("button", { name: /^Quote in the chat/ }).click();
  await expect(box).toHaveValue(/\n\n> Needs you · Question · EXO · EXO lead: Which take for the boss music\? \(Suggested: Take A: drums first\)\n\n$/);

  await page.locator('[data-chief-chip="asked"]').click();
  const asked = page.locator("[data-chief-asked] li").first();
  await asked.hover();
  await asked.getByRole("button", { name: /^Quote in the chat/ }).click();
  await expect(box).toHaveValue(/\n\n> You asked: .+\n\n$/);
  await page.screenshot({ path: test.info().outputPath("quoted.png") });
});

// Ash, 13 Nov: "you could be able to message the first mate from that side thing ... making sure that the chief of
// staff knows that you've messaged the first mate".
test("one chat: a first mate's chat opens beside the one chat, and what you send there leaves a line in it", async ({ page }) => {
  await home(page);
  await chiefRow(page).click();
  await page.locator('[data-chief-chip="working"]').click();
  await page.locator("[data-message-lead]").filter({ hasText: "EXO lead" }).first().click();
  await expect(page.locator("[data-chief-working]")).toHaveCount(0);
  // The one chat stays where it was, with the first mate's own chat open beside it.
  await expect(oneChat(page)).toBeVisible();
  const beside = page.locator('[data-session-drop]:not([data-session-drop="mockup-chat-chief"])').filter({ has: page.locator("textarea:visible") });
  await expect(beside).toHaveCount(1);
  await beside.locator("textarea:visible").fill("Example: do the checkpoint pass before the music");
  await beside.locator("textarea:visible").press("Enter");
  await expect(beside).toContainText("Example: do the checkpoint pass before the music");
  const line = oneChat(page).locator("[data-beside-message]");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("You messaged EXO lead");
  await expect(line).toContainText("the Chief of Staff knows");
  // The app's line, not the Chief of Staff's: no name over it and no "worked" row under it.
  const turn = page.locator('[data-transcript-turn^="beside-"]');
  await expect(turn).toHaveCount(1);
  await expect(turn).not.toContainText("worked");
  await expect(turn.locator("[data-turn-actions]")).toHaveCount(0);
  expect((await turn.innerText()).trim().startsWith("You messaged EXO lead")).toBe(true);
  await page.screenshot({ path: test.info().outputPath("beside.png") });
});

// Ash's round 3 pick (13 Nov): a question from any project is answered inside the reply that asks it, so he never
// leaves the one chat for Needs you.
test("one chat: a question in the Chief of Staff's reply is its own answer card, answered where it sits", async ({ page }) => {
  await home(page);
  await chiefRow(page).click();
  // Two in the reply, one in the Needs you roll-up the app posted above it.
  const cards = oneChat(page).locator("[data-inline-need]");
  await expect(cards).toHaveCount(3);
  const rollup = oneChat(page).locator("[data-needs-rollup]");
  await expect(rollup).toContainText("Needs you now");
  await expect(rollup.locator('[data-inline-need="question:nibbii:onboarding-read"]')).toContainText("Read the onboarding copy before it goes out?");
  // The roll-up is the app's: no agent name over it, and not folded into the reply above.
  expect((await page.locator('[data-transcript-turn^="needs-rollup-"]').innerText()).trim().startsWith("Needs you now")).toBe(true);
  const boss = oneChat(page).locator('[data-inline-need="question:vg-game:boss-music"]');
  await expect(boss).toContainText("Which take for the boss music?");
  await expect(boss).toContainText("EXO lead");
  await expect(boss.locator('[data-need-choice="a"]')).toContainText("Take A: drums first");
  await expect(boss.locator('[data-need-choice="a"][data-suggested]')).toHaveCount(1);
  await expect(boss.locator('[data-need-choice="b"]')).toContainText("Take B: choir first");
  // The card stands where the link was: never inside a paragraph, and the link itself is gone.
  expect(await boss.evaluate((node) => !!node.closest("p"))).toBe(false);
  await expect(oneChat(page).locator('a[href^="hivra://local/need"]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("cards.png") });

  await boss.locator('[data-need-choice="a"]').click();
  const answered = oneChat(page).locator('[data-need-answered="question:vg-game:boss-music"]');
  await expect(answered).toHaveText("Answered: Take A: drums first. EXO lead has it.");
  await expect(oneChat(page).locator("[data-inline-need]")).toHaveCount(2);
  await expect(oneChat(page).locator('[data-inline-need="question:hivra:waitlist-headline"]')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("answered.png") });
});

// Ash's round 3 pick (13 Nov): the one chat narrows to one project and back, and what he types while narrowed is about
// that project. Ash 15:25: "curious how the project filter tells things apart" (asks/model/chiefLens.ts).
test("one chat: the project filter narrows the same chat to one project, and a message sent there stays under it", async ({ page }) => {
  await home(page);
  await chiefRow(page).click();
  const lens = page.locator("[data-chief-lens]");
  await expect(lens.locator('[data-lens-pick="all"]')).toHaveText("Everything");
  await expect(lens.locator('[data-lens-pick="vg-game"]')).toHaveText("EXO2");
  const turn = (id: string) => oneChat(page).locator(`[data-transcript-turn="${id}"]`);
  const rollup = oneChat(page).locator('[data-transcript-turn^="needs-rollup-"]');
  await expect(rollup).toBeVisible();

  await lens.locator('[data-lens-pick="vg-game"]').click();
  await expect(lens).toHaveAttribute("data-chief-lens", "vg-game");
  await expect(page.locator("[data-lens-status]")).toContainText("Only EXO, in this same chat.");
  // The Nibbii roll-up isn't about EXO; the reply that asks about EXO and Hivra stays, with only EXO's card.
  await expect(rollup).toBeHidden();
  await expect(turn("mockup-chat-chief-b2")).toBeVisible();
  await expect(oneChat(page).locator('[data-inline-need="question:vg-game:boss-music"]')).toBeVisible();
  await expect(oneChat(page).locator('[data-inline-need="question:hivra:waitlist-headline"]')).toBeHidden();
  await expect(page.locator("[data-lens-composer]")).toContainText("About EXO.");

  // A message that names no project, sent while narrowed, carries EXO.
  const box = page.locator("textarea[placeholder^='Ask, build']:visible");
  await box.fill("Example: what's left before the build?");
  await box.press("Enter");
  const sent = oneChat(page).locator("[data-transcript-turn]").filter({ hasText: "what's left before the build?" });
  await expect(sent).toHaveCount(1);
  // Its reply (the mock-up's stand-in) lands in the same turn.
  await expect(sent).toContainText("Example reply from", { timeout: 15_000 });
  await expect(sent).toHaveAttribute("data-turn-tags", /(^| )vg-game( |$)/);
  await expect(sent).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("exo.png") });

  await lens.locator('[data-lens-pick="hivra"]').click();
  await expect(sent).toBeHidden();
  await expect(oneChat(page).locator('[data-inline-need="question:hivra:waitlist-headline"]')).toBeVisible();

  await page.locator("[data-lens-clear]").click();
  await expect(lens).toHaveAttribute("data-chief-lens", "all");
  await expect(sent).toBeVisible();
  await expect(rollup).toBeVisible();
  await expect(page.locator("[data-lens-composer]")).toHaveCount(0);
});
