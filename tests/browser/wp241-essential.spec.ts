import { expect, test } from "@playwright/test";

// WP-241. The person marks a confirmed fact to be sent in every chat, and takes the mark off. Example data (the WP-240
// page) at the review size. Shots are chromium only. WP241_BEFORE=1 takes the "before" shot and checks nothing else.
test.use({ viewport: { width: 1440, height: 900 } });

const SHOTS = "docs/hivra/work/shots/wp-241";

test("a confirmed fact can be sent in every chat", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp241-essential.html");
  const row = (text: string) => page.locator("[data-id]", { hasText: text });
  await expect(row("Example: reviews happen on Friday")).toBeVisible();
  const shoot = testInfo.project.name === "chromium";
  if (process.env.WP241_BEFORE) {
    if (shoot) await page.screenshot({ path: `${SHOTS}/before/fact.png` });
    return;
  }

  // Only a fact the person confirmed can be marked; a guess cannot.
  await expect(row("Example: likes small commits").locator("[data-essential-button]")).toHaveCount(0);
  const friday = row("Example: reviews happen on Friday");
  await expect(friday.locator("[data-essential]")).toHaveCount(0);

  await page.getByRole("button", { name: "Send in every chat: Example: reviews happen on Friday" }).click();
  await expect(friday.locator("[data-essential]")).toHaveText("Sent in every chat");
  await expect(friday.locator("[data-essential-button]")).toHaveAttribute("aria-pressed", "true");
  if (shoot) await page.screenshot({ path: `${SHOTS}/after/fact.png` });

  await page.getByRole("button", { name: "Stop sending in every chat: Example: reviews happen on Friday" }).click();
  await expect(friday.locator("[data-essential]")).toHaveCount(0);
  await expect(friday.locator("[data-essential-button]")).toHaveAttribute("aria-pressed", "false");
});
