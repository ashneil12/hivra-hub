import { expect, test } from "@playwright/test";

// WP-20: first launch chooses the CLIs on this Mac and a project, then lands in that project's coding team.
// Monos and a group are offered and stay off unless ticked.
test.use({ viewport: { width: 1440, height: 900 } });

test("first launch lands in the new project's coding team", async ({ page }) => {
  await page.goto("/hub-dev.html?onboarding");
  const card = page.locator("[data-hub-onboarding]");
  await expect(card).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await expect(page.getByText("What should your team call you?")).toBeVisible();
  await page.locator("[data-hub-onboarding-next]").click();
  await expect(page.locator("[data-hub-onboarding-team]")).toContainText("None are added unless you tick them");
  // Dropwave: a setup that already proved Claude Code (this page's stand-in does) starts with it ticked; the other
  // tools stay off.
  const claude = page.locator('[data-hub-onboarding-cli="claude"]');
  await expect(claude).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-hub-onboarding-cli="codex"]')).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-hub-onboarding-group]")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-hub-onboarding-starter]")).toHaveCount(5);
  await page.locator("[data-hub-onboarding-project]").fill("Field notes");
  await page.locator("[data-hub-onboarding-next]").click();
  await page.locator("[data-hub-onboarding-next]").click();
  await page.locator("[data-hub-onboarding-done]").click();
  await expect(card).toHaveCount(0);

  await expect(page.locator("[data-coding-team-lead]")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Field lead").first()).toBeVisible();
  await expect(page.getByPlaceholder(/Message/)).toBeVisible();

  const home = await page.evaluate(() => localStorage.getItem("monocode:coding-team-home") ?? "");
  expect(home).toContain("field-notes");
  const chats = await page.evaluate(() => localStorage.getItem("monocode:hub-chats") ?? "");
  expect(chats).not.toContain('"name":"Group"');
  const roster = await page.evaluate(() => localStorage.getItem("monocode:mono-roster") ?? "[]");
  expect(roster).not.toContain("Coordinator");
  const clis = await page.evaluate(() => localStorage.getItem("monocode:coding-team-clis") ?? "");
  expect(clis).toContain("claude");
});
