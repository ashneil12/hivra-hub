import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { openLocalHub, openProjectLead } from "./localHub";

// WP-137 (docs/hivra/work/WP-137-workspace-chrome.md): groups on the project strip, "Show only this group", a split
// beside the open chat, and a second window. The real app in a browser reading its own local store, with three chats in
// EXO's folder updated 3, 2 and 1 minutes ago. A second page in the same browser stands in for New Window: it shares
// the group list (localStorage) and has its own view state (sessionStorage), as a second Tauri window does.
//
// The rule under test throughout: none of these steps moves a row. The chat list keeps its order, the strip keeps the
// saved project order, and projects the filter hides come back in their slots.

const SHOTS = process.env.WP137_PROOF_DIR ?? "test-results/wp137-spaces";
const shot = async (page: Page, name: string, engine: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png` });
};

test.use({ viewport: { width: 1440, height: 900 } });

const FOLDER = "/Users/example/Projects/vg-game";
const OLDEST = "c1-oldest";
const MIDDLE = "c2-middle";
const NEWEST = "c3-newest";

function chats(now: number) {
  const chat = (id: string, title: string, minutesAgo: number) => ({
    id, cwd: FOLDER, harness: "claude", model: "claude:sonnet-5", runtimeMode: "supervised", title,
    createdAt: now - 3_600_000, updatedAt: now - minutesAgo * 60_000,
  });
  return [chat(OLDEST, "Oldest chat", 3), chat(MIDDLE, "Middle chat", 2), chat(NEWEST, "Newest chat", 1)];
}

const strip = (page: Page) => page.locator("[data-hub-strip]");
/** The strip's project tiles, top to bottom. */
const tiles = (page: Page) =>
  strip(page).evaluate((nav) =>
    [...nav.querySelectorAll("button[aria-label]")]
      .map((b) => b.getAttribute("aria-label") ?? "")
      .filter((label) => ["EXO", "Hivra", "Nibbii", "MonoCode Hub"].includes(label.replace(/,.*$/, "")))
      .map((label) => label.replace(/,.*$/, "")),
  );
/** The seeded chats as the list shows them, top to bottom. */
const chatOrder = (page: Page) =>
  page.evaluate((ids) => {
    const cards = [...document.querySelectorAll("[data-session-card]")].filter((el) => el.getBoundingClientRect().width > 0);
    return cards.map((el) => el.getAttribute("data-session-card") ?? "").filter((id) => ids.includes(id));
  }, [OLDEST, MIDDLE, NEWEST]);
const EXPECTED_CHATS = [NEWEST, MIDDLE, OLDEST];

async function seed(page: Page, now: number) {
  await page.addInitScript((list) => {
    if (localStorage.getItem("monocode:dev-sessions") === null) {
      localStorage.setItem("monocode:dev-sessions", JSON.stringify(list));
    }
  }, chats(now));
}

async function openExo(page: Page) {
  // Dropwave: EXO opens on its own home; the chat list is beside its lead's chat.
  await expect(strip(page).getByRole("button", { name: /^EXO/ }).first()).toBeVisible({ timeout: 60_000 });
  await openProjectLead(page);
  await expect.poll(() => chatOrder(page), { timeout: 15_000 }).toEqual(EXPECTED_CHATS);
}

test("a group on the strip, Show only this group, a split and a second window, and no row moves", async ({ page, context }, info) => {
  // The whole flow, two cold page loads and a reload: about 27 s in Chromium, so the default 30 s is too tight.
  test.setTimeout(120_000);
  const engine = info.project.name;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(page, Date.now());
  await openLocalHub(page);
  await openExo(page);
  await expect.poll(() => tiles(page)).toEqual(["EXO", "Hivra", "Nibbii", "MonoCode Hub"]);
  // Off by default: no heading, no filter.
  await expect(page.locator("[data-strip-group]")).toHaveCount(0);
  await shot(page, "1-strip-no-groups", engine);

  // Create a group: Nibbii's menu, Group, New group.
  await strip(page).getByRole("button", { name: "Nibbii", exact: true }).click({ button: "right" });
  await page.locator('[data-project-menu-item="Group"]').click();
  await page.locator("[data-project-group-new]").click();
  await page.locator("[data-project-group-new-name]").fill("Side projects");
  await page.locator("[data-project-group-new-name]").press("Enter");
  await expect(page.locator("[data-strip-group]")).toHaveText("Side projects");
  // Hub joins it from its own menu.
  await strip(page).getByRole("button", { name: "MonoCode Hub", exact: true }).click({ button: "right" });
  await page.locator('[data-project-menu-item="Group"]').click();
  await page.locator('[data-project-group-choice="Side projects"]').click();
  await expect(page.locator("[data-strip-group-section]").getByRole("button", { name: "MonoCode Hub", exact: true })).toBeVisible();
  await expect.poll(() => tiles(page)).toEqual(["EXO", "Hivra", "Nibbii", "MonoCode Hub"]);
  // Making a group did not filter, and the chat list did not move.
  await expect(page.locator("[data-strip-show-all]")).toHaveCount(0);
  expect(await chatOrder(page)).toEqual(EXPECTED_CHATS);
  await shot(page, "2-group-made", engine);

  // Show only this group: a second, explicit action from the heading.
  await page.locator("[data-strip-group]").click();
  await page.getByRole("menuitem", { name: "Show only this group" }).click();
  await expect.poll(() => tiles(page)).toEqual(["Nibbii", "MonoCode Hub"]);
  await expect(page.locator("[data-strip-show-all]")).toBeVisible();
  // EXO stays open; its chats stay where they were.
  expect(await chatOrder(page)).toEqual(EXPECTED_CHATS);
  await shot(page, "3-only-this-group", engine);

  // A reload keeps this window's filter and the group.
  await page.reload();
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => tiles(page)).toEqual(["Nibbii", "MonoCode Hub"]);
  await expect(page.locator("[data-strip-group]")).toHaveText("Side projects");
  await expect.poll(() => chatOrder(page), { timeout: 15_000 }).toEqual(EXPECTED_CHATS);

  // Split: open the oldest chat and split it right. Two panes; the oldest chat stays at the bottom of the list.
  await page.locator(`[data-session-card="${OLDEST}"]`).click();
  await expect(page.locator("[data-pane-id]:visible")).toHaveCount(1, { timeout: 15_000 });
  await page.locator("[data-pane-id]:visible").first().click({ position: { x: 200, y: 200 } });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+d" : "Control+d");
  await expect(page.locator("[data-pane-id]:visible")).toHaveCount(2);
  expect(await chatOrder(page)).toEqual(EXPECTED_CHATS);
  await shot(page, "4-split", engine);

  // Move a chat into the split: drag the middle chat from the list onto the right pane.
  const right = page.locator("[data-pane-id]:visible").nth(1);
  const box = (await right.boundingBox())!;
  const source = (await page.locator(`[data-session-card="${MIDDLE}"]`).boundingBox())!;
  await page.mouse.move(source.x + 40, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + 120, source.y + source.height / 2, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20, { steps: 10 });
  await page.mouse.up();
  // The split's empty new chat takes the dropped chat (the pane tree's own rule for a blank pane): still two panes, the
  // middle chat in the right one, opened once, not copied.
  await expect(page.locator(`[data-pane-id="${MIDDLE}"]:visible`)).toHaveCount(1);
  await expect(page.locator("[data-pane-id]:visible")).toHaveCount(2);
  await expect(page.locator(`[data-pane-id="${OLDEST}"]:visible`)).toHaveCount(1);
  expect(await chatOrder(page)).toEqual(EXPECTED_CHATS);
  await shot(page, "5-chat-moved-into-split", engine);

  // A second window: the same group list, its own filter (off), the same chat order.
  const second = await context.newPage();
  await second.goto("/hub-dev.html?local");
  await openExo(second);
  await expect.poll(() => tiles(second)).toEqual(["EXO", "Hivra", "Nibbii", "MonoCode Hub"]);
  await expect(second.locator("[data-strip-group]")).toHaveText("Side projects");
  await expect(second.locator("[data-strip-show-all]")).toHaveCount(0);
  await shot(second, "6-second-window", engine);

  // A rename there reaches the first window, whose filter stays on.
  await second.locator("[data-strip-group]").click();
  await second.getByRole("menuitem", { name: "Rename group" }).click();
  await second.getByLabel("Group name").fill("Side");
  await second.getByLabel("Group name").press("Enter");
  await expect(second.locator("[data-strip-group]")).toHaveText("Side");
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("[data-strip-group]")).toHaveText("Side");
  await expect.poll(() => tiles(page)).toEqual(["Nibbii", "MonoCode Hub"]);
  // Focusing the first window moved nothing.
  expect(await chatOrder(page)).toEqual(EXPECTED_CHATS);
  expect(await chatOrder(second)).toEqual(EXPECTED_CHATS);

  // Show all: every project back in its slot.
  await page.locator("[data-strip-show-all]").click();
  await expect.poll(() => tiles(page)).toEqual(["EXO", "Hivra", "Nibbii", "MonoCode Hub"]);
  await shot(page, "7-show-all", engine);
  expect(errors).toEqual([]);
});
