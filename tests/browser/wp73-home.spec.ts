import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

// WP-73. Home on the real strip. Sections that have nothing stay hidden, an arrangement survives a reload,
// and a missing chief is offered instead of a project list.
test.use({ viewport: { width: 1100, height: 760 } });

test("home keeps the strip, hides empty sections, and keeps a pinned panel", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp73-home.html");
  const strip = page.locator("[data-hub-strip]");
  await expect(strip.locator("button").first()).toHaveAttribute("aria-label", "Home");
  await expect(page.locator("[data-hub-home] button")).toHaveAttribute("aria-current", "true");

  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.locator("[data-home-empty]")).toContainText("Nothing needs you.");
  await expect(page.getByText("All quiet.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Projects" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Moving now" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recent" })).toHaveCount(0);
  await expect(page.getByLabel("Ask")).toBeVisible();
  await expect(page.locator("[data-count]")).toHaveCount(0);

  await page.getByRole("button", { name: "Customize" }).click();
  await expect(page.getByRole("button", { name: "Move Working now up" })).toBeVisible();
  await expect(page.getByText("Pin a panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Hide Done today" }).click();
  await expect(page.getByRole("button", { name: "Show Done today" })).toBeVisible();
  await page.getByRole("button", { name: "Show Done today" }).click();
  await page.getByRole("button", { name: "Pin Example board" }).click();
  await expect(page.locator("[data-home]")).toHaveAttribute("data-home-order", "panel:my-panels:board");
  await expect(page.frameLocator("iframe[title='Example board']").getByText("Example: board")).toBeVisible();

  const pinned = page.locator("[data-home-section='panel:my-panels:board']");
  await pinned.scrollIntoViewIfNeeded();
  await expect(pinned).toHaveCSS("opacity", "1");
  mkdirSync("docs/hivra/work/proofs/wp-73", { recursive: true });
  await page.locator("[data-wp73-shell]").screenshot({ path: `docs/hivra/work/proofs/wp-73/${testInfo.project.name}.png` });

  await page.reload();
  await expect(page.locator("[data-home]")).toHaveAttribute("data-home-order", "panel:my-panels:board");
  await expect(page.locator("[data-home-empty]")).toHaveCount(0);
});

test("an empty home says nothing needs you and keeps the chat", async ({ page }) => {
  await page.goto("/tests/browser/wp73-home.html?empty=1");
  await expect(page.locator("[data-home-empty]")).toContainText("Nothing needs you.");
  await expect(page.getByText("All quiet.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Working now" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Done today" })).toHaveCount(0);
  await expect(page.locator("[data-home-start]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a chat with Crew" })).toHaveCount(0);
});

test("with no project, home offers the chief and files nothing", async ({ page }) => {
  await page.goto("/tests/browser/wp73-home.html?noprojects=1");
  await expect(page.locator("[data-home-no-projects]")).toHaveCount(0);
  await expect(page.getByText("There is no Chief of Staff.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add the Chief of Staff" })).toBeVisible();
  await expect(page.getByLabel("Ask")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-tasks-created", "0");
  await page.getByRole("button", { name: "Add the Chief of Staff" }).click();
  await expect(page.locator("body")).not.toHaveAttribute("data-mono-chat", "");
  const opened = await page.locator("body").getAttribute("data-mono-chat");
  expect(opened).toBeTruthy();
  expect(opened).not.toBe("coordinator");
  await expect(page.locator("body")).toHaveAttribute("data-tasks-created", "0");
});
