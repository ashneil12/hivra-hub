import { expect, test } from "@playwright/test";

test("the team switch is off by default, saves an address, and says what is left to do", async ({ page }) => {
  await page.goto("/tests/browser/wp80-team-workspace.html");

  const share = page.getByLabel("Share projects with my team");
  await expect(share).toBeVisible();
  await expect(share).not.toBeChecked();
  await expect(page.getByText("Off. Nothing leaves this computer.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Join" })).toBeDisabled();

  await share.check();
  await expect(share).toBeChecked();
  await expect(page.getByText("On. Add the team server address to start sharing.")).toBeVisible();

  // A plain-http address to somewhere else is refused with the reason, and nothing is saved.
  await page.getByLabel("Team server address").fill("http://sync.example.test/v1");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("the endpoint must be https, or http on this machine")).toBeVisible();

  await page.getByLabel("Team server address").fill("http://127.0.0.1:4010/v1");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Team server address")).toHaveValue("http://127.0.0.1:4010/v1");

  await page.getByLabel("Invitation code").fill("invite-123");
  await page.getByLabel("Your name").fill("ann");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByText("On. Shared projects sync with the team server.")).toBeVisible();

  // The address and the switch survive a reload, and turning off keeps the address for next time.
  await page.reload();
  await expect(page.getByLabel("Share projects with my team")).toBeChecked();
  await expect(page.getByLabel("Team server address")).toHaveValue("http://127.0.0.1:4010/v1");
  await page.getByLabel("Share projects with my team").uncheck();
  await expect(page.getByText("Off. Nothing leaves this computer.")).toBeVisible();
  await page.getByLabel("Share projects with my team").check();
  await expect(page.getByLabel("Team server address")).toHaveValue("http://127.0.0.1:4010/v1");

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
  expect(text).not.toContain("invite-123");
});
