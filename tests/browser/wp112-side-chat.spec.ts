import { expect, test } from "@playwright/test";

type ParentBlock = { id: string; role: string; text: string };

type Probe = {
  blocks: ParentBlock[];
  submits: number;
};

async function parent(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { __wp112: Probe }).__wp112;
    return {
      submits: probe.submits,
      blocks: probe.blocks.map((block) => ({
        id: block.id,
        role: block.role,
        text: block.text,
      })),
    };
  });
}

test("a side question shows a recap and comes back as a draft", async ({
  page,
}) => {
  await page.goto("/tests/browser/wp112-side-chat.html");
  await expect(
    page.getByRole("button", { name: "Side question" }),
  ).toBeVisible();
  const before = await parent(page);

  await page.getByRole("button", { name: "Side question" }).click();
  const recap = page.locator("[data-side-recap]");
  await expect(recap).toContainText("Recap");
  await expect(recap).toContainText("You: Explain the parser");
  await expect(recap).toContainText("Assistant: It changes the parser.");
  await expect(recap).toContainText("Current file: src/parser.ts (+2 -0)");

  await page.getByRole("tab", { name: "Why the parser?" }).click();
  await page.getByRole("button", { name: "Add to the main chat" }).click();

  await expect(page.locator("[data-session-composer] textarea")).toHaveValue(
    "It splits tokens.\n\n",
  );
  const after = await parent(page);
  expect(after.submits).toBe(0);
  expect(after.blocks).toEqual(before.blocks);
  await expect(page.getByText("Explain the parser", { exact: true })).toBeVisible();
});
