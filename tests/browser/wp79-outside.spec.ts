import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp79-outside.html";

test("a late reply does not bring back a connection that is already gone", async ({ page }) => {
  await page.goto(pageUrl);
  const late = page.locator("#late");
  await late.getByRole("checkbox", { name: "Let AI tools on this computer read Hivra" }).click();
  await expect(late.getByText("Nothing is connected.")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { releaseStale: () => Promise<void> }).releaseStale(),
  );
  await expect(late.getByText("Stale")).toHaveCount(0);
  await expect(late.getByText("Nothing is connected.")).toBeVisible();
});

test("shows a connection and disconnects it", async ({ page, browserName }) => {
  await page.goto(pageUrl);
  const grant = page.locator("#grant");
  await expect(grant.getByText("Desk")).toBeVisible();
  await expect(grant.getByText("Read only")).toBeVisible();
  await expect(grant.getByText("Hivra", { exact: true })).toBeVisible();
  await expect(grant.getByText("1970-01-01 00:00")).toBeVisible();
  await expect(grant.getByText("http://127.0.0.1:9/mcp")).toBeVisible();
  if (browserName === "chromium") {
    await grant.screenshot({ path: "tests/browser/wp79-outside.png" });
  }
  await grant.getByRole("button", { name: "Disconnect" }).click();
  await expect(grant.getByText("Nothing is connected.")).toBeVisible();
  await expect(grant.getByText("Desk")).toHaveCount(0);
});

test("asks for a project before it allows a tool to read", async ({ page }) => {
  await page.goto(pageUrl);
  const ask = page.locator("#ask");
  await expect(ask.getByText("Claude wants to read Hivra.")).toBeVisible();
  await ask.getByRole("button", { name: "Allow read access" }).click();
  await expect(ask.getByText("Pick a project first.")).toBeVisible();
  await expect(page.locator("#done")).toHaveText("");

  await ask.getByRole("checkbox", { name: "Hivra", exact: true }).check();
  await ask.getByRole("button", { name: "Allow read and task writes" }).click();
  await expect(page.locator("#done")).toHaveText("hivra write=true");
  await expect(ask.getByText("Claude wants to read Hivra.")).toHaveCount(0);
  await expect(ask.getByText("Finish in the browser window.")).toBeVisible();
  await expect(page.getByText("secret-code")).toHaveCount(0);
  await expect(page.getByText("code=")).toHaveCount(0);
});

test("says the browser was not sent on when there is no redirect", async ({ page }) => {
  await page.goto(pageUrl);
  const miss = page.locator("#miss");
  await miss.getByRole("checkbox", { name: "Hivra", exact: true }).check();
  await miss.getByRole("button", { name: "Allow read access" }).click();
  await expect(miss.getByRole("alert")).toHaveText("The browser was not sent on.");
  await expect(miss.getByText("Finish in the browser window.")).toHaveCount(0);
});
