import { expect, test, type Page } from "@playwright/test";
import { openLocalHub } from "./localHub";

// WP-21: pin, mute and edit live on the real rail's existing menu, not a second list.
test.use({ viewport: { width: 1440, height: 900 } });

const EXO = "/Users/example/Projects/vg-game";

const rail = (page: Page) => page.locator("[data-mono-rail]").first();
const row = (page: Page, name: string) =>
  rail(page).locator("[data-mono-status]").filter({
    has: page.locator("[data-mono-primary-name]", { hasText: new RegExp(`^${name}$`) }),
  });

test("pin, mute and edit profile from a Mono's menu", async ({ page }) => {
  await page.addInitScript((folder) => {
    localStorage.setItem(
      "monocode:dev-roster-seed",
      JSON.stringify([
        {
          id: "milo",
          name: "Milo",
          role: "Notes",
          mascot: "crab",
          color: "hsl(142 55% 50%)",
          projects: [folder],
        },
        {
          id: "ada",
          name: "Ada",
          role: "Design review",
          mascot: "dino",
          color: "hsl(211 92% 62%)",
          projects: [folder],
        },
      ]),
    );
  }, EXO);
  await openLocalHub(page);
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await expect(rail(page)).toBeVisible({ timeout: 60_000 });
  await expect(row(page, "Ada")).toBeVisible({ timeout: 30_000 });

  await row(page, "Ada").hover();
  await rail(page).locator('button[aria-label="Ada options"]').click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(rail(page).locator("[data-mono-primary-name]").first()).toHaveText("Ada");

  await row(page, "Ada").hover();
  await rail(page).locator('button[aria-label="Ada options"]').click();
  await page.getByRole("menuitem", { name: "Mute", exact: true }).click();
  await expect(row(page, "Ada").locator("[data-mono-unread]")).toHaveCount(0);
  await row(page, "Ada").hover();
  await rail(page).locator('button[aria-label="Ada options"]').click();
  await expect(page.getByRole("menuitem", { name: "Unmute", exact: true })).toBeVisible();

  await page.getByRole("menuitem", { name: "Edit profile", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Mono name" });
  await name.fill("Ada L");
  await name.press("Enter");
  await expect(row(page, "Ada L")).toBeVisible();
  await expect(row(page, "Milo")).toBeVisible();
});
