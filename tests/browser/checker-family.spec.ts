import { expect, test, type Page } from "@playwright/test";

const WORDS = [
  {
    rule: "different",
    label: "A different model family",
    description:
      "A task done on Claude is checked by Codex or Grok, and any other task by Claude. If only one family is signed in, a different model of it checks and the task says so.",
  },
  {
    rule: "any",
    label: "Any model",
    description: "The strongest checker that is signed in, whichever model did the work.",
  },
] as const;

type Call = { command: string; args: Record<string, unknown> | undefined };

async function calls(page: Page, command: string): Promise<Call[]> {
  const all = await page.evaluate(() => (window as unknown as { __checkerCalls: Call[] }).__checkerCalls);
  return all.filter((call) => call.command === command);
}

test("who checks the work lists both choices in full with a different family chosen by default", async ({ page }) => {
  await page.goto("/tests/browser/checker-family.html");
  const group = page.getByRole("radiogroup", { name: "Who checks the work" });
  await expect(group).toBeVisible();
  await expect(group.getByRole("radio")).toHaveCount(2);
  for (const { rule, label, description } of WORDS) {
    const row = page.locator(`[data-checker-family='${rule}']`);
    await expect(row).toBeVisible();
    await expect(page.getByRole("radio", { name: label, exact: true })).toBeVisible();
    // The line under the name is there whole: not cut with an ellipsis, not clipped.
    const line = row.getByText(description, { exact: true });
    await expect(line).toBeVisible();
    await expect(line).toHaveCSS("text-overflow", "clip");
    await expect(line).toHaveCSS("white-space", "normal");
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  await expect(page.getByRole("radio", { name: "A different model family", exact: true })).toBeChecked();
  await expect(page.locator("[data-checker-family='different']")).toContainText("Default");
  // Nothing was written by looking.
  expect(await calls(page, "checker_family_rule_set")).toEqual([]);
  expect((await calls(page, "checker_family_rule_get")).length).toBe(1);
});

test("who checks the work writes a pick and shows it once it is saved", async ({ page }) => {
  await page.goto("/tests/browser/checker-family.html");
  await page.getByRole("radio", { name: "Any model", exact: true }).check();
  await expect(page.getByRole("radio", { name: "Any model", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "A different model family", exact: true })).not.toBeChecked();
  expect((await calls(page, "checker_family_rule_set"))[0]?.args).toEqual({ rule: "any" });
  await expect(page.locator("[data-checker-family-note]")).toHaveCount(0);
});

test("who checks the work says so in one grey line when a save fails and keeps what is stored", async ({ page }) => {
  await page.goto("/tests/browser/checker-family.html?fail=1");
  await expect(page.getByRole("radio", { name: "A different model family", exact: true })).toBeChecked();
  // A click, not check(): the refused write leaves the stored choice selected, which is the point.
  await page.getByRole("radio", { name: "Any model", exact: true }).click();
  await expect(page.locator("[data-checker-family-note]")).toHaveText("Couldn't save this setting. Try again.");
  await expect(page.getByRole("radio", { name: "A different model family", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Any model", exact: true })).not.toBeChecked();
  // The second try goes through.
  await page.getByRole("radio", { name: "Any model", exact: true }).check();
  await expect(page.getByRole("radio", { name: "Any model", exact: true })).toBeChecked();
  expect((await calls(page, "checker_family_rule_set")).length).toBe(2);
});
