import { expect, test } from "@playwright/test";

test("memory can be searched, edited, deleted, and a proposal accepted or rejected", async ({ page }) => {
  await page.goto("/tests/browser/wp51-memory.html");
  await expect(page.getByText("Memory could not be read this time.")).toBeVisible();
  await expect(page.getByText("Likes small commits")).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByText("Likes small commits", { exact: true })).toBeVisible();
  await expect(page.locator("[data-id]").first().locator("[data-state]")).toHaveText("Unreviewed");
  await expect(page.locator("[data-id]").first().locator("[data-source]")).toHaveText("turn-1");
  await expect(page.locator("body")).not.toContainText("sk-ant-");

  await page.getByLabel("Search memory").fill("friday");
  await expect(page.getByText("Likes small commits")).toHaveCount(0);
  await expect(page.getByText("Reviews happen on Friday", { exact: true })).toBeVisible();
  // WP-100: a person can see which engine wrote a memory.
  await expect(page.locator("[data-kind='add']", { hasText: "Reviews happen on Friday" }).locator("[data-by]")).toHaveText(
    "Written by Codex",
  );
  await expect(page.locator("[data-kind='add']", { hasText: "Reviews happen on Friday" }).locator("[data-by]")).toHaveCount(1);
  await expect(page.locator("[data-by]")).toHaveCount(1);
  await page.getByLabel("Search memory").fill("");

  await page.getByRole("button", { name: "Edit Likes small commits" }).click();
  await page.getByLabel("Memory text").fill("Likes tiny commits");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Likes tiny commits", { exact: true })).toBeVisible();
  const edited = page.locator("[data-kind='add']", { hasText: "Likes tiny commits" });
  await expect(edited.locator("[data-state]")).toHaveText("Edited");

  await page.getByRole("button", { name: "Delete Likes tiny commits" }).click();
  await expect(page.getByText("Likes tiny commits")).toHaveCount(0);

  await page.getByRole("button", { name: "Accept skill reviewing-a-diff" }).click();
  await expect(page.locator("[data-skill='reviewing-a-diff']")).toContainText("Kept as a skill");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __skills: number }).__skills)).toBe(1);
  await page.getByRole("button", { name: "Reject skill renaming-a-branch" }).click();
  await expect(page.getByText("Rename the branch before opening it.")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __skills: number }).__skills)).toBe(1);

  await page.getByRole("button", { name: "Accept import from notes" }).click();
  await expect(page.locator("[data-kind='add']", { hasText: "Decides on Tuesday" })).toBeVisible();
  await page.getByRole("button", { name: "Reject import from old" }).click();
  await expect(page.getByText("Uses tabs")).toHaveCount(0);
});

test("the memory screen can say why the last turn recalled what it did", async ({ page }) => {
  await page.goto("/tests/browser/wp51-memory.html");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Likes small commits", { exact: true })).toBeVisible();

  const why = page.locator("[data-recall-why]");
  await expect(why.locator("summary")).toHaveText("Why these were recalled");
  // Folded away until asked for.
  await expect(why.locator("p")).not.toBeVisible();
  await why.locator("summary").click();
  await expect(why.locator("p")).toBeVisible();
  await expect(why.locator("p")).toContainText("picked");
  await expect(why.locator("p")).toContainText("skipped");
  await expect(why.locator("p")).toContainText("needs review");
});
