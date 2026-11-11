import { expect, test } from "@playwright/test";

// WP-88. The chief chat stays at the top of Home and answers across two seeded projects.
test.use({ viewport: { width: 1100, height: 760 } });

test("the chief chat is at the top and answers across two projects", async ({ page }) => {
  await page.goto("/tests/browser/wp88-home.html");
  const column = page.locator("[data-home] > div");
  await expect(column.locator(":scope > *").first()).toHaveAttribute("data-home-start", "");
  await expect(page.getByRole("button", { name: "Start a chat with Crew" })).toHaveCount(0);

  await page.getByLabel("Ask").fill("What's happening?");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.locator("[data-home-reply]");
  await expect(reply.getByRole("button", { name: /Write the notes/ })).toBeVisible();
  await expect(reply.getByRole("button", { name: /Paint the door/ })).toBeVisible();
  await expect(reply.getByRole("button", { name: /Crew plan/ })).toBeVisible();
  await expect(reply.getByRole("button", { name: /Site spec/ })).toBeVisible();

  await reply.getByRole("button", { name: /Write the notes/ }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", JSON.stringify({ kind: "task", projectId: "crew", id: "write" }));
  await reply.getByRole("button", { name: /Site spec/ }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", JSON.stringify({ kind: "doc", id: "spec" }));
});
