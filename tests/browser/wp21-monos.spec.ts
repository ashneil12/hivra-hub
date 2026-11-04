import { expect, test } from "@playwright/test";

// WP-21: the contacts list mounted in the real app (Classic), not the fixture page.
test.use({ viewport: { width: 1440, height: 900 } });

test("the Monos list and its menu", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("monocode.insetLayout", "0");
    // ?local copies this onto the roster (browserTauriMock). Writing the roster key itself is overwritten.
    const roster = [
      {
        id: "ada",
        name: "Ada",
        role: "Design review",
        mascot: "dino",
        color: "hsl(211 92% 62%)",
        projects: ["/work/My Project"],
        pinned: true,
      },
      {
        id: "milo",
        name: "Milo",
        role: "Notes",
        mascot: "crab",
        color: "hsl(142 55% 50%)",
        projects: [],
        muted: true,
      },
    ];
    localStorage.setItem("monocode:dev-roster-seed", JSON.stringify(roster));
  });
  await page.goto("/hub-dev.html?local");
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  const expand = page.getByRole("button", { name: "Expand projects", exact: true });
  if (await expand.isVisible().catch(() => false)) await expand.click();

  const list = page.locator("[data-mono-contacts]");
  await expect(list).toBeVisible({ timeout: 60_000 });
  const exactName = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const row = (name: string) =>
    list.locator("[data-contact]").filter({
      has: page.locator("[data-contact-name]", { hasText: exactName(name) }),
    });
  const menu = (name: string) => list.getByRole("button", { name: `Menu for ${name}`, exact: true });

  await expect(row("Ada")).toBeVisible();
  const names = list.locator("[data-contact-name]");
  await expect(names.first()).toHaveText("Ada");
  await expect(row("Ada").locator("[data-contact-title]")).toHaveText("Design review");
  await expect(row("Ada").locator("[data-contact-last]")).toHaveText("No messages yet");
  await expect(row("Ada").locator("[data-contact-unread]")).toHaveCount(0);
  await expect(row("Milo").locator("[data-contact-last]")).toHaveText("No messages yet");
  await expect(row("Milo").locator("[data-contact-unread]")).toHaveCount(0);
  await expect(row("Milo").locator("[data-contact-title]")).toHaveText("Notes");
  await page.screenshot({ path: testInfo.outputPath("list.png") });

  await menu("Ada").click();
  await page.getByRole("menuitem", { name: "Mute", exact: true }).click();
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

  await list.getByRole("button", { name: "New Mono" }).click();
  await list.getByRole("button", { name: "New from scratch" }).click();
  await expect(list.locator("[data-contact]")).toHaveCount(3);

  await list.getByRole("button", { name: "New Mono" }).click();
  await list.getByRole("button", { name: "New from Design review" }).click();
  await expect(row("Design review")).toBeVisible();
  await expect(row("Design review").locator("[data-contact-title]")).toHaveText("Looks at a screen and ranks what to fix.");
});
