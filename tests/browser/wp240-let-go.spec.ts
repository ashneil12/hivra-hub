import { expect, test } from "@playwright/test";

// WP-240. Example data at the review size. Shots are chromium only. WP240_BEFORE=1 takes the "before" shot of the
// screen as it was (run once against the previous MemoryReview) and checks nothing else.
test.use({ viewport: { width: 1440, height: 900 } });

const SHOTS = "docs/hivra/work/shots/wp-240";

test("memory says how sure it is, and keeps what it let go", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp240-let-go.html");
  await expect(page.getByText("Example: likes small commits", { exact: true })).toBeVisible();
  const shoot = testInfo.project.name === "chromium";
  if (process.env.WP240_BEFORE) {
    if (shoot) await page.screenshot({ path: `${SHOTS}/before/memory.png` });
    return;
  }

  // How sure memory is: said once, said twice, or the person's own.
  const row = (text: string) => page.locator("[data-id]", { hasText: text });
  await expect(row("Example: likes small commits").locator("[data-state]")).toHaveText("Mentioned once");
  await expect(row("Example: writes release notes on Monday").locator("[data-state]")).toHaveText("Learned");
  await expect(row("Example: reviews happen on Friday").locator("[data-state]")).toHaveText("Confirmed");
  if (shoot) await page.screenshot({ path: `${SHOTS}/after/kept.png` });

  // The "Let go" tab: each item says why, and what replaced it when something did.
  await page.getByRole("tab", { name: "Let go (3)" }).click();
  await expect(page.getByRole("tab", { name: "Let go (3)" })).toHaveAttribute("aria-selected", "true");
  const gone = (text: string) => page.locator("[data-let-go]", { hasText: text });
  await expect(gone("Example: reviews happen on Thursday").locator("[data-let-go-why]")).toHaveText(
    "Replaced by a newer fact: Example: reviews happen on Friday",
  );
  await expect(gone("Example: the trip to Lisbon").locator("[data-let-go-why]")).toHaveText("Its end date has passed");
  await expect(gone("Example: prefers tabs").locator("[data-let-go-why]")).toHaveText("Mentioned once and not since");
  await expect(page.getByText("Example: likes small commits")).toHaveCount(0);
  if (shoot) await page.screenshot({ path: `${SHOTS}/after/let-go.png` });

  // Bring back puts it in the kept list again.
  await page.getByRole("button", { name: "Bring back Example: prefers tabs" }).click();
  await expect(gone("Example: prefers tabs")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Let go (2)" })).toBeVisible();

  // Delete is the hard forget: it leaves the list too.
  await page.getByRole("button", { name: "Delete Example: the trip to Lisbon is in October" }).click();
  await expect(gone("Example: the trip to Lisbon")).toHaveCount(0);

  await page.getByRole("tab", { name: "Kept" }).click();
  await expect(row("Example: prefers tabs")).toBeVisible();

  // The person can let a fact go by hand; it says so.
  await page.getByRole("button", { name: "Let go Example: likes small commits" }).click();
  await expect(row("Example: likes small commits")).toHaveCount(0);
  await page.getByRole("tab", { name: /^Let go/ }).click();
  await expect(gone("Example: likes small commits").locator("[data-let-go-why]")).toHaveText("You let it go");
});

test("a memory with nothing let go says so in one line", async ({ page }) => {
  await page.goto("/tests/browser/wp240-let-go.html");
  test.skip(!!process.env.WP240_BEFORE, "before shot only");
  await page.getByRole("tab", { name: "Let go (3)" }).click();
  for (const text of ["Example: reviews happen on Thursday", "Example: the trip to Lisbon is in October", "Example: prefers tabs"]) {
    await page.getByRole("button", { name: `Delete ${text}` }).click();
    await expect(page.locator("[data-let-go]", { hasText: text })).toHaveCount(0);
  }
  await expect(page.getByText("Nothing has been let go.")).toBeVisible();
});
