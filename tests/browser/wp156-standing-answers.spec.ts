import { expect, test } from "@playwright/test";

test("retire a standing answer and see who relied on it", async ({ page }) => {
  await page.goto("/tests/browser/wp156-standing-answers.html");
  const off = page.locator("#off");
  const on = page.locator("#on");

  await expect(off).not.toContainText("Standing answers");
  await expect(off.locator("article")).toHaveCount(0);

  await expect(on.locator("[data-standing-key='keep']")).toContainText("Used 2 times");
  await expect(on.locator("[data-standing-key='logo']")).toContainText("Used 1 time");
  await expect(on).toContainText("A ticked answer is reused for similar questions. It is guidance, not permission.");
  await expect(on.locator("[data-standing-key='logo']").getByRole("checkbox", { name: "Reuse for similar questions" })).not.toBeChecked();
  await expect(on).toContainText("Keep deleted sessions, or delete them?");
  await expect(page.locator("body")).not.toContainText("—");
  await expect(page.locator("body")).not.toContainText("–");

  await on.locator("[data-standing-key='keep']").getByRole("button", { name: "Retire", exact: true }).click();
  await on.getByRole("button", { name: "Retire this answer" }).click();
  await expect(on).toContainText("Say why, in a short line.");

  await on.getByLabel("Why are you retiring this?").fill("The rule changed.");
  await on.getByRole("button", { name: "Retire this answer" }).click();
  const retired = on.locator("[data-standing-retired='true']");
  await expect(retired).toContainText("Retired.");
  await expect(retired).toContainText("Tasks that relied on this");
  await expect(retired).toContainText("task-1");
  await expect(retired).toContainText("task-2");

  const logoBox = on.locator("[data-standing-key='logo']").getByRole("checkbox", { name: "Reuse for similar questions" });
  await logoBox.click();
  await expect(logoBox).toBeChecked();
  await expect(on.locator("[data-standing-key='logo']")).toHaveCount(1);
  await logoBox.click();
  await expect(logoBox).not.toBeChecked();
  await expect(on.locator("[data-standing-key='logo']")).toHaveCount(1);
  await expect(retired).toContainText("task-1");
  await expect(page.locator("body")).not.toContainText("—");
  await expect(page.locator("body")).not.toContainText("–");
});
