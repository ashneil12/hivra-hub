import fs from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PROOFS = "docs/hivra/work/proofs/wp-182";

async function shot(page: Page, info: TestInfo, name: string) {
  if (info.project.name !== "chromium") return;
  fs.mkdirSync(PROOFS, { recursive: true });
  await page.screenshot({ path: `${PROOFS}/${name}.png`, fullPage: true });
}

test("the card's sections, fast mode, skills and the worker line", async ({ page }, info) => {
  await page.setViewportSize({ width: 960, height: 900 });
  await page.goto("/tests/browser/mono-card.html");
  const card = page.locator("[data-mono-card='ada']");
  const section = (id: string) => card.locator(`[data-mono-card-section="${id}"]`);

  for (const id of ["role", "runs", "workers", "fallback", "skills"]) {
    await expect(section(id)).toHaveAttribute("aria-expanded", "false");
  }
  await expect(section("role")).toContainText("Role");
  await expect(section("runs")).toContainText("Runs on");
  await expect(section("workers")).toContainText("Its workers");
  await expect(section("fallback")).toContainText("Fallback");
  await expect(section("fallback")).toContainText("Not set up yet.");
  await expect(section("skills")).toContainText("Skills and commands");
  await shot(page, info, "sections");

  await section("runs").click();
  const runs = card.locator("[data-mono-card-runs]");
  await expect(runs.getByRole("switch", { name: "Fast" })).toBeVisible();
  await shot(page, info, "runs-fast");

  await runs.getByLabel("Model").selectOption("claude:sonnet-plain");
  await expect(runs.getByRole("switch", { name: "Fast" })).toHaveCount(0);
  await shot(page, info, "runs-no-fast");

  await runs.getByLabel("Model").selectOption("claude:opus-fast");
  await runs.getByRole("switch", { name: "Fast" }).click();
  await expect.poll(async () => page.evaluate(() => {
    const roster = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { id: string; engineFast?: boolean }[];
    return roster.find((mono) => mono.id === "ada")?.engineFast ?? null;
  })).toBe(true);
  await shot(page, info, "runs-fast-on");

  await section("skills").click();
  await expect(card.getByText("not installed here")).toBeVisible();
  await card.getByRole("checkbox", { name: "Skills grill-me" }).check();
  await expect(card.getByRole("checkbox", { name: "Skills grill-me" })).toBeChecked();
  await expect(card.getByRole("checkbox", { name: "Skills tdd" })).not.toBeChecked();
  await expect(card.getByRole("checkbox", { name: "Commands ship" })).toBeVisible();
  await shot(page, info, "skills");

  await section("workers").click();
  await expect(card.locator("[data-worker-default-line]")).toBeVisible();
  await expect(card.locator("[data-worker-default-line]")).toContainText("usual model");
  await shot(page, info, "workers");

  await section("fallback").click();
  await expect(card.locator("[data-mono-card-fallback]")).toHaveText("Not set up yet.");
  await shot(page, info, "fallback");
});

test("a command from the slash catalog can be picked without injected offers", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 900 });
  await page.goto("/tests/browser/mono-card.html?catalog=1");
  const card = page.locator("[data-mono-card='ada']");
  await card.locator('[data-mono-card-section="skills"]').click();
  await expect(card.getByRole("checkbox", { name: "Commands ship" })).toBeVisible();
});
