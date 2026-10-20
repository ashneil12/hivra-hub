// Autopilot, as the webview sees it (src-tauri/src/autopilot.rs owns the truth): the switches with their end times,
// the log, auto-resume settings and armed resumes. One store per window, read with useSyncExternalStore; the Rust side
// emits `monocode:autopilot-changed` after every change. Outside the app (vitest, the browser preview) a backend can be
// swapped in: tests pass an in-memory one, the dev page's example flag a small example one.

import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const EVERYTHING = "*";
export const AUTOPILOT_CHANGED = "monocode:autopilot-changed";
/** The Autopilot screen asks the app to show a chat (useAutopilot listens). */
export const OPEN_CHAT_EVENT = "monocode:autopilot-open-chat";

export type Switch = {
  scope: string;
  untilMs: number;
  setBy: string;
  setAt: number;
  chatId: string | null;
  said: string | null;
};

export type LogKind = "decision" | "question" | "approval" | "switch" | "resume" | "relaunch";
export type LogOutcome =
  | "taken"
  | "held"
  | "handed_back"
  | "on"
  | "off"
  | "ended"
  | "armed"
  | "resumed"
  | "gave_up"
  | "relaunched"
  | "cancelled";

export type LogEntry = {
  id: string;
  at: number;
  kind: LogKind;
  outcome: LogOutcome;
  project: string | null;
  chatId: string | null;
  monoId: string | null;
  who: string | null;
  what: string;
  recommendation: string | null;
  red: string | null;
  detail: string | null;
};

export type LogInput = {
  kind: LogKind;
  outcome: LogOutcome;
  project?: string | null;
  chatId?: string | null;
  monoId?: string | null;
  who?: string | null;
  what: string;
  recommendation?: string | null;
  red?: string | null;
  detail?: string | null;
  dedupe?: string | null;
};

export type AutoResumeSettings = { default: boolean; projects: Record<string, boolean> };

export type AutopilotStatus = {
  switches: Switch[];
  awake: { supported: boolean; held: boolean; error: string | null };
  relaunch: { supported: boolean; installed: boolean; reason: string | null };
  autoResume: AutoResumeSettings;
  logSeenAt: number;
  unseen: number;
  /** This start was the watcher reopening the app after a crash (WP5's crash-loop cap counts it like any restart). */
  relaunchedAfterCrash: boolean;
  now: number;
};

export type SetInput = {
  scopes: string[];
  untilMs: number;
  by: string;
  chatId?: string;
  said?: string;
  /** Ash's whole message that `said` quotes (a Mono switching it for him); the log keeps it with the switch. */
  turn?: string;
  who?: string;
};

export type OffInput = { scopes?: string[]; by: string; chatId?: string; said?: string; who?: string };

export type Resume = {
  sessionId: string;
  resetsAt: number;
  resumeAt: number;
  attempts: number;
  state: "armed" | "resumed" | "gave_up" | "cancelled";
  title: string | null;
  armedAt: number;
  updatedAt: number;
};

export type ArmInput = { sessionId: string; resetsAt: number; resumeAt: number; title?: string };
export type ArmResult = { armed: boolean; resume: Resume | null; reason: string | null };

export type AutopilotBackend = {
  status(): Promise<AutopilotStatus>;
  set(input: SetInput): Promise<AutopilotStatus>;
  off(input: OffInput): Promise<AutopilotStatus>;
  log(input: LogInput): Promise<LogEntry | null>;
  listLog(limit?: number, before?: number): Promise<LogEntry[]>;
  seen(at: number): Promise<void>;
  setAutoResume(input: { default?: boolean; project?: string; value?: boolean | null }): Promise<AutoResumeSettings>;
  arm(input: ArmInput): Promise<ArmResult>;
  settle(sessionId: string, outcome: "resumed" | "cancelled" | "finished"): Promise<Resume | null>;
  resumes(): Promise<Resume[]>;
  /** Live updates; returns the unsubscribe. */
  subscribe?(onChange: () => void): () => void;
};

export const tauriAutopilot: AutopilotBackend = {
  status: () => invoke("autopilot_status"),
  set: (input) => invoke("autopilot_set", { input }),
  off: (input) => invoke("autopilot_off", { input: { scopes: [], ...input } }),
  log: (input) => invoke("autopilot_log_add", { input }),
  listLog: (limit, before) => invoke("autopilot_log_list", { limit, before }),
  seen: (at) => invoke("autopilot_log_seen", { at }),
  setAutoResume: (input) => invoke("autopilot_auto_resume_set", { input }),
  arm: (input) => invoke("autopilot_resume_arm", { input }),
  settle: (sessionId, outcome) => invoke("autopilot_resume_settle", { sessionId, outcome }),
  resumes: () => invoke("autopilot_resumes"),
  subscribe: (onChange) => {
    const pending = listen(AUTOPILOT_CHANGED, () => onChange());
    return () => void pending.then((off) => off());
  },
};

let backend: AutopilotBackend | null = null;

/** The backend this window uses: the app's, unless a test or the example page set one. */
export function autopilotBackend(): AutopilotBackend | null {
  if (backend) return backend;
  return isTauriSafe() ? tauriAutopilot : null;
}

export function setAutopilotBackend(next: AutopilotBackend | null): void {
  stopStore();
  backend = next;
  status = null;
  log = [];
  emit();
}

function isTauriSafe(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

// ---- coverage ------------------------------------------------------------------------------------------------------

/** The switches still on at `now` (the store can lag the end time by up to a minute). */
export function activeSwitches(s: Pick<AutopilotStatus, "switches"> | null, now: number): Switch[] {
  return (s?.switches ?? []).filter((sw) => sw.untilMs > now);
}

/**
 * The switch that covers a project: everything, or that project's own; the later end time when both are on. `null`
 * project (a leadership Mono's chat outside any one project) is covered only by everything.
 */
export function coveringSwitch(
  s: Pick<AutopilotStatus, "switches"> | null,
  projectId: string | null | undefined,
  now: number,
): Switch | undefined {
  return activeSwitches(s, now)
    .filter((sw) => sw.scope === EVERYTHING || (!!projectId && sw.scope === projectId))
    .sort((a, b) => b.untilMs - a.untilMs)[0];
}

export function autoResumeOn(settings: AutoResumeSettings | undefined, projectId: string | null | undefined): boolean {
  const s = settings ?? { default: true, projects: {} };
  if (projectId && typeof s.projects[projectId] === "boolean") return s.projects[projectId];
  return s.default;
}

// ---- the store -----------------------------------------------------------------------------------------------------

let status: AutopilotStatus | null = null;
let log: LogEntry[] = [];
let version = 0;
let failed: string | null = null;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;
let refreshing: Promise<void> | null = null;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Read everything again (after a change event, or on demand). */
export function refreshAutopilot(): Promise<void> {
  const b = autopilotBackend();
  if (!b) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [nextStatus, nextLog] = await Promise.all([b.status(), b.listLog(200)]);
      status = nextStatus;
      log = nextLog;
      failed = null;
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    } finally {
      refreshing = null;
      emit();
    }
  })();
  return refreshing;
}

function startStore(): void {
  if (unsubscribe) return;
  const b = autopilotBackend();
  if (!b) return;
  unsubscribe = b.subscribe?.(() => void refreshAutopilot()) ?? (() => {});
  void refreshAutopilot();
}

function stopStore(): void {
  unsubscribe?.();
  unsubscribe = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startStore();
  return () => {
    listeners.delete(listener);
  };
}

/** What is known now, for code outside React (the app actions, the completion report). */
export function autopilotSnapshot(): AutopilotStatus | null {
  return status;
}

export function autopilotLogSnapshot(): LogEntry[] {
  return log;
}

export function autopilotError(): string | null {
  return failed;
}

/** Re-render on any change; returns the version. */
export function useAutopilotVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Keep the store live for the window's lifetime (the app hook calls it once). */
export function ensureAutopilotStore(): () => void {
  return subscribe(() => {});
}

/** After a write: take its answer at once instead of waiting for the change event. */
export function adoptStatus(next: AutopilotStatus): void {
  status = next;
  emit();
  void refreshAutopilot();
}
