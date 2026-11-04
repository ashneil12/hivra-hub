import { expect, test } from "@playwright/test";
import fs from "node:fs";

// WP-22 proof (the real room view in a browser, not Ash's Mac; made-up data labelled Example:): Ash switches a room's
// responder mode, then gives it a goal; the lead's turn ends the run on needs input, and its control block never shows.
const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/wp22";

test("switching a room's mode, then a goal run that ends on needs input", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/tests/browser/wp22-groups.html");
  const mode = page.locator("[data-hub-room-responder]");
  await expect(mode).toHaveValue("everyone", { timeout: 60_000 });
  await expect(page.locator("[data-hub-room-responder-hint]")).toContainText("The lead answers first");

  await mode.selectOption("auto");
  await expect(page.locator("[data-hub-room-responder-hint]")).toContainText("until then the lead answers");
  await mode.selectOption("mentions");
  await expect(page.locator("[data-hub-room-responder-hint]")).toContainText("Only the members you @mention answer");
  expect(await page.evaluate(() => (window as unknown as { __wp22Room: () => { responder?: string } }).__wp22Room().responder)).toBe("mentions");
  await mode.selectOption("lead");
  await expect(mode).toHaveValue("lead");
  await page.screenshot({ path: `${SHOTS}/wp22-mode.png` });

  await page.locator("[data-hub-goal-toggle]").click();
  await expect(page.locator("[data-hub-goal-hint]")).toContainText("up to 13 turns");
  const box = page.locator("textarea").last();
  await box.fill("Example: get the pricing page ready to ship");
  await box.press("Enter");

  await expect(page.locator("[data-hub-msg-system]").first()).toHaveText("Goal mode: Ada leads the room toward this goal, for up to 13 turns.");
  await expect(page.locator("[data-hub-goal-bar]")).toHaveAttribute("data-hub-goal-state", "needs_input", { timeout: 10_000 });
  await expect(page.locator("[data-hub-msg-system]").last()).toHaveText("Goal needs you: Ash picks between 9 and 12 a month.");
  await expect(page.getByText("Example: two prices are on the table, 9 or 12 a month.")).toBeVisible();
  await expect(page.getByText("room_control")).toHaveCount(0);
  await expect(page.locator("[data-hub-goal-hint]")).toHaveCount(0);
  // The waiting goal says why above the composer, with Continue and End goal.
  await expect(page.locator('[data-hub-room-strip="goal-waiting"]')).toHaveText("Goal needs you: Ash picks between 9 and 12 a month.");
  await expect(page.locator("[data-hub-goal-continue]")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/wp22-goal-needs-input.png` });
  await page.locator("[data-hub-goal-end]").click();
  await expect(page.locator("[data-hub-msg-system]").last()).toHaveText("Goal stopped: you ended it.");
  await expect(page.locator("[data-hub-goal-continue]")).toHaveCount(0);
});
