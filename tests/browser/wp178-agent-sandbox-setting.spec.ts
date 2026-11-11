import { expect, test } from "@playwright/test";

const LABEL = "Run agents in the macOS sandbox";

test("the sandbox switch is off by default and writes the app's setting when turned on", async ({ page }) => {
  await page.goto("/tests/browser/wp178-agent-sandbox-setting.html");

  const row = page.locator("[data-setting-id='agent-sandbox']");
  await expect(row).toContainText(LABEL);
  const sw = page.getByRole("switch", { name: LABEL });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(sw).toBeEnabled();

  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  const calls = await page.evaluate(() => (window as unknown as { __wp178Calls: unknown[] }).__wp178Calls);
  expect(calls).toContainEqual({ command: "agent_sandbox_set", args: { enabled: true } });

  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
