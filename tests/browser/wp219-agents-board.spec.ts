import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const beforeDir = "docs/hivra/work/shots/wp-219/before";
const afterDir = "docs/hivra/work/shots/wp-219/after";

test("the agents board", async ({ page }, info) => {
  mkdirSync(beforeDir, { recursive: true });
  mkdirSync(afterDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const shoot = info.project.name === "chromium";

  await page.goto("/tests/browser/agents-page.html");
  if (shoot) await page.screenshot({ path: `${beforeDir}/agents-page.png` });

  await page.goto("/tests/browser/wp219-before-orchestration.html");
  await expect(page.getByText("Example: Fix the build")).toBeVisible();
  if (shoot) await page.screenshot({ path: `${beforeDir}/orchestration-list.png` });

  await page.addInitScript(() => localStorage.removeItem("monocode:agents-board-open"));
  await page.goto("/tests/browser/wp219-agents-board.html");
  const board = page.locator("[data-agents-board]");
  await expect(board.getByText("Example: Fix the build")).toBeVisible();
  await expect(board.getByText("Example: Read the test")).toBeVisible();
  await expect(board.getByText("3 checks failing")).toBeVisible();
  await expect(board.getByText("#217")).toBeVisible();
  await expect(board.getByText("$1.50")).toBeVisible();
  const names = await board.locator("[data-name]").allTextContents();
  for (const name of names) {
    if (name === "Chief of Staff") continue;
    expect(name.startsWith("Example:")).toBe(true);
  }
  await expect(board.getByRole("option", { name: "Hivra" })).toHaveCount(1);
  await expect(board.getByRole("option", { name: "EXO" })).toHaveCount(1);
  await expect(board.getByRole("option", { name: "Crew" })).toHaveCount(0);
  await expect(board).not.toContainText("stuck");
  await expect(board.locator("input, textarea, [contenteditable='true']")).toHaveCount(0);
  await expectChipCounts(board);
  if (shoot) await page.screenshot({ path: `${afterDir}/tree.png` });

  await board.getByLabel("Project").selectOption("hivra");
  await expect(board.getByText("Example: Look at EXO")).toHaveCount(0);
  await expect(board.getByText("Example: Home")).toHaveCount(0);
  await expect(board.getByText("Example: Fix the build")).toBeVisible();
  await expectChipCounts(board);
  const needsYou = board.getByRole("button", { name: "Needs you", exact: true });
  await expect(needsYou).toHaveAttribute("aria-pressed", "false");
  await needsYou.focus();
  await expect(needsYou).toBeFocused();
  await page.keyboard.press("Space");
  await expect(needsYou).toHaveAttribute("aria-pressed", "true");
  await expect(board.getByRole("button", { name: "Working", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(board.getByRole("button", { name: "Done today", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(board.getByText("Example: Fix the build")).toBeVisible();
  await expect(board.getByText("Example: Write the note")).toHaveCount(0);
  await needsYou.blur();
  if (shoot) await page.screenshot({ path: `${afterDir}/filter.png` });

  await board.getByRole("button", { name: "Needs you", exact: true }).click();
  await board.locator("[data-node='newer']").click();
  const chat = board.locator("[data-readonly-chat]");
  await expect(chat).toContainText("Example: The build failed on the Windows test.");
  await expect(chat.locator("input, textarea, [contenteditable='true']")).toHaveCount(0);
  await chat.getByRole("button", { name: "Stop" }).click();
  await expect(chat.getByRole("dialog", { name: "Stop this chat" })).toBeVisible();
  await expect(chat.locator("input, textarea, [contenteditable='true']")).toHaveCount(0);
  if (shoot) await page.screenshot({ path: `${afterDir}/readonly.png` });
  await chat.getByRole("button", { name: "Stop" }).click();
  await expect(chat.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(chat.getByText("Read only")).toBeVisible();
});

async function expectChipCounts(board: import("@playwright/test").Locator) {
  const needs = await board.locator("[data-state='needs-you']").count();
  const working = await board.locator("[data-state='working']").count();
  const doneToday = await board.locator("[data-done-today='true']").count();
  await expect(board.getByRole("button", { name: "Needs you", exact: true }).locator("[data-count]")).toHaveText(String(needs));
  await expect(board.getByRole("button", { name: "Working", exact: true }).locator("[data-count]")).toHaveText(String(working));
  await expect(board.getByRole("button", { name: "Done today", exact: true }).locator("[data-count]")).toHaveText(String(doneToday));
}
