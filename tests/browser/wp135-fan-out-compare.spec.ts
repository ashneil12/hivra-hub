import { expect, test } from "@playwright/test";

test("a compare can pick one chat and discard the other", async ({ page }) => {
  await page.goto("/tests/browser/wp135-fan-out-compare.html");

  const winner = page.locator("[data-fan-out-child='child-a']");
  const loser = page.locator("[data-fan-out-child='child-b']");
  await expect(winner).toContainText("Working");
  await expect(winner).toContainText("The flake was a shared clock.");
  await expect(loser).toContainText("Idle");
  await expect(loser).toContainText("No reply yet");

  await winner.getByRole("button", { name: "Pick this one" }).click();
  await expect(winner.locator("[data-fan-out-winner]")).toHaveText(
    "This worktree stays. Nothing was copied back.",
  );
  await expect(winner.getByRole("button", { name: "Discard" })).toBeDisabled();

  await loser.getByRole("button", { name: "Discard" }).click();
  await expect(loser.locator("[data-fan-out-cleanup]")).toHaveText("Its worktree was removed.");
  await expect(page.locator("[data-fan-out-removed]")).toHaveText("/work/trees/b");
  await expect(page.getByRole("button", { name: "Merge" })).toHaveCount(0);

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
  expect(text.toLowerCase()).not.toContain("merge");
});
