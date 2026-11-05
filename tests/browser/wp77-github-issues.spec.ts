import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp77-github-issues.html";

test("the switch starts off, on the hivra label, and turning it on asks to save", async ({ page }) => {
  await page.goto(pageUrl);
  const toggle = page.getByRole("switch", { name: "Take GitHub issues labelled hivra" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("textbox", { name: "Label", exact: true })).toHaveValue("hivra");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("body")).toHaveAttribute("data-last-command", "github_issues_setting_set");
  await expect(page.getByText("acme/web", { exact: true })).toBeVisible();
});

test("a linked task shows its issue, the read-only line, the paused badge and the crew pull request", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByRole("link", { name: "https://github.com/acme/web/issues/7" })).toBeVisible();
  await expect(page.getByText("This task's title and description are read-only while it is linked to GitHub.")).toBeVisible();
  await expect(page.getByText("GitHub sync paused")).toBeVisible();
  const links = page.getByRole("region", { name: "GitHub links" });
  await expect(links.getByRole("link", { name: "Crew" })).toHaveAttribute("href", "https://github.com/acme/web/pull/4");
  await expect(links.getByText("https://github.com/acme/web/issues/7")).toHaveCount(0);
});

test("a late reply for the previous project does not overwrite the current one", async ({ page }) => {
  await page.goto(pageUrl);
  await page.getByRole("button", { name: "Slow project" }).click();
  await page.getByRole("button", { name: "Other project" }).click();
  await expect(page.getByText("This project is off.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Label", exact: true })).toHaveValue("other");
  await expect(page.getByRole("switch", { name: "Take GitHub issues labelled other" })).toHaveAttribute("aria-checked", "false");
  await page.evaluate(() => (window as unknown as { releaseStale: () => void }).releaseStale());
  await expect(page.getByRole("switch", { name: "Take GitHub issues labelled other" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("textbox", { name: "Label", exact: true })).toHaveValue("other");
  await expect(page.getByText("This project is off.")).toBeVisible();
  await expect(page.getByText("Stale note.")).toHaveCount(0);
  await expect(page.getByText("acme/old")).toHaveCount(0);
});

test("a label edit and the switch do not share one version", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByRole("switch", { name: "Take GitHub issues labelled hivra" })).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { holdSaves: boolean }).holdSaves = true;
  });
  const label = page.getByRole("textbox", { name: "Label", exact: true });
  await label.fill("bugs");
  await label.blur();
  await page.getByRole("switch", { name: "Take GitHub issues labelled bugs" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-pending-saves", "1");
  await page.evaluate(() => (window as unknown as { releaseOneSave: () => void }).releaseOneSave());
  await expect(page.locator("body")).toHaveAttribute("data-pending-saves", "1");
  await expect(page.locator("body")).toHaveAttribute("data-pending-expected", "1");
  await page.evaluate(() => (window as unknown as { releaseOneSave: () => void }).releaseOneSave());
  await expect(page.locator("body")).toHaveAttribute("data-pending-saves", "0");
  await expect(page.getByRole("switch", { name: "Take GitHub issues labelled bugs" })).toHaveAttribute("aria-checked", "true");
  await expect(label).toHaveValue("bugs");
  await expect(page.getByText("That changed. Showing the latest.")).toHaveCount(0);
});

test("a label edit does not turn the switch back off", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByRole("switch", { name: "Take GitHub issues labelled hivra" })).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { holdSaves: boolean }).holdSaves = true;
  });
  await page.getByRole("switch", { name: "Take GitHub issues labelled hivra" }).click();
  const label = page.getByRole("textbox", { name: "Label", exact: true });
  await label.fill("bugs");
  await label.blur();
  await expect(page.locator("body")).toHaveAttribute("data-pending-saves", "1");
  await page.evaluate(() => (window as unknown as { releaseOneSave: () => void }).releaseOneSave());
  await expect(page.locator("body")).toHaveAttribute("data-pending-saves", "1");
  await expect(page.locator("body")).toHaveAttribute("data-pending-expected", "1");
  await page.evaluate(() => (window as unknown as { releaseOneSave: () => void }).releaseOneSave());
  await expect(page.locator("body")).toHaveAttribute("data-pending-saves", "0");
  await expect(page.getByRole("switch", { name: "Take GitHub issues labelled bugs" })).toHaveAttribute("aria-checked", "true");
  await expect(label).toHaveValue("bugs");
});

test("a rejected save is not followed by a queued overwrite", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByRole("switch", { name: "Take GitHub issues labelled hivra" })).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { holdSaves: boolean }).holdSaves = true;
  });
  const label = page.getByRole("textbox", { name: "Label", exact: true });
  await label.fill("bugs");
  await label.blur();
  await page.getByRole("switch", { name: "Take GitHub issues labelled bugs" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-pending-saves", "1");
  await page.evaluate(() => (window as unknown as { bumpSaved: () => void }).bumpSaved());
  await page.evaluate(() => (window as unknown as { releaseOneSave: () => void }).releaseOneSave());
  await expect(page.locator("body")).toHaveAttribute("data-pending-saves", "0");
  await expect(page.getByText("That changed. Showing the latest.")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Take GitHub issues labelled hivra" })).toHaveAttribute("aria-checked", "false");
  await expect(label).toHaveValue("hivra");
});
