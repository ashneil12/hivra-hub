import { expect, test } from "@playwright/test";
import { openLocalHub } from "./localHub";

// WP-06: a waiting update is a slim bar on the main pane, above an open project's coding team. Not only on the empty home.
const ID = "20261104-120000-aaaaaaa";

test.use({ viewport: { width: 1440, height: 900 } });

test("a waiting update shows Restart now above an open project", async ({ page }) => {
  await page.addInitScript((summary) => {
    localStorage.setItem("monocode:dev-ship", JSON.stringify(summary));
  }, {
    enabled: true,
    holding: false,
    pending: { id: ID, force: false },
    current: {
      id: ID,
      phase: "waiting",
      accepted: true,
      committed: false,
      seen: false,
      from: { sha: "a".repeat(40), branch: "main" },
      to: { sha: "b".repeat(40), branch: "main" },
    },
  });
  await openLocalHub(page);
  const bar = page.locator("[data-hub-ship]");
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(bar.getByRole("button", { name: "Restart now" })).toBeVisible();
  await expect(page.getByText("No projects yet")).toHaveCount(0);
  await expect(page.locator("[data-coding-team-lead]")).toBeVisible({ timeout: 15_000 });
});
