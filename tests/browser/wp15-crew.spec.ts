import { expect, test } from "@playwright/test";

const START = 1_700_000_000_000;

test("the crew, a decision, a failure, and one digest an hour", async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date(START) });
  await page.goto("/tests/browser/wp15-crew.html");
  const crew = page.getByRole("tab", { name: "Crew" });
  await expect(crew).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Explorer" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Changes" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "History" })).toHaveCount(0);

  const row = (id: string) => page.locator(`[data-crew-row='${id}']`);
  await expect(row("working")).toContainText("working");
  await expect(row("needs")).toContainText("needs you");
  await expect(row("done")).toContainText("done");
  await expect(row("failed")).toContainText("failed");
  await expect(row("paused")).toContainText("paused");
  await expect(row("working")).toContainText("claude");
  await expect(row("working")).toContainText("opus");
  // WP-141: the reason the crew picked a worker shows on its row, and only there.
  await expect(row("working").locator("[data-crew-why]")).toHaveText("Builder role prefers Codex.");
  await expect(row("done").locator("[data-crew-why]")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __crewCommands: string[] }).__crewCommands))
    .toContain("delegations_list_open");
  await page.screenshot({ path: testInfo.outputPath("crew.png") });

  await expect(page.locator("[data-recommended]")).toContainText("Recommended");
  await expect(page.locator("[data-immediate]")).toContainText("Ship it now?");
  await expect(page.locator("[data-digest]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("inbox.png") });

  const failure = page.locator("[data-failure]");
  await expect(failure).toContainText("The save did not finish.");
  await expect(failure).not.toContainText("sk-");
  await expect(failure).not.toContainText("at save");
  await page.screenshot({ path: testInfo.outputPath("failure.png") });

  await page.clock.fastForward("01:00:00");
  await expect(page.locator("[data-digest]")).toHaveCount(1);
  await expect(page.locator("[data-digest]")).not.toContainText("Ship it now?");
  await expect(page.locator("[data-digest]")).not.toContainText("needs you");
  await page.clock.fastForward("01:00:00");
  await expect(page.locator("[data-digest]")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("digest.png") });

  await page.getByRole("button", { name: "Ship it" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __crewCommands: string[] }).__crewCommands))
    .toContain("decisions_answer");
  await expect(row("needs")).toContainText("working");
  await expect(row("needs")).not.toContainText("needs you");

  const windowBefore = await page.evaluate(() => {
    const raw = localStorage.getItem("hivra.crewDigest");
    const parsed = raw ? (JSON.parse(raw) as { lastDigestAt?: unknown }) : null;
    return typeof parsed?.lastDigestAt === "number" ? parsed.lastDigestAt : null;
  });
  await page.getByRole("button", { name: "A quiet hour" }).click();
  await page.clock.fastForward("01:00:00");
  await expect(page.locator("[data-digest]")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("hivra.crewDigest");
        const parsed = raw ? (JSON.parse(raw) as { lastDigestAt?: unknown }) : null;
        return typeof parsed?.lastDigestAt === "number" ? parsed.lastDigestAt : null;
      }),
    )
    .toBe(windowBefore);
});
