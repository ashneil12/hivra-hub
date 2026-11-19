import { expect, test, type Page } from "@playwright/test";

// Gap A7 (formal/asks/README.md): an ask of Ash's that two daily checks found with nothing moved is one Needs you row,
// with a card that offers Answer it, Let it go and Remind the first mate. Example data only. Never Ash's chats.
//
// The page (quiet-ask.html) is the Inbox's Needs you list and its card, mounted the way InboxView mounts them in the Hub
// bundle (the full Inbox only renders with the Hub flag, which the default browser config doesn't set), on the app's own
// ask ledger kept in this page's localStorage (`monocode:dev-local-hub:asks`, seeded here already raised). The daily check
// that raises an ask, the reminder's send and the row's removal on a status change are unit tested (askQuiet.test.ts,
// useAskLedger.quiet.test.ts, needsLive.quietAsk.test.ts); this proves what a person sees and taps.
test.use({ viewport: { width: 1100, height: 700 } });

const FOLDER = "/Users/example/Projects/vg-game";
const WORDS = "Example: make sure the build runs on a small laptop before Friday";
const CHAT = "quiet-chat-exo";
const ASKS_KEY = "monocode:dev-local-hub:asks";
const DAY = 24 * 60 * 60_000;

async function open(page: Page): Promise<{ askedAt: number }> {
  const askedAt = Date.now() - 3 * DAY;
  await page.addInitScript(
    ({ folder, words, chat, key, asked }) => {
      // Seeded once per page, so a reload keeps what the app wrote.
      if (localStorage.getItem(key) !== null) return;
      const now = Date.now();
      localStorage.setItem("monocode.colorScheme", "dark");
      localStorage.setItem(
        "monocode:dev-local-hub:projects",
        JSON.stringify({ projects: [{ id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder }] }),
      );
      localStorage.setItem(
        "monocode:dev-roster-seed",
        JSON.stringify([
          {
            id: "vg-game-lead",
            name: "EXO lead",
            mascot: "invader",
            mascotPicked: true,
            color: "hsl(211 92% 62%)",
            projects: [folder],
            engine: "claude",
            sessionId: "quiet-chat-home",
            projectSessions: { "vg-game": chat },
          },
        ]),
      );
      localStorage.setItem(
        key,
        JSON.stringify({
          next: 2,
          since: now - 10 * 24 * 60 * 60_000,
          heard: {},
          nudged: { "vg-game-lead": now - 3 * 60 * 60_000 },
          asks: [
            {
              id: "ask-1-quiet-block",
              n: 1,
              mateId: "vg-game-lead",
              sessionId: chat,
              blockId: "quiet-block",
              quote: words,
              summary: "Check the build on a small laptop",
              kind: "do",
              status: "heard",
              heardBy: "model",
              createdAt: asked,
              updatedAt: asked,
              history: [{ at: asked, status: "heard", by: "app" }],
              chase: { at: asked, checks: 2, raisedAt: now - 3 * 60 * 60_000 },
            },
          ],
        }),
      );
    },
    { folder: FOLDER, words: WORDS, chat: CHAT, key: ASKS_KEY, asked: askedAt },
  );
  await page.goto("/tests/browser/quiet-ask.html?local");
  await expect(page.locator("[data-inbox-need='ask']")).toHaveCount(1, { timeout: 30_000 });
  return { askedAt };
}

type Ledger = { asks: Array<{ status: string; history: Array<{ status: string; by: string }>; chase?: { checks: number; raisedAt?: number; remindAt?: number } }> };

/** The ledger as the app wrote it back. */
async function ledger(page: Page): Promise<Ledger> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}") as Ledger, ASKS_KEY);
}

const rowOf = (page: Page) => page.locator("[data-inbox-need='ask']");
const cardOf = (page: Page) => page.locator("[data-need-detail]");

async function openCard(page: Page) {
  await rowOf(page).getByRole("button").first().click();
  await expect(cardOf(page)).toBeVisible();
}

test("a quiet ask is one Needs you row, in plain words, and opens its own card with its answers", async ({ page }) => {
  await open(page);
  const row = rowOf(page);
  // The row: the red dot and the kind, the ask in its own words, how long it has been open, who has it, how many answers.
  await expect(page.locator("[data-inbox-needs]")).toHaveAttribute("data-inbox-needs", "1");
  await expect(row).toContainText("You asked: " + WORDS);
  await expect(row.locator("[data-need-line]")).toHaveText(/^Still open since (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\. EXO lead hasn't moved it\.$/);
  await expect(row.locator("[data-need-summary]")).toHaveText("EXO lead · 3 answers");
  await expect(row.locator("span[aria-hidden]").first()).toHaveCSS("background-color", "rgb(255, 107, 107)");
  const rowText = (await row.innerText()).replace(/\s+/g, " ");
  expect(rowText).not.toMatch(/\bStuck\b/);
  expect(rowText).not.toMatch(/[—–]/);

  // The card, beside the list: the title, the quiet line, the answers lettered, a box.
  await openCard(page);
  const card = cardOf(page);
  await expect(card.locator("[data-need-kind]")).toHaveText("Ask");
  await expect(card.locator("[data-need-sentence]")).toHaveText("You asked: " + WORDS);
  await expect(card.locator("[data-need-line]")).toHaveText(/^Still open since \w+day\. EXO lead hasn't moved it\.$/);
  await expect(card.locator("[data-need-choice]")).toHaveText(["aAnswer it", "bLet it go", "cRemind EXO lead"]);
  await expect(card.getByRole("textbox", { name: "Reply to EXO lead" })).toBeVisible();
  const cardText = (await card.innerText()).replace(/\s+/g, " ");
  expect(cardText).not.toMatch(/\bStuck\b/);
  expect(cardText).not.toMatch(/[—–]/);
  // Nothing has been changed by looking.
  const after = await ledger(page);
  expect(after.asks[0].status).toBe("heard");
  expect(after.asks[0].chase?.raisedAt).toBeDefined();
});

test("Answer it opens the chat that asked, on the message that asked, and the row stays until the first mate moves it", async ({ page }) => {
  const { askedAt } = await open(page);
  await openCard(page);
  await cardOf(page).locator("[data-need-choice='a']").click();
  const opened = await page.evaluate(() => (window as unknown as { __quiet: { seen: { opened: unknown[] } } }).__quiet.seen.opened);
  expect(opened).toEqual([{ kind: "chat", id: CHAT, projectId: "vg-game" }]);
  const asked = await page.evaluate((chat) => (window as unknown as { __quiet: { asked: (id: string) => unknown } }).__quiet.asked(chat), CHAT);
  expect(asked).toEqual({ text: WORDS, at: askedAt });
  // The card is as it was: no "Sent", every answer still there, and the ask untouched.
  await expect(cardOf(page).locator("[data-need-choices]")).toHaveAttribute("data-need-choices", "idle");
  await expect(cardOf(page).locator("[data-need-choice-state]")).toHaveCount(0);
  await expect(rowOf(page)).toHaveCount(1);
  expect((await ledger(page)).asks[0].status).toBe("heard");
});

test("Let it go drops the ask as the person's own word, and the row goes", async ({ page }) => {
  await open(page);
  await openCard(page);
  await cardOf(page).locator("[data-need-choice='b']").click();
  // The row leaves the list at once; the card's place says what happened.
  await expect(page.locator("[data-need-answered]")).toHaveText("Let go. It is off your list.");
  await expect(rowOf(page)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await ledger(page)).asks[0].status).toBe("dropped");
  expect((await ledger(page)).asks[0].history.at(-1)).toMatchObject({ status: "dropped", by: "ash" });
});

test("Remind queues one reminder for the first mate, takes the row away and starts the count again", async ({ page }) => {
  await open(page);
  await openCard(page);
  await cardOf(page).locator("[data-need-choice='c']").click();
  await expect(page.locator("[data-need-answered]")).toHaveText("Reminded EXO lead.");
  await expect(rowOf(page)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await ledger(page)).asks[0].chase?.remindAt).toBeDefined();
  const asked = (await ledger(page)).asks[0];
  expect(asked.status).toBe("heard");
  expect(asked.chase).toMatchObject({ checks: 0 });
  expect(asked.chase?.raisedAt).toBeUndefined();
});

test("the box sends a few words to the chat that asked, and answers the ask", async ({ page }) => {
  await open(page);
  await openCard(page);
  const card = cardOf(page);
  await card.getByRole("textbox", { name: "Reply to EXO lead" }).fill("Example: yes, the old laptop is the one to check");
  await card.getByRole("button", { name: "Send" }).click();
  await expect(rowOf(page)).toHaveCount(0, { timeout: 15_000 });
  const sent = await page.evaluate(() => (window as unknown as { __quiet: { seen: { sent: unknown[] } } }).__quiet.seen.sent);
  expect(sent).toEqual([[CHAT, "Example: yes, the old laptop is the one to check"]]);
  await expect.poll(async () => (await ledger(page)).asks[0].chase?.raisedAt).toBeUndefined();
  expect((await ledger(page)).asks[0].status).toBe("heard");
});
