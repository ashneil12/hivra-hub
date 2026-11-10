import { expect, test } from "@playwright/test";

test("proposals show their quotes and are accepted or rejected one at a time", async ({ page }) => {
  await page.goto("/tests/browser/wp83-learn.html");
  await expect(page.getByText("Instruction files stay under 2,000 tokens. Each profile file stays under 1,500.")).toBeVisible();
  await expect(page.getByText("This sends about 1,200 tokens.")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Run once a week" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Include my instruction file" })).not.toBeChecked();
  await expect(page.getByText("A weekly look is ready.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Learn from recent chats" })).toBeDisabled();

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("This sends about 1,200 tokens. Nothing is saved until you accept an edit."),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __accepted?: string[] }).__accepted ?? [])).toEqual(
    [],
  );

  await page.getByRole("button", { name: "Learn from recent chats" }).click();
  await expect(page.getByRole("heading", { name: "Say it once" })).toBeVisible();
  await expect(page.getByText("the launch notes were wrong", { exact: true })).toBeVisible();
  await expect(page.getByText("the launch notes were wrong again", { exact: true })).toBeVisible();
  await expect(page.getByText("+ Say it once")).toBeVisible();
  await expect(page.getByText("seen in two chats")).toBeVisible();

  await page.getByRole("button", { name: "Accept Say it once" }).click();
  await expect(page.getByRole("heading", { name: "Say it once" })).toHaveCount(0);
  await expect(page.getByText("the launch notes were wrong again")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Drop the duplicate" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __accepted: string[] }).__accepted)).toEqual(["p1"]);

  await page.getByRole("button", { name: "Reject Drop the duplicate" }).click();
  await expect(page.getByRole("heading", { name: "Drop the duplicate" })).toHaveCount(0);
  await expect(page.getByText("seen in two chats")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __rejected: string[] }).__rejected)).toEqual(["p2"]);

  await page.getByLabel("Opinions").fill("# Opinions\n\n## Small commits\n");
  await page.getByRole("button", { name: "Save opinions" }).click();
  await expect(page.getByLabel("Opinions")).toHaveValue("# Opinions\n\n## Small commits\n");
});

test("edits a work log retro left waiting show first, and are decided one at a time", async ({ page }) => {
  await page.goto("/tests/browser/wp83-learn.html");
  const waiting = page.getByRole("region", { name: "From the work log" });
  await expect(waiting).toContainText("A retro suggested these. Nothing is saved until you accept one.");
  await expect(waiting.getByRole("heading", { name: "Correction: Keep the work log line short." })).toBeVisible();
  await expect(waiting.getByText("Agents will see this once a second log line backs it.")).toBeVisible();
  await expect(waiting.getByText("Sent back: The brief was thin.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __accepted?: string[] }).__accepted ?? [])).toEqual([]);

  await waiting.getByRole("button", { name: "Accept Work sent back" }).click();
  await expect(waiting.getByRole("heading", { name: "Work sent back" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __accepted: string[] }).__accepted)).toEqual(["retro:two"]);

  await waiting.getByRole("button", { name: "Reject Correction: Keep the work log line short." }).click();
  await expect(waiting).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __rejected: string[] }).__rejected)).toEqual(["retro:one"]);
});
