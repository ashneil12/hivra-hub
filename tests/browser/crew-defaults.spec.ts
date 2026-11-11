import { expect, test } from "@playwright/test";

test("crew defaults shows the lock, the roles, the lists and what is in force", async ({ page }) => {
  await page.goto("/tests/browser/crew-defaults.html");
  await expect(page.getByRole("heading", { name: "Crew defaults" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "For this project" })).toBeChecked();
  await page.getByRole("radio", { name: "For everything" }).check();
  await expect(page.getByRole("radio", { name: "For everything" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "For this project" })).not.toBeChecked();
  await expect(page.getByRole("heading", { name: "Default for every worker" })).toBeVisible();
  await expect(page.getByLabel("Builder CLI")).toBeVisible();
  await expect(page.getByLabel("Reviewer CLI")).toBeVisible();
  await expect(page.getByLabel("Researcher CLI")).toBeVisible();
  await expect(page.locator("[data-crew-defaults-line]")).toHaveText("Its workers use the usual model.");

  await page.getByLabel("Builder CLI").selectOption("codex");
  await expect(page.locator("[data-crew-defaults-line]")).toHaveText(
    "Its workers use the usual model. Crew rules still send `builder` work to Codex.",
  );

  await page.getByRole("switch", { name: "Always use my default" }).check();
  await expect(page.getByRole("switch", { name: "Always use my default" })).toBeChecked();

  // WP-141 HIGH 3: Never use is a picker of CLIs, so a typed name cannot be saved as one.
  await expect(page.getByLabel("Never use", { exact: true }).locator("option")).toHaveCount(12);
  await page.getByLabel("Never use", { exact: true }).selectOption("pi");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator("[data-never-use='pi']")).toBeVisible();

  await page.getByLabel("Fallback CLI").selectOption("grok");
  await page.getByRole("button", { name: "Add to fallback" }).click();
  await page.getByLabel("Fallback CLI").selectOption("claude");
  await page.getByRole("button", { name: "Add to fallback" }).click();
  await page.getByRole("button", { name: "Move Claude Code up" }).click();
  await expect(page.locator("[data-fallback]").nth(0)).toHaveAttribute("data-fallback", "claude");
  await expect(page.locator("[data-fallback]").nth(1)).toHaveAttribute("data-fallback", "grok");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.locator("[data-never-use='pi']")).toBeVisible();
  await expect(page.locator("[data-fallback]").nth(0)).toHaveAttribute("data-fallback", "claude");
  await expect(page.locator("[data-fallback]").nth(1)).toHaveAttribute("data-fallback", "grok");
});

test("crew defaults says when the saved rules could not be read, and clears it on the next save", async ({ page }) => {
  await page.goto("/tests/browser/crew-defaults.html?unreadable=1");
  const notice = page.getByRole("alert");
  await expect(notice).toHaveText("Your crew rules could not be read. Agents are held until you save them again.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(notice).toHaveCount(0);
});
