import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HARNESSES } from "../../sessions/model/session";

/**
 * WP-134: More agents. A local command that speaks ACP version 1, listed below the eleven Agent CLIs and run on the
 * generic ACP path (src/integrations/harness/moreAgents/). It is not a HarnessId and never passes through `asHarness`
 * or Rust's `Kind::from_id`. The list lives in the app's data folder (src-tauri/src/more_agents.rs); every entry read
 * back is untrusted, so a bad one is shown as unusable and the rest still load.
 */

export const MORE_AGENT_PROTOCOL = "acp-v1";

/** Hints only. The live `initialize` answer is what Hivra believes. */
export type MoreAgentAbilities = {
  cancel?: boolean;
  permissions?: boolean;
  previews?: boolean;
  models?: boolean;
  resume?: boolean;
  steer?: boolean;
};

export type MoreAgentEntry = {
  id: string;
  name: string;
  command: string;
  args: string[];
  protocol: typeof MORE_AGENT_PROTOCOL;
  abilities: MoreAgentAbilities;
};

/** One row as read: usable, or kept with the reason it cannot run. */
export type MoreAgentRow =
  | { usable: true; entry: MoreAgentEntry; raw: unknown }
  | { usable: false; id?: string; name?: string; reason: string; raw: unknown };

/** `approved` is the ids whose current command the person has allowed to run (the app decides; this is for display). */
export type MoreAgentsList = {
  revision: number;
  rows: MoreAgentRow[];
  approved: string[];
  /** The fingerprint the app shows for each entry; an allow sends it back so the app refuses a changed entry. */
  fingerprints: Record<string, string>;
  /** The absolute file each entry resolves to right now, or null when it is not found. */
  resolved: Record<string, string | null>;
  /** A line for the Allow card when the entry fetches its program at start (only the launcher is pinned). */
  notes: Record<string, string>;
};

/** The words a person sees for each gap in the subset (WP-134's table). No dashes. */
export const MORE_AGENT_COPY = {
  notFound: "This agent was not found. Check the command in More agents.",
  wrongVersion: "This agent does not speak the version Hivra supports.",
  noPermissionAsks: "This agent does not ask before it acts.",
  unknownAsk: "This agent asked for something Hivra cannot answer. The ask was declined.",
  noPreview: "No preview from this agent.",
  waits: "Your message waits until this turn finishes.",
  stopSent: "Stop sent. This agent does not confirm it stopped.",
  cannotContinue: "This chat cannot continue in the agent's last session. Start a new one.",
  gone: "This agent is no longer in your list.",
  noModels: "This agent did not name any models.",
  notAnswering: "This agent is not answering.",
  firstClass: "This is one of Hivra's own agent CLIs. Set it up under Agent CLIs instead.",
  changedElsewhere: "The list changed in another window. It has been reloaded, so try again.",
} as const;

/** The commands the eleven Agent CLIs run as. A registry entry may not be one of them (src-tauri/src/more_agents.rs). */
export const FIRST_CLASS_COMMANDS: readonly string[] = [
  "claude",
  "codex",
  "cursor-agent",
  "agent",
  "grok",
  "opencode",
  "pi",
  "pi-coding-agent",
  "omp",
  "fx",
  "hermes",
  "agy_acp_server.par",
  "devin",
];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_FIELD = 4096;
const MAX_ARGS = 64;
const ABILITY_KEYS: (keyof MoreAgentAbilities)[] = [
  "cancel",
  "permissions",
  "previews",
  "models",
  "resume",
  "steer",
];

function commandBasename(command: string): string {
  const parts = command.split(/[\\/]/);
  const last = parts[parts.length - 1] ?? "";
  return last.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/**
 * Check one entry read from disk or typed into the form. Unknown fields are ignored. The reason is plain words the
 * Settings row shows.
 */
export function parseMoreAgentEntry(
  raw: unknown,
): { ok: true; entry: MoreAgentEntry } | { ok: false; reason: string; id?: string; name?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "This entry is not a list item Hivra can read." };
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const label = { ...(id ? { id } : {}), ...(name ? { name } : {}) };
  if (!id) return { ok: false, reason: "This entry has no id.", ...label };
  if (!ID_PATTERN.test(id)) {
    return {
      ok: false,
      reason: "The id may only use lowercase letters, digits and hyphens, up to 48 characters.",
      ...label,
    };
  }
  if ((HARNESSES as string[]).includes(id)) return { ok: false, reason: MORE_AGENT_COPY.firstClass, ...label };
  if (!name) return { ok: false, reason: "This entry has no name.", ...label };
  if (name.length > 80) return { ok: false, reason: "The name is longer than 80 characters.", ...label };
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) return { ok: false, reason: "This entry has no command.", ...label };
  if (command.length > MAX_FIELD || /[\0\n\r]/.test(command)) {
    return { ok: false, reason: "The command is not a single line Hivra can run.", ...label };
  }
  if (FIRST_CLASS_COMMANDS.includes(commandBasename(command))) {
    return { ok: false, reason: MORE_AGENT_COPY.firstClass, ...label };
  }
  const rawArgs = record.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== "string")) {
    return { ok: false, reason: "The arguments must be a list of words.", ...label };
  }
  const args = rawArgs as string[];
  if (args.length > MAX_ARGS || args.some((arg) => arg.length > MAX_FIELD || arg.includes("\0"))) {
    return { ok: false, reason: "There are too many arguments, or one is too long.", ...label };
  }
  if (record.protocol !== MORE_AGENT_PROTOCOL) {
    return { ok: false, reason: `${MORE_AGENT_COPY.wrongVersion} Hivra runs ${MORE_AGENT_PROTOCOL} only.`, ...label };
  }
  const abilities: MoreAgentAbilities = {};
  const rawAbilities = record.abilities;
  if (rawAbilities && typeof rawAbilities === "object" && !Array.isArray(rawAbilities)) {
    for (const key of ABILITY_KEYS) {
      const value = (rawAbilities as Record<string, unknown>)[key];
      if (typeof value === "boolean") abilities[key] = value;
    }
  }
  return { ok: true, entry: { id, name, command, args, protocol: MORE_AGENT_PROTOCOL, abilities } };
}

/** Every entry, in order. A bad one is kept as unusable; a repeated id is unusable after the first. */
export function parseMoreAgentRows(agents: unknown): MoreAgentRow[] {
  const list = Array.isArray(agents) ? agents : [];
  const seen = new Set<string>();
  return list.map((raw): MoreAgentRow => {
    const parsed = parseMoreAgentEntry(raw);
    if (!parsed.ok) {
      return {
        usable: false,
        reason: parsed.reason,
        raw,
        ...(parsed.id ? { id: parsed.id } : {}),
        ...(parsed.name ? { name: parsed.name } : {}),
      };
    }
    if (seen.has(parsed.entry.id)) {
      return {
        usable: false,
        id: parsed.entry.id,
        name: parsed.entry.name,
        reason: "Another agent above already uses this id.",
        raw,
      };
    }
    seen.add(parsed.entry.id);
    return { usable: true, entry: parsed.entry, raw };
  });
}

/** Words typed into the arguments box: one argument per line, kept literally. Hivra never expands them. */
export function argsFromLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
}

/** A form's entry, checked the same way as one read from disk. */
export function newMoreAgentEntry(input: {
  id: string;
  name: string;
  command: string;
  argsText: string;
}): { ok: true; entry: MoreAgentEntry } | { ok: false; reason: string } {
  const parsed = parseMoreAgentEntry({
    id: input.id,
    name: input.name,
    command: input.command,
    args: argsFromLines(input.argsText),
    protocol: MORE_AGENT_PROTOCOL,
  });
  return parsed.ok ? parsed : { ok: false, reason: parsed.reason };
}

/** A suggested id from the name: lowercase words joined by hyphens. */
export function suggestMoreAgentId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

type StoredDocument = {
  revision: number;
  agents: unknown[];
  approved?: unknown;
  fingerprints?: unknown;
  resolved?: unknown;
  notes?: unknown;
};

function listFrom(doc: StoredDocument): MoreAgentsList {
  const approved = Array.isArray(doc.approved)
    ? doc.approved.filter((id): id is string => typeof id === "string")
    : [];
  const fingerprints: Record<string, string> = {};
  if (doc.fingerprints && typeof doc.fingerprints === "object") {
    for (const [id, fp] of Object.entries(doc.fingerprints)) if (typeof fp === "string") fingerprints[id] = fp;
  }
  const resolved: Record<string, string | null> = {};
  if (doc.resolved && typeof doc.resolved === "object") {
    for (const [id, path] of Object.entries(doc.resolved)) {
      resolved[id] = typeof path === "string" ? path : null;
    }
  }
  const notes: Record<string, string> = {};
  if (doc.notes && typeof doc.notes === "object") {
    for (const [id, note] of Object.entries(doc.notes)) if (typeof note === "string") notes[id] = note;
  }
  return { revision: doc.revision, rows: parseMoreAgentRows(doc.agents), approved, fingerprints, resolved, notes };
}

export class MoreAgentsChangedError extends Error {
  constructor() {
    super(MORE_AGENT_COPY.changedElsewhere);
  }
}

const listeners = new Set<() => void>();

/** The app announces every change to the list, from any window. `onChange` runs here for each one. */
export async function subscribeMoreAgentsChanges(onChange: () => void): Promise<() => void> {
  return listen("more-agents-changed", () => onChange());
}

export function subscribeMoreAgents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener();
}

export async function loadMoreAgents(): Promise<MoreAgentsList> {
  return listFrom(await invoke<StoredDocument>("more_agents_read"));
}

/**
 * Write the whole list on top of the revision this window last read. A window holding an older revision is refused,
 * so it cannot wipe an agent another window just added.
 */
async function saveRows(revision: number, agents: unknown[]): Promise<MoreAgentsList> {
  try {
    const doc = await invoke<StoredDocument>("more_agents_write", { expectedRevision: revision, agents });
    notify();
    return listFrom(doc);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/revision/i.test(detail)) throw new MoreAgentsChangedError();
    throw error instanceof Error ? error : new Error(detail);
  }
}

export function addMoreAgent(list: MoreAgentsList, entry: MoreAgentEntry): Promise<MoreAgentsList> {
  if (list.rows.some((row) => (row.usable ? row.entry.id : row.id) === entry.id)) {
    return Promise.reject(new Error("An agent with this id is already in the list."));
  }
  const { abilities, ...rest } = entry;
  const stored = Object.keys(abilities).length ? entry : rest;
  return saveRows(list.revision, [...list.rows.map((row) => row.raw), stored]);
}

/** Drops the link only: the agent's own files, its sign-in and the chats stay. */
export function removeMoreAgent(list: MoreAgentsList, index: number): Promise<MoreAgentsList> {
  return saveRows(
    list.revision,
    list.rows.filter((_row, at) => at !== index).map((row) => row.raw),
  );
}

/** Asks the app whether this entry may run now (approved as it is, file unchanged). Throws with the app's reason. */
export async function checkMoreAgentApproval(id: string): Promise<void> {
  await invoke("more_agents_check", { id });
}

/**
 * The person's own tap: allow this entry to run as it is shown, or withdraw that allowance. `shown` is the
 * fingerprint the window displayed; the app refuses an allow for any other command, arguments or file.
 */
export async function approveMoreAgent(id: string, allowed: boolean, shown?: string): Promise<MoreAgentsList> {
  const doc = await invoke<StoredDocument>("more_agents_approve", { id, allowed, shown: shown ?? null });
  notify();
  return listFrom(doc);
}

/** The result of checking one entry (src/integrations/harness/moreAgents/checkAgent.ts). */
export type MoreAgentCheck = {
  status: "ok" | "not_found" | "wrong_version" | "not_answering" | "gone" | "not_approved";
  message: string;
  agentName?: string;
  protocolVersion?: number;
  loadSession?: boolean;
};

/** What the row says about an entry's claimed abilities and the subset it runs on. */
export function moreAgentSubsetNotes(entry: MoreAgentEntry): string[] {
  const notes = [
    "Runs on the generic ACP path: queue, approvals, previews and stop.",
    "A message sent during a turn waits until it finishes.",
  ];
  if (entry.abilities.permissions === false) notes.push(MORE_AGENT_COPY.noPermissionAsks);
  if (entry.abilities.models === false) notes.push(MORE_AGENT_COPY.noModels);
  if (entry.abilities.previews === false) notes.push(MORE_AGENT_COPY.noPreview);
  return notes;
}
