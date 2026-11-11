import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp244-quiet-watch.html";
const SHOTS = process.env.WP244_SHOTS;

test("an automation can watch one thing and keeps it beside its definition", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pageUrl);
  await page.getByText("Example: CI watch").first().click();
  if (SHOTS === "before") {
    // Before WP-244 the editor has no watch: the screenshot is all this run is for.
    await page.screenshot({ path: "docs/hivra/work/shots/wp-244/before-automation-editor.png" });
    return;
  }
  const field = page.locator("[data-automation-watch]");
  await expect(field).toBeVisible();
  await expect(page.getByText("Only run when this changes")).toBeVisible();
  await field.fill("github:example/app is:pr is:open review-requested:@me");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __wp244: { docs: Map<string, { value: unknown }> } }).__wp244.docs.get("schedule-watches")
            ?.value,
      ),
    )
    .toEqual({
      automations: {
        "ci-watch": { watch: { kind: "github", repo: "example/app", items: "pr", query: "is:open review-requested:@me" } },
      },
    });
  // The automation's own definition never carries it.
  const sent = await page.evaluate(() => (window as unknown as { __wp244: { saved: Record<string, unknown>[] } }).__wp244.saved);
  expect(sent.length).toBe(1);
  expect("watch" in sent[0]).toBe(false);
  // Read back from the store once the editor closed and reopened on the saved automation.
  await expect(field).toHaveValue("github:example/app is:pr is:open review-requested:@me");
  if (browserName === "chromium" && SHOTS === "after")
    await page.screenshot({ path: "docs/hivra/work/shots/wp-244/after-automation-editor.png" });
});

test("a watch it can't read is refused in plain words and nothing is saved", async ({ page }) => {
  await page.goto(pageUrl);
  await page.getByText("Example: CI watch").first().click();
  test.skip(SHOTS === "before", "no watch field before WP-244");
  await page.locator("[data-automation-watch]").fill("http://example.com/price");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("A watched address must start with https://")).toBeVisible();
  const sent = await page.evaluate(() => (window as unknown as { __wp244: { saved: unknown[] } }).__wp244.saved);
  expect(sent.length).toBe(0);
});
