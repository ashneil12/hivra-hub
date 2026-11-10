import { expect, test, type Page } from "@playwright/test";

// WP-137b on the real project rail. The page seeds recents and storage only.
// Pinned: alpha (Work), gamma (Home). Work: beta. Home: nothing else.
// Empty: nothing. Ungrouped: delta.
const seed = {
  "monocode.projectGroups": JSON.stringify([
    { id: "work", name: "Work", collapsed: false },
    { id: "home", name: "Home", collapsed: false },
    { id: "empty", name: "Empty", collapsed: false },
  ]),
  "monocode.projectGroupAssignments": JSON.stringify({
    "/work/alpha": "work",
    "/work/beta": "work",
    "/work/gamma": "home",
  }),
  "monocode.projectRailPinned": JSON.stringify(["/work/alpha", "/work/gamma"]),
};
const railKeys = [
  "monocode.projectGroups",
  "monocode.projectGroupAssignments",
  "monocode.projectRailPinned",
  "monocode.projectRailOrder",
];
const url = "/tests/browser/wp137b-project-rail.html";

async function seedStorage(page: Page, setting?: string) {
  await page.addInitScript(
    ([values, flag]) => {
      for (const [key, value] of Object.entries(values as Record<string, string>)) {
        localStorage.setItem(key, value);
      }
      if (flag) localStorage.setItem("monocode.showOnlyGroup", flag as string);
    },
    [seed, setting ?? ""] as const,
  );
}

/** Project rows in the order they sit on the rail. */
async function order(page: Page): Promise<string> {
  await expect(page.locator("[data-group-filter]")).toBeVisible();
  return page.locator("nav").first().evaluate((nav) =>
    [...nav.querySelectorAll<HTMLButtonElement>("button[title]")]
      .filter((button) => button.title.includes("\n/work/"))
      .map((button) => button.getAttribute("aria-label"))
      .join(" "),
  );
}

async function state(page: Page): Promise<string | null> {
  return page.locator("[data-group-filter]").getAttribute("data-group-filter");
}

async function railStorage(page: Page): Promise<string> {
  return page.evaluate(
    (keys) => JSON.stringify(keys.map((key) => localStorage.getItem(key))),
    railKeys,
  );
}

const setting = (page: Page) => page.getByRole("switch", { name: "Show only one group" });

test("a missing or bad setting leaves today's rail, with and without the hub list", async ({ page }) => {
  await seedStorage(page, "yes");
  await page.goto(url);
  expect(await order(page)).toBe("gamma alpha beta delta");
  expect(await state(page)).toBe("off");
  await expect(page.locator("[data-show-only-group]")).toHaveCount(0);
  await expect(setting(page)).toHaveAttribute("aria-checked", "false");

  await page.getByRole("button", { name: "Use hub list" }).click();
  await expect(page.locator("[data-hub-items]")).toBeVisible();
  expect(await order(page)).toBe("");
  await expect(page.locator("[data-project-group]")).toHaveCount(0);
  await expect(page.locator("nav")).not.toContainText(/[—–]/);
});

test("show only this group hides the others and show every project puts them back", async ({ page }) => {
  await seedStorage(page);
  await page.goto(url);
  const full = await order(page);
  expect(full).toBe("gamma alpha beta delta");
  const before = await railStorage(page);

  await setting(page).click();
  await page.locator('[data-project-group="work"] button[aria-expanded]').click();
  await page.locator('[data-project-group="work"] button[aria-expanded]').click();
  expect(await order(page)).toBe(full);
  expect(await state(page)).toBe("off");

  await page.getByRole("button", { name: "Show only this group, Work" }).click();
  expect(await order(page)).toBe("alpha beta");
  expect(await state(page)).toBe("on");
  await expect(page.locator('[data-project-group="home"]')).toHaveCount(0);
  await expect(page.locator('[data-project-group="empty"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show every project" })).toBeVisible();
  expect(await railStorage(page)).toBe(before);

  await page.getByRole("button", { name: "Show every project" }).click();
  expect(await order(page)).toBe(full);
  expect(await state(page)).toBe("off");
  expect(await railStorage(page)).toBe(before);

  await page.getByRole("button", { name: "Show only this group, Home" }).click();
  expect(await order(page)).toBe("gamma");
  await page.getByRole("button", { name: "Show every project" }).click();

  await page.getByRole("button", { name: "Show only this group, Empty" }).click();
  await expect(page.locator("[data-group-empty=empty]")).toHaveText("No projects in this group.");
  expect(await order(page)).toBe("");
  expect(await state(page)).toBe("on");
  expect(await railStorage(page)).toBe(before);
  await expect(page.locator("nav")).not.toContainText(/[—–]/);
});

test("turning the setting off puts every project back", async ({ page }) => {
  await seedStorage(page, "1");
  await page.goto(url);
  await page.getByRole("button", { name: "Show only this group, Work" }).click();
  expect(await order(page)).toBe("alpha beta");
  await setting(page).click();
  expect(await order(page)).toBe("gamma alpha beta delta");
  expect(await state(page)).toBe("off");
  await expect(page.locator("[data-show-only-group]")).toHaveCount(0);
});

test("the hub list stays while the groups are filtered", async ({ page }) => {
  await seedStorage(page, "1");
  await page.goto(url);
  await page.getByRole("button", { name: "Use hub list" }).click();
  await expect(page.locator("[data-hub-items]")).toBeVisible();
  await page.getByRole("button", { name: "Show only this group, Work" }).click();
  expect(await order(page)).toBe("alpha beta");
  await expect(page.locator("[data-hub-items]")).toBeVisible();
});

test("a missing group shows the full rail and a plain sentence", async ({ page }) => {
  await seedStorage(page, "1");
  await page.goto(url);
  await page.getByRole("button", { name: "Show only this group, Work" }).click();
  expect(await order(page)).toBe("alpha beta");

  await page.evaluate(() => (window as unknown as { removeGroup: (id: string) => void }).removeGroup("work"));
  await expect(page.getByRole("status")).toHaveText("That group is no longer there.");
  expect(await state(page)).toBe("unavailable");
  const shown = (await order(page)).split(" ").sort();
  expect(shown).toEqual(["alpha", "beta", "delta", "gamma"]);

  await page.getByRole("button", { name: "Show every project" }).click();
  expect(await state(page)).toBe("off");
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("two windows filter apart, and closing one writes nothing", async ({ page, context }) => {
  await seedStorage(page, "1");
  const other = await context.newPage();
  await page.goto(url);
  await other.goto(url);

  await page.getByRole("button", { name: "Show only this group, Work" }).click();
  expect(await order(page)).toBe("alpha beta");
  expect(await order(other)).toBe("gamma alpha beta delta");
  expect(await state(other)).toBe("off");

  const stored = await other.evaluate(() => JSON.stringify(localStorage));
  await page.close();
  expect(await other.evaluate(() => JSON.stringify(localStorage))).toBe(stored);
  expect(await order(other)).toBe("gamma alpha beta delta");

  await other.getByRole("button", { name: "Show only this group, Home" }).click();
  expect(await order(other)).toBe("gamma");
  await expect(other.locator("nav")).not.toContainText(/[—–]/);
});
