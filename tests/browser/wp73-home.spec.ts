import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

// WP-73. Home on the real strip: sections show and hide, a moving task changes live, a line opens its place,
// and an arrangement survives a reload.
test.use({ viewport: { width: 1100, height: 760 } });

test("home lists what needs the person, follows a task as it moves, and keeps an arrangement", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp73-home.html");
  const strip = page.locator("[data-hub-strip]");
  await expect(strip.locator("button").first()).toHaveAttribute("aria-label", "Home");
  await expect(page.locator("[data-hub-home] button")).toHaveAttribute("aria-current", "true");

  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Moving now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Crew · Should we ship?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Crew · Which font?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Crew · Read the spec" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Crew · Write the notes · Ada" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Plan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lead chat" })).toBeVisible();
  await expect(page.locator("[data-home-section='recent'] [data-home-line]").first()).toHaveAttribute("data-home-line", "doc");
  await expect(page.locator("[data-home-empty]")).toHaveCount(0);
  await expect(page.locator("[data-count]")).toHaveCount(0);

  await page.getByRole("button", { name: "Crew · Should we ship?" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", JSON.stringify({ kind: "inbox", projectId: "crew", decisionKey: "ship" }));
  await expect(page.locator("article[data-selected='true']")).toHaveAttribute("data-decision-key", "ship");
  await expect(page.locator("article[data-selected='true']")).toContainText("Should we ship?");
  await page.getByRole("button", { name: "Crew · Which font?" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", JSON.stringify({ kind: "task", projectId: "crew", id: "font" }));
  await page.getByRole("button", { name: "Plan" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", JSON.stringify({ kind: "doc", id: "plan" }));
  await page.getByRole("button", { name: "Lead chat" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened", JSON.stringify({ kind: "chat", id: "c1", projectId: "crew" }));
  await expect(page.locator("[data-hub-home] button")).not.toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("region", { name: "Opened chat" })).toHaveAttribute("data-open-id", "c1");

  // The button sits outside the shell and under it. Calling click on the element itself still runs its listener.
  await page.locator("#task-moved").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("button", { name: "Crew · Write the notes now · Ada" })).toBeVisible();

  await page.getByRole("button", { name: "Hide Moving now" }).click();
  await expect(page.getByRole("heading", { name: "Moving now" })).toHaveCount(0);
  await page.getByRole("button", { name: "Hide Recent" }).click();
  await expect(page.getByRole("heading", { name: "Recent" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show Moving now" }).click();
  await page.getByRole("button", { name: "Show Recent" }).click();
  await expect(page.getByRole("heading", { name: "Moving now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();

  await page.getByRole("button", { name: "Move Recent up" }).click();
  await expect(page.locator("[data-home]")).toHaveAttribute("data-home-order", "needs-you projects recent moving-now");
  await page.getByRole("button", { name: "Hide Needs you" }).click();
  await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(0);
  await page.getByRole("button", { name: "Pin Example board" }).click();
  await expect(page.locator("[data-home]")).toHaveAttribute("data-home-order", "projects recent moving-now panel:my-panels:board");
  await expect(page.frameLocator("iframe[title='Example board']").getByText("Example: board")).toBeVisible();

  const pinned = page.locator("[data-home-section='panel:my-panels:board']");
  await pinned.scrollIntoViewIfNeeded();
  await expect(pinned).toHaveCSS("opacity", "1");
  mkdirSync("docs/hivra/work/proofs/wp-73", { recursive: true });
  await page.locator("[data-wp73-shell]").screenshot({ path: `docs/hivra/work/proofs/wp-73/${testInfo.project.name}.png` });

  await page.reload();
  await expect(page.locator("[data-home]")).toHaveAttribute("data-home-order", "projects recent moving-now panel:my-panels:board");
  await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(0);
});

test("an empty home says all quiet and offers a chat, with no empty section", async ({ page }) => {
  await page.goto("/tests/browser/wp73-home.html?empty=1");
  await expect(page.getByText("All quiet.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Moving now" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recent" })).toHaveCount(0);
  await expect(page.locator("[data-home-start]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a chat with Crew" })).toHaveCount(0);
});

test("with no project at all, home says the projects are still in Ash OS and offers to bring them over", async ({ page }) => {
  await page.goto("/tests/browser/wp73-home.html?noprojects=1");
  const note = page.locator("[data-home-no-projects]");
  await expect(note).toContainText("Your projects haven't come over from Ash OS yet.");
  await expect(note.getByRole("button", { name: "Bring them over" })).toBeVisible();
  await expect(page.getByText("All quiet.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Projects" })).toHaveCount(0);
  // An ask with nowhere to file it says so, instead of asking which project.
  await page.getByLabel("Ask").fill("Write the notes");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("[data-home-reply]")).toContainText("There are no projects yet.");
  await expect(note.getByRole("button", { name: "New project" })).toBeVisible();
});
