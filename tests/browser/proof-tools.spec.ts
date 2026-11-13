import { expect, test, type Page } from "@playwright/test";

const HINT = "Open-source tools that check the work. The app uses the ones this project already has and never installs one by itself.";
const STALE = "That changed in another window. Look again, then set it.";

// What the catalogue says fast-check proves (src/features/proofTools/model/proofTools.json), word for word.
const FAST_CHECK_PROVES = "Properties hold for generated inputs, not just the examples.";

type Call = { command: string; args: Record<string, unknown> };

async function calls(page: Page, command: string): Promise<Call[]> {
  const all = await page.evaluate(() => (window as unknown as { __proofToolsCalls: Call[] }).__proofToolsCalls);
  return all.filter((call) => call.command === command);
}

const row = (page: Page, id: string) => page.locator(`[data-proof-tool='${id}']`);
const state = (page: Page, id: string) => page.locator(`[data-proof-tool-state='${id}']`);
const toggle = (page: Page, id: string) => page.locator(`[data-proof-tool-switch='${id}']`);
const more = (page: Page, id: string) => page.locator(`[data-proof-tool-more='${id}']`);
const details = (page: Page, id: string) => page.locator(`[data-proof-tool-details='${id}']`);

test("proof tools lists what fits with the words in full, the section words and the hint", async ({ page }) => {
  await page.goto("/tests/browser/proof-tools.html");
  const section = page.getByRole("region", { name: "Proof tools" });
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: "Proof tools" })).toBeVisible();
  await expect(page.locator("[data-proof-tools-hint]")).toHaveText(HINT);
  await expect(page.getByText("For app.")).toBeVisible();
  // One row per tool that fits, in the catalogue's order.
  await expect(page.locator("[data-proof-tool]")).toHaveCount(4);
  expect(await page.locator("[data-proof-tool]").evaluateAll((els) => els.map((el) => el.getAttribute("data-proof-tool")))).toEqual([
    "fast-check",
    "stryker",
    "semgrep",
    "playwright",
  ]);
  // What each tool proves is there whole: not cut with an ellipsis, not clipped.
  const proves = row(page, "fast-check").getByText(FAST_CHECK_PROVES, { exact: true });
  await expect(proves).toBeVisible();
  await expect(proves).toHaveCSS("text-overflow", "clip");
  await expect(proves).toHaveCSS("white-space", "normal");
  for (const id of ["fast-check", "stryker", "semgrep", "playwright"]) {
    const line = row(page, id).locator("p").nth(1);
    await expect(line).toHaveCSS("text-overflow", "clip");
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), id).toBe(true);
    expect(((await line.textContent()) ?? "").trim().length, id).toBeGreaterThan(10);
  }
  await expect(page.getByText(/Stuck|\bMono\b/)).toHaveCount(0);
  // Looking writes nothing.
  expect(await calls(page, "proof_tools_set")).toEqual([]);
  expect(await calls(page, "proof_tools_list")).toEqual([{ command: "proof_tools_list", args: { folder: "/work/app" } }]);
});

test("proof tools shows Used and Not in this project, Proposed and Declined as small tags, and a switch only for a tool the project has", async ({ page }) => {
  await page.goto("/tests/browser/proof-tools.html");
  await expect(page.locator("[data-proof-tool]")).toHaveCount(4);
  await expect(state(page, "fast-check")).toHaveText("Used");
  await expect(state(page, "playwright")).toHaveText("Used");
  await expect(state(page, "stryker")).toHaveText("Not in this project");
  await expect(state(page, "semgrep")).toHaveText("Not in this project");
  await expect(row(page, "stryker").locator("[data-proof-tool-tag]")).toHaveText("Proposed");
  await expect(row(page, "semgrep").locator("[data-proof-tool-tag]")).toHaveText("Declined");
  await expect(row(page, "fast-check").locator("[data-proof-tool-tag]")).toHaveCount(0);
  // The switch is the app's switch, named for the tool.
  await expect(page.getByRole("switch", { name: "Use fast-check in this project" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Use Playwright in this project" })).toBeChecked();
  await expect(page.getByRole("switch")).toHaveCount(2);
  await expect(toggle(page, "stryker")).toHaveCount(0);
  await expect(toggle(page, "semgrep")).toHaveCount(0);
  await expect(more(page, "stryker")).toHaveText("More");
});

test("proof tools switches a tool off on the revision it read, then back on", async ({ page }) => {
  await page.goto("/tests/browser/proof-tools.html");
  await expect(toggle(page, "fast-check")).toBeVisible();
  await toggle(page, "fast-check").click();
  await expect(state(page, "fast-check")).toHaveText("Off");
  await expect(toggle(page, "fast-check")).not.toBeChecked();
  await expect(state(page, "playwright")).toHaveText("Used");
  expect((await calls(page, "proof_tools_set"))[0]?.args).toEqual({
    folder: "/work/app",
    toolId: "fast-check",
    on: false,
    expectedRevision: 0,
  });
  await expect(page.locator("[data-proof-tools-note]")).toHaveCount(0);
  await toggle(page, "fast-check").click();
  await expect(state(page, "fast-check")).toHaveText("Used");
  await expect(toggle(page, "fast-check")).toBeChecked();
  expect((await calls(page, "proof_tools_set"))[1]?.args).toEqual({
    folder: "/work/app",
    toolId: "fast-check",
    on: true,
    expectedRevision: 1,
  });
});

test("proof tools says so in one grey line when another window changed it, then shows what is stored", async ({ page }) => {
  await page.goto("/tests/browser/proof-tools.html?stale=1");
  await expect(toggle(page, "fast-check")).toBeChecked();
  await toggle(page, "fast-check").click();
  const note = page.locator("[data-proof-tools-note]");
  await expect(note).toHaveText(STALE);
  // What shows is what is stored now: the other window's switch, not the click.
  await expect(state(page, "playwright")).toHaveText("Off");
  await expect(state(page, "fast-check")).toHaveText("Used");
  await expect(toggle(page, "fast-check")).toBeChecked();
  // Switching again, from what it just read, goes through and clears the line.
  await toggle(page, "fast-check").click();
  await expect(state(page, "fast-check")).toHaveText("Off");
  await expect(note).toHaveCount(0);
  const writes = await calls(page, "proof_tools_set");
  expect(writes[writes.length - 1]?.args).toEqual({ folder: "/work/app", toolId: "fast-check", on: false, expectedRevision: 9 });
});

test("proof tools More shows the licence, the repo, that it needs no model, and nothing to install for a tool the project has", async ({ page }) => {
  await page.goto("/tests/browser/proof-tools.html");
  await more(page, "fast-check").click();
  const open = details(page, "fast-check");
  await expect(open).toBeVisible();
  await expect(open).toContainText("MIT licence");
  await expect(open).toContainText("Needs no model");
  await expect(open).not.toContainText("Your first mate can add this for you");
  const repo = page.locator("[data-proof-tool-repo='fast-check']");
  await expect(repo).toHaveText("github.com/dubzzz/fast-check");
  // It opens in the browser through the app, never in this window.
  await repo.click();
  const opened = await calls(page, "plugin:opener|open_url");
  expect(opened).toHaveLength(1);
  expect(opened[0]?.args).toMatchObject({ url: "https://github.com/dubzzz/fast-check" });
  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(open).toHaveCount(0);
});

test("proof tools More for a tool the project lacks gives the install command as plain text", async ({ page }) => {
  await page.goto("/tests/browser/proof-tools.html");
  await more(page, "stryker").click();
  const open = details(page, "stryker");
  await expect(open).toContainText("Apache 2.0 licence");
  await expect(open.locator("[data-proof-tool-install]")).toContainText("npm install --save-dev @stryker-mutator/core");
  await expect(open).toContainText("Your first mate can add this for you; it asks you first.");
  await expect(open).not.toContainText("never bundles");
  // A click outside closes it.
  await page.mouse.click(900, 700);
  await expect(open).toHaveCount(0);
});

test("proof tools More for an external tool says it runs only if installed and is never bundled or installed by the app", async ({ page }) => {
  await page.goto("/tests/browser/proof-tools.html");
  await more(page, "semgrep").click();
  const open = details(page, "semgrep");
  await expect(open).toContainText("LGPL 2.1 or later licence");
  await expect(open).toContainText("Runs only if you have it installed. The app never bundles or installs it.");
  await expect(open).toContainText("python -m pip install semgrep");
  await expect(open).toContainText("Your first mate can add this for you; it asks you first.");
});

test("proof tools shows one grey line when nothing fits the project", async ({ page }) => {
  await page.goto("/tests/browser/proof-tools.html?none=1");
  const none = page.locator("[data-proof-tools-none]");
  await expect(none).toHaveText("None of these tools fit this project.");
  await expect(page.locator("[data-proof-tool]")).toHaveCount(0);
  await expect(page.locator("[data-proof-tool-more]")).toHaveCount(0);
  await expect(page.locator("[data-proof-tools-hint]")).toHaveText(HINT);
});

test("proof tools from Home asks for a project first and reads nothing until one is picked", async ({ page }) => {
  await page.goto("/tests/browser/proof-tools.html?home=1");
  await expect(page.getByText("Pick a project to see which of these tools fit it.")).toBeVisible();
  await expect(page.locator("[data-proof-tools-hint]")).toHaveText(HINT);
  await expect(page.locator("[data-proof-tool]")).toHaveCount(0);
  await expect(page.locator("[data-proof-tools-none]")).toHaveCount(0);
  // The project Home was last in is not read for it.
  expect(await calls(page, "proof_tools_list")).toEqual([]);
  await page.getByRole("button", { name: "Project: Choose a project" }).click();
  await page.getByRole("option", { name: "other" }).click();
  await expect(page.locator("[data-proof-tool]")).toHaveCount(1);
  await expect(row(page, "proptest")).toBeVisible();
  await expect(page.getByText("For other.")).toBeVisible();
  expect((await calls(page, "proof_tools_list"))[0]?.args).toEqual({ folder: "/work/other" });
});
