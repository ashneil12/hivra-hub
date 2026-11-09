import { expect, test, type Locator, type Page } from "@playwright/test";

const PAGE = "/tests/browser/pane-divider.html";
const ROW_FULL = "This row cannot fit another pane.";

async function sizes(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const read = (window as unknown as { paneTreeSizes?: () => number[] })
      .paneTreeSizes;
    if (!read) throw new Error("pane sizes are not ready");
    return read();
  });
}

async function events(page: Page): Promise<
  { kind: string; paneId?: string; dir?: string; reason?: string }[]
> {
  return page.evaluate(() => {
    const read = (
      window as unknown as {
        paneTreeEvents?: {
          kind: string;
          paneId?: string;
          dir?: string;
          reason?: string;
        }[];
      }
    ).paneTreeEvents;
    if (!read) throw new Error("pane events are not ready");
    return read;
  });
}

async function treeBox(page: Page) {
  const box = await page.locator("[data-pane-fixture] > div").boundingBox();
  if (!box) throw new Error("the pane tree has no box");
  return box;
}

async function sashCenter(sash: Locator) {
  const box = await sash.boundingBox();
  if (!box) throw new Error("the divider has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("dragging the divider near a quarter snaps to it", async ({ page }) => {
  await page.goto(PAGE);
  const sash = page.getByRole("separator", { name: "Resize panes" });
  await expect(sash).toBeVisible();
  await expect(sash).toHaveAttribute("aria-valuemin", "0");
  await expect(sash).toHaveAttribute("aria-valuemax", "100");
  await expect(sash).toHaveAttribute("aria-orientation", "vertical");
  expect(
    await sash.locator("div").evaluate((node) => getComputedStyle(node).cursor),
  ).toBe("col-resize");

  const tree = await treeBox(page);
  const from = await sashCenter(sash);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Six pixels past the quarter, still inside the 12 pixel snap window.
  await page.mouse.move(tree.x + tree.width * 0.25 + 6, from.y);
  await expect(sash).toHaveAttribute("data-snapped", "");
  await expect(sash).toHaveAttribute("aria-valuenow", "25");
  await page.mouse.up();

  await expect.poll(async () => (await sizes(page))[0]).toBeCloseTo(0.25, 5);
  await expect(sash).not.toHaveAttribute("data-snapped");
});

test("holding Alt drags the divider to the pointer instead of a snap", async ({
  page,
}) => {
  await page.goto(PAGE);
  const sash = page.getByRole("separator", { name: "Resize panes" });
  await expect(sash).toBeVisible();
  const tree = await treeBox(page);
  const from = await sashCenter(sash);
  await page.keyboard.down("Alt");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const landed = tree.x + tree.width * 0.25 + 6;
  await page.mouse.move(landed, from.y);
  await expect(sash).not.toHaveAttribute("data-snapped");
  await page.mouse.up();
  await page.keyboard.up("Alt");

  await expect
    .poll(async () => (await sizes(page))[0])
    .toBeCloseTo(0.25 + 6 / tree.width, 3);
});

test("a double-click resets the divider to half", async ({ page }) => {
  await page.goto(`${PAGE}?start=0.2`);
  const sash = page.getByRole("separator", { name: "Resize panes" });
  await expect(sash).toHaveAttribute("aria-valuenow", "20");
  await sash.dblclick();
  await expect.poll(async () => (await sizes(page))[0]).toBeCloseTo(0.5, 5);
  await expect(sash).toHaveAttribute("aria-valuenow", "50");
});

test("arrow keys nudge the divider", async ({ page }) => {
  await page.goto(PAGE);
  const sash = page.getByRole("separator", { name: "Resize panes" });
  await sash.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await sizes(page))[0]).toBeCloseTo(0.52, 5);
  await expect(sash).toHaveAttribute("aria-valuenow", "52");
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await sizes(page))[0]).toBeCloseTo(0.62, 5);
  await expect(sash).toHaveAttribute("aria-valuenow", "62");
});

test("both split buttons focus the pane and then split", async ({ page }) => {
  await page.goto(PAGE);
  const pane = page.locator("[data-pane-id='a']");
  await pane.getByRole("button", { name: "Split right", exact: true }).click();
  await pane.getByRole("button", { name: "Split down", exact: true }).click();
  expect(await events(page)).toEqual([
    { kind: "focus", paneId: "a", reason: "pointer" },
    { kind: "split", dir: "right" },
    { kind: "focus", paneId: "a", reason: "pointer" },
    { kind: "split", dir: "down" },
  ]);
});

test("a lone pane shows both split buttons", async ({ page }) => {
  await page.goto(`${PAGE}?scenario=single`);
  const header = page.locator("[data-pane-header]");
  await expect(
    header.getByRole("button", { name: "Split right", exact: true }),
  ).toBeEnabled();
  await expect(
    header.getByRole("button", { name: "Split down", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("separator", { name: "Resize panes" })).toHaveCount(
    0,
  );
});

test("a full row disables split right and says why", async ({ page }) => {
  await page.goto(`${PAGE}?scenario=full`);
  const pane = page.locator("[data-pane-id='a']");
  const right = pane.getByRole("button", { name: "Split right" });
  await expect(right).toBeDisabled();
  await expect(right).toHaveAttribute("title", ROW_FULL);
  await expect(right).toHaveAttribute(
    "aria-label",
    `Split right. ${ROW_FULL}`,
  );
  const down = pane.getByRole("button", { name: "Split down", exact: true });
  await expect(down).toBeEnabled();
  await down.click();
  expect(await events(page)).toEqual([
    { kind: "focus", paneId: "a", reason: "pointer" },
    { kind: "split", dir: "down" },
  ]);
});
