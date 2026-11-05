import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp85-terminal.html";

test("a terminal session appears live and can be attached to a task", async ({ page }) => {
  await page.goto(pageUrl);
  const chats = page.getByRole("list", { name: "Chats" });
  await expect(chats.getByText("terminal")).toHaveCount(0);

  await page.getByRole("button", { name: "Session started" }).click();
  const item = chats.getByRole("listitem").filter({ hasText: "terminal" });
  await expect(item).toContainText("Running");
  await expect(item).toContainText("/work/notes");

  await item.getByRole("button").click();
  await expect(page.getByText("hello from the terminal")).toBeVisible();

  await page.getByRole("combobox", { name: "Task" }).selectOption({ label: "#1 Write" });
  await page.getByRole("button", { name: "Attach to task" }).click();
  await expect(page.getByRole("article", { name: "Task 1" })).toContainText("Terminal session");
  const attached = await page.evaluate(() =>
    (window as unknown as { __mirrorCalls: { command: string; args: { sessionId?: string; taskId?: string } }[] }).__mirrorCalls.filter(
      (call) => call.command === "terminal_mirror_attach",
    ),
  );
  expect(attached).toEqual([{ command: "terminal_mirror_attach", args: { sessionId: "s1", taskId: "task-1" } }]);
});

test("turning sessions on shows what it adds before it installs", async ({ page }) => {
  await page.goto(pageUrl);
  const toggle = page.getByRole("switch", { name: "Show my terminal Claude sessions" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(page.getByRole("button", { name: "Turn it on" })).toBeVisible();
  await expect(page.getByText("No login and no token")).toBeVisible();
  const before = await page.evaluate(() =>
    (window as unknown as { __mirrorCalls: { command: string; args: { enabled?: boolean } }[] }).__mirrorCalls.filter(
      (call) => call.command === "terminal_mirror_set",
    ),
  );
  expect(before).toEqual([]);
  await page.getByRole("button", { name: "Turn it on" }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const after = await page.evaluate(() =>
    (window as unknown as { __mirrorCalls: { command: string; args: { enabled?: boolean } }[] }).__mirrorCalls.filter(
      (call) => call.command === "terminal_mirror_set",
    ),
  );
  expect(after[0]?.args.enabled).toBe(true);
});
