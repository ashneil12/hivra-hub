import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp166-repo-watch.html";
const planted = `ghp_${"a".repeat(36)}`;

const oneRepo = JSON.stringify({
  pins: [
    {
      url: "https://github.com/acme/web",
      licence: "MIT",
      pinSha: "abc1234",
      notes: "door",
    },
  ],
});

test("starts empty and imports a pin file", async ({ page }) => {
  await page.goto(pageUrl);
  const list = page.locator("#list");
  await expect(list.getByText("No repositories are pinned yet.")).toBeVisible();

  await page.evaluate(() => {
    window.repoWatch.file = null;
  });
  await list.getByRole("button", { name: "Import a file" }).click();
  await expect(list.getByText("No repositories are pinned yet.")).toBeVisible();

  await page.evaluate((body) => {
    window.repoWatch.files["pins.json"] = body;
    window.repoWatch.file = "/tmp/pins.json";
  }, oneRepo);
  await list.getByRole("button", { name: "Import a file" }).click();
  await expect(list.getByRole("link", { name: "acme/web" })).toBeVisible();
  await expect(list.getByText("MIT, abc1234")).toBeVisible();
  await expect(list.getByText("door")).toBeVisible();
  await expect(list.getByText("Added 1 repository.")).toBeVisible();
  await expect(list.getByRole("link", { name: "acme/web" })).toHaveAttribute(
    "href",
    "https://github.com/acme/web",
  );
});

test("does not show a token or a home path", async ({ page }) => {
  await page.goto(pageUrl);
  const list = page.locator("#list");
  const notes = `see ${planted} in /Users/example/notes`;
  await page.evaluate((body) => {
    window.repoWatch.files["secret.json"] = body;
    window.repoWatch.file = "/tmp/secret.json";
  }, JSON.stringify({ pins: [{ url: "acme/web", notes }] }));
  await list.getByRole("button", { name: "Import a file" }).click();
  await expect(list.getByText("acme/web")).toBeVisible();
  await expect(list.getByText(planted)).toHaveCount(0);
  await expect(list.getByText("/Users/example")).toHaveCount(0);
  await expect(list.getByText("[secret removed]")).toBeVisible();
  await expect(list.getByText("a local path")).toBeVisible();
});

test("a folder import prefers repo-pins.json", async ({ page }) => {
  await page.goto(pageUrl);
  const list = page.locator("#list");
  await page.evaluate((preferred) => {
    window.repoWatch.files["repo-pins.json"] = preferred;
    window.repoWatch.files["repos.json"] = JSON.stringify({
      repos: [{ repo: "other/skip", license: "MIT" }],
    });
    window.repoWatch.folder = "/work/picked";
  }, oneRepo);
  await list.getByRole("button", { name: "Import a folder" }).click();
  await expect(list.getByRole("link", { name: "acme/web" })).toBeVisible();
  await expect(list.getByText("other/skip")).toHaveCount(0);
});

test("says when a folder has no pin file", async ({ page }) => {
  await page.goto(pageUrl);
  const list = page.locator("#list");
  await page.evaluate(() => {
    window.repoWatch.files = {};
    window.repoWatch.folder = "/work/empty";
  });
  await list.getByRole("button", { name: "Import a folder" }).click();
  await expect(list.getByText("That folder has no pin file.")).toBeVisible();
  await expect(list.getByText("No repositories are pinned yet.")).toBeVisible();
});

test("a late load does not wipe an import", async ({ page }) => {
  await page.goto(pageUrl);
  const late = page.locator("#late");
  await page.waitForFunction(() => window.repoWatch.loadStarted);
  await page.evaluate((body) => {
    window.repoWatch.files["late.json"] = body;
    window.repoWatch.file = "/tmp/late.json";
  }, oneRepo);
  await late.getByRole("button", { name: "Import a file" }).click();
  await expect(late.getByRole("link", { name: "acme/web" })).toBeVisible();
  await page.evaluate(() => window.repoWatch.releaseLoad());
  await expect(late.getByRole("link", { name: "acme/web" })).toBeVisible();
  await expect(late.getByText("Added 1 repository.")).toBeVisible();
});

test("turns the weekly check on without removing it when switched off", async ({ page }) => {
  await page.goto(pageUrl);
  const habit = page.locator("#habit");
  const toggle = habit.getByRole("switch", { name: "Watch upstream repos" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => window.repoWatchHabits.map((habit) => habit.id))).toEqual(["repo-watch"]);
  await expect.poll(() => page.evaluate(() => window.repoWatchHabits[0]?.enabled)).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => page.evaluate(() => window.repoWatchHabits)).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.repoWatchHabits[0]?.enabled)).toBe(false);
});

test("leaves the switch up when habits cannot be read", async ({ page }) => {
  await page.goto(pageUrl);
  const down = page.locator("#habit-down");
  await expect(down.getByRole("switch", { name: "Watch upstream repos" })).toBeVisible();
  await expect(down.getByText("Could not read habits this time.")).toBeVisible();
});

test("asks for a project before it offers import", async ({ page }) => {
  await page.goto(pageUrl);
  const none = page.locator("#none");
  await expect(none.getByText("Open a project first.")).toBeVisible();
  await expect(none.getByRole("button")).toHaveCount(0);
});

declare global {
  interface Window {
    repoWatch: {
      file: string | null;
      folder: string | null;
      files: Record<string, string>;
      loadStarted: boolean;
      releaseLoad: () => void;
    };
    repoWatchHabits: { id: string; enabled: boolean }[];
  }
}
