// WP-34. The bridge to the creator commands. Anything that comes back is untrusted until readState accepts it.
// A late reply is dropped: takeLatest moves on as soon as the next click starts.

import { invoke } from "@tauri-apps/api/core";
import type { ContributionKind, DraftFile } from "./draftFor";
import { currentViewId } from "./view";

export type PanelPreview = {
  id: string;
  title: string;
  html: string;
  css: string;
  js: string;
  permissions: string[];
};

export type Report = { path: string; message: string };

export type CreatorState = {
  id: string;
  view: string;
  revision: number;
  phase: string;
  plugin: string | null;
  expect: string;
  enabledGlobally: boolean;
  visibleHere: boolean;
  mcpApproved: boolean;
  mcpWaiting: boolean;
  scriptWaiting: boolean;
  reports: Report[];
  panel: PanelPreview | null;
  skills: string[];
  mcpServers: string[];
  mcpTools: string[];
  mcpNote: string | null;
};

const PHASES = new Set(["started", "drafted", "previewed", "kept", "undone", "discarded"]);

const FAILED = "That didn't work.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readReports(value: unknown): Report[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.message !== "string") return [];
    return [{ path: item.path, message: item.message }];
  });
}

/** A panel that isn't the shape we render is dropped. The rest of the state still stands. */
function readPanel(value: unknown): PanelPreview | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.html !== "string") return null;
  return {
    id: value.id,
    title: value.title,
    html: value.html,
    css: typeof value.css === "string" ? value.css : "",
    js: typeof value.js === "string" ? value.js : "",
    permissions: strings(value.permissions),
  };
}

/** `null` for a payload that isn't a creator session. Never throws. */
export function readState(raw: unknown): CreatorState | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.view !== "string") return null;
  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 0) return null;
  if (typeof raw.phase !== "string" || !PHASES.has(raw.phase)) return null;
  return {
    id: raw.id,
    view: raw.view,
    revision: raw.revision,
    phase: raw.phase,
    plugin: typeof raw.plugin === "string" ? raw.plugin : null,
    expect: typeof raw.expect === "string" ? raw.expect : "",
    enabledGlobally: raw.enabledGlobally === true,
    visibleHere: raw.visibleHere === true,
    mcpApproved: raw.mcpApproved === true,
    mcpWaiting: raw.mcpWaiting === true,
    scriptWaiting: raw.scriptWaiting === true,
    reports: readReports(raw.reports),
    panel: raw.panel == null ? null : readPanel(raw.panel),
    skills: strings(raw.skills),
    mcpServers: strings(raw.mcpServers),
    mcpTools: strings(raw.mcpTools),
    mcpNote: typeof raw.mcpNote === "string" ? raw.mcpNote : null,
  };
}

export function statusLine(phase: string): string {
  if (phase === "drafted") return "Drafted. Nothing is installed yet.";
  if (phase === "previewed") return "Only this view can see it.";
  if (phase === "kept") return "Kept.";
  if (phase === "undone") return "Rolled back.";
  if (phase === "discarded") return "The scratch folder is gone.";
  return "Started.";
}

export function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return FAILED;
}

let generation = 0;

/** The number of the click that just started. An older click is no longer current. */
export function takeLatest(): number {
  generation += 1;
  return generation;
}

export function isLatest(token: number): boolean {
  return token === generation;
}

/** Test hook. Clicks in one page share the counter; a test starts from zero. */
export function resetLatest(): void {
  generation = 0;
}

async function call(command: string, args: Record<string, unknown>): Promise<CreatorState> {
  const state = readState(await invoke(command, args));
  if (!state) throw new Error(FAILED);
  return state;
}

export function creatorStart(expect: ContributionKind): Promise<CreatorState> {
  return call("creator_start", { view: currentViewId(), expect });
}

export function creatorDraft(id: string, revision: number, files: DraftFile[]): Promise<CreatorState> {
  return call("creator_draft", { id, revision, files });
}

export function creatorState(id: string): Promise<CreatorState> {
  return call("creator_state", { id });
}

export function creatorPreview(id: string, revision: number): Promise<CreatorState> {
  return call("creator_preview", { id, revision });
}

export function creatorKeep(id: string, revision: number): Promise<CreatorState> {
  return call("creator_keep", { id, revision });
}

export function creatorUndo(id: string, revision: number): Promise<CreatorState> {
  return call("creator_undo", { id, revision });
}

export function creatorDiscard(id: string, revision: number): Promise<CreatorState> {
  return call("creator_discard", { id, revision });
}

export function creatorApproveMcp(id: string, revision: number): Promise<CreatorState> {
  return call("creator_approve_mcp", { id, revision });
}

export function creatorProbe(id: string, revision: number): Promise<CreatorState> {
  return call("creator_probe_mcp", { id, revision });
}
