// The hub's own local store for a browser proof (WP-04: no Ash OS). hub-dev.html?local reads it from the page's
// localStorage (src/dev/browserTauriMock.ts, `monocode:dev-local-hub:<key>`); this seeds it before the app loads, once
// per page, so a reload keeps what the app wrote. The same four projects the old Ash OS stub had.
import type { Page } from "@playwright/test";

export type SeedProject = { id: string; name: string; shortName: string; iconShape: string; folder: string | null };

export const EXAMPLE_PROJECTS: SeedProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/Users/example/Projects/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/example/Projects/hivra" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "heart", folder: "/Users/example/Projects/nibbii" },
  { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "code", folder: "/Users/example/Projects/monocode-hub" },
];

/** Seeds the local store, then opens hub-dev.html?local (plus `query`, e.g. "&fakeClaude"). */
export async function openLocalHub(page: Page, query = "", projects: SeedProject[] = EXAMPLE_PROJECTS): Promise<void> {
  await page.addInitScript((list) => {
    const key = "monocode:dev-local-hub:projects";
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ projects: list }));
  }, projects);
  await page.goto(`/hub-dev.html?local${query}`);
}
