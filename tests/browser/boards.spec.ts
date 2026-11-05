import fs from "node:fs";
import { expect, test } from "@playwright/test";

// WP-71. Drag, a live card, the list, the timeline, and a view that is still there after reload.
test.use({ viewport: { width: 1100, height: 720 } });
fs.mkdirSync("docs/hivra/work/shots", { recursive: true });

test("a board, a list and a timeline", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/boards.html");
  await expect(page.getByRole("button", { name: "#1 Write the notes" })).toBeVisible();

  await page.keyboard.press("c");
  await expect(page.getByLabel("Task title")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Task title")).toHaveCount(0);

  await page.getByRole("button", { name: "Board", exact: true }).click();
  const progress = page.getByRole("region", { name: "In progress" });
  await expect(progress).toBeVisible();
  await page.getByRole("button", { name: "#1 Write the notes" }).dragTo(progress);
  await expect(progress.getByRole("button", { name: "#1 Write the notes" })).toBeVisible();
  await page.screenshot({ path: `docs/hivra/work/shots/wp71-board-${testInfo.project.name}.png` });

  await page.evaluate(() => window.__hivraMove?.("agent-1", "Done"));
  await expect(page.getByRole("region", { name: "Done" }).getByRole("button", { name: "#3 Ship the board" })).toBeVisible();

  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("group", { name: "Todo" }).getByRole("button", { name: "#2 Fix the save" })).toBeVisible();
  await expect(page.getByRole("group", { name: "In progress" }).getByRole("button", { name: "#1 Write the notes" })).toBeVisible();
  await page.getByLabel("Select #1").check();
  await page.getByLabel("Select #2").check();
  await page.getByLabel("Bulk status").selectOption("Done");
  await expect(page.getByRole("group", { name: "Done" }).getByRole("button", { name: "#1 Write the notes" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Done" }).getByRole("button", { name: "#2 Fix the save" })).toBeVisible();
  await page.screenshot({ path: `docs/hivra/work/shots/wp71-list-${testInfo.project.name}.png` });

  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.locator("[data-timeline-bar='agent-1']")).toBeVisible();
  await page.screenshot({ path: `docs/hivra/work/shots/wp71-timeline-${testInfo.project.name}.png` });

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("hivra-wp71-views") ?? "")).toContain('"layout":"board"');
  await page.reload();
  await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Done" })).toBeVisible();
});
