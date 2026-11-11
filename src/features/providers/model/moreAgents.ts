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
  const argsProblem = argumentProblem(command, args);
  if (argsProblem) return { ok: false, reason: argsProblem, ...label };
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

// The same argument rules as src-tauri/src/more_agents.rs (checked_fields), so a bad entry is refused when it is added.
const SCRIPT_EXTENSIONS = [
  "mjs", "cjs", "js", "jsx", "ts", "tsx", "py", "rb", "pl", "php", "lua", "sh", "json", "yaml", "yml",
  "toml", "ini", "env", "conf", "cfg", "wasm", "txt",
];
const INTERPRETERS = ["node", "nodejs", "bun", "deno", "ruby", "perl", "php", "uv", "uvx", "tsx", "ts-node"];
const LOADER_FLAG_NAMES = ["-m", "-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--preload"];
const INLINE_FLAG_NAMES = ["-c", "-e", "--eval", "-p", "--print", "/c", "/k", "-command", "-encodedcommand"];

function isInterpreter(command: string): boolean {
  const name = commandBasename(command);
  return INTERPRETERS.includes(name) || name.startsWith("python");
}

/** Index of `=`, or of the colon that separates a flag from its value. A Windows drive colon is not that colon. */
function valueSeparator(arg: string): number {
  const eq = arg.indexOf("=");
  if (eq >= 0) return eq;
  if (!arg.startsWith("-")) return -1;
  for (let at = 0; at < arg.length; at++) {
    if (arg[at] === ":" && !isDriveColon(arg, at)) return at;
  }
  return -1;
}

/** `C:\foo` after `=`, after another colon, or as an attached short flag (`-IC:\foo`). */
function isDriveColon(arg: string, at: number): boolean {
  if (at === 0 || at + 1 >= arg.length) return false;
  const letter = arg[at - 1];
  const next = arg[at + 1];
  if (!/[A-Za-z]/.test(letter) || (next !== "/" && next !== "\\")) return false;
  if (at === 1 || arg[at - 2] === "=" || arg[at - 2] === ":") return true;
  return at === 3 && arg[0] === "-" && arg[1] !== "-";
}

function valuesOf(arg: string): string[] {
  if (!arg.startsWith("-")) return [arg];
  const out: string[] = [];
  const at = valueSeparator(arg);
  if (at >= 0) out.push(arg.slice(at + 1));
  if (arg.length > 2 && !arg.startsWith("--")) out.push(arg.slice(2));
  return out;
}

function runningOnWindows(): boolean {
  if (typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent)) return true;
  return typeof process !== "undefined" && process.platform === "win32";
}

/** A drive letter, a colon, and no slash: `C:foo`, `C:..\agent`. `C:\foo` is absolute and is not this.
 *  A model tag (`o:latest`, `m:stable`, `x:nightly`) is not a path. `C:latest` is the same shape, so it is not caught. */
function isDriveRelative(value: string): boolean {
  if (!/^[A-Za-z]:/.test(value)) return false;
  if (value.length > 2 && (value[2] === "/" || value[2] === "\\")) return false;
  const rest = value.slice(2);
  return rest !== "latest" && rest !== "stable" && rest !== "nightly";
}

/** A root with no drive: `\Users\ash`, and on Windows `/Users/ash`. A UNC path is not this.
 *  `\t`, `\n` and `\r` are escapes, not a file at the root of the current drive. */
function isRootedWithoutDrive(value: string, platform: string): boolean {
  if (value.startsWith("\\\\") || value.startsWith("//")) return false;
  if (value.startsWith("\\")) {
    if (value.length === 2 && (value[1] === "t" || value[1] === "n" || value[1] === "r")) return false;
    return true;
  }
  return platform === "win32" && value.startsWith("/");
}

function foldPath(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return value.normalize("NFKC");
  }
  return value;
}

/** `file:` that is not a local file is refused. A local `file://` or `file:/` URL is pinned by the app, so it is allowed here. */
function fileUrlClass(value: string): "not-file" | "local" | "refuse" {
  if (value.length < 5 || value.slice(0, 5).toLowerCase() !== "file:") return "not-file";
  const rest = value.slice(5);
  if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const slash = after.indexOf("/");
    if (slash < 0) return "refuse";
    const host = after.slice(0, slash);
    if (host !== "" && host.toLowerCase() !== "localhost") return "refuse";
    const path = after.slice(slash);
    if (path === "" || path === "/") return "refuse";
    return "local";
  }
  if (rest.startsWith("/")) return rest === "/" ? "refuse" : "local";
  return "refuse";
}

/** `..`, or `C:..` where the drive letter would otherwise hide the parent segment. */
function isParentSegment(segment: string): boolean {
  return segment === ".." || /^[A-Za-z]:\.\.$/.test(segment);
}

function isRelativeFile(value: string, platform: string): boolean {
  if (!value) return false;
  return relativeFolded(foldPath(value), platform);
}

function relativeFolded(value: string, platform: string): boolean {
  if (!value) return false;
  // A leading @ is not a free pass. `@../x` and `@~/x` are paths. `@scope/pkg` is not.
  if (value.startsWith("@")) return relativeFolded(value.slice(1), platform);
  const fileUrl = fileUrlClass(value);
  if (fileUrl === "refuse") return true;
  if (fileUrl === "local") return false;
  if (value.includes("://")) return false;
  if (isDriveRelative(value) || isRootedWithoutDrive(value, platform)) return true;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const ext = value.includes(".") ? value.slice(value.lastIndexOf(".") + 1).toLowerCase() : "";
  const segments = value.split(/[/\\]/);
  // A slash in a model name is not a path. Refuse a .. segment, a ~ path, a leading dot, or a script or config name.
  return segments.some((segment) => isParentSegment(segment))
    || segments.some((segment) => segment.startsWith("~"))
    || value.startsWith(".")
    || SCRIPT_EXTENSIONS.includes(ext);
}

/** The reason an argument list is refused, or null when it is allowed. `platform` is for tests; the running OS is the default. */
export function argumentProblem(command: string, args: string[], platform = runningOnWindows() ? "win32" : "other"): string | null {
  const interpreter = isInterpreter(command);
  if (interpreter) {
    const inline = args.some((arg) => {
      const lower = arg.toLowerCase();
      const flag = lower.split("=")[0];
      if (INLINE_FLAG_NAMES.includes(flag)) return true;
      if (lower.startsWith("-") && !lower.startsWith("--") && lower.length <= 5 && /^-[a-z]+$/.test(lower)) {
        return /[cep]/.test(lower.slice(1));
      }
      return false;
    });
    if (inline) return "An agent cannot be started with an inline program (-c, -e, --eval or -p). Point at its program file.";
  }
  if (args.some((arg) => valuesOf(arg).some((value) => isRelativeFile(value, platform)))) {
    return "An argument that names a file must give its full absolute path. A relative path is not pinned, so it is refused.";
  }
  if (interpreter) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const lower = arg.toLowerCase();
      const long = lower.split("=")[0];
      const shortCluster = /^-[a-z]{1,3}$/i.test(arg) && /[mr]/i.test(arg.slice(1));
      if (!LOADER_FLAG_NAMES.includes(long) && !shortCluster) continue;
      const value = arg.includes("=") && long.startsWith("--")
        ? arg.slice(arg.indexOf("=") + 1)
        : shortCluster && !/[mr]$/i.test(arg)
          ? arg.slice(arg.search(/[mr]/i) + 1)
          : args[i + 1];
      if (!value || !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) {
        return "A loader flag (-m, -r, --require, --import, --loader, --env-file, --preload) must name an absolute file.";
      }
    }
  }
  return null;
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
