import { expect, test } from "@playwright/test";
import { EXAMPLE_PROJECTS, openLocalHub } from "./localHub";

// WP-94: a project with no icon of its own (the placeholder "folder" shape every project gets when nothing was chosen)
// shows two letters from its name on a tile coloured by that name, in the strip and in the project's header. A project
// that has chosen a shape keeps it. The letters and the colour are the same every time the page opens.

test.use({ viewport: { width: 1280, height: 860 } });

const PROJECTS = [
  ...EXAMPLE_PROJECTS,
  { id: "nebula", name: "Nebula", shortName: "Nebula", iconShape: "folder", folder: null },
  { id: "orchard", name: "Silver Orchard", shortName: "Orchard", iconShape: "folder", folder: null },
];

test("a project with no icon shows its name's letters on its name's colour, and keeps it", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("monocode:hub-onboarded", "1");
    localStorage.setItem("monocode:hub-setup-not-now", "1");
  });
  await openLocalHub(page, "", PROJECTS);
  const strip = page.locator("[data-hub-strip]");
  await expect(strip.getByRole("button", { name: "Nebula", exact: true })).toBeVisible({ timeout: 60_000 });

  const nebula = strip.getByRole("button", { name: "Nebula", exact: true }).locator('[data-project-glyph="monogram"]');
  const orchard = strip.getByRole("button", { name: "Silver Orchard", exact: true }).locator('[data-project-glyph="monogram"]');
  await expect(nebula).toHaveText("NA");
  await expect(orchard).toHaveText("SO");
  await expect(nebula).toHaveAttribute("data-project-monogram", "NA");
  // Each name picks its own colour, so the two tiles do not look alike.
  expect(await nebula.getAttribute("class")).not.toBe(await orchard.getAttribute("class"));

  // A project that chose a shape keeps it, and shows no letters.
  await expect(strip.getByRole("button", { name: "EXO", exact: true }).locator('[data-project-shape="gamepad"]')).toBeVisible();

  // Opening the project shows the same tile in its header.
  await strip.getByRole("button", { name: "Nebula", exact: true }).click();
  await expect(page.locator("[data-hub-project-header] [data-project-glyph='monogram']")).toHaveText("NA");

  // The colour is a property of the name, not of this visit: a reload draws the same tile.
  const before = await nebula.getAttribute("class");
  await page.reload();
  await expect(strip.getByRole("button", { name: "Nebula", exact: true })).toBeVisible({ timeout: 60_000 });
  const after = await strip
    .getByRole("button", { name: "Nebula", exact: true })
    .locator('[data-project-glyph="monogram"]')
    .getAttribute("class");
  expect(after).toBe(before);
});

test("a name that is only punctuation still draws a tile", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("monocode:hub-onboarded", "1");
    localStorage.setItem("monocode:hub-setup-not-now", "1");
  });
  await openLocalHub(page, "", [
    ...EXAMPLE_PROJECTS,
    { id: "dashes", name: "---", shortName: "Dashes", iconShape: "folder", folder: null },
  ]);
  // The tile's accessible name is the project's name, which here is only punctuation.
  const dashes = page.locator("[data-hub-strip]").getByRole("button", { name: "---", exact: true });
  await expect(dashes).toBeVisible({ timeout: 60_000 });
  await expect(dashes.locator('[data-project-glyph="monogram"]')).toHaveText("PR");
});
