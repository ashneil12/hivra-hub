import { expect, test } from "@playwright/test";

const NOTICE =
  "Waiting for approval to run `npm test`. Your message waits until you allow or deny it on the card above.";

test("a held approval says it is waiting, in plain words", async ({ page }) => {
  await page.goto("/tests/browser/wp146-approval.html");
  await expect(page.getByText("Waiting for approval", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(page.getByText(NOTICE)).toBeVisible();
});
