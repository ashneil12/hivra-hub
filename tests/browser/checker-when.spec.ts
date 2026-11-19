import { expect, test, type Page } from "@playwright/test";

const WORDS = [
  {
    rule: "follow-mode",
    label: "Follow the testing mode",
    description: "Full checks every code change. Test at ship and Light check risky changes only. The ship check always has it.",
  },
  {
    rule: "every-code-change",
    label: "Every code change",
    description: "Every code change gets it, in every mode but No testing, and so does the ship check.",
  },
  {
    rule: "risky-only",
    label: "Only risky changes",
    description: "Only a change to a protected or security path gets it. The ship check keeps the quick review.",
  },
  { rule: "off", label: "Off", description: "Only the quick one-turn check, everywhere." },
] as const;

type Call = { command: string; args: Record<string, unknown> | undefined };

async function calls(page: Page, command: string): Promise<Call[]> {
  const all = await page.evaluate(() => (window as unknown as { __checkerCalls: Call[] }).__checkerCalls);
  return all.filter((call) => call.command === command);
}

const radio = (page: Page, name: string) => page.getByRole("radio", { name, exact: true });

test("when the checker runs lists the four choices in full with Follow the testing mode chosen by default", async ({ page }) => {
  await page.goto("/tests/browser/checker-when.html");
  const group = page.getByRole("radiogroup", { name: "When the checker runs" });
  await expect(group).toBeVisible();
  await expect(group.getByRole("radio")).toHaveCount(4);
  for (const { rule, label, description } of WORDS) {
    const row = page.locator(`[data-checker-when='${rule}']`);
    await expect(row).toBeVisible();
    await expect(radio(page, label)).toBeVisible();
    // The line under the name is there whole: not cut with an ellipsis, not clipped.
    const line = row.getByText(description, { exact: true });
    await expect(line).toBeVisible();
    await expect(line).toHaveCSS("text-overflow", "clip");
    await expect(line).toHaveCSS("white-space", "normal");
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  await expect(radio(page, "Follow the testing mode")).toBeChecked();
  await expect(page.locator("[data-checker-when='follow-mode']")).toContainText("Default");
  // Nothing was written by looking.
  expect(await calls(page, "checker_when_rule_set")).toEqual([]);
  expect((await calls(page, "checker_when_rule_get")).length).toBe(1);
});

test("when the checker runs keeps a saved choice and puts the long explanation behind More", async ({ page }) => {
  await page.goto("/tests/browser/checker-when.html?stored=risky-only");
  await expect(radio(page, "Only risky changes")).toBeChecked();
  await expect(radio(page, "Follow the testing mode")).not.toBeChecked();
  await expect(page.locator("[data-checker-when='follow-mode']")).toContainText("Default");
  const details = page.getByText("about two model calls from another family", { exact: false });
  await expect(details).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(details).toBeVisible();
  await page.getByRole("button", { name: "Less", exact: true }).click();
  await expect(details).toHaveCount(0);
});

test("when the checker runs writes a pick and shows it once it is saved", async ({ page }) => {
  await page.goto("/tests/browser/checker-when.html");
  await radio(page, "Every code change").check();
  await expect(radio(page, "Every code change")).toBeChecked();
  await expect(radio(page, "Follow the testing mode")).not.toBeChecked();
  expect((await calls(page, "checker_when_rule_set"))[0]?.args).toEqual({ rule: "every-code-change" });
  await expect(page.locator("[data-checker-when-note]")).toHaveCount(0);
});

test("when the checker runs says so in one grey line when a save fails and keeps what is stored", async ({ page }) => {
  await page.goto("/tests/browser/checker-when.html?fail=1");
  await expect(radio(page, "Follow the testing mode")).toBeChecked();
  // A click, not check(): the refused write leaves the stored choice selected, which is the point.
  await radio(page, "Off").click();
  await expect(page.locator("[data-checker-when-note]")).toHaveText("Couldn't save this setting. Try again.");
  await expect(radio(page, "Follow the testing mode")).toBeChecked();
  await expect(radio(page, "Off")).not.toBeChecked();
  // The second try goes through.
  await radio(page, "Off").check();
  await expect(radio(page, "Off")).toBeChecked();
  expect((await calls(page, "checker_when_rule_set")).length).toBe(2);
});
