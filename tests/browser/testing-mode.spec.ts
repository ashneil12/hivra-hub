import { expect, test, type Page } from "@playwright/test";

const WORDS = [
  { mode: "at-ship", label: "Test at ship", description: "Tasks are checked for obvious slips only; tests and review run once, when you ship." },
  { mode: "light", label: "Light tests each task", description: "Every task that changes code runs the project's tests and gets a quick review." },
  { mode: "full", label: "Full checks each task", description: "Light, plus the task's own checks, the real-app check and a second reviewer." },
  { mode: "off", label: "No testing", description: "Tasks are not tested or reviewed." },
] as const;

type Call = { command: string; args: Record<string, unknown> };

async function calls(page: Page, command: string): Promise<Call[]> {
  const all = await page.evaluate(() => (window as unknown as { __testingCalls: Call[] }).__testingCalls);
  return all.filter((call) => call.command === command);
}

test("how tasks are tested lists the four ways with their words in full and Test at ship chosen", async ({ page }) => {
  await page.goto("/tests/browser/testing-mode.html");
  const group = page.getByRole("radiogroup", { name: "How tasks are tested" });
  await expect(group).toBeVisible();
  await expect(group.getByRole("radio")).toHaveCount(4);
  for (const { mode, label, description } of WORDS) {
    const row = page.locator(`[data-testing-mode='${mode}']`);
    await expect(row).toBeVisible();
    await expect(page.getByRole("radio", { name: label, exact: true })).toBeVisible();
    // The line under the name is there whole: not cut with an ellipsis, not clipped.
    const line = row.getByText(description, { exact: true });
    await expect(line).toBeVisible();
    await expect(line).toHaveCSS("text-overflow", "clip");
    await expect(line).toHaveCSS("white-space", "normal");
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  await expect(page.getByRole("radio", { name: "Test at ship", exact: true })).toBeChecked();
  await expect(page.locator("[data-testing-mode='at-ship']")).toContainText("Default");
  await expect(page.getByText("For app.")).toBeVisible();
  // Nothing was written by looking.
  expect(await calls(page, "delivery_testing_mode_set")).toEqual([]);
  expect(await calls(page, "delivery_settings_get")).toEqual([{ command: "delivery_settings_get", args: { project: "/work/app" } }]);
});

test("how tasks are tested writes a pick on top of the row it last read", async ({ page }) => {
  await page.goto("/tests/browser/testing-mode.html");
  await page.getByRole("radio", { name: "Light tests each task", exact: true }).check();
  await expect(page.getByRole("radio", { name: "Light tests each task", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Test at ship", exact: true })).not.toBeChecked();
  expect((await calls(page, "delivery_testing_mode_set"))[0]?.args).toEqual({
    project: "/work/app",
    mode: "light",
    expectedUpdatedAt: null,
  });
  await page.getByRole("radio", { name: "No testing", exact: true }).check();
  await expect(page.getByRole("radio", { name: "No testing", exact: true })).toBeChecked();
  expect((await calls(page, "delivery_testing_mode_set"))[1]?.args).toEqual({
    project: "/work/app",
    mode: "off",
    expectedUpdatedAt: 1,
  });
  await expect(page.locator("[data-testing-mode-note]")).toHaveCount(0);
});

test("how tasks are tested says so in one grey line when another window changed it", async ({ page }) => {
  await page.goto("/tests/browser/testing-mode.html?stale=1");
  await expect(page.getByRole("radio", { name: "Test at ship", exact: true })).toBeChecked();
  // A click, not check(): the refused write leaves the stored choice selected, which is the point.
  await page.getByRole("radio", { name: "No testing", exact: true }).click();
  const note = page.locator("[data-testing-mode-note]");
  await expect(note).toHaveText("Those delivery settings changed in another window. Look again, then set them.");
  // What shows is what is stored now, not what was clicked.
  await expect(page.getByRole("radio", { name: "Full checks each task", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "No testing", exact: true })).not.toBeChecked();
  // Picking again, from what it just read, goes through and clears the line.
  await page.getByRole("radio", { name: "No testing", exact: true }).check();
  await expect(page.getByRole("radio", { name: "No testing", exact: true })).toBeChecked();
  await expect(note).toHaveCount(0);
  const writes = await calls(page, "delivery_testing_mode_set");
  expect(writes[writes.length - 1]?.args).toEqual({ project: "/work/app", mode: "off", expectedUpdatedAt: 9 });
});

test("how tasks are tested from Home asks for a project first", async ({ page }) => {
  await page.goto("/tests/browser/testing-mode.html?home=1");
  await expect(page.getByText("Pick a project to see how its tasks are tested.")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "How tasks are tested" })).toHaveCount(0);
  // The project Home was last in is not read for it.
  expect(await calls(page, "delivery_settings_get")).toEqual([]);
  await page.getByRole("button", { name: "Project: Choose a project" }).click();
  await page.getByRole("option", { name: "other" }).click();
  await expect(page.getByRole("radiogroup", { name: "How tasks are tested" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Test at ship", exact: true })).toBeChecked();
  await expect(page.getByText("For other.")).toBeVisible();
  expect((await calls(page, "delivery_settings_get"))[0]?.args).toEqual({ project: "/work/other" });
});
