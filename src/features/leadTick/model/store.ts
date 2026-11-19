// WP-160: the lead tick's settings and its last run per project, in one hub document (`lead-tick`, in the app's
// database: src-tauri/src/local_hub.rs). Every window reads the same one and it survives a restart. A write lands only
// on the revision just read; another window's write means read again and apply on top. Keys are project folders, the
// way the Crew tab and the worker limits name a project.

import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import { defaultLeadTickSetting, LEAD_TICK_DOC_KEY, readLeadTickSetting, type LeadTickSetting } from "./setting";
import { NOTED_KEY_MAX } from "./tick";

/** What the last tick of a project did. */
export type LeadTickRun = {
  lastTickAt: number;
  /** The line the tick wrote, for the Crew card. */
  lastLine: string;
  /** Things already said once (a head that waits for the person, a refusal), so a tick does not repeat them. */
  noted: string[];
};

/** Said-once keys kept per project. A key that falls off is said again, so this is well above what a project has open. */
export const NOTED_LIMIT = 200;
const LINE_MAX = 500;
const TRIES = 5;

type Shape = { revision: number; settings: Record<string, LeadTickSetting>; runs: Record<string, LeadTickRun> };

export function folderKey(folder: string): string {
  return folder.replace(/\\/g, "/").trim().replace(/\/+$/, "");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readRun(raw: unknown): LeadTickRun | undefined {
  const value = record(raw);
  const at = value.lastTickAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return undefined;
  const line = typeof value.lastLine === "string" ? value.lastLine.slice(0, LINE_MAX) : "";
  const noted = Array.isArray(value.noted)
    ? value.noted.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= NOTED_KEY_MAX)
    : [];
  return { lastTickAt: at, lastLine: line, noted: noted.slice(-NOTED_LIMIT) };
}

function parse(raw: unknown, revision: number): Shape {
  const value = record(raw);
  const settings: Record<string, LeadTickSetting> = {};
  for (const [key, setting] of Object.entries(record(value.settings))) {
    const clean = folderKey(key);
    if (clean) settings[clean] = readLeadTickSetting(setting);
  }
  const runs: Record<string, LeadTickRun> = {};
  for (const [key, run] of Object.entries(record(value.runs))) {
    const clean = folderKey(key);
    const read = readRun(run);
    if (clean && read) runs[clean] = read;
  }
  return { revision, settings, runs };
}

export type LeadTickStore = {
  load(): Promise<void>;
  refresh(): Promise<void>;
  revision(): number;
  settingFor(folder: string): LeadTickSetting;
  /** Every project with a setting kept, by folder. */
  settings(): Record<string, LeadTickSetting>;
  runFor(folder: string): LeadTickRun | undefined;
  writeSetting(folder: string, patch: Partial<LeadTickSetting>): Promise<LeadTickSetting>;
  recordRun(folder: string, run: { at: number; line: string; noted: readonly string[] }): Promise<void>;
  subscribe(fn: () => void): () => void;
};

export function createLeadTickStore(disk: LocalHubDisk): LeadTickStore {
  let file: Shape = { revision: 0, settings: {}, runs: {} };
  let loaded = false;
  let watching = false;
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of [...listeners]) fn();
  };
  const adopt = (next: Shape) => {
    if (next.revision < file.revision) return;
    file = next;
    notify();
  };
  const read = async () => {
    const doc = await disk.readDoc(LEAD_TICK_DOC_KEY);
    return parse(doc.value, doc.rev);
  };
  const refresh = async () => {
    adopt(await read());
    loaded = true;
    if (!watching && disk.watch) {
      watching = true;
      disk.watch((key, rev) => {
        if (key === LEAD_TICK_DOC_KEY && rev > file.revision) void refresh().catch(() => undefined);
      });
    }
  };
  const change = (fn: (draft: Shape) => void): Promise<void> => {
    const run = chain.then(async () => {
      for (let attempt = 0; attempt < TRIES; attempt += 1) {
        let base: Shape;
        try {
          base = await read();
        } catch {
          continue;
        }
        const draft: Shape = { revision: base.revision, settings: { ...base.settings }, runs: { ...base.runs } };
        fn(draft);
        let rev: number | null;
        try {
          rev = await disk.write(LEAD_TICK_DOC_KEY, { settings: draft.settings, runs: draft.runs }, base.revision);
        } catch {
          continue;
        }
        if (rev == null) continue;
        loaded = true;
        adopt({ ...draft, revision: rev });
        return;
      }
      throw new Error("The lead tick setting couldn't be saved. Try again.");
    });
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    load: () => (loaded ? Promise.resolve() : refresh()),
    refresh,
    revision: () => file.revision,
    settingFor: (folder) => file.settings[folderKey(folder)] ?? defaultLeadTickSetting(),
    settings: () => ({ ...file.settings }),
    runFor: (folder) => file.runs[folderKey(folder)],
    async writeSetting(folder, patch) {
      const key = folderKey(folder);
      if (!key) return defaultLeadTickSetting();
      await change((draft) => {
        const current = draft.settings[key] ?? defaultLeadTickSetting();
        draft.settings[key] = readLeadTickSetting({ ...current, ...patch });
      });
      return file.settings[key] ?? defaultLeadTickSetting();
    },
    async recordRun(folder, run) {
      const key = folderKey(folder);
      if (!key) return;
      await change((draft) => {
        draft.runs[key] = {
          lastTickAt: run.at,
          lastLine: run.line.slice(0, LINE_MAX),
          noted: [...new Set(run.noted)].filter((k) => k && k.length <= NOTED_KEY_MAX).slice(-NOTED_LIMIT),
        };
      });
    },
    subscribe(fn) {
      listeners.add(fn);
      void refresh().catch(() => undefined);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

let active: LeadTickStore | undefined;

/** The window's store: the app's database in the app, memory in a browser preview or a test. */
export function leadTickStore(): LeadTickStore {
  if (active) return active;
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  active = createLeadTickStore(inTauri ? tauriLocalHubDisk : memoryDisk());
  return active;
}

export function setLeadTickStore(store: LeadTickStore | undefined): void {
  active = store;
}
