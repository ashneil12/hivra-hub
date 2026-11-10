import { expect, test } from "@playwright/test";

// WP-165. Morning lists the drafts and does not offer a way to start, merge or spend.
test.use({ viewport: { width: 1100, height: 900 } });

test("the morning list shows drafts and the scout stays off", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("/tests/browser/wp165-drafts.html");
  expect(errors, errors.join("\n")).toEqual([]);

  const quiet = page.locator("[data-quiet-home]");
  await expect(quiet.getByText("All quiet.")).toBeVisible();
  await expect(quiet.locator("[data-home] > div > *").first()).toHaveAttribute("data-home-start", "");
  expect(await quiet.innerText()).not.toMatch(/\d/);

  const drafts = page.locator("[data-draft-home]");
  await expect(drafts.getByRole("heading", { name: "Overnight drafts" })).toBeVisible();
  await expect(drafts.getByText("Show the queue")).toBeVisible();
  await expect(drafts.getByText("Waiting for you.")).toBeVisible();
  await expect(drafts.getByText("Auth for the desk")).toBeVisible();
  await expect(drafts.locator("[data-overnight-draft='parked']")).toContainText("Parked for a security check.");
  await expect(drafts.getByText("All quiet.")).toHaveCount(0);
  await expect(drafts.locator("[data-home] > div > *").first()).toHaveAttribute("data-home-start", "");
  await expect(drafts.getByRole("button", { name: /start|merge|spend|launch/i })).toHaveCount(0);
  await drafts.locator("[data-overnight-draft='waiting']").getByText("Read the brief").click();
  await expect(drafts.getByText("Source: firstmate (MIT).")).toBeVisible();

  const setting = page.getByRole("switch", { name: "Overnight scout" });
  await expect(setting).toBeEnabled();
  await expect(setting).toHaveAttribute("aria-checked", "false");
  await expect(setting).toHaveText("Off");
});
