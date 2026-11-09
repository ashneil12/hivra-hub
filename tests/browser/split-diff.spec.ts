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
