import { expect, test } from "@playwright/test";
import { openLocalHub } from "./localHub";

// G10: in the hub's Inbox a first mate's decision is one row of the Needs you list, answered there, and the first-mate
// panel under it keeps only its results and failures. Example data only. Run with -c tests/browser/inbox-one-list.config.ts.
const FOLDER = "/Users/example/Projects/vg-game";
const PALETTE = "Example: Which palette for the menu?";
const SHIP = "Example: Ship it now?";

test.use({ viewport: { width: 1440, height: 900 } });

test("a first mate's decision shows once in the Inbox and is answered from its Needs you row", async ({ page }) => {
  const now = Date.now();
  const row = (id: string, title: string, status: string, patch: Record<string, unknown> = {}) => ({
    id,
    project: FOLDER,
    title,
    status,
    childSession: null,
    ownerSession: "lead-session",
    createdAt: now - 60_000,
    updatedAt: now,
    ...patch,
  });
  const decision = (key: string, question: string, options: string[], recommended: string | null, ago: number) => ({
    project: FOLDER,
    decisionKey: key,
    question,
    options,
    recommended,
    askedBy: "lead-session",
    askedByMono: null,
    waiting: [],
    state: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: now - ago,
    updatedAt: now - ago,
    version: 1,
  });
  await page.addInitScript(
    ({ rows, decisions, delivery }) => {
      // Seeded once per page, so a reload keeps what the app wrote.
      if (localStorage.getItem("monocode:dev-decisions") !== null) return;
      localStorage.setItem("monocode:dev-delegations", JSON.stringify(rows));
      localStorage.setItem("monocode:dev-decisions", JSON.stringify(decisions));
      localStorage.setItem("monocode:dev-deliveries", JSON.stringify([delivery]));
    },
    {
      rows: [
        row("done", "Ship the menu", "done", { settledAt: now }),
        row("failed", "Save the game", "failed", { statusNotice: "The save did not finish.", error: "at save.ts:10" }),
      ],
      decisions: [
        decision("ship", SHIP, ["Ship it", "Wait"], "Ship it", 5 * 60_000),
        decision("palette", PALETTE, ["Warm", "Cool", "Mono"], null, 2 * 60_000),
      ],
      delivery: { delegationId: "done", state: "open", url: "https://github.com/example/vg-game/pull/12", number: 12, updatedAt: now },
    },
  );
  await openLocalHub(page);
  await expect(page.locator("[data-hub-strip]")).toBeVisible({ timeout: 60_000 });
  // The project's lead chat puts the Inbox on the project's folder, where the first mate's decisions live.
  await page.locator("[data-hub-strip]").getByRole("button", { name: /^EXO/ }).first().click();
  await page.getByRole("button", { name: /^EXO lead/ }).first().click();
  await page.getByRole("button", { name: /^Inbox/ }).first().click();

  const inbox = page.getByRole("region", { name: "Inbox" });
  const needs = inbox.getByRole("region", { name: "Needs you" });
  const palette = needs.locator("[data-inbox-need][data-decision-key='palette']");
  await expect(palette.getByRole("button", { name: "Cool", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(inbox.locator("[data-inbox-kind=failure]")).toContainText("The save did not finish.", { timeout: 30_000 });
  await expect(inbox.locator("[data-inbox-kind=review]")).toContainText("Ship the menu");

  // Each decision once: its Needs you row, never a second card or a digest line under the list.
  await expect(inbox.getByText(PALETTE)).toHaveCount(1);
  await expect(inbox.getByText(SHIP)).toHaveCount(1);
  await expect(inbox.locator("[data-inbox-kind=decision]")).toHaveCount(0);
  await expect(palette).toContainText("Open the chat");
  await expect(needs.locator("[data-inbox-need][data-decision-key='ship']")).toContainText("Recommended");

  // Answered from the row: the store holds the answer and the row leaves the list.
  await palette.getByRole("button", { name: "Cool", exact: true }).click();
  await expect(inbox.getByText(PALETTE)).toHaveCount(0, { timeout: 15_000 });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("monocode:dev-decisions") ?? "[]"));
  expect(stored.find((entry: { decisionKey: string }) => entry.decisionKey === "palette")).toMatchObject({
    state: "answered",
    answer: "Cool",
  });
  await expect(inbox.getByText(SHIP)).toHaveCount(1);
});
