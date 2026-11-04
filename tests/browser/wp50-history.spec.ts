import { expect, test } from "@playwright/test";

test("a preview stays a count, then a run drafts a sourced line", async ({ page }) => {
  await page.goto("/tests/browser/wp50-history.html");
  const claude = page.getByRole("checkbox", { name: "Claude Code" });
  const codex = page.getByRole("checkbox", { name: "Codex" });
  const hermes = page.getByRole("checkbox", { name: "Hermes" });
  await expect(claude).not.toBeChecked();
  await expect(codex).not.toBeChecked();
  await expect(hermes).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Run" })).toBeDisabled();

  await claude.check();
  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.locator("[data-preview]");
  await expect(preview).toContainText("1 conversation");
  await expect(preview).toContainText("3 Jan 2026");
  await expect(preview.locator("[data-project='notes']")).toHaveText("notes");
  await expect(page.locator("body")).not.toContainText("I like small commits");
  await expect(page.locator("body")).not.toContainText("sk-ant-");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __historyReads: number }).__historyReads)).toBe(0);

  await expect(page.getByRole("button", { name: "Run" })).toBeEnabled();
  await expect(page.getByText("This uses your signed-in CLI, unless you pick a model.")).toBeVisible();
  await expect(page.getByText("Add a model in Other models first.")).toHaveCount(0);

  await page.locator("[data-add-model]").click();
  await page.getByLabel("Model").selectOption("local");
  await expect(page.locator("[data-estimate]")).toContainText("tokens at most");
  await expect(page.locator("[data-estimate]")).toContainText("no model fee");

  await page.getByRole("button", { name: "Run" }).click();
  const proposal = page.locator("[data-proposal]");
  await expect(proposal).toContainText("[src: sess-1 #m1]");
  await expect(page.locator("[data-result]")).toContainText("Not applied");
  await expect(page.locator("body")).not.toContainText("No citation");
  await expect(page.locator("body")).not.toContainText("sk-ant-");
  await expect(page.locator("body")).not.toContainText("I like small commits");
});
