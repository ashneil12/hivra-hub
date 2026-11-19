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
  await expect(board.locator("[data-node='captain']")).toHaveAttribute("data-state", "needs-you");
  await expect(board.locator("[data-node='captain']")).toHaveAttribute("data-rolled", "true");
  await expect(board.locator("[data-node='newer']")).toHaveAttribute("data-state", "needs-you");
  await expect(board.locator("[data-node='newer']")).toHaveAttribute("data-rolled", "false");
  await expect(board.locator("[data-node='captain'] [data-chip]")).toHaveAttribute("data-rolled", "true");
  await expect(board.locator("[data-node='newer'] [data-chip]")).toHaveAttribute("data-rolled", "false");
  await expect(board.locator("[data-node='captain']")).toContainText("1 needs you below");
  await expect(board.getByText("Task", { exact: true })).toBeVisible();
  await expect(board.getByText("Cost", { exact: true })).toBeVisible();
  await expect(board.getByText("Time", { exact: true })).toBeVisible();
  await expect(board.getByText("PR", { exact: true })).toBeVisible();
  await expect(board.getByText("Checks", { exact: true })).toBeVisible();
  const taskHead = await board.locator("[data-head='task']").boundingBox();
  const taskCell = await board.locator("[data-node='home'] [data-task]").boundingBox();
  const costHead = await board.locator("[data-head='cost']").boundingBox();
  const costCell = await board.locator("[data-node='newer'] [data-cost]").boundingBox();
  expect(taskHead && taskCell && Math.abs(taskHead.x - taskCell.x)).toBeLessThan(2);
  expect(costHead && costCell && Math.abs(costHead.x + costHead.width - (costCell.x + costCell.width))).toBeLessThan(2);
  const pillWidths = await board.locator("[data-chip][data-rolled='false']").evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().width)),
  );
  expect(new Set(pillWidths).size).toBe(1);
  expect(pillWidths[0]).toBeGreaterThan(80);
  await expectCount(board, "Needs you", "1");
  await expectCount(board, "Working", "2");
  await expectCount(board, "Done today", "1");
  await expectChipCounts(board);
  if (shoot) await page.screenshot({ path: `${afterDir}/tree.png` });

  await board.getByLabel("Project").selectOption("hivra");
  await expect(board.getByText("Example: Look at EXO")).toHaveCount(0);
  await expect(board.getByText("Example: Home")).toHaveCount(0);
  await expect(board.getByText("Example: Fix the build")).toBeVisible();
  await expectCount(board, "Needs you", "1");
  await expectCount(board, "Working", "1");
  await expectCount(board, "Done today", "1");
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
  await board.locator("[data-node='newer']").getByRole("button", { name: "Open", exact: true }).click();
  await expect(board).toHaveAttribute("data-opened", "newer");
  await board.locator("[data-node='newer']").click();
  const chat = board.locator("[data-readonly-chat]");
  await expect(chat).toContainText("Example: The build failed on the Windows test.");
  await chat.getByRole("button", { name: "Open to answer" }).click();
  await expect(board).toHaveAttribute("data-opened", "newer");
  await expect(chat.locator("input, textarea, [contenteditable='true']")).toHaveCount(0);
  await chat.getByRole("button", { name: "Stop" }).click();
  await expect(chat.getByRole("dialog", { name: "Stop this chat" })).toBeVisible();
  await expect(chat.locator("input, textarea, [contenteditable='true']")).toHaveCount(0);
  if (shoot) await page.screenshot({ path: `${afterDir}/readonly.png` });
  await chat.getByRole("button", { name: "Stop" }).click();
  await expect(chat.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(chat.getByText("Stopped")).toBeVisible();
});

async function expectCount(board: import("@playwright/test").Locator, name: string, count: string) {
  await expect(board.getByRole("button", { name, exact: true }).locator("[data-count]")).toHaveText(count);
}

async function expectChipCounts(board: import("@playwright/test").Locator) {
  const needs = await board.locator("[data-state='needs-you'][data-rolled='false']").count();
  const working = await board.locator("[data-state='working'][data-rolled='false']").count();
  const doneToday = await board.locator("[data-done-today='true'][data-rolled='false']").count();
  await expectCount(board, "Needs you", String(needs));
  await expectCount(board, "Working", String(working));
  await expectCount(board, "Done today", String(doneToday));
}
