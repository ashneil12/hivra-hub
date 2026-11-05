import { expect, test } from "@playwright/test";

const CREW = "Crew rules still send `frontend` work to Sonnet 5.";

test("the three places show what is in force, and clearing falls back", async ({ page }) => {
  await page.goto("/tests/browser/wp89-worker-default.html");
  const system = page.locator('[data-worker-default="system"]');
  const mono = page.locator('[data-worker-default="mono"]');
  const project = page.locator('[data-worker-default="project"]');
  const line = (scope: ReturnType<typeof page.locator>) => scope.locator("[data-worker-default-line]");

  await expect(page.getByRole("heading", { name: "Default for every worker" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model for its workers" })).toBeVisible();
  await expect(line(system)).toHaveText("Its workers use the usual model.");
  await expect(line(mono)).toHaveText(`Its workers use the usual model. ${CREW}`);
  await expect(line(project)).toHaveText(`Its workers use the usual model. ${CREW}`);

  await system.getByLabel("Model", { exact: true }).selectOption("claude:opus-4-7");
  await system.getByLabel("Effort", { exact: true }).selectOption("high");
  const everywhere = "Its workers use Opus 4.7 at high effort (set for every worker).";
  await expect(line(system)).toHaveText(everywhere);
  await expect(line(mono)).toHaveText(`${everywhere} ${CREW}`);
  await expect(line(project)).toHaveText(`${everywhere} ${CREW}`);

  await project.getByLabel("CLI").selectOption("cursor");
  await project.getByLabel("Model for its workers").selectOption("cursor:composer");
  const forProject = `Its workers use Composer on Cursor at medium effort (set for this project). ${CREW}`;
  await expect(line(project)).toHaveText(forProject);
  await expect(line(mono)).toHaveText(`${everywhere} ${CREW}`);

  await project.getByRole("button", { name: "Use the default" }).click();
  await expect(line(project)).toHaveText(`${everywhere} ${CREW}`);

  await mono.getByLabel("Model", { exact: true }).selectOption("claude:sonnet-5");
  const forMono = `Its workers use Sonnet 5 at low effort (set for this Mono). ${CREW}`;
  await expect(line(mono)).toHaveText(forMono);
  await expect(line(project)).toHaveText(forMono);
  await expect(line(system)).toHaveText(everywhere);

  await mono.getByRole("button", { name: "Use the default" }).click();
  await expect(line(mono)).toHaveText(`${everywhere} ${CREW}`);
  await expect(line(project)).toHaveText(`${everywhere} ${CREW}`);

  await system.getByRole("button", { name: "Use the default" }).click();
  await expect(line(system)).toHaveText("Its workers use the usual model.");
  await expect(line(mono)).toHaveText(`Its workers use the usual model. ${CREW}`);
  await expect(line(project)).toHaveText(`Its workers use the usual model. ${CREW}`);

  await expect(page.locator("[data-launched-ran]")).toHaveText(
    "Runs on Claude Code, Opus 4.7, High effort (set for every worker)",
  );
  await expect(page.locator("[data-launched-model]")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Undone" })).toBeVisible();
  await expect(line(system)).toHaveText(everywhere);
});
