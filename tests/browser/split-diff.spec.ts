import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1100, height: 760 } });

async function stages(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          splitStages: () => { id: string; pos?: number }[];
        }
      ).splitStages(),
  );
}

test("switches to split and back, and unified staging still works", async ({
  page,
}) => {
  await page.goto("/tests/browser/split-diff.html");
  const unified = page.getByRole("region", { name: "Unified diff", exact: true });
  await expect(unified).toBeVisible();
  await expect(page.getByRole("radio", { name: "Unified" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("radio", { name: "Split" })).toHaveAttribute(
    "aria-checked",
    "false",
  );

  await page.getByRole("radio", { name: "Split" }).click();
  const split = page.getByRole("region", { name: "Split diff", exact: true });
  await expect(split).toBeVisible();
  await expect(unified).toHaveCount(0);
  await expect(split).toContainText("old line");
  await expect(split).toContainText("new line");
  await expect(
    page.getByText("Split is view only. Staging stays on Unified."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Stage hunk" })).toHaveCount(0);

  await page.getByRole("radio", { name: "Unified" }).click();
  await expect(unified).toBeVisible();
  await expect(split).toHaveCount(0);
  const added = page.locator(".diff-review-gutter-lane .diff-review-line.is-add").first();
  await added.hover();
  await added.getByRole("button", { name: "Stage hunk", exact: true }).click();
  await expect.poll(async () => (await stages(page)).length).toBe(1);
  const staged = await stages(page);
  expect(staged[0]).toMatchObject({ id: "file-0" });
  expect(typeof staged[0].pos).toBe("number");
});

const SPLIT_CHOICE = () => localStorage.setItem("monocode.diffLayout", "split");

test("the split package loads only when Split is chosen", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (/pierre/i.test(request.url())) requested.push(request.url());
  });
  await page.goto("/tests/browser/split-diff.html");
  await expect(
    page.getByRole("region", { name: "Unified diff", exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(requested).toEqual([]);

  await page.getByRole("radio", { name: "Split" }).click();
  await expect(
    page.getByRole("region", { name: "Split diff", exact: true }),
  ).toContainText("new line");
  expect(requested.length).toBeGreaterThan(0);
});

const SPLIT_MODULE = /pierreDiff\.tsx/;

test("the unified review stays on screen while the split package is on its way", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(SPLIT_MODULE, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/tests/browser/split-diff.html");
  const unified = page.getByRole("region", { name: "Unified diff", exact: true });
  const split = page.getByRole("region", { name: "Split diff", exact: true });
  await expect(unified).toBeVisible();

  await page.getByRole("radio", { name: "Split" }).click();
  await expect(page.getByRole("radio", { name: "Split" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.waitForTimeout(400);
  await expect(unified).toBeVisible();
  await expect(split).toHaveCount(0);
  await expect(page.getByText("Loading split view")).toHaveCount(0);

  release();
  await expect(split).toContainText("new line");
  await expect(unified).toHaveCount(0);
});

test("a split package that fails to load leaves the unified review and says so", async ({
  page,
}) => {
  await page.route(SPLIT_MODULE, (route) => route.abort());
  await page.goto("/tests/browser/split-diff.html");
  await page.getByRole("radio", { name: "Split" }).click();
  await expect(
    page.getByText("Split view could not load. Showing Unified."),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Unified diff", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Split diff", exact: true }),
  ).toHaveCount(0);
  // Unified is what is drawn, so staging is still there.
  const added = page.locator(".diff-review-gutter-lane .diff-review-line.is-add").first();
  await added.hover();
  await expect(
    added.getByRole("button", { name: "Stage hunk", exact: true }),
  ).toBeVisible();
});

test("split brings the focused file to the top, until the person scrolls", async ({
  page,
}) => {
  await page.addInitScript(SPLIT_CHOICE);
  await page.goto("/tests/browser/split-diff.html?files=8&focus=file-3");
  const split = page.getByRole("region", { name: "Split diff", exact: true });
  await expect(split).toBeVisible();
  await expect(split).toContainText("file 7 line 30 changed");

  // How far the focused file starts below the top edge of the region, in pixels.
  const offset = () =>
    split.evaluate((region) => {
      const file = region.querySelector('[data-split-file="file-3"]');
      if (!file) return Number.NaN;
      return Math.round(
        file.getBoundingClientRect().top - region.getBoundingClientRect().top,
      );
    });
  const scrollTop = () => split.evaluate((region) => region.scrollTop);

  await expect.poll(offset).toBeLessThanOrEqual(2);
  await expect.poll(offset).toBeGreaterThanOrEqual(-2);
  expect(await scrollTop()).toBeGreaterThan(300);
  // Still there after the files above it have finished drawing.
  await page.waitForTimeout(800);
  expect(Math.abs(await offset())).toBeLessThanOrEqual(2);

  // Once the person scrolls, the view stays where they put it.
  await split.hover();
  const before = await scrollTop();
  await page.mouse.wheel(0, 400);
  await expect.poll(scrollTop).toBeGreaterThan(before + 100);
  // WebKit animates a wheel scroll, so wait until it has come to rest before reading where it stopped.
  const settled = async () => {
    const first = await scrollTop();
    await page.waitForTimeout(200);
    return (await scrollTop()) === first;
  };
  await expect.poll(settled).toBe(true);
  const moved = await scrollTop();
  await page.waitForTimeout(600);
  expect(await scrollTop()).toBe(moved);
  // And the focused file was not pulled back to the top.
  expect(Math.abs(await offset())).toBeGreaterThan(100);
});

test("a pull request review is unified only, even after Split was chosen", async ({
  page,
}) => {
  await page.addInitScript(SPLIT_CHOICE);
  await page.goto("/tests/browser/split-diff.html?pr=1");
  await expect(
    page.getByRole("region", { name: "Unified diff", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("new line").first()).toBeVisible();
  await expect(page.getByRole("radio", { name: "Split" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Split diff", exact: true }),
  ).toHaveCount(0);
});
