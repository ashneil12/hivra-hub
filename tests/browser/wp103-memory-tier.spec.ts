import { expect, test } from "@playwright/test";

test("the memory tier can be chosen, and is kept", async ({ page }) => {
  await page.goto("/tests/browser/wp103-memory-tier.html");

  // The three choices, in plain words, and today's behaviour is the one already picked.
  await expect(page.getByText("Rules on this Mac")).toBeVisible();
  await expect(page.getByText("Nothing leaves this Mac.")).toBeVisible();
  await expect(page.getByText("A cheap model")).toBeVisible();
  await expect(page.getByText("Your crew", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Your crew")).toBeChecked();

  // Rules sends nothing, and has no model to pick.
  await page.getByLabel("Rules on this Mac").check();
  await expect(page.getByLabel("Rules on this Mac")).toBeChecked();
  await expect(page.getByLabel("The model to use")).toHaveCount(0);

  // A reload keeps it.
  await page.reload();
  await expect(page.getByLabel("Rules on this Mac")).toBeChecked();

  // Cheap asks which model, and only then.
  await page.getByLabel("A cheap model").check();
  const picker = page.getByLabel("The model to use");
  await expect(picker).toBeVisible();
  await expect(picker.locator("option")).toHaveText(["Grok fast", "DeepSeek chat"]);
  await picker.selectOption("deepseek-def456");

  // The model is kept too, and the picker comes back on it.
  await page.reload();
  await expect(page.getByLabel("A cheap model")).toBeChecked();
  await expect(page.getByLabel("The model to use")).toHaveValue("deepseek-def456");

  // "Test this model" says in plain words whether it worked.
  await page.getByRole("button", { name: "Test this model" }).click();
  await expect(page.getByRole("status")).toHaveText("Connected, deepseek-chat replied");

  // The line about when a change starts is there throughout.
  await expect(page.getByText("A change starts with your next turn.")).toBeVisible();
});
