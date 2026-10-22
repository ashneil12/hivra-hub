import { expect, test } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";
import { ringContrast } from "./contrastProbe";

// Round 30d proof (the real app in a browser, not Ash's Mac; made-up data labelled Example:): the one shared delete
// confirm. Ash makes a room, then deletes it from the sidebar: "Delete Example: launch room?", "This can't be undone.",
// Cancel focused (Enter cancels) and a red Delete. After Cancel the room is still there.
//   PM_PROOF_SPEC=pm-30d-delete-confirm.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs/on-r47 npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-30d";
let stub: { url: string; close(): Promise<void> };
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());

test("deleting a room asks first in the shared confirm; Cancel (and Enter) keep it", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 20_000 }).then(() => notNow.click(), () => undefined);
  const card = page.locator("[data-hub-home-projects] > div", { hasText: "Hivra" }).first();
  await card.scrollIntoViewIfNeeded({ timeout: 60_000 });
  await card.getByRole("button", { name: "Being built", exact: true }).click();
  await page.locator("[data-hub-new-chat-button]").click();
  await page.getByRole("textbox").first().fill("Example: launch room");
  await page.locator("[data-hub-create-chat]").click();
  const roomRow = page.locator("[data-hub-room-row]", { hasText: "Example: launch room" });
  await expect(roomRow).toHaveCount(1, { timeout: 20_000 });
  await roomRow.hover();
  await roomRow.locator("[data-hub-room-delete]").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete Example: launch room?");
  await expect(dialog).toContainText("This can't be undone.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveClass(/text-red-400/);
  // r30e: Cancel's focus ring shows from the start (it was focused by the dialog, not by a key), the ring passes 3:1
  // against the dialog's surface, and a darker overlay sits behind the dialog.
  const ring = await dialog.getByRole("button", { name: "Cancel" }).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe("none");
  const contrast = await ringContrast(page);
  console.log("focus ring contrast", JSON.stringify(contrast));
  expect(contrast.ratio).toBeGreaterThanOrEqual(3);
  await expect(page.locator("[data-modal-scrim]")).toHaveClass(/confirm-scrim/);
  expect(await page.locator("[data-modal-scrim]").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0.55)");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-30d-delete-confirm-1512.png` });
  // Enter with the focus where it starts is Cancel: the room stays.
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(roomRow).toHaveCount(1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/pm-30d-after-cancel-1512.png` });
});
