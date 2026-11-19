import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

type Call = { command: string; args: Record<string, unknown> };

async function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as unknown as { __cloudCalls: Call[] }).__cloudCalls);
}

async function shot(page: Page, selector: string, path: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`nothing to photograph for ${selector}`);
  const viewport = page.viewportSize() ?? { width: 900, height: 1100 };
  const x = Math.max(0, Math.floor(box.x) - 16);
  const y = Math.max(0, Math.floor(box.y) - 16);
  let width = Math.max(320, Math.ceil(box.width) + 32);
  let height = Math.max(120, Math.ceil(box.height) + 32);
  if (x + width > viewport.width) width = Math.floor(viewport.width - x);
  if (y + height > viewport.height) height = Math.floor(viewport.height - y);
  if (width < 320 || height < 120) throw new Error(`photograph is ${width}x${height}`);
  await page.screenshot({ path, clip: { x, y, width, height } });
}

test.use({ viewport: { width: 900, height: 1100 } });

test("cloud stays off until it is turned on, then signs in and fills Add machine", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp61-cloud.html");
  const cloud = page.getByRole("switch", { name: "Hivra Cloud" });
  await expect(cloud).toBeEnabled();
  await expect(cloud).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-screen='sign-in']")).toHaveCount(0);
  await expect(page.locator("[data-screen='machines']")).toHaveCount(0);
  const before = await calls(page);
  expect(before.some((call) => call.command === "hivra_cloud_save")).toBe(false);
  expect(before.some((call) => call.command === "hivra_cloud_sign_in")).toBe(false);
  expect(before.some((call) => call.command === "hivra_cloud_account")).toBe(false);
  expect(before.some((call) => call.command === "hivra_cloud_pair")).toBe(false);

  await page.getByLabel("Hivra Cloud address").fill("http://cloud.example");
  await cloud.click();
  await expect(page.getByText("The Hivra Cloud address must be https, or http to this Mac.")).toBeVisible();
  expect((await calls(page)).some((call) => call.command === "hivra_cloud_save")).toBe(false);
  await expect(cloud).toHaveAttribute("aria-checked", "false");

  await page.getByLabel("Hivra Cloud address").fill("https://cloud.example");
  await cloud.click();
  await expect(page.locator("[data-screen='sign-in']")).toBeVisible();
  const seen = await calls(page);
  const saved = seen.filter((call) => call.command === "hivra_cloud_save");
  // The address is saved on blur while the switch stays off. Only the switch turns Cloud on.
  expect(saved).toEqual([
    { command: "hivra_cloud_save", args: { enabled: false, endpoint: "https://cloud.example", expectedRevision: 0 } },
    { command: "hivra_cloud_save", args: { enabled: true, endpoint: "https://cloud.example", expectedRevision: 1 } },
  ]);
  expect(seen.some((call) => call.command === "hivra_cloud_sign_in")).toBe(false);
  expect(seen.some((call) => call.command === "hivra_cloud_account")).toBe(false);
  expect(seen.some((call) => call.command === "hivra_cloud_pair")).toBe(false);
  mkdirSync("docs/hivra/work/proofs/wp-61", { recursive: true });
  await shot(page, "[data-screen='sign-in']", `docs/hivra/work/proofs/wp-61/${testInfo.project.name}-sign-in.png`);

  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("[data-screen='machines']")).toBeVisible();
  const signIn = (await calls(page)).filter((call) => call.command === "hivra_cloud_sign_in");
  expect(signIn).toEqual([{ command: "hivra_cloud_sign_in", args: {} }]);
  expect(JSON.stringify(signIn[0].args)).not.toMatch(/token|key|secret/i);

  await expect(page.getByRole("alert")).toContainText(
    "Hivra Cloud can't be reached right now. Your own machines still work.",
  );
  await expect(page.getByLabel("Pairing code")).toBeVisible();
  await page.getByLabel("Pairing code").fill("ABCD-1234");
  await page.locator("[data-action='pair']").click();
  await expect(page.getByRole("button", { name: "Add this machine" })).toBeVisible();
  const paired = (await calls(page)).filter((call) => call.command === "hivra_cloud_pair");
  expect(paired).toEqual([{ command: "hivra_cloud_pair", args: { code: "ABCD-1234" } }]);
  expect(JSON.stringify(paired[0].args)).not.toMatch(/token|key|secret/i);

  await page.getByRole("button", { name: "Add this machine" }).click();
  await expect(page.getByPlaceholder("user@my-mac-mini or an SSH alias")).toHaveValue("me@cloud");
  await expect(page.getByPlaceholder("Optional, e.g. Home Mac mini")).toHaveValue("Desk");
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
  expect((await calls(page)).some((call) => call.command === "remote_ssh_begin")).toBe(false);
  await shot(page, "[data-screen='machines']", `docs/hivra/work/proofs/wp-61/${testInfo.project.name}-machines.png`);
});

test("an empty address is saved and does not open sign-in", async ({ page }) => {
  await page.goto("/tests/browser/wp61-cloud.html");
  const cloud = page.getByRole("switch", { name: "Hivra Cloud" });
  await expect(cloud).toBeEnabled();
  await cloud.click();
  await expect(page.getByText("Add an address before signing in.")).toBeVisible();
  await expect(page.locator("[data-screen='sign-in']")).toHaveCount(0);
  const saved = (await calls(page)).filter((call) => call.command === "hivra_cloud_save");
  expect(saved).toEqual([{ command: "hivra_cloud_save", args: { enabled: true, endpoint: "", expectedRevision: 0 } }]);
  expect((await calls(page)).some((call) => call.command === "hivra_cloud_sign_in")).toBe(false);
  expect((await calls(page)).some((call) => call.command === "hivra_cloud_account")).toBe(false);
});
