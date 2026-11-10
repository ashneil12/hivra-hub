import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp159-programme.html";

test("groups queued, in flight, parked and failed, and hides a merged row", async ({ page }) => {
  await page.goto(pageUrl);
  const board = page.locator("#board");
  await expect(board.getByRole("heading", { name: "Programme" })).toBeVisible();
  const queued = board.locator("[data-programme-group='queued']");
  const flight = board.locator("[data-programme-group='flight']");
  const parked = board.locator("[data-programme-group='parked']");
  const failed = board.locator("[data-programme-group='failed']");
  await expect(queued).toContainText("Write the notes.");
  await expect(queued).not.toContainText("Check the diff.");
  await expect(flight).toContainText("Build the panel.");
  await expect(flight).toContainText("Open the review.");
  await expect(parked).toContainText("Wait for a look.");
  await expect(parked).toContainText("Needs a look");
  await expect(parked).toContainText("Check the diff.");
  await expect(parked).toContainText("Security check.");
  await expect(failed).toContainText("Fix the build.");
  await expect(board.getByText("Already merged.")).toHaveCount(0);
  await expect(board.locator("[data-programme-notice]")).toHaveText("That package changed. Read it again and retry.");
  await expect(queued).toContainText("Write the notes.");

  const clear = parked.getByRole("button", { name: "Clear park for Wait for a look" });
  await expect(clear).toHaveText("Clear park");
  await clear.click();
  await expect(page.locator("#cleared")).toHaveText("k:4");
  await expect(parked.getByRole("button", { name: "Clear park for Check the diff" })).toBeVisible();
  await expect(queued.getByRole("button")).toHaveCount(0);
});

test("an empty programme shows nothing", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.locator("#empty [data-programme]")).toHaveCount(0);
  await expect(page.locator("#empty")).toBeEmpty();
});
