import { expect, test } from "@playwright/test";

// WP-06: what Today, Being built and Needs you showed, and WP-15 kept, is on the Crew tab or in the Inbox.
// The hourly digest is WP-15's own spec. This one only checks the fields those screens used to be the only place for.
const START = 1_700_000_000_000;

test("work that left Today and Being built is on the crew or in the inbox", async ({ page }) => {
  await page.clock.install({ time: new Date(START) });
  await page.goto("/tests/browser/wp15-crew.html");

  const row = (id: string) => page.locator(`[data-crew-row='${id}']`);
  await expect(row("working")).toContainText("working");
  await expect(row("needs")).toContainText("needs you");
  await expect(row("done")).toContainText("done");
  await expect(row("failed")).toContainText("failed");
  await expect(row("paused")).toContainText("paused");

  // A worker line: title, cli, model, how long, branch and diff. The minus is the row's own character.
  const working = row("working");
  await expect(working).toContainText("Fix the save bug");
  await expect(working).toContainText("claude");
  await expect(working).toContainText("opus");
  await expect(working).toContainText("fix-save");
  await expect(working).toContainText("+12");
  await expect(working).toContainText("−3");
  await expect(working).toContainText("12 min");

  // A finished line: its pull request and the check still going.
  const done = row("done");
  await expect(done).toContainText("Pull request #12");
  await expect(done).toContainText("1 check still going");

  // What needed the person: a decision, a failure with no secret or stack, a credential, a review.
  await expect(page.locator("[data-inbox-kind=decision]")).toContainText("Ship it now?");
  await expect(page.locator("[data-inbox-kind=decision]")).toContainText("Open the chat");
  const failure = page.locator("[data-inbox-kind=failure]");
  await expect(failure).toContainText("The save did not finish.");
  await expect(failure).not.toContainText("sk-");
  await expect(failure).not.toContainText("at save");
  await expect(page.locator("[data-inbox-kind=credential]")).toContainText("Waiting for a usage limit");
  await expect(page.locator("[data-inbox-kind=review]")).toContainText("Ready for review");
});
