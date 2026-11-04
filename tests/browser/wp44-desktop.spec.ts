import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp44-desktop.html";

test("a new app asks, and allow adds it", async ({ page }) => {
  await page.goto(pageUrl);
  const on = page.locator("#on");
  await expect(on.getByText("Mail is asking to be used in this project.")).toBeVisible();
  await expect(on.getByText("In café.")).toBeVisible();
  await on.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(on.getByText("Mail is asking to be used in this project.")).toHaveCount(0);
  await expect(on.getByRole("list", { name: "Allowed apps" })).toContainText("Mail");
});

test("don't allow keeps the app off", async ({ page }) => {
  await page.goto(pageUrl);
  const on = page.locator("#on");
  await on.getByRole("button", { name: "Don't allow" }).click();
  await expect(on.getByRole("list", { name: "Refused apps" })).toContainText("Mail");
  await expect(on.getByRole("list", { name: "Allowed apps" })).not.toContainText("Mail");
});

test("visible control starts off", async ({ page }) => {
  await page.goto(pageUrl);
  const on = page.locator("#on");
  const visible = on.getByRole("switch", { name: "Allow visible control" });
  await expect(visible).toHaveAttribute("aria-checked", "false");
  await expect(
    on.getByText("Headless until you allow it. Visible control moves the pointer and takes focus."),
  ).toBeVisible();
  await visible.click();
  await expect(visible).toHaveAttribute("aria-checked", "true");
});

test("says desktop control is off", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.locator("#off")).toContainText(
    "Desktop control is off. Turn it on above. An agent cannot use an app until you do.",
  );
});

test("installs the carried desktop plugin", async ({ page }) => {
  await page.goto(pageUrl);
  await page.getByRole("button", { name: "Install desktop control" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-last-command", "desktop_control_install");
});

test("gets the desktop program", async ({ page }) => {
  await page.goto(pageUrl);
  await page.getByRole("button", { name: "Get the desktop program" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-last-command", "desktop_control_fetch");
});
