import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

// WP-212. Example data at the review size. Shots are chromium only.
test.use({ viewport: { width: 1440, height: 900 } });

const SHOTS = "docs/hivra/work/shots/wp-212/after";

test("home shows the chief, the three sections, and customize", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp212-home.html");
  const home = page.locator("[data-home]");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.locator("[data-home-date]")).toHaveText("Wednesday 11 November");
  await expect(page.locator("[data-home-chief]")).toHaveText("Chief of Staff");
  await expect(page.locator("[data-home-avatar='chief']")).toHaveText("CS");
  await expect(page.locator("[data-home-scope]")).toHaveText("read all 7 projects");
  await expect(page.getByRole("button", { name: "Send" })).not.toHaveClass(/bg-accent/);
  await expect(page.getByLabel("Ask")).toHaveAttribute("placeholder", "Ask anything, or hand work to any project");
  await expect(home).toHaveAttribute("data-home-order", "needs-you moving-now recent");

  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.locator("[data-home-count='2']")).toHaveText("2");
  await expect(page.locator("[data-home-line='need']").first()).toContainText("Should we ship the notes?");
  await expect(page.locator("[data-home-line='need']").first().getByRole("button", { name: "Yes" })).toBeVisible();
  await expect(page.locator("[data-home-line='need']").first().getByRole("button", { name: "Not yet" })).toBeVisible();
  const stopped = page.locator("[data-home-line='need']").nth(1);
  await expect(stopped).toContainText("Stopped.");
  await expect(stopped).not.toContainText("Needs you");
  await expect(stopped).toContainText("Example: The notes worker stopped.");
  await expect(stopped.getByRole("button", { name: "Open chat" })).toBeVisible();
  await expect(page.getByText("Stuck")).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Working now" })).toBeVisible();
  await expect(page.locator("[data-home-workers]")).toHaveText("4 workers");
  await expect(page.locator("[data-home-line='working']")).toContainText("4 workers: chat move fixes, PR watch, commit guard, crew locks");
  await expect(page.locator("[data-home-since]")).toHaveText("since 03:40");

  await expect(page.getByRole("heading", { name: "Done today" })).toBeVisible();
  await expect(page.locator("[data-home-line='done']")).toContainText("Merged the notes");
  await expect(page.locator("[data-home-time]")).toHaveText("09:05");
  await expect(page.getByText("All quiet.")).toHaveCount(0);
  expect(await home.innerText()).not.toMatch(/[—–]/);
  await expect(page.locator("[data-home-section='recent']")).toHaveCSS("opacity", "1");

  if (testInfo.project.name === "chromium") {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/home.png` });
  }

  await page.getByLabel("Ask").fill("how is EXO going?");
  await expect(page.getByRole("button", { name: "Send" })).toHaveClass(/bg-accent/);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("[data-home-speaker='you']")).toHaveText("You");
  await expect(page.locator("[data-home-you] .user-message-bubble")).toHaveText("how is EXO going?");
  await expect(page.locator("[data-home-speaker='chief']")).toHaveText("Chief of Staff");
  await expect(page.locator("[data-home-reply]")).toContainText("EXO is fine.");
  await expect(page.getByRole("button", { name: "Sounds good" })).toBeVisible();
  await page.getByRole("button", { name: "Open full chat" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", "chief-1");
  if (testInfo.project.name === "chromium") await page.screenshot({ path: `${SHOTS}/turn.png` });

  await page.getByRole("button", { name: "Customize" }).click();
  await expect(page.locator("[data-home-customize]")).toBeVisible();
  await expect(page.getByText("Pin a panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Move Working now up" }).click();
  await expect(home).toHaveAttribute("data-home-order", "moving-now needs-you recent");
  await page.getByRole("switch", { name: "Show Done today" }).click();
  await expect(page.getByRole("heading", { name: "Done today" })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Show Done today" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Pin Example board" }).click();
  await expect(home).toHaveAttribute("data-home-order", "moving-now needs-you panel:my-panels:board");
  const pinned = page.locator("[data-home-section='panel:my-panels:board']");
  await expect(pinned).toBeVisible();
  await pinned.scrollIntoViewIfNeeded();
  const box = await pinned.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: `${SHOTS}/customize.png` });

  await page.reload();
  await expect(page.locator("[data-home]")).toHaveAttribute("data-home-order", "moving-now needs-you panel:my-panels:board");
  await expect(page.getByRole("heading", { name: "Done today" })).toHaveCount(0);
  await page.getByRole("button", { name: "Customize" }).click();
  await expect(page.getByRole("switch", { name: "Show Done today" })).toHaveAttribute("aria-checked", "false");
});

test("with nothing to show, home keeps the chat and one line", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp212-home.html?empty=1");
  await expect(page.locator("[data-home-start]")).toBeVisible();
  await expect(page.locator("[data-home-empty]")).toHaveText("Nothing needs you.");
  await expect(page.locator("[data-home-section]")).toHaveCount(0);
  await expect(page.getByText("All quiet.")).toHaveCount(0);
  await expect(page.getByText("Stuck")).toHaveCount(0);
  if (testInfo.project.name === "chromium") {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/empty.png` });
  }
});
