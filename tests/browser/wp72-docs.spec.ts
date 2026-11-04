import { expect, test } from "@playwright/test";
import fs from "node:fs";

// WP-72: a nested page, the slash menu, a task mention and a restored version.
// The fixture is the docs screen on the in-memory store. No app window is launched.

const SHOTS = "docs/hivra/work/proofs/wp-72";

test("create a nested page, mention a task, and restore an older version", async ({ page }, testInfo) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.clock.install({ time: new Date("2026-11-04T12:00:00Z") });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto("/tests/browser/wp72-docs.html");

  await page.getByRole("button", { name: "New page" }).click();
  await page.getByRole("button", { name: "Add page inside" }).click();
  const editor = page.locator("[data-block-editor] textarea").first();
  await editor.focus();
  await editor.fill("/");
  await page.getByRole("button", { name: "Heading", exact: true }).click();
  await editor.fill("Hello");
  await page.keyboard.press("Enter");
  await page.keyboard.type("@");
  await page.getByRole("button", { name: "Write the spec" }).click();
  await page.clock.fastForward(250);
  await expect(page.locator("[data-docs-root]")).toHaveAttribute("data-doc-versions", "1");

  await page.keyboard.type("Changed");
  await page.clock.fastForward(250);
  await expect(page.locator("[data-docs-root]")).toHaveAttribute("data-doc-versions", "2");

  await page.getByRole("button", { name: "History" }).click();
  await page.locator('[data-doc-version="1"]').getByRole("button", { name: "Restore" }).click();
  await expect(page.locator("[data-block-editor]")).toContainText("Hello");
  await expect(page.locator("[data-block-editor]")).not.toContainText("Changed");
  await expect(page.locator("[data-docs-root]")).toHaveAttribute("data-doc-versions", "3");
  await expect(page.locator("[data-parent-id]").nth(1)).not.toHaveAttribute("data-parent-id", "");

  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}.png`, fullPage: true });
});
