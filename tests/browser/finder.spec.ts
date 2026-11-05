import { expect, test } from "@playwright/test";

// WP-74. ⌘K finds a task, a doc, a Mono and a message, and opens each.
test.use({ viewport: { width: 960, height: 800 } });

test("finder opens a task, a doc, a Mono and a message", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/finder.html");
  await expect(page.getByRole("button", { name: "#1 Fix the notes" })).toBeVisible();

  await page.getByLabel("Terminal").focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Finder" })).toHaveCount(0);

  await page.keyboard.press("Meta+k");
  const finder = page.getByRole("dialog", { name: "Finder" });
  await expect(finder).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(finder).toHaveCount(0);

  await page.getByRole("heading", { name: "Tasks" }).click();
  await page.keyboard.press("Control+k");
  await expect(finder).toBeVisible();
  await finder.getByRole("textbox", { name: "Finder" }).fill("notes");
  await expect(finder.getByRole("option", { name: "Fix the notes" })).toBeVisible();
  await expect(finder.getByRole("option", { name: "Notes page" })).toBeVisible();
  await expect(finder.getByRole("option", { name: "Notes keeper" })).toBeVisible();
  await expect(finder.getByRole("option", { name: "Chat about notes" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("finder.png") });
  await page.screenshot({ path: "docs/hivra/work/WP-74-finder.png" });

  await finder.getByRole("option", { name: "Fix the notes" }).click();
  await expect(page.getByRole("article", { name: "Task 1" })).toBeVisible();
  await expect(page.getByText("Save the notes")).toBeVisible();

  await page.keyboard.press("Control+k");
  await finder.getByRole("textbox", { name: "Finder" }).fill("notes");
  await finder.getByRole("option", { name: "Notes page" }).click();
  await expect(page.locator("[data-block-id='block-9'] textarea")).toHaveValue("Write the notes");

  await page.keyboard.press("Control+k");
  await finder.getByRole("textbox", { name: "Finder" }).fill("notes");
  await finder.getByRole("option", { name: "Notes keeper" }).click();
  await expect(page.locator("[data-open-mono]")).toHaveText("Notes keeper");

  await page.keyboard.press("Control+k");
  await finder.getByRole("textbox", { name: "Finder" }).fill("notes");
  await finder.getByRole("option", { name: "Chat about notes" }).click();
  await expect(page.locator("[data-message-id='msg-1']")).toHaveAttribute("data-highlighted", "true");
});
