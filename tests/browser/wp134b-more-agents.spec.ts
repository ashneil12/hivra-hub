import { expect, test } from "@playwright/test";

test("More agents stays off until it is switched on", async ({ page }) => {
  await page.goto("/tests/browser/wp134b-more-agents.html");

  const toggle = page.getByRole("switch", { name: "More agents" });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("Off until you switch it on.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add agent" })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("button", { name: "Add agent" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "More agents" })).toBeChecked();

  await page.getByRole("switch", { name: "More agents" }).click();
  await page.reload();
  await expect(page.getByRole("switch", { name: "More agents" })).not.toBeChecked();

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});

test("a local command is kept, it waits for an approval, and a built-in name is refused", async ({ page }) => {
  await page.goto("/tests/browser/wp134b-more-agents.html");
  await page.getByRole("switch", { name: "More agents" }).click();

  await page.getByLabel("Agent name").fill("My Copilot");
  await page.getByLabel("Command").fill("/opt/agents/copilot");
  await page.getByLabel("Arguments").fill("acp\nhello world");
  await page.getByRole("button", { name: "Add agent" }).click();

  const list = page.locator("[data-agent-list]");
  await expect(list).toContainText("My Copilot");
  await expect(list).toContainText("/opt/agents/copilot");
  await expect(list).toContainText("2 arguments");
  await expect(list).toContainText("Not allowed to run yet.");
  // Every argument is on screen, exactly, and the file it resolves to.
  await expect(list.locator("[data-agent-exact]")).toHaveText("/opt/agents/copilot acp hello world");
  await expect(list.locator("[data-agent-resolved]")).toHaveText("/opt/agents/copilot");

  await page.getByRole("button", { name: "Allow My Copilot" }).click();
  await expect(page.locator("[data-agent-list]")).toContainText("Allowed to run.");

  await page.getByRole("button", { name: "Start a chat with My Copilot" }).click();
  await expect(page.locator("[data-chat-request]")).toHaveAttribute("data-chat-request", "my-copilot");

  await page.getByLabel("Agent name").fill("Claude");
  await page.getByLabel("Command").fill("/opt/agents/copilot");
  await page.getByRole("button", { name: "Add agent" }).click();
  await expect(
    page.getByText("This is one of Hivra's own agent CLIs. Set it up under Agent CLIs instead."),
  ).toBeVisible();
  await expect(page.locator("[data-agent-list] li")).toHaveCount(1);

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});

test("a bad entry is skipped and does not wipe the list", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "wp134b-list",
      JSON.stringify({
        revision: 2,
        agents: [
          {
            id: "good",
            name: "Good",
            command: "good-agent",
            args: [],
            protocol: "acp-v1",
          },
          {
            id: "claude",
            name: "Nope",
            command: "../secret-value",
            args: [],
            protocol: "acp-v1",
          },
        ],
        approved: [],
      }),
    );
  });
  await page.goto("/tests/browser/wp134b-more-agents.html");
  await page.getByRole("switch", { name: "More agents" }).click();

  await expect(page.locator("[data-agent-list]")).toContainText("Good");
  await expect(page.getByText("Nope was skipped.")).toBeVisible();
  await expect(page.locator("[data-agent-list] li")).toHaveCount(1);

  const text = await page.locator("body").innerText();
  expect(text).not.toContain("secret-value");
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});

test("an entry allowed or edited in the same visit starts, or is refused, without a reload", async ({ page }) => {
  await page.goto("/tests/browser/wp134b-more-agents.html");
  await page.getByRole("switch", { name: "More agents" }).click();

  await page.getByLabel("Agent name").fill("Copilot");
  await page.getByLabel("Command").fill("/opt/agents/copilot");
  await page.getByRole("button", { name: "Add agent" }).click();
  await page.getByRole("button", { name: "Start a chat with Copilot" }).click();
  await expect(page.getByText("This agent is not approved to run. Allow it in More agents first.")).toBeVisible();
  await expect(page.locator("[data-chat-request]")).toHaveCount(0);

  // Allowed in this visit, then started in the same visit: no reload in between.
  await page.getByRole("button", { name: "Allow Copilot" }).click();
  await page.getByRole("button", { name: "Start a chat with Copilot" }).click();
  await expect(page.locator("[data-chat-request]")).toHaveAttribute("data-chat-request", "copilot");

  // Removed and added again with another command: the old allowance does not carry over, and the refusal shows.
  await page.getByRole("button", { name: "Remove Copilot" }).click();
  await page.getByLabel("Agent name").fill("Copilot");
  await page.getByLabel("Command").fill("/opt/agents/other");
  await page.getByRole("button", { name: "Add agent" }).click();
  await page.getByRole("button", { name: "Start a chat with Copilot" }).click();
  await expect(page.getByText("This agent is not approved to run. Allow it in More agents first.")).toBeVisible();
  await expect(page.locator("[data-agent-list]")).toContainText("Not allowed to run yet.");
});
