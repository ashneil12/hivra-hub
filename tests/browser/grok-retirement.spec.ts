import { expect, test } from "@playwright/test";

const PATHS = "monocode.providerBinaryPaths.v1";
const NOTE = "Claude Code now runs on your Claude login. The Grok launcher isn't used any more.";

test("a retired launcher path is cleared and the note shows once", async ({ page }) => {
  await page.addInitScript((pathsKey) => {
    localStorage.setItem(
      pathsKey,
      JSON.stringify({
        claude: "/Users/ash/.local/bin/claude-grok",
        codex: "/Users/ash/.local/bin/codex",
      }),
    );
  }, PATHS);
  await page.goto("/tests/browser/grok-retirement.html");
  const note = page.locator("[data-grok-retirement-note]");
  await expect(note).toBeVisible();
  await expect(note).toContainText(NOTE);
  const cleared = await page.evaluate((key) => localStorage.getItem(key), PATHS);
  expect(JSON.parse(cleared!)).toEqual({ codex: "/Users/ash/.local/bin/codex" });
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(note).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-grok-retirement-note]")).toHaveCount(0);
  const still = await page.evaluate((key) => localStorage.getItem(key), PATHS);
  expect(JSON.parse(still!).claude).toBeUndefined();
});

test("a DeepSeek launcher path is left alone and shows no note", async ({ page }) => {
  const deepseek = "/Users/ash/.local/bin/claude-deepseek";
  await page.addInitScript(
    ({ key, path }) => {
      localStorage.setItem(key, JSON.stringify({ claude: path }));
    },
    { key: PATHS, path: deepseek },
  );
  await page.goto("/tests/browser/grok-retirement.html");
  await expect(page.locator("[data-grok-retirement-note]")).toHaveCount(0);
  const stored = await page.evaluate((key) => localStorage.getItem(key), PATHS);
  expect(JSON.parse(stored!).claude).toBe(deepseek);
});
