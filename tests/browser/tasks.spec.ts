import { expect, test } from "@playwright/test";

// WP-70. The real task pane: the list, a new task, an assignee, and a comment.
test.use({ viewport: { width: 960, height: 640 } });

test("a person lists, adds and assigns a task", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/tasks.html");
  await expect(page.getByRole("button", { name: "#4 Fix the save" })).toBeVisible();
  await page.getByRole("button", { name: "#4 Fix the save" }).click();
  await expect(page.getByText("recorded")).toBeVisible();
  await expect(page.getByText("Needs you")).toBeVisible();
  await page.getByLabel("Comment").fill("Please look");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByText("Please look")).toBeVisible();

  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByLabel("Task title").fill("Write the notes");
  await page.getByLabel("New task assignee").fill("mate-2");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("button", { name: "#2 Write the notes" })).toBeVisible();
  await expect(page.getByText("Assigned to mate-2")).toBeVisible();

  await page.getByLabel("Assignee").fill("mate-3");
  await page.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByText("Assigned to mate-3")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("tasks.png") });
});

// WP-250: a first mate takes unassigned tasks that match its rule.
test("a person sets which tasks a first mate picks up", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/tasks.html");
  await page.getByRole("button", { name: "Pickup rules" }).click();
  const rules = page.getByRole("region", { name: "Pickup rules" });
  await expect(rules.getByText("No rules yet.")).toBeVisible();

  await rules.getByLabel("First mate").fill("mate-1");
  await rules.getByRole("button", { name: "Save rule" }).click();
  await expect(rules).toContainText("would take every task");

  await rules.getByLabel("Statuses").fill("Todo");
  await rules.getByLabel("Labels").fill("bug, ui");
  await rules.getByRole("button", { name: "Save rule" }).click();
  await expect(rules).toContainText("mate-1: Takes unassigned tasks in this project with status Todo, labelled bug and ui");
  await page.screenshot({ path: testInfo.outputPath("pickup-rules.png") });

  await rules.getByRole("button", { name: "Turn off" }).click();
  await expect(rules).toContainText("(off)");
  await rules.getByRole("button", { name: "Remove" }).click();
  await expect(rules.getByText("No rules yet.")).toBeVisible();
});
