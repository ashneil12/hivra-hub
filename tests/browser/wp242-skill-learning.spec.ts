import { expect, test } from "@playwright/test";

// WP-242. Settings > Memory: "Learn skills" is Automatic unless set; the person picks Ask first or Off, the choice is
// kept after a reload, and the health card says how many lessons were left out. Example data at the review size. Shots
// are chromium only.
test.use({ viewport: { width: 1440, height: 900 } });

const SHOTS = "docs/hivra/work/shots/wp-242";
const KEY = "monocode.skillLearning";

test("before: Settings > Memory had no skill learning switch", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp242-skill-learning.html?before");
  await expect(page.locator("[data-health-last-run]")).toBeVisible();
  await expect(page.locator("[data-skill-learning]")).toHaveCount(0);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: `${SHOTS}/before/memory-settings.png` });
});

test("the person chooses how skills are learned, and the choice is kept", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp242-skill-learning.html");
  await page.evaluate((key) => localStorage.removeItem(key), KEY);
  await page.reload();
  const group = page.getByRole("radiogroup", { name: "Learn skills" });
  await expect(group).toBeVisible();
  const option = (label: string) => group.getByRole("radio", { name: new RegExp(`^${label}`) });

  // Automatic is the default.
  await expect(option("Automatic")).toBeChecked();
  await expect(page.getByText("names, email addresses, home folder paths and account numbers are taken out")).toBeVisible();
  const shoot = testInfo.project.name === "chromium";
  if (shoot) await page.screenshot({ path: `${SHOTS}/after/automatic.png` });

  await option("Ask first").check();
  await expect(option("Ask first")).toBeChecked();
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toContain("ask");

  await option("Off").check();
  await page.reload();
  await expect(option("Off")).toBeChecked();
  await expect(page.locator("[data-health-skills-dropped]")).toHaveText(
    "2 lessons were not learned, because skill learning is off.",
  );
  if (shoot) await page.screenshot({ path: `${SHOTS}/after/off.png` });
});
