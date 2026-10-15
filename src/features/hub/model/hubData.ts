import { useSyncExternalStore } from "react";
import { projectKey } from "../../../shared/lib/paths";
import { loadTabGroupLabels, saveTabGroupLabel } from "../../workspace/model/tabGroups";
import { examplesOn } from "./examples";
import { startActivityTracking } from "./hubActivity";
import { HubStore } from "./hubStore";
import { tauriHubTransport } from "./hubTransport";
import { createLiveHubData } from "./liveHubData";
import { mockHubData } from "./mockData";
import type { HubDataSource, HubProject } from "./types";
import { seedHubBundleDefaults } from "./hubBundle";

// Before the first chat is made (App imports this module first): the Hub bundle starts new chats on Claude Code.
seedHubBundleDefaults();

// The app ships clean: it reads Ash OS. The example data answers only behind the dev flag
// (`monocode:hub-examples`, set by hub-dev.html), or when a source is swapped in with `setHubDataSource`.
let override: { source: HubDataSource; store?: HubStore } | undefined;
let chosen: { source: HubDataSource; store?: HubStore } | undefined;

function choose(): { source: HubDataSource; store?: HubStore } {
  if (chosen) return chosen;
  if (examplesOn()) {
    chosen = { source: mockHubData };
  } else {
    const store = new HubStore({
      transport: tauriHubTransport,
      whileRunning: (s) => startActivityTracking((at) => void s.reportActive(at)),
    });
    chosen = { source: createLiveHubData(store), store };
  }
  return chosen;
}

/** The one place the frontend gets hub data from. */
export function hubData(): HubDataSource {
  return (override ?? choose()).source;
}

/**
 * Swap in another source (tests, or a different backend). Pass its store too if the screens should re-render and
 * start it when the data changes.
 */
export function setHubDataSource(next: HubDataSource | undefined, store?: HubStore): void {
  override = next ? { source: next, store } : undefined;
}

const noSubscribe = () => () => undefined;
const noSnapshot = () => undefined;

/**
 * Call this in any component that reads `hubData()` while rendering: it re-renders when the data changes, and it is
 * what starts the live store (the first screen to subscribe) and stops it (a moment after the last one leaves).
 */
export function useHubDataVersion(): void {
  const store = (override ?? choose()).store;
  useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getSnapshot : noSnapshot);
}

/** Ash left the page: Needs that ticked themselves off while he was looking go away. */
export function dismissDoneNeeds(): void {
  (override ?? choose()).store?.dismissDone();
}

/**
 * Give Monocode's own project label the hub's display name, so the coding
 * views say "EXO game" rather than the folder name.
 */
export function nameHubProject(project: HubProject): void {
  if (!project.folder) return;
  const key = projectKey(project.folder);
  if (loadTabGroupLabels()[key] !== project.name) saveTabGroupLabel(key, project.name);
}

/**
 * The Since paragraph as Ash reads it: no lists of raw titles in brackets (Ash OS's plain fallback text quotes them),
 * tidy spacing. The screen also clamps it to four lines.
 */
export function calmSummary(text: string): string {
  return text
    .replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => (inner.length > 24 || inner.includes(",") || inner.includes(";") ? "" : whole))
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** "Since 2pm", "Since yesterday", "Since Monday", "Since 3 Oct". */
export function sinceLabel(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(then)) / 86_400_000);
  if (days <= 0) {
    const h = then.getHours();
    const m = then.getMinutes();
    const hour = h % 12 || 12;
    return `Since ${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  }
  if (days === 1) return "Since yesterday";
  if (days < 7) return `Since ${then.toLocaleDateString("en-GB", { weekday: "long" })}`;
  return `Since ${then.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}

/**
 * Sidebar Monos on Today: grouped under a quiet project header, so same-named
 * Monos (two Chiefs of Staff) are clear. The app's own Monos have no project.
 */
export function hubMonoGroup(mono: { projects: readonly string[] }): string {
  const folder = mono.projects[0];
  if (!folder) return "";
  return hubData().listProjects().find((p) => p.folder === folder)?.name ?? "";
}
