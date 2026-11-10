import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp108-usage.html";

test("shows the last 30 days by day, project and engine, without the prompt", async ({ page }) => {
  await page.goto(pageUrl);
  const usage = page.locator("#usage");

  await expect(usage.getByRole("region", { name: "Today" })).toBeVisible();
  await expect(usage.getByRole("region", { name: "Last 7 days" })).toBeVisible();
  await expect(usage.getByRole("region", { name: "Last 30 days" })).toBeVisible();
  await expect(usage.getByRole("table", { name: "By project" })).toContainText("secret-project");
  await expect(usage.getByRole("table", { name: "By project" })).toContainText("lib");
  await expect(usage.getByRole("table", { name: "By engine" })).toContainText("Claude Code");
  await expect(usage.getByRole("table", { name: "By engine" })).toContainText("Codex");
  await expect(usage.getByRole("table", { name: "By model" })).toContainText("sonnet-5");
  await expect(usage).toContainText("Cost reported for 1 of 2 turns");
  await expect(usage).toContainText("Cost not reported by this engine");
  await expect(usage).toContainText("$0.50");
  await expect(usage).not.toContainText("$0.500");
  await expect(usage.getByRole("listitem", { name: /5 Nov/ })).toBeVisible();
  await expect(usage.getByRole("button", { name: "Copy as CSV" })).toBeVisible();

  await expect(usage).not.toContainText("hunter2");
  await expect(usage).not.toContainText("must not travel");
  await expect(usage).not.toContainText("/work/");
});

test("says when there are no turns", async ({ page }) => {
  await page.goto(pageUrl);
  const empty = page.locator("#empty");
  await expect(empty.getByText("No turns in the last 30 days.")).toBeVisible();
  await expect(empty.getByText("No turns yet").first()).toBeVisible();
  await expect(empty.getByRole("button", { name: "Copy as CSV" })).toBeVisible();
});
