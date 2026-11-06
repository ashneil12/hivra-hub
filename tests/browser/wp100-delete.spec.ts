import { expect, test } from "@playwright/test";

async function open(page: import("@playwright/test").Page) {
  await page.goto("/tests/browser/wp100-delete.html");
  await expect(page.getByText("Read the diff before commenting.", { exact: true })).toBeVisible();
}

test("deleting a kept skill takes its lesson out of the skill file too", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Delete Read the diff before commenting." }).click();
  await expect(page.getByText("Read the diff before commenting.", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __files: Record<string, string> }).__files["reviewing-a-diff"])).toBe("");
  await expect(page.getByText("Deleted. Its lesson is no longer in the reviewing a diff skill file.")).toBeVisible();
  await expect(page.getByText("Its change is still listed under Settings, Changes, Bot changes.")).toBeVisible();
  await expect(page.getByText("The chat it came from still has its words.")).toBeVisible();
});

test("says plainly when the skill file could not be cleared, and still deletes the fact", async ({ page }) => {
  await page.goto("/tests/browser/wp100-delete.html");
  await page.evaluate(() => {
    (window as unknown as { __refuse: boolean }).__refuse = true;
  });
  await expect(page.getByText("Read the diff before commenting.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete Read the diff before commenting." }).click();
  await expect(page.getByText("Read the diff before commenting.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Deleted here, but the reviewing a diff skill file still has that lesson.")).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __files: Record<string, string> }).__files["reviewing-a-diff"]),
  ).toContain("Read the diff before commenting.");
});

test("deleting a plain fact names the chat that still has it", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Delete Likes small commits" }).click();
  await expect(page.getByText("Likes small commits", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Deleted. The chat it came from still has its words.")).toBeVisible();
});
