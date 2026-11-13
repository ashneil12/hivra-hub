import { expect, test, type Page } from "@playwright/test";

const LINE = "Changes to keys, permissions, the sandbox, billing, migrations, CI or installers always get the full checks.";
const ADD_MORE = "Add more paths to a project's protected list.";

const protectedLine = (page: Page) => page.locator("[data-testing-mode-protected]");
// The toggle reads "More" while it is closed and "Less" while it is open (SettingRow), so it is found by either word.
const more = (page: Page) => protectedLine(page).getByRole("button", { name: /^(More|Less)$/ });

test("the protected-paths line sits under the mode list in Test at ship, with More closed", async ({ page }) => {
  await page.goto("/tests/browser/sensitive-paths.html");
  await expect(page.getByRole("radio", { name: "Test at ship", exact: true })).toBeChecked();
  await expect(protectedLine(page).getByText(LINE, { exact: true })).toBeVisible();
  const groupBox = await page.getByRole("radiogroup", { name: "How tasks are tested" }).boundingBox();
  const lineBox = await protectedLine(page).boundingBox();
  expect(groupBox).not.toBeNull();
  expect(lineBox).not.toBeNull();
  expect(lineBox!.y).toBeGreaterThanOrEqual(groupBox!.y + groupBox!.height);
  await expect(more(page)).toHaveText("More");
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(ADD_MORE, { exact: true })).toHaveCount(0);
});

test("More opens every built-in pattern and the add-more sentence, and closes again", async ({ page }) => {
  await page.goto("/tests/browser/sensitive-paths.html");
  await more(page).click();
  await expect(more(page)).toHaveAttribute("aria-expanded", "true");
  await expect(more(page)).toHaveText("Less");
  for (const pattern of ["**/*.pem", ".github/**", "**/migrations/**"]) {
    await expect(protectedLine(page).getByText(pattern, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(ADD_MORE, { exact: true })).toBeVisible();
  await more(page).click();
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(ADD_MORE, { exact: true })).toHaveCount(0);
});

test("More is reachable from the keyboard and toggles with Enter and Space", async ({ page }) => {
  await page.goto("/tests/browser/sensitive-paths.html");
  await more(page).focus();
  await expect(more(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(more(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText(ADD_MORE, { exact: true })).toBeVisible();
  await page.keyboard.press(" ");
  await expect(more(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(ADD_MORE, { exact: true })).toHaveCount(0);
});

test("No testing removes the line, and picking a mode again brings it back", async ({ page }) => {
  await page.goto("/tests/browser/sensitive-paths.html");
  await page.getByRole("radio", { name: "No testing", exact: true }).check();
  await expect(page.getByRole("radio", { name: "No testing", exact: true })).toBeChecked();
  await expect(protectedLine(page)).toHaveCount(0);
  await expect(page.getByText(LINE, { exact: true })).toHaveCount(0);
  await page.getByRole("radio", { name: "Test at ship", exact: true }).check();
  await expect(protectedLine(page).getByText(LINE, { exact: true })).toBeVisible();
});

test("the line and More fit a 390px wide screen without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/tests/browser/sensitive-paths.html");
  await expect(protectedLine(page).getByText(LINE, { exact: true })).toBeVisible();
  await more(page).click();
  await expect(page.getByText(ADD_MORE, { exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
