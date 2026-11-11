// WP-05: a fresh start offers the five starter templates, all unticked. Skip adds nobody.
// A ticked one becomes an ordinary Mono, and the template id is never that Mono's id.
import { expect, type Page } from "@playwright/test";

export const STARTER_IDS = ["coordinator", "design-review", "planner", "record-keeper", "team-steward"] as const;

const STARTER_NAMES = ["Chief of Staff", "Design review", "Planner", "Record keeper", "Team steward"] as const;

async function dismissSetup(page: Page) {
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}

const roster = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { id: string; name?: string }[]);

/** The onboarding card, on its first step. */
export async function openOnboarding(page: Page) {
  await page.goto("/hub-dev.html?onboarding");
  await expect(page.locator("[data-hub-onboarding]")).toBeVisible({ timeout: 60_000 });
  await dismissSetup(page);
}

/** The start step: five starter templates, none ticked, and no add-on. */
export async function assertStartersUnticked(page: Page) {
  await expect(page.locator("[data-hub-onboarding-team]")).toContainText("None are added unless you tick them");
  await expect(page.locator("[data-hub-onboarding-starter]")).toHaveCount(STARTER_IDS.length);
  for (const id of STARTER_IDS) {
    await expect(page.locator(`[data-hub-onboarding-starter="${id}"]`)).toHaveAttribute("aria-checked", "false");
  }
  await expect(page.locator("[data-hub-onboarding-addon]")).toHaveCount(0);
  await expect(page.getByText("Pre-load a saved team")).toHaveCount(0);
}

/** Skip with nothing ticked: the card closes and none of the five are on the roster. */
export async function skipAddsNobody(page: Page) {
  await page.locator("[data-hub-onboarding-skip]").click();
  await expect(page.locator("[data-hub-onboarding]")).toHaveCount(0);
  const names = (await roster(page)).map((mono) => mono.name);
  for (const name of STARTER_NAMES) expect(names).not.toContain(name);
}

/**
 * A second launch (the first left the roster as it was). Ticking Chief of Staff and skipping adds one ordinary Mono.
 * Its id is not the template id, and the other four stay off the roster.
 */
export async function tickedBecomesOrdinaryMono(page: Page) {
  await openOnboarding(page);
  await page.locator("[data-hub-onboarding-next]").click();
  const box = page.locator('[data-hub-onboarding-starter="coordinator"]');
  await box.click();
  await expect(box).toHaveAttribute("aria-checked", "true");
  await page.locator("[data-hub-onboarding-skip]").click();
  await expect(page.locator("[data-hub-onboarding]")).toHaveCount(0);
  const monos = await roster(page);
  const made = monos.filter((mono) => mono.name === "Chief of Staff");
  expect(made).toHaveLength(1);
  expect(made[0]?.id).not.toBe("coordinator");
  const names = monos.map((mono) => mono.name);
  for (const name of STARTER_NAMES) if (name !== "Chief of Staff") expect(names).not.toContain(name);
}
