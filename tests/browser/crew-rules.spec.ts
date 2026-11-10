import { expect, test } from "@playwright/test";

test("crew rules can be ordered, and a plugin rule stays underneath", async ({ page }) => {
  await page.goto("/tests/browser/crew-rules.html");
  await expect(page.getByText("With nothing else set, work uses Claude Code.")).toBeVisible();
  await expect(page.getByText("From a plugin")).toBeVisible();
  await expect(page.locator("[data-plugin-rule] button")).toHaveCount(0);

  await page.getByRole("button", { name: "A Mono" }).click();
  await expect(page.getByLabel("Mono")).toBeVisible();
  await page.getByRole("button", { name: "This project" }).click();
  await expect(page.getByLabel("Mono")).toHaveCount(0);

  await page.getByLabel("Labels for a new rule").fill("docs");
  await page.getByLabel("CLI for a new rule").selectOption("cursor");
  await page.getByLabel("Task ceiling for a new rule").fill("10");
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByLabel("Task ceiling for rule 1")).toHaveValue("10");
  await expect(page.getByText("It never raises a ceiling already set.")).toBeVisible();
  await page.getByLabel("Labels for a new rule").fill("backend");
  await page.getByLabel("CLI for a new rule").selectOption("codex");
  await page.getByRole("button", { name: "Add rule" }).click();

  await expect(page.getByLabel("Labels for rule 1")).toHaveValue("docs");
  await expect(page.getByLabel("Labels for rule 2")).toHaveValue("backend");
  await page.getByRole("button", { name: "Move rule 2 up" }).click();
  await expect(page.getByLabel("Labels for rule 1")).toHaveValue("backend");
  await expect(page.getByLabel("Labels for rule 2")).toHaveValue("docs");
  await expect(page.getByLabel("Task ceiling for rule 2")).toHaveValue("10");
  await expect(page.getByLabel("Task ceiling for rule 1")).toHaveValue("");
  await page.getByRole("button", { name: "Remove rule 2" }).click();
  await expect(page.getByLabel("Labels for rule 1")).toHaveValue("backend");
  await expect(page.getByLabel("Task ceiling for rule 1")).toHaveValue("");
  await expect(page.getByLabel("Labels for rule 2")).toHaveCount(0);
  await expect(page.getByText("From a plugin")).toBeVisible();
});
