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
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).not.toHaveClass(/bg-accent/);
  await expect(send.locator("path")).toHaveCount(2);
  await expect(page.getByLabel("Ask")).toHaveAttribute("placeholder", "Ask anything, or hand work to any project");
  await expect(home).toHaveAttribute("data-home-order", "needs-you moving-now recent");

  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.locator("[data-home-count='2']")).toHaveText("2");
  const stopped = page.locator("[data-home-line='need']").first();
  await expect(stopped).toContainText("Stopped.");
  await expect(stopped).not.toContainText("Needs you");
  await expect(stopped).toContainText("Example: The notes worker stopped.");
  await expect(stopped.getByRole("button", { name: "Open chat" })).toBeVisible();
  const question = page.locator("[data-home-line='need']").nth(1);
  await expect(question).toContainText("Should we ship the notes?");
  await expect(question.getByRole("button", { name: "Yes" })).toBeVisible();
  await expect(question.getByRole("button", { name: "Not yet" })).toBeVisible();
  const answer = await page.getByRole("button", { name: "Yes, do that" }).boundingBox();
  const rowButton = await question.getByRole("button", { name: "Yes" }).boundingBox();
  expect(answer).toBeTruthy();
  expect(rowButton).toBeTruthy();
  expect(Math.abs(answer!.height - rowButton!.height)).toBeLessThan(1);
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
  await expect(send).toHaveClass(/bg-accent/);
  await expect(send.locator("path")).toHaveCount(2);
  await send.click();
  await expect(page.locator("[data-home-speaker='you']")).toHaveText("You");
  await expect(page.locator("[data-home-you] .user-message-bubble")).toHaveText("how is EXO going?");
  await expect(page.locator("[data-home-speaker='chief']")).toHaveText("Chief of Staff");
  await expect(page.locator("[data-home-reply]")).toContainText("EXO is fine.");
  await expect(page.getByRole("button", { name: "Sounds good" })).toBeVisible();
  await page.getByRole("button", { name: "Open full chat" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", "chief-1");
  if (testInfo.project.name === "chromium") await page.screenshot({ path: `${SHOTS}/turn.png` });

  await page.getByRole("button", { name: "Customize" }).click();
  const panel = page.locator("[data-home-customize]");
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  const sendBox = await send.boundingBox();
  const cardBox = await page.locator("[data-home-start]").boundingBox();
  expect(panelBox).toBeTruthy();
  expect(sendBox).toBeTruthy();
  expect(cardBox).toBeTruthy();
  const coversSend = panelBox!.y < sendBox!.y + sendBox!.height && panelBox!.y + panelBox!.height > sendBox!.y
    && panelBox!.x < sendBox!.x + sendBox!.width && panelBox!.x + panelBox!.width > sendBox!.x;
  expect(coversSend).toBe(false);
  expect(cardBox!.y).toBeGreaterThanOrEqual(panelBox!.y + panelBox!.height - 1);
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
  await expect(pinned.getByRole("heading", { name: "Example board" })).toBeVisible();
  await expect(pinned.locator("[data-home-panel]")).toContainText("Example: board");
  await expect(pinned).toHaveCSS("opacity", "1");
  const aligned = async (locator: ReturnType<typeof page.getByRole>) => {
    const box = await locator.boundingBox();
    expect(box).toBeTruthy();
    return box!.x;
  };
  const up = await Promise.all([
    aligned(page.getByRole("button", { name: "Move Working now up" })),
    aligned(page.getByRole("button", { name: "Move Needs you up" })),
    aligned(page.getByRole("button", { name: "Move Done today up" })),
    aligned(page.getByRole("button", { name: "Move Example board up" })),
  ]);
  expect(Math.max(...up) - Math.min(...up)).toBeLessThan(2);
  const switches = await Promise.all([
    aligned(page.getByRole("switch", { name: "Show Working now" })),
    aligned(page.getByRole("switch", { name: "Show Needs you" })),
    aligned(page.getByRole("switch", { name: "Show Done today" })),
    aligned(page.getByRole("switch", { name: "Show Example board" })),
  ]);
  expect(Math.max(...switches) - Math.min(...switches)).toBeLessThan(2);
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
  await expect(page.locator("[data-home-quiet]")).toHaveText("All quiet. Ask me anything, or hand work to any project.");
  await expect(page.locator("[data-home-start]")).toContainText("All quiet. Ask me anything, or hand work to any project.");
  await expect(page.locator("[data-home-empty]")).toHaveCount(0);
  await expect(page.getByText("Nothing needs you.")).toHaveCount(0);
  await expect(page.locator("[data-home-section]")).toHaveCount(0);
  await expect(page.getByText("Stuck")).toHaveCount(0);
  if (testInfo.project.name === "chromium") {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/empty.png` });
  }
});

test("the whole window shows the rail, the sidebar, the status bar and home", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp212-home.html?full=1");
  await expect(page.locator("[data-hub-strip]")).toBeVisible();
  await expect(page.locator("[data-hub-strip]").getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "true");
  await expect(page.locator("aside").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(page.locator("[data-home-line='need']").first()).toContainText("Stopped.");
  await expect(page.locator("[data-home-section='recent']")).toHaveCSS("opacity", "1");
  await expect(page.getByText("All quiet.")).toHaveCount(0);
  expect(await page.locator("[data-wp212-window]").innerText()).not.toMatch(/[—–]/);
  const windowBox = await page.locator("[data-wp212-window]").boundingBox();
  expect(windowBox).toBeTruthy();
  expect(windowBox!.width).toBeGreaterThanOrEqual(1440);
  expect(windowBox!.height).toBeGreaterThanOrEqual(900);
  if (testInfo.project.name === "chromium") {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/full.png` });
  }
});
