import { expect, test, type Page } from "@playwright/test";

// Ash, 13 Nov: "there's a lot of ones that I can't actually tick as done ... when they resolve, they can just go into
// their own pile that is like out of the way", and a question he never answered must not be retired by an async result.
// Example data only. Never Ash's chats.
//
// The page (quiet-ask.html) is the Inbox's Needs you list and its card. This seeds one row that already finished (the
// app's own record, `monocode:needs-finished`) and one question still open (a first mate's decision), then walks the two
// things a person does: open the folded line, and let the question go from its row.
test.use({ viewport: { width: 1100, height: 700 } });

const FOLDER = "/Users/example/Projects/vg-game";
const QUESTION = "Example: which of the two takes goes in the trailer?";
const FINISHED = "Example: rename the pricing heading";
const DECISIONS_KEY = "monocode:dev-decisions";
const FINISHED_KEY = "monocode:needs-finished";

async function open(page: Page): Promise<void> {
  await page.addInitScript(
    ({ folder, question, finished, decisionsKey, finishedKey }) => {
      const now = Date.now();
      localStorage.setItem("monocode.colorScheme", "dark");
      localStorage.setItem(
        "monocode:dev-local-hub:projects",
        JSON.stringify({ projects: [{ id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder }] }),
      );
      localStorage.setItem(
        decisionsKey,
        JSON.stringify([
          {
            project: folder,
            decisionKey: "take",
            question,
            options: ["Take A", "Take B"],
            recommended: "Take A",
            askedBy: "exo-lead-chat",
            askedByMono: null,
            waiting: [],
            state: "open",
            createdAt: now - 60 * 60_000,
            updatedAt: now - 60 * 60_000,
            version: 1,
          },
        ]),
      );
      localStorage.setItem(
        finishedKey,
        JSON.stringify([
          {
            key: "question:old-take",
            kind: "question",
            sentence: finished,
            who: "EXO lead",
            reason: "answered",
            at: now - 2 * 60 * 60_000,
          },
        ]),
      );
    },
    { folder: FOLDER, question: QUESTION, finished: FINISHED, decisionsKey: DECISIONS_KEY, finishedKey: FINISHED_KEY },
  );
  await page.goto("/tests/browser/quiet-ask.html?local");
  await expect(page.locator("[data-let-go-need]")).toHaveCount(1, { timeout: 30_000 });
}

test("finished rows sit behind one folded line that opens in place", async ({ page }) => {
  await open(page);
  const toggle = page.locator("[data-finished-toggle]");
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toContainText("Finished");
  await expect(toggle).toContainText("1");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-finished-need]")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const row = page.locator("[data-finished-need]");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(FINISHED);
  await expect(row).toContainText("Answered: EXO lead has it.");
});

test("a question he cannot tick done is finished from its own row", async ({ page }) => {
  await open(page);
  await page.locator("[data-let-go-need]").click();
  // The row is gone from the flow, and it is in the Finished pile with its reason.
  await expect(page.locator("[data-let-go-need]")).toHaveCount(0);
  const toggle = page.locator("[data-finished-toggle]");
  await expect(toggle).toContainText("2");
  await toggle.click();
  await expect(page.locator("[data-finished-need]")).toHaveCount(2);
  await expect(page.locator("[data-finished-need]").first()).toContainText("You let it go.");
});
