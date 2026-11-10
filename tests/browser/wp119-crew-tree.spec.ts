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

  const inbox = page.locator("#inbox");
  const rows = inbox.locator("[data-inbox-kind]");
  await expect(rows.first()).toHaveAttribute("data-inbox-kind", "decision");
  await expect(rows.first()).toContainText("Oldest question");
  await expect(rows.first()).toContainText("waiting 20 minutes");
  await expect(rows.nth(1)).toContainText("Newer question");
  const kinds = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-inbox-kind")));
  expect(kinds.indexOf("credential")).toBeGreaterThan(kinds.lastIndexOf("decision"));
  expect(kinds.indexOf("failure")).toBeGreaterThan(kinds.indexOf("credential"));
  await rows.first().getByRole("button", { name: "Open the chat" }).click();
  await expect(inbox.locator("[data-inbox-opened]")).toHaveText("chat-old");
});
