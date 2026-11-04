import { expect, test } from "@playwright/test";

test("the Monos list and its menu", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp21-monos.html");
  const list = page.locator("[data-mono-contacts]");
  const row = (name: string) =>
    list.locator("[data-contact]").filter({
      has: page.locator("[data-contact-name]", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }),
    });
  const menu = (name: string) => page.getByRole("button", { name: `Menu for ${name}`, exact: true });

  await expect(row("Ada")).toBeVisible();
  const names = list.locator("[data-contact-name]");
  await expect(names.first()).toHaveText("Ada");
  await expect(row("Ada").locator("[data-contact-title]")).toHaveText("Design review");
  await expect(row("Ada").locator("[data-contact-last]")).toHaveText("The screen is too crowded.");
  await expect(row("Ada").locator("[data-contact-unread]")).toHaveText("2");
  await expect(row("Milo").locator("[data-contact-last]")).toHaveText("Nothing new.");
  await expect(row("Milo").locator("[data-contact-unread]")).toHaveCount(0);
  await expect(row("Milo").locator("[data-contact-title]")).toHaveText("Notes");
  await page.screenshot({ path: testInfo.outputPath("list.png") });

  await menu("Ada").click();
  await page.getByRole("menuitem", { name: "Mute", exact: true }).click();
  await expect(row("Ada").locator("[data-contact-unread]")).toHaveCount(0);
  await expect(row("Ada")).toBeVisible();

  await menu("Ada").click();
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(row("Ada copy")).toBeVisible();
  await expect(row("Ada")).toBeVisible();
  await expect(row("Ada copy").locator("[data-contact-last]")).toHaveText("No messages yet");

  await menu("Ada").click();
  await page.getByRole("menuitem", { name: "Edit profile", exact: true }).click();
  await page.locator("[data-edit-profile]").locator("input").first().fill("Ada L");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(row("Ada L")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("menu.png") });

  await menu("Milo").click();
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await expect(row("Milo")).toHaveCount(0);
  await expect(row("Ada L")).toBeVisible();

  await page.getByRole("button", { name: "New Mono" }).click();
  await page.getByRole("button", { name: "New from scratch" }).click();
  await expect(list.locator("[data-contact]")).toHaveCount(3);

  await page.getByRole("button", { name: "New Mono" }).click();
  await page.getByRole("button", { name: "New from Design review" }).click();
  await expect(row("Design review")).toBeVisible();
  await expect(row("Design review").locator("[data-contact-title]")).toHaveText("Looks at a screen and ranks what to fix.");
});
