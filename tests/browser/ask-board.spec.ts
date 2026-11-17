import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// "You asked" as a board beside the one chat (Ash, 17 Nov: "a main chat in the center ... at the side something like
// sticky notes that pop up, grouped per project"), walked in the real frontend with the hub flag on. Like
// one-chat.spec.ts it builds the design mockup (the real app as static files, example data only, every native call
// stubbed: docs/hivra/ux/MOCKUP.md) and serves it. DROPWAVE_MOCKUP_BUILT=1 reuses target/mockup as it is. `lists=side`
// puts the Chief of Staff's lists in the panel beside the chat (Settings > "Where the lists show").
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

const oneChat = (page: Page) => page.locator('[data-session-drop="mockup-chat-chief"]');
const tab = (page: Page, name: "needs" | "asked" | "working") => page.locator(`[data-chief-tab="${name}"]`);
const stack = (page: Page, id: string) => page.locator(`[data-ask-stack="${id}"]`);
const note = (page: Page, words: string) => page.locator("[data-ask-note]").filter({ hasText: words });

/** The Chief of Staff's one chat with its lists beside it. `query` is "?reset" for the example data as it starts. */
async function chief(page: Page, query = "?reset&lists=side") {
  await page.goto(`${base}/mockup.html${query}`);
  await expect(page.locator("[data-home]")).toBeVisible({ timeout: 60_000 });
  await page.locator("[data-chief-pinned] button").first().click();
  await expect(oneChat(page)).toBeVisible();
}

test("the board: what he asked for shows as notes per project beside the one chat, the ones that need him first", async ({ page }) => {
  await chief(page);
  // The panel arrives on what he asked for while any of it is open.
  await expect(tab(page, "asked")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-ask-board]")).toBeVisible();
  // What no project claims on top, then the projects in the app's own order, then ideas for later.
  await expect(page.locator("[data-ask-stack]")).toHaveCount(5);
  expect(await page.locator("[data-ask-stack]").evaluateAll((all) => all.map((one) => one.getAttribute("data-ask-stack")))).toEqual([
    "unsorted",
    "vg-game",
    "hivra",
    "safetube",
    "ideas",
  ]);
  await expect(stack(page, "unsorted").locator("h3")).toContainText("Not sorted yet");
  await expect(stack(page, "vg-game").locator("h3")).toContainText("EXO");
  await expect(stack(page, "vg-game").locator("h3")).toContainText("3 asks · 2 need you");
  await expect(stack(page, "safetube").locator("h3")).toContainText("1 ask");
  await expect(stack(page, "ideas").locator("h3")).toContainText("Ideas, for later");
  // Red first inside a stack: both of EXO's notes that wait on a Needs you item come before the one being worked on.
  const exo = stack(page, "vg-game").locator("[data-ask-note]");
  await expect(exo).toHaveCount(3);
  await expect(exo.nth(0)).toHaveAttribute("data-ask-needs", /.+/);
  await expect(exo.nth(1)).toHaveAttribute("data-ask-needs", /.+/);
  await expect(exo.nth(2)).toContainText("Move dodge to the right bumper");
  await expect(exo.nth(2)).toContainText("Working · Handed to a worker");
  // A note says what he asked in his own words, and each red count matches the project strip's.
  await expect(note(page, "The boss music in EXO is too quiet under the hits, fix that")).toContainText("Waiting on you · Which take for the boss music?");
  await expect(stack(page, "hivra").locator("[data-ask-stack-needs]")).toHaveAttribute("data-ask-stack-needs", "2");
  // The finished one is tucked away, still saying which project it was for.
  const finished = page.locator("[data-asked-finished]");
  await expect(finished.locator("summary")).toHaveText("Finished (1)");
  await expect(finished.locator("[data-ask-note]")).toBeHidden();
  await finished.locator("summary").click();
  await expect(finished.locator("[data-ask-note]")).toContainText("Done · Nibbii");
  // The list he typed stays in the one chat, with what was heard of it under it.
  await expect(oneChat(page).getByText("Heard 8 asks and 1 idea")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("board.png") });
});

test("the board: a red note opens its question where it sits, and stops waiting on him once he answers", async ({ page }) => {
  await chief(page);
  const headline = note(page, "Pick a headline for the Hivra waitlist");
  await expect(headline).toHaveAttribute("data-ask-needs", "question:hivra:waitlist-headline");
  await headline.locator("[data-ask-answer]").click();
  const card = headline.locator("[data-ask-card]");
  await expect(card).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("question.png") });
  await card.getByRole("button", { name: /Your agents, one captain/ }).click();
  // The question leaves Needs you, and the note says what he answered instead of "Waiting on you".
  await expect(headline).toHaveAttribute("data-asked-status", "heard");
  await expect(headline).toContainText("Open · Answered: Your agents, one captain. Hivra lead has it.");
  await expect(headline.locator("[data-ask-card]")).toHaveCount(0);
  await expect(stack(page, "hivra").locator("[data-ask-stack-needs]")).toHaveAttribute("data-ask-stack-needs", "1");
  await page.screenshot({ path: test.info().outputPath("answered.png") });
});

test("the board: an ask no project claims is placed with one tap, and stays there", async ({ page }) => {
  await chief(page);
  const spam = "Find out why our sign-in emails land in spam";
  await expect(stack(page, "unsorted").locator("[data-ask-note]").filter({ hasText: spam })).toContainText("Waiting on you · Which project is this for?");
  await note(page, spam).locator("[data-ask-place]").click();
  const menu = page.locator("[data-ask-place-menu]");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
  for (const name of ["EXO", "Hivra", "Nibbii", "SafeTube"]) await expect(menu.getByRole("menuitemradio", { name, exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("place.png") });
  await menu.locator('[data-ask-place-in="safetube"]').click();
  await expect(menu).toHaveCount(0);
  const placed = stack(page, "safetube").locator("[data-ask-note]").filter({ hasText: spam });
  await expect(placed).toContainText("Open · You put it under SafeTube.");
  await expect(stack(page, "unsorted").locator("[data-ask-note]")).toHaveCount(1);
  // A maybe is settled where it sits.
  const maybe = note(page, "And the pricing thing from Friday's call");
  await expect(maybe).toContainText("Maybe an ask");
  await maybe.getByRole("button", { name: /^It is an ask/ }).click();
  await expect(maybe).toHaveAttribute("data-asked-status", "heard");
  // It is kept in the app's own store: opening the app again (on Home, or on the chat it was left on) finds it where he
  // put it.
  await page.goto(`${base}/mockup.html?lists=side`);
  const board = page.locator("[data-ask-board]");
  await expect(board.or(page.locator("[data-home]")).first()).toBeVisible({ timeout: 60_000 });
  if (!(await board.isVisible())) await page.locator("[data-chief-pinned] button").first().click();
  await expect(stack(page, "safetube").locator("[data-ask-note]").filter({ hasText: spam })).toBeVisible();
});

test("the board: a list typed into the one chat lands as notes under its projects and brings the board into view", async ({ page }) => {
  await chief(page);
  await tab(page, "needs").click();
  await expect(tab(page, "needs")).toHaveAttribute("aria-selected", "true");
  const box = page.locator("textarea[placeholder^='Ask, build']:visible");
  // Three asks: a list worth a receipt (one or two short asks are heard quietly, hooks/useAskLedger.ts).
  await box.fill("Example: add a pause button to SafeTube. Make the EXO menu music loop properly. Also I wonder if we should do stickers.");
  await box.press("Enter");
  await expect(tab(page, "asked")).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
  // Each line under the project its words name, and the one that names none on top.
  await expect(stack(page, "safetube").locator("[data-ask-note]").filter({ hasText: "add a pause button to SafeTube" })).toBeVisible();
  await expect(stack(page, "vg-game").locator("[data-ask-note]").filter({ hasText: "Make the EXO menu music loop properly" })).toBeVisible();
  await expect(stack(page, "unsorted").locator("[data-ask-note]").filter({ hasText: "Also I wonder if we should do stickers" })).toBeVisible();
  await expect(oneChat(page).locator("[data-ask-receipt]").last()).toContainText("Heard 3 asks", { timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath("typed.png") });
});

test("the board: with the lists as buttons above the chat, You asked opens the same board", async ({ page }) => {
  await chief(page, "?reset");
  await page.locator('[data-chief-chip="asked"]').click();
  await expect(page.locator("[data-ask-board]")).toBeVisible();
  await expect(page.locator("[data-ask-stack]")).toHaveCount(5);
  // A note's smaller actions show while the pointer is on it.
  const dodge = note(page, "Move dodge to the right bumper");
  await dodge.hover();
  await expect(dodge.getByRole("button", { name: /^Quote in the chat/ })).toBeVisible();
  await expect(dodge.getByRole("button", { name: /^Open the work on/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("chips.png") });
  // Quote puts the note in the chat's box, not sent: his words, where it stands, and where it came from.
  await dodge.getByRole("button", { name: /^Quote in the chat/ }).click();
  await expect(page.locator("textarea[placeholder^='Ask, build']:visible")).toHaveValue(
    /^> You asked: Move dodge to the right bumper\. \(Working · Handed to a worker: [^\n]+\)\n> Source: ask [^\n]+\n\n$/,
  );
});
