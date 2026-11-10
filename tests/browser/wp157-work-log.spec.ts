import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp157-work-log.html";

test("groups the week by day and kind, and answers today from the log", async ({ page, browserName }) => {
  await page.goto(pageUrl);
  const log = page.locator("#log");
  const days = log.locator("[data-day]");
  await expect(days).toHaveCount(2);
  await expect(days.first()).toContainText("Today, 2026-11-10");
  await expect(days.first()).toContainText("Outcomes");
  await expect(days.first()).toContainText("Done: Shipped the panel.");
  await expect(days.first()).toContainText("Decisions");
  await expect(days.nth(1)).toContainText("2026-11-09");
  await expect(log.getByText("Done: Too old for the week.")).toHaveCount(0);
  await expect(log.locator("[data-today-answer]")).toHaveText("Done: Shipped the panel.\nDone: Other project.");

  if (browserName === "chromium") {
    await log.screenshot({ path: "tests/browser/wp157-work-log.png" });
  }

  await log.getByRole("textbox", { name: "Project" }).fill("hivra");
  await expect(log.getByText("Done: Other project.")).toHaveCount(0);
  await expect(log.locator("[data-today-answer]")).toHaveText("Done: Shipped the panel.");

  await log.getByRole("button", { name: "Today" }).click();
  await expect(log.locator("[data-day]")).toHaveCount(1);
  await expect(log.getByText("Done: Wrote the log.")).toHaveCount(0);
});

test("says when nothing is written, and a miss is not an empty log", async ({ page }) => {
  await page.goto(pageUrl);
  const empty = page.locator("#empty");
  await expect(empty.getByText("Nothing has been written yet.")).toBeVisible();
  await expect(empty.locator("[data-today-answer]")).toHaveText("Nothing got done today.");
  await empty.getByRole("textbox", { name: "Project" }).fill("missing");
  await expect(empty.getByText("Nothing matches.")).toBeVisible();
});
