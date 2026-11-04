import { expect, test } from "@playwright/test";

test("the crew, a decision, a failure, and one digest an hour", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp15-crew.html");
  const crew = page.getByRole("tab", { name: "Crew" });
  await expect(crew).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Explorer" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Changes" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "History" })).toBeVisible();

  const row = (id: string) => page.locator(`[data-crew-row='${id}']`);
  await expect(row("working")).toContainText("working");
  await expect(row("needs")).toContainText("needs you");
  await expect(row("done")).toContainText("done");
  await expect(row("failed")).toContainText("failed");
  await expect(row("paused")).toContainText("paused");
  await expect(row("working")).toContainText("claude");
  await expect(row("working")).toContainText("opus");
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

  await page.getByRole("button", { name: "An hour passes" }).click();
  await expect(page.locator("[data-digest]")).toHaveCount(1);
  await expect(page.locator("[data-digest]")).not.toContainText("Ship it now?");
  await expect(page.locator("[data-digest]")).not.toContainText("needs you");
  await page.getByRole("button", { name: "An hour passes" }).click();
  await expect(page.locator("[data-digest]")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("digest.png") });

  await page.getByRole("button", { name: "Ship it" }).click();
  await expect(row("needs")).toContainText("working");
  await expect(row("needs")).not.toContainText("needs you");

  const windowBefore = await page.locator("[data-window]").getAttribute("data-window");
  await page.getByRole("button", { name: "A quiet hour" }).click();
  await expect(page.locator("[data-digest]")).toHaveCount(0);
  await expect(page.locator("[data-window]")).toHaveAttribute("data-window", windowBefore ?? "");
});
