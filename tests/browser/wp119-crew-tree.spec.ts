import { expect, test } from "@playwright/test";

test("the crew tree and its detail", async ({ page }) => {
  await page.goto("/tests/browser/wp119-crew-tree.html");
  const tree = page.locator("#tree");
  await expect(tree.locator("[data-role='mate']")).toContainText("Lead");
  await expect(tree.locator("[data-role='worker']")).toHaveCount(2);
  await expect(tree.locator("[data-crew-node='a']")).toContainText("Fix the save");
  await expect(tree.locator("[data-crew-node='b'] [data-latest-tool]")).toHaveText("Read notes");
  await expect(tree.locator("[data-crew-node='subagent:chat-a:sub1']")).toContainText("Check the save");
  await expect(tree.locator("[data-crew-tree]")).not.toContainText("running");
  await expect(tree.locator("[data-crew-tree]")).not.toContainText("—");
  await expect(tree.locator("[data-crew-tree]")).not.toContainText("–");

  await tree.locator("[data-crew-node='subagent:chat-a:sub1']").click();
  const detail = tree.locator("[data-crew-detail]");
  await expect(detail.locator("[data-crew-brief]")).toHaveText("Check the save");
  await expect(detail.locator("[data-tool-call='s1']")).toContainText("Read the file");
  await expect(detail.locator("[data-tool-call='s1']")).toContainText("working");
  await detail.getByRole("button", { name: "Open the chat" }).click();
  await expect(tree.locator("[data-opened]")).toHaveText("chat-a");

  await expect(page.locator("#empty")).toContainText("No one is on this yet.");
  await expect(page.locator("#empty [data-crew-node]")).toHaveCount(0);
  await expect(page.locator("#mate [data-crew-node='mate:lead']")).toContainText("Lead");
  await expect(page.locator("#mate")).not.toContainText("No one is on this yet.");
});
