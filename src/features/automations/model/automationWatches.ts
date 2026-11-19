// WP-244: what each automation watches, and what the app saw last time. Kept in the app's own database
// (local_hub.rs, one document) beside the automation rather than in its definition, so the automation store and its
// Rust side stay as they are. A watch is opt-in: an automation with none here runs as it always did.
import { invoke } from "@tauri-apps/api/core";
import { parseSeen, parseWatch, type ScheduleWatch, type WatchSeen } from "./quietWatch";

export const AUTOMATION_WATCHES_KEY = "schedule-watches";

export type AutomationWatchEntry = { watch: ScheduleWatch; seen?: WatchSeen };
type Doc = { automations: Record<string, AutomationWatchEntry> };

export type WatchDisk = {
  read(key: string): Promise<{ value: unknown; rev: number }>;
  /** Writes over revision `rev`; null when someone else wrote first. */
  write(key: string, value: unknown, rev: number): Promise<number | null>;
};

const appDisk: WatchDisk = {
  read: async (key) => {
    const doc = await invoke<{ value: unknown; rev: number }>("plugin:hub|local_hub_read", { key });
    return { value: doc?.value ?? null, rev: typeof doc?.rev === "number" ? doc.rev : 0 };
  },
  write: (key, value, rev) => invoke<number | null>("plugin:hub|local_hub_write", { key, value, expectRev: rev }),
};
let disk: WatchDisk = appDisk;
/** Tests: keep the document in memory. */
export function setWatchDisk(next: WatchDisk | undefined): void {
  disk = next ?? appDisk;
}

function parseDoc(value: unknown): Doc {
  const out: Doc = { automations: {} };
  const list = value && typeof value === "object" ? (value as { automations?: unknown }).automations : undefined;
  if (!list || typeof list !== "object") return out;
  for (const [id, raw] of Object.entries(list as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    try {
      const watch = parseWatch((raw as { watch?: unknown }).watch);
      if (!watch) continue;
      const seen = parseSeen((raw as { seen?: unknown }).seen);
      out.automations[id] = { watch, ...(seen ? { seen } : {}) };
    } catch {
      // A watch the app can't read any more is left out; the automation runs as before.
    }
  }
  return out;
}

export async function automationWatch(id: string): Promise<AutomationWatchEntry | undefined> {
  return parseDoc((await disk.read(AUTOMATION_WATCHES_KEY)).value).automations[id];
}

async function change(update: (doc: Doc) => void): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { value, rev } = await disk.read(AUTOMATION_WATCHES_KEY);
    const doc = parseDoc(value);
    update(doc);
    if ((await disk.write(AUTOMATION_WATCHES_KEY, doc, rev)) !== null) return;
  }
  throw new Error("Could not save the automation's watch; another window kept changing it.");
}

/** Set or clear (undefined) an automation's watch. A new watch starts with no look: its first run goes ahead. */
export function setAutomationWatch(id: string, watch: ScheduleWatch | undefined): Promise<void> {
  return change((doc) => {
    const current = doc.automations[id];
    if (!watch) delete doc.automations[id];
    else if (!current || JSON.stringify(current.watch) !== JSON.stringify(watch)) doc.automations[id] = { watch };
  });
}

/** Keep what the run saw (or the last look, marked failed). Nothing changes for an automation whose watch went. */
export function recordAutomationSeen(id: string, seen: WatchSeen | undefined): Promise<void> {
  return change((doc) => {
    const current = doc.automations[id];
    if (!current) return;
    doc.automations[id] = { watch: current.watch, ...(seen ? { seen } : {}) };
  });
}
