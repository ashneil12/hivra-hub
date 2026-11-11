import { expect, test } from "@playwright/test";
import { openLocalHub, type SeedProject } from "./localHub";

// WP-210: one Needs you list. The first run of this file, against unchanged code, writes the before shots.
// Example data only. Never Ash's chats.
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECTS: SeedProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/Users/example/Projects/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/example/Projects/hivra" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "heart", folder: "/Users/example/Projects/nibbii" },
  { id: "safetube", name: "SafeTube", shortName: "SafeTube", iconShape: "play", folder: "/Users/example/Projects/safetube" },
];

const NOW = 1_700_000_000_000;

function decision(project: string, key: string, question: string, at: number) {
  return {
    project,
    decisionKey: key,
    question: `Example: ${question}`,
    options: ["Yes", "No"],
    recommended: "Yes",
    askedBy: "lead-session",
    askedByMono: null,
    waiting: [],
    state: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
}

test("rail and home with the example needs list", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript((decisions) => {
    localStorage.setItem("monocode.colorScheme", "dark");
    localStorage.setItem("monocode:dev-decisions", JSON.stringify(decisions));
  }, [
    decision("hivra", "windows-build", "The Windows build stopped after 3 tries.", NOW - 50_000),
    decision("hivra", "merge-217", "Ready to merge #217.", NOW - 40_000),
    decision("vg-game", "hit-flash", "Ship the hit flash?", NOW - 30_000),
    decision("nibbii", "npm-publish", "frank wants to run npm publish in nibbii-web.", NOW - 20_000),
    decision("safetube", "weekly-views", "The Weekly views page asks to read YouTube stats.", NOW - 10_000),
  ]);
  await openLocalHub(page, "", PROJECTS);
  await expect(page.locator("[data-hub-strip]")).toBeVisible({ timeout: 60_000 });
  await page.locator("[data-hub-home]").getByRole("button", { name: "Home" }).click();
  await expect(page.locator("[data-home]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-home-loading]")).toHaveCount(0, { timeout: 30_000 });

  const rail = (id: string) => page.locator(`[data-hub-strip] [data-project-id="${id}"] [data-needs-count]`);
  const agree = async (total: string, hivra: string) => {
    await expect(rail("hivra")).toHaveAttribute("data-needs-count", hivra, { timeout: 30_000 });
    await expect(rail("vg-game")).toHaveAttribute("data-needs-count", "1");
    await expect(rail("nibbii")).toHaveAttribute("data-needs-count", "1");
    await expect(rail("safetube")).toHaveAttribute("data-needs-count", "1");
    await expect(page.locator("[data-home-needs-count]")).toHaveAttribute("data-home-needs-count", total);
    await expect(page.locator("[data-sidebar-needs-count]")).toHaveAttribute("data-sidebar-needs-count", total);
    const header = page.locator("[data-hub-project-header]");
    const id = await header.getAttribute("data-project-id");
    expect(id).toBeTruthy();
    await expect(header.locator("[data-project-needs]")).toHaveAttribute("data-project-needs", (await rail(id!).getAttribute("data-needs-count")) ?? "");
    const marks = page.locator("[data-inbox-needs]");
    await expect(marks.first()).toHaveAttribute("data-inbox-needs", total);
    const count = await marks.count();
    for (let i = 1; i < count; i++) await expect(marks.nth(i)).toHaveAttribute("data-inbox-needs", total);
  };

  await agree("5", "2");
  const beforeDir = process.env.WP210_SHOTS ?? "docs/hivra/work/shots/wp-210/before";
  await page.screenshot({ path: `${beforeDir}/home.png` });
  await page.locator("[data-hub-strip]").screenshot({ path: `${beforeDir}/rail.png` });

  await page.locator("[data-needs-project='hivra'] [data-needs-answer]").first().click();
  await agree("4", "1");
  const afterDir = beforeDir.replace(/\/before\/?$/, "/after");
  await page.screenshot({ path: `${afterDir}/home.png` });
  await page.locator("[data-hub-strip]").screenshot({ path: `${afterDir}/rail.png` });
});
