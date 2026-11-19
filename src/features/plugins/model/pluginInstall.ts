// Pinned install, update and rollback (WP-31). The Rust side is the gate: a range, a branch or a
// script still waits or is refused there. This only chooses what to ask for and reads what came back.
import { invoke } from "@tauri-apps/api/core";

export type PluginSource = {
  kind: string;
  location: string;
  pin?: string | null;
  tag?: string | null;
  path?: string | null;
  registry?: string | null;
};

export type InstallSource =
  | { kind: "git"; url: string; commit?: string; tag?: string; path?: string; registry?: never }
  | { kind: "npm"; package: string; version: string; registry?: string }
  | { kind: "local"; path: string };

export type PluginSnapshot = {
  version?: string | null;
  source: PluginSource;
  installedAtMs: number;
  integrity?: string | null;
};

export type InstalledPlugin = {
  name: string;
  version?: string | null;
  source: PluginSource;
  installedAtMs: number;
  enabled: { global: boolean; projects: string[] };
  integrity?: string | null;
  previous?: PluginSnapshot | null;
};

export type ScriptStep = { run: string[]; cwd: string; why: string };

export type RequestedBy = {
  kind: string;
  session?: string;
  mono?: string;
  reason?: string;
};

/** WP-101: what the install check (Rust `plugins::scan`) found in the staged copy. */
export type ScanFinding = {
  severity: "block" | "warn" | "info";
  code: string;
  path: string;
  message: string;
};

export type ScanResult = {
  blocked: boolean;
  findings: ScanFinding[];
  files: number;
  bytes: number;
  tokenEstimate: number;
};

export type PendingRequest = {
  id: string;
  op: string;
  name: string;
  version?: string | null;
  description?: string | null;
  replaces?: string | null;
  source: InstallSource;
  resolved: PluginSource;
  requestedBy: RequestedBy;
  steps: ScriptStep[];
  skills: string[];
  mcpServers: string[];
  reports: { path: string; message: string }[];
  /** Missing on a request saved before the install check existed: nothing to show, not a failure. */
  scan?: ScanResult | null;
  createdAtMs: number;
};

const PERSON: RequestedBy = { kind: "person" };

export function listPlugins(): Promise<unknown> {
  return invoke("plugins_list");
}

export function listPending(): Promise<unknown> {
  return invoke("plugins_pending");
}

export function updatePlugin(name: string, source: InstallSource): Promise<unknown> {
  return invoke("plugins_update", { name, source, requestedBy: PERSON });
}

export function rollbackPlugin(name: string): Promise<unknown> {
  return invoke("plugins_rollback", { name });
}

export function removePlugin(name: string): Promise<unknown> {
  return invoke("plugins_uninstall", { name });
}

/** On, everywhere. No project: Rust reads a missing project as the global scope. */
export function enablePlugin(name: string): Promise<unknown> {
  return invoke("plugins_enable", { name });
}

/** Off, everywhere. */
export function disablePlugin(name: string): Promise<unknown> {
  return invoke("plugins_disable", { name });
}

export function approvePlugin(id: string): Promise<unknown> {
  return invoke("plugins_approve", { id });
}

export function declinePlugin(id: string): Promise<unknown> {
  return invoke("plugins_decline", { id });
}

export function isWaiting(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { status?: unknown }).status === "waiting";
}

/** The plain-words reports an enable or disable returned. A missing list is nothing to show, not a failure. */
export function readReports(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const reports = (value as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) return [];
  const lines: string[] = [];
  for (const item of reports) {
    if (!item || typeof item !== "object") continue;
    const message = (item as { message?: unknown }).message;
    if (typeof message !== "string") continue;
    const text = message.replace(/\r/g, "").trim();
    if (!text || text.includes("\0")) continue;
    const path = (item as { path?: unknown }).path;
    const where = typeof path === "string" ? path.replace(/\r/g, "").trim() : "";
    lines.push(where && !where.includes("\0") ? `${where}: ${text}` : text);
  }
  return lines;
}

/** The on/off switch the command just wrote, when the result carries the plugin. */
export function enabledFrom(value: unknown): { global: boolean; projects: string[] } | undefined {
  if (!value || typeof value !== "object") return;
  const entry = (value as { entry?: unknown }).entry;
  if (!entry || typeof entry !== "object") return;
  const enabled = (entry as { enabled?: unknown }).enabled;
  if (!enabled || typeof enabled !== "object") return;
  const global = (enabled as { global?: unknown }).global;
  const projects = (enabled as { projects?: unknown }).projects;
  if (typeof global !== "boolean") return;
  if (!Array.isArray(projects) || projects.some((item) => typeof item !== "string")) return;
  return { global, projects };
}

/** Refuse a list that isn't a registry. An empty object is a real empty install, not a broken read. */
export function readRegistry(value: unknown): { plugins: Record<string, InstalledPlugin> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The installed list couldn't be read.");
  }
  const plugins = (value as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    throw new Error("The installed list couldn't be read.");
  }
  return { plugins: plugins as Record<string, InstalledPlugin> };
}

export function installedRows(registry: { plugins: Record<string, InstalledPlugin> }): InstalledPlugin[] {
  return Object.values(registry.plugins)
    .filter((row) => !!row && typeof row.name === "string" && typeof row.source?.location === "string")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A waiting list that isn't a list is nothing waiting: no card, so nothing can be approved by mistake. */
export function readPending(value: unknown): PendingRequest[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PendingRequest =>
      !!item && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string",
  );
}

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const FULL_SHA256 = /^[0-9a-f]{64}$/i;

/** The next exact pin for an installed plugin. A 40 or 64 hex string is a commit; anything else is a tag. */
export function updatePayload(source: PluginSource, pin: string): InstallSource {
  const value = pin.trim();
  if (source.kind === "npm") {
    const next: InstallSource = { kind: "npm", package: source.location, version: value };
    if (source.registry) next.registry = source.registry;
    return next;
  }
  if (source.kind === "git") {
    const next: InstallSource = { kind: "git", url: source.location };
    if (FULL_COMMIT.test(value) || FULL_SHA256.test(value)) next.commit = value;
    else next.tag = value;
    if (source.path) next.path = source.path;
    return next;
  }
  return { kind: "local", path: value };
}

export function pinField(kind: string): { label: string; empty: string } {
  if (kind === "npm") return { label: "Exact version", empty: "Give an exact version." };
  if (kind === "git") return { label: "Commit or tag", empty: "Give a commit or a tag." };
  return { label: "Folder", empty: "Give the folder's full path." };
}

export function sourceLine(source: PluginSource | null | undefined): string {
  if (!source || typeof source.location !== "string" || !source.location) return "Unknown source";
  if (source.kind === "npm") return `${source.location}@${source.pin || "unknown version"}`;
  if (source.kind === "git") {
    const where = source.path ? `${source.location} (${source.path})` : source.location;
    const pin = source.tag
      ? `${source.tag} (${(source.pin || "").slice(0, 12)})`
      : (source.pin || "").slice(0, 12) || "unpinned";
    return `${where} at ${pin}`;
  }
  return source.location;
}

/** Install the carried desktop control plugin. It stays off until it is turned on. */
export function installDesktopControl(): Promise<unknown> {
  return invoke("desktop_control_install");
}

/** WP-44: download the pinned desktop program. The package's scripts are not run. */
export function fetchDesktopProgram(): Promise<unknown> {
  return invoke("desktop_control_fetch");
}

export function plainError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "That didn't work.";
}
