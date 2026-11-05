import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp82-worktree-pool.html";

test("shows who holds each slot and does not offer to remove a leased one", async ({ page }) => {
  await page.goto(pageUrl);
  const pool = page.getByRole("region", { name: "Worktree pool" });
  await expect(pool.getByText("Leased to crew-a")).toBeVisible();
  await expect(pool.getByText("available", { exact: true })).toBeVisible();
  await expect(
    pool.getByText("Left in place: the worktree has uncommitted changes"),
  ).toBeVisible();
  await expect(pool.getByText("quarantined", { exact: true })).toBeVisible();
  await expect(pool.getByText("In use")).toBeVisible();
  await expect(pool.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(
    pool.getByText(
      "The worktree pool isn't installed yet, so this checkout is a plain git worktree.",
    ),
  ).toBeVisible();
});

test("new worktree uses the pool starts off", async ({ page }) => {
  await page.goto(pageUrl);
  const pool = page.getByRole("region", { name: "Worktree pool" });
  const usePool = pool.getByRole("switch", { name: "Use the worktree pool" });
  const interactive = pool.getByRole("switch", { name: "New worktree uses the pool" });
  await expect(usePool).toHaveAttribute("aria-checked", "true");
  await expect(interactive).toHaveAttribute("aria-checked", "false");
  await expect(pool.getByRole("spinbutton", { name: "Worktrees per project" })).toHaveValue("6");
  await interactive.click();
  await expect(interactive).toHaveAttribute("aria-checked", "true");
});

test("prune previews idle slots before it removes them", async ({ page }) => {
  await page.goto(pageUrl);
  const pool = page.getByRole("region", { name: "Worktree pool" });
  await pool.getByRole("button", { name: "Prune idle worktrees" }).click();
  await expect(pool.getByText("would remove /Users/ash/Worktrees/pool/hivra-2")).toBeVisible();
  await expect(pool.getByText("/Users/ash/Worktrees/pool/hivra-2", { exact: true })).toBeVisible();
  await pool.getByRole("button", { name: "Remove these idle worktrees" }).click();
  await expect(pool.getByText("/Users/ash/Worktrees/pool/hivra-2", { exact: true })).toHaveCount(0);
  await expect(pool.getByText("would remove /Users/ash/Worktrees/pool/hivra-2")).toHaveCount(0);
  await expect(pool.getByText("Leased to crew-a")).toBeVisible();
});
