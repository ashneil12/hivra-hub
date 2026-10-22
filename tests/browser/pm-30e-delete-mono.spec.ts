import { expect, test } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";
import { ringContrast } from "./contrastProbe";

// Round 30e proof (the real app in a browser, not Ash's Mac; made-up data labelled Example:): "Delete mono…" asks in
// the shared confirm, not the native sheet: "Delete “Example: Pip”?", what else goes, "This can't be undone.", Cancel
// focused with its ring showing, a red Delete, a darker overlay behind. Cancel keeps the Mono.
//   PM_PROOF_SPEC=pm-30e-delete-mono.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs/on-r47 npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-30e";
let stub: { url: string; close(): Promise<void> };
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());

test("Delete mono… asks in the shared confirm; Cancel keeps the Mono", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  let nativeAsk = false;
  page.on("dialog", (d) => { nativeAsk = true; void d.dismiss(); });
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 20_000 }).then(() => notNow.click(), () => undefined);
  const row = page.locator("[data-mono-status]", { hasText: "Alfred" }).first();
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await row.hover();
  await row.locator('button[title="Mono options"]').click();
  const nameBox = page.getByRole("textbox", { name: "Mono name" });
  await nameBox.fill("Example: Pip");
  await nameBox.press("Enter");
  const pip = page.locator("[data-mono-status]", { hasText: "Example: Pip" }).first();
  await expect(pip).toHaveCount(1);
  // Open its chat once, so it has one to delete (the dev data's Monos start with none).
  await pip.locator("button[title]").first().click();
  await expect
    .poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { name?: string; sessionId?: string }[]).find((m) => m.name === "Example: Pip")?.sessionId ?? null), { timeout: 20_000 })
    .not.toBeNull();
  await pip.hover();
  await pip.locator('button[title="Mono options"]').click();
  await page.getByRole("menuitem", { name: "Delete mono…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete “Example: Pip”?");
  await expect(dialog).toContainText("Its current chat will be deleted and its habits stop. Its soul and memory are kept. This can't be undone.");
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  expect(await cancel.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
  expect((await ringContrast(page)).ratio).toBeGreaterThanOrEqual(3);
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toHaveClass(/text-red-400/);
  await expect(page.locator("[data-modal-scrim]")).toHaveClass(/confirm-scrim/);
  expect(nativeAsk).toBe(false);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-30e-delete-mono-1512.png` });
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(pip).toHaveCount(1);
});
