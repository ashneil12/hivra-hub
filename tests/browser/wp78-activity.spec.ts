import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp78-activity.html";

test("lists newest first and links the chat and the pull request", async ({ page, browserName }) => {
  await page.goto(pageUrl);
  const log = page.locator("#log");
  const items = log.getByRole("listitem");
  await expect(items.first()).toContainText("Pushed 100%_done.");
  await expect(items.nth(1)).toContainText("Opened a pull request into main.");
  await expect(items.nth(2)).toContainText("Merged acme/web#7.");
  await expect(items.nth(3)).toContainText("Pushed work.");
  await expect(log.getByText("note:not-a-url")).toBeVisible();
  await expect(log.getByRole("link", { name: "Pushed 100%_done." })).toHaveCount(0);

  if (browserName === "chromium") {
    await log.screenshot({ path: "tests/browser/wp78-activity.png" });
  }

  await log.getByRole("button", { name: "Merged acme/web#7." }).click();
  await expect(page.locator("#opened")).toHaveText("lead-1");
  const link = log.getByRole("link", { name: "Opened a pull request into main." });
  await expect(link).toHaveAttribute("rel", "noreferrer");
  await expect(link).toHaveAttribute("href", "https://github.com/acme/web/pull/3");
});

test("filters by project, agent and kind, and a percent sign is not a wildcard", async ({ page }) => {
  await page.goto(pageUrl);
  const log = page.locator("#log");

  await log.getByRole("textbox", { name: "Project" }).fill("other");
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await expect(log.getByRole("listitem")).toContainText("Opened a pull request into main.");

  await log.getByRole("textbox", { name: "Project" }).fill("");
  await log.getByRole("textbox", { name: "Agent" }).fill("Ada");
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await expect(log.getByRole("listitem")).toContainText("Merged acme/web#7.");

  await log.getByRole("textbox", { name: "Agent" }).fill("");
  await log.getByRole("textbox", { name: "Kind" }).fill("git.push");
  await expect(log.getByRole("listitem")).toHaveCount(2);

  await log.getByRole("textbox", { name: "Kind" }).fill("");
  await log.getByRole("textbox", { name: "Search" }).fill("100%_done");
  await expect(log.getByRole("listitem")).toHaveCount(1);
  await expect(log.getByRole("listitem")).toContainText("Pushed 100%_done.");

  await log.getByRole("textbox", { name: "Search" }).fill("100X_done");
  await expect(log.getByText("Nothing matches.")).toBeVisible();
});

test("says when nothing is recorded", async ({ page }) => {
  await page.goto(pageUrl);
  const empty = page.locator("#empty");
  await expect(empty.getByText("Nothing has been recorded yet.")).toBeVisible();
  await empty.getByRole("textbox", { name: "Project" }).fill("missing");
  await expect(empty.getByText("Nothing matches.")).toBeVisible();
});
