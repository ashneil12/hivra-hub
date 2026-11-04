import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

// The five hub screen ideas (research/ui-port-map.md) on the real components in a browser, with example data
// (pm-ui-ideas.tsx). One photo per idea. A browser preview only: not Ash's Mac.
const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-ui-ideas";
const shot = async (page: Page, name: string, selector?: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  const path = `${SHOTS}/${name}.png`;
  if (selector) await page.locator(selector).first().screenshot({ path });
  else await page.screenshot({ path });
};
/** A photo of the chat cut to the part that shows the idea, from one element to another (with a margin). */
const area = async (page: Page, name: string, from: string, to = from, pad = 24) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  const chat = (await page.locator("[data-proof-chat]").boundingBox())!;
  const a = (await page.locator(from).first().boundingBox())!;
  const b = (await page.locator(to).last().boundingBox())!;
  const y = Math.max(chat.y, Math.min(a.y, b.y) - pad);
  const bottom = Math.min(chat.y + chat.height, Math.max(a.y + a.height, b.y + b.height) + pad);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: chat.x, y, width: chat.width, height: bottom - y } });
};
type Proof = { setBusy(b: boolean): void; stops: string[]; sent: [string, string][] };
const proof = (page: Page) => page.evaluate(() => {
  const p = (window as unknown as { proof: Proof }).proof;
  return { stops: [...p.stops], sent: [...p.sent] };
});

test.use({ viewport: { width: 1320, height: 900 }, deviceScaleFactor: 2 });

test("the five ideas on the real components", async ({ page }) => {
  await page.goto("/tests/browser/pm-ui-ideas.html");
  const chat = page.locator("[data-proof-chat]");
  await expect(chat.locator("[data-team-report]").first()).toBeVisible({ timeout: 60_000 });

  // 5. Since you were here: once, before what came while Ash was away 4 h, as a quiet date-line.
  const since = chat.locator("[data-since-you-were-here]");
  await expect(since).toHaveCount(1);
  await expect(since).toHaveText("Since you were here: 2 replies, 2 reports");
  await since.scrollIntoViewIfNeeded();
  await area(page, "pm-ui-5-since-you-were-here", "[data-since-you-were-here]", "[data-proof-chat] [data-team-report]", 140);

  // 1. The EXO coding team's report: framed, its name on the frame's edge, folded only past the tall rule.
  const cards = chat.locator("[data-team-report]");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator("legend")).toHaveText("EXO coding team");
  await expect(cards.first().locator("[data-team-report-more]")).toHaveCount(0);
  const tall = cards.nth(1);
  await expect(tall.locator("[data-team-report-more]")).toHaveText("Show all");
  await expect(tall.locator("[data-team-report-body]")).toHaveAttribute("data-folded", "");
  const legendColor = await cards.first().locator("legend").evaluate((el) => getComputedStyle(el).color);
  console.log("legend color", legendColor);
  await tall.scrollIntoViewIfNeeded();
  await area(page, "pm-ui-1-team-report", "[data-proof-chat] [data-team-report]", "[data-proof-chat] [data-team-report]");
  await tall.locator("[data-team-report-more]").click();
  await expect(tall.locator("[data-team-report-more]")).toHaveText("Fold");
  await tall.locator("[data-team-report-more]").click();

  // 2. During a turn the empty box's send is Stop (same spot, grey), stopping only the turn; the model is text above.
  const send = chat.locator('form button[type="submit"]').last();
  const idleBox = await send.boundingBox();
  await expect(send).toHaveAttribute("aria-label", "Send");
  await page.evaluate(() => (window as unknown as { proof: Proof }).proof.setBusy(true));
  await expect(send).toHaveAttribute("aria-label", "Stop");
  const busyBox = await send.boundingBox();
  expect(busyBox).toEqual(idleBox);
  const line = chat.locator("[data-mono-model-line]");
  await expect(line).toContainText("Sonnet");
  await expect(chat.locator("[data-model-menu]")).toBeVisible();
  await area(page, "pm-ui-2-stop-and-model", "[data-proof-chat] [data-mono-pick]", '[data-proof-chat] form button[type="submit"]', 60);
  await send.click();
  expect((await proof(page)).stops).toEqual(["turn:cos-chat"]);
  await chat.getByRole("textbox").last().fill("Example: one more thing");
  await expect(send).toHaveAttribute("aria-label", "Send");
  await chat.getByRole("textbox").last().fill("");

  // 3. Needs you: why, in one plain word per row; a red line is Approve once or Deny, neither chosen.
  const needs = page.locator("[data-proof-needs]");
  await expect(needs.locator("[data-hub-waiting-reason]")).toHaveText(["sign in", "pick an option", "approve a red-line step"]);
  const approval = needs.locator("[data-hub-approval] button");
  await expect(approval).toHaveText(["Approve once", "Deny"]);
  await expect(needs.getByText(/Always allow/)).toHaveCount(0);
  expect(await page.evaluate(() => !!document.activeElement?.closest("[data-hub-approval]"))).toBe(false);
  await shot(page, "pm-ui-3-needs-you-reasons", "[data-proof-needs]");
});
