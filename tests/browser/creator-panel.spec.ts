import { expect, test } from "@playwright/test";

test("a panel is built, previewed, kept, undone and discarded", async ({ page }) => {
  await page.goto("/tests/browser/creator-panel.html");
  await expect(page.locator("[data-app-source]")).toHaveText("app source");
  await page.getByLabel("What should it do?").fill("Ship the panel");
  await page.getByRole("button", { name: "Build" }).click();

  const frame = page.frameLocator("iframe");
  await expect(frame.locator("p")).toHaveText("Ship the panel");
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.locator("[data-creator-status]")).toHaveText("Drafted. Nothing is installed yet.");

  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator("[data-creator-status]")).toHaveText("Only this view can see it.");
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(page.locator("[data-creator-status]")).toHaveText("Kept.");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("[data-creator-status]")).toHaveText("Rolled back.");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator("[data-creator-status]")).toHaveText("The scratch folder is gone.");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("[data-app-source]")).toHaveText("app source");
});

test("an MCP server does not run until it is allowed", async ({ page }) => {
  await page.goto("/tests/browser/creator-panel.html?server=1");
  await page.getByLabel("What should it do?").fill("Ship the panel");
  await page.getByRole("button", { name: "Build" }).click();
  await expect(page.getByText("This server doesn't run until you allow it.")).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(page.locator("[data-creator]")).toHaveAttribute("data-phase", "previewed");
  await page.getByRole("button", { name: "Allow this server" }).click();
  await expect(page.getByText("This server doesn't run until you allow it.")).toHaveCount(0);
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(page.locator("[data-creator-status]")).toHaveText("Kept.");
});

test("a setup step waits for an OK", async ({ page }) => {
  await page.goto("/tests/browser/creator-panel.html?script=1");
  await page.getByLabel("What should it do?").fill("Ship the panel");
  await page.getByRole("button", { name: "Build" }).click();
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: "Keep" }).click();
  await expect(page.getByText("It wants to run a setup step, so it is waiting for your OK.")).toBeVisible();
  await expect(page.locator("[data-creator]")).toHaveAttribute("data-phase", "previewed");
});
