import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp86-attribution.html";

test("shows a task's commits, the activity line, and who made a pull request", async ({ page, browserName }) => {
  await page.goto(pageUrl);
  const task = page.locator("#task");
  await expect(task.getByRole("region", { name: "Commits" })).toBeVisible();
  await expect(task.getByText("Stamp the trailer")).toBeVisible();
  await expect(task.getByText("2 files, 10 lines")).toBeVisible();
  await expect(task.getByText("sk-ant-api03-SECRETVALUE")).toHaveCount(0);

  const log = page.locator("#log");
  await expect(log.getByText("commit by Ada for Fix the gate")).toBeVisible();
  await expect(log.locator("[data-activity-row='commit-1']")).toContainText("· Commit ·");

  const pr = page.locator("#pr");
  await expect(pr.getByRole("region", { name: "Who made this" })).toBeVisible();
  await expect(pr.getByText("Agents")).toBeVisible();
  await expect(pr.getByText("Ada")).toBeVisible();
  await expect(pr.getByText("Tasks")).toBeVisible();
  await expect(pr.getByText("Fix the gate")).toBeVisible();

  if (browserName === "chromium") {
    await page.locator("#page").screenshot({ path: "tests/browser/wp86-attribution.png" });
  }
});
