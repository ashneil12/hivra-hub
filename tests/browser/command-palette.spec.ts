import { expect, test } from "@playwright/test";

// WP-93. The palette lists every command, ranks as the person types, runs the
// command through the handler its shortcut already uses, and keeps what was
// used. The fixture wires the real registry and runner the way App does.
test.use({ viewport: { width: 960, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/command-palette.html");
  await page.evaluate(() => localStorage.removeItem("monocode.commandPalette"));
});

test("opens on the shortcut, ranks a typed query and runs New chat", async ({ page }, testInfo) => {
  await page.locator("body").click();
  await page.keyboard.press("Meta+Shift+P");

  const palette = page.getByRole("dialog", { name: "Command Palette" });
  await expect(palette).toBeVisible();
  const field = palette.getByRole("textbox", { name: "Command Palette" });
  await expect(field).toBeFocused();

  // An empty query is every command in groups, each with its current chord.
  await expect(palette.locator("[data-command-group]").first()).toBeVisible();
  await expect(
    palette.getByRole("option", { name: /Reload/ }).locator("kbd"),
  ).toHaveText("⌘⇧R");
  // A command with no shortcut of its own shows no chord.
  await expect(
    palette.getByRole("option", { name: "New chat" }).locator("kbd"),
  ).toHaveCount(0);

  await field.fill("> new chat");
  const newChat = palette.getByRole("option", { name: "New chat" });
  await expect(newChat).toBeVisible();
  await expect(palette.getByRole("option").first()).toHaveAccessibleName(/New chat/);
  await page.screenshot({ path: testInfo.outputPath("command-palette.png") });

  await newChat.click();
  await expect(palette).toHaveCount(0);
  await expect(page.locator("[data-runs]")).toHaveText("app:new-chat");
});

test("remembers the last commands used and shows them first on an empty query", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command Palette" });
  const field = palette.getByRole("textbox", { name: "Command Palette" });
  await field.fill("> settings");
  await palette.getByRole("option", { name: /^Settings/ }).click();
  await expect(palette).toHaveCount(0);
  await expect(page.locator("[data-runs]")).toHaveText("app:settings");

  await page.keyboard.press("Meta+Shift+P");
  await expect(palette.locator("[data-command-group]").first()).toHaveText("Recent");
  await expect(palette.getByRole("option").first()).toContainText("Settings");

  // A pick lasts for its query, so the same query opens on it the next time.
  await field.fill("> settings");
  await expect(palette.getByRole("option").first()).toContainText("Settings");

  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(page.locator("[data-runs]")).toHaveText("app:settings");
});

test("greys a command it cannot run, says why, and never runs it", async ({ page }) => {
  await page.getByRole("button", { name: "Close the project" }).click();
  await page.keyboard.press("Meta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("textbox", { name: "Command Palette" }).fill("> new terminal");

  const row = palette.locator('[data-command-label="New terminal"]');
  await expect(row).toHaveAttribute("aria-disabled", "true");
  await expect(row).toContainText("Open a project first");
  // aria-disabled leaves the row clickable, so force the click: the guard that
  // matters is in the palette, not in the browser.
  await row.click({ force: true });
  await expect(palette).toBeVisible();
  await expect(page.locator("[data-runs]")).toHaveText("");
});

test("says so when nothing matches, and never throws", async ({ page }) => {
  await page.keyboard.press("Meta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("textbox", { name: "Command Palette" }).fill("> zzzz");
  await expect(page.getByText("No matching commands")).toBeVisible();
  await expect(palette.getByRole("option")).toHaveCount(0);
});
