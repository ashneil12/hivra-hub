// WP-134b. The More agents list, kept with the other provider settings.
// A bad entry is skipped. A write carries the revision it read, so a stale
// write does not replace a newer list.

import { HARNESSES } from "../../sessions/model/session";
import { loadMoreAgentsEnabled } from "../../settings/model/settings";
import { AGENT_GONE, UNSUPPORTED_PROTOCOL } from "./registryCopy";

export const REGISTRY_STORAGE_KEY = "monocode.moreAgents";

export const START_REGISTRY_CHAT_EVENT = "monocode:start-registry-chat";

export const LIST_UNREADABLE = "The list could not be read. Nothing was changed.";

const LIST_CHANGED = "The list changed somewhere else. Try again.";

const ID_BUILTIN = "That id is one of the built-in CLIs.";

const ID_SHAPE = "The id can only use letters, numbers and hyphens.";

const ID_TAKEN = "That id is already in the list.";

const NAME_EMPTY = "The name is empty.";

const COMMAND_EMPTY = "The command is empty.";

const COMMAND_NEWLINE = "The command has a newline or a null.";

const COMMAND_SPLIT = "The command is not a single executable. Arguments go in the argument list.";

const COMMAND_DOTDOT = "The command cannot contain ..";

const COMMAND_BUILTIN = "That command is one of the built-in CLIs.";

const COMMAND_SHELL = "That command is a shell, not an agent.";

const COMMAND_LONG = "The command is too long.";

const ARG_TEXT = "An argument is not text.";

const ARG_NEWLINE = "An argument has a newline or a null.";

const ARG_LONG = "An argument is too long.";

const ARG_COUNT = "There are too many arguments.";

const ENV_NAME = "An environment name is not valid.";

const ENV_RESERVED = "That environment name is reserved.";

const ENV_VALUE = "An environment value is not text.";

const ENV_NEWLINE = "An environment value has a newline or a null.";

const ENV_DUP = "That environment name is repeated.";

const ENV_COUNT = "There are too many environment variables.";

const CHAT_ID = "That chat id is not valid.";

const MAX_TRIES = 5;

const MAX_TEXT = 4096;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SESSION_KEY = /^[A-Za-z0-9_-]{1,128}$/;

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const META = /[|&;<>`$(){}]/;

const BUILTIN_IDS = new Set<string>(HARNESSES);

const RESERVED_BINARIES = new Set<string>([
  ...HARNESSES,
  "cursor-agent",
  "agy_acp_server.par",
]);

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "cmd",
  "powershell",
  "pwsh",
  "env",
]);

export type RegistryEnv = { name: string; value: string };

export type RegistryAgent = {
  id: string;
  name: string;
  command: string;
  args: string[];
  protocol: "acp-v1";
  env: RegistryEnv[];
};

export type RejectedEntry = { index: number; reason: string; label: string };

export type LoadedRegistry = {
  rev: number;
  agents: RegistryAgent[];
  chats: Record<string, string>;
  rejected: RejectedEntry[];
  readable: boolean;
};

export type RegistryStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type RegistryWrite =
  | { ok: true; rev: number }
  | { ok: false; reason: "stale" | "unreadable" | "invalid" };

const EMPTY: LoadedRegistry = {
  rev: 0,
  agents: [],
  chats: {},
  rejected: [],
  readable: true,
};

function builtinStore(): RegistryStore | null {
  try {
    if (typeof localStorage === "undefined" || localStorage == null) return null;
    return localStorage;
  } catch {
    return null;
  }
}

function resolveStore(store?: RegistryStore): RegistryStore | null {
  return store ?? builtinStore();
}

export function parseArgLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseEnvLines(text: string): { ok: true; env: RegistryEnv[] } | { ok: false; reason: string } {
  const env: RegistryEnv[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const splitAt = trimmed.indexOf("=");
    if (splitAt <= 0) return { ok: false, reason: "An environment line needs a name and a value." };
    env.push({ name: trimmed.slice(0, splitAt).trim(), value: trimmed.slice(splitAt + 1) });
  }
  const issue = envProblem(env);
  if (issue) return { ok: false, reason: issue };
  return { ok: true, env };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function binaryName(command: string): string {
  const parts = command.split(/[/\\]/).filter((part) => part.length > 0);
  const base = (parts[parts.length - 1] ?? "").toLowerCase();
  return base.replace(/\.(exe|bat|cmd)$/i, "");
}

export function commandProblem(command: string): string | null {
  if (typeof command !== "string" || command.trim() === "") return COMMAND_EMPTY;
  if (command.includes("\0") || /[\r\n]/.test(command)) return COMMAND_NEWLINE;
  if (command.length > MAX_TEXT) return COMMAND_LONG;
  if (META.test(command)) return COMMAND_SPLIT;
  const segments = command.split(/[/\\]/);
  if (segments.some((part) => part === "..")) return COMMAND_DOTDOT;
  const hasPath = /[/\\]/.test(command);
  if (!hasPath && /\s/.test(command)) return COMMAND_SPLIT;
  const base = binaryName(command);
  if (SHELLS.has(base)) return COMMAND_SHELL;
  if (RESERVED_BINARIES.has(base)) return COMMAND_BUILTIN;
  return null;
}

function envProblem(env: unknown): string | null {
  if (!Array.isArray(env)) return ENV_VALUE;
  if (env.length > 32) return ENV_COUNT;
  const seen = new Set<string>();
  for (const row of env) {
    if (!row || typeof row !== "object") return ENV_VALUE;
    const name = (row as { name?: unknown }).name;
    const value = (row as { value?: unknown }).value;
    if (typeof name !== "string" || !ENV_KEY.test(name)) return ENV_NAME;
    if (name.startsWith("MONOCODE_") || name === "LD_PRELOAD" || name === "LD_LIBRARY_PATH" || name.startsWith("DYLD_") || name === "NODE_OPTIONS") {
      return ENV_RESERVED;
    }
    if (seen.has(name)) return ENV_DUP;
    seen.add(name);
    if (typeof value !== "string") return ENV_VALUE;
    if (value.includes("\0") || /[\r\n]/.test(value) || value.length > MAX_TEXT) return ENV_NEWLINE;
  }
  return null;
}

function argsProblem(args: unknown): string | null {
  if (!Array.isArray(args)) return ARG_TEXT;
  if (args.length > 64) return ARG_COUNT;
  for (const arg of args) {
    if (typeof arg !== "string") return ARG_TEXT;
    if (arg.includes("\0") || /[\r\n]/.test(arg)) return ARG_NEWLINE;
    if (arg.length > MAX_TEXT) return ARG_LONG;
  }
  return null;
}

function labelFor(raw: unknown, index: number): string {
  if (raw && typeof raw === "object") {
    const name = (raw as { name?: unknown }).name;
    if (typeof name === "string") {
      const trimmed = name.trim();
      if (trimmed && trimmed.length <= 80 && !/[\u0000-\u001f]/.test(trimmed)) return trimmed;
    }
  }
  return `Entry ${index + 1}`;
}

function parseAgent(raw: unknown, index: number, seen: Set<string>): RegistryAgent | RejectedEntry {
  const reject = (reason: string): RejectedEntry => ({ index, reason, label: labelFor(raw, index) });
  if (!raw || typeof raw !== "object") return reject(ID_SHAPE);
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  if (!SLUG.test(id)) return reject(ID_SHAPE);
  if (BUILTIN_IDS.has(id)) return reject(ID_BUILTIN);
  if (seen.has(id)) return reject(ID_TAKEN);
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name || name.length > 80 || /[\r\n\0]/.test(name)) return reject(NAME_EMPTY);
  if (typeof row.command !== "string") return reject(COMMAND_EMPTY);
  const commandIssue = commandProblem(row.command);
  if (commandIssue) return reject(commandIssue);
  const argsIssue = argsProblem(row.args);
  if (argsIssue) return reject(argsIssue);
  if (row.protocol !== "acp-v1") return reject(UNSUPPORTED_PROTOCOL);
  const envIssue = envProblem(row.env);
  if (envIssue) return reject(envIssue);
  seen.add(id);
  return {
    id,
    name,
    command: row.command,
    args: row.args as string[],
    protocol: "acp-v1",
    env: (row.env as RegistryEnv[]).map((item) => ({ name: item.name, value: item.value })),
  };
}

function parseChats(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const chats: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SESSION_KEY.test(key)) return null;
    if (typeof value !== "string" || !SLUG.test(value)) return null;
    chats[key] = value;
  }
  return chats;
}

export function loadRegistryDocument(store?: RegistryStore): LoadedRegistry {
  const resolved = resolveStore(store);
  if (!resolved) return { ...EMPTY, readable: false };
  let text: string | null;
  try {
    text = resolved.getItem(REGISTRY_STORAGE_KEY);
  } catch {
    return { ...EMPTY, readable: false };
  }
  if (text == null || text.trim() === "") return { ...EMPTY };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...EMPTY, readable: false };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY, readable: false };
  const body = raw as Record<string, unknown>;
  if (typeof body.rev !== "number" || !Number.isInteger(body.rev) || body.rev < 0) {
    return { ...EMPTY, readable: false };
  }
  if (!Array.isArray(body.agents)) return { ...EMPTY, readable: false };
  const chats = parseChats(body.chats ?? {});
  if (!chats) return { ...EMPTY, readable: false };
  const agents: RegistryAgent[] = [];
  const rejected: RejectedEntry[] = [];
  const seen = new Set<string>();
  body.agents.forEach((entry, index) => {
    const parsed = parseAgent(entry, index, seen);
    if ("reason" in parsed) rejected.push(parsed);
    else agents.push(parsed);
  });
  return { rev: body.rev, agents, chats, rejected, readable: true };
}

function commit(store: RegistryStore, expectedRev: number, next: { agents: RegistryAgent[]; chats: Record<string, string> }): "ok" | "stale" | "unreadable" {
  const current = loadRegistryDocument(store);
  if (!current.readable) return "unreadable";
  if (current.rev !== expectedRev) return "stale";
  try {
    store.setItem(
      REGISTRY_STORAGE_KEY,
      JSON.stringify({ rev: expectedRev + 1, agents: next.agents, chats: next.chats }),
    );
  } catch {
    return "unreadable";
  }
  return "ok";
}

export function saveRegistryDocument(
  next: { agents: RegistryAgent[]; chats: Record<string, string> },
  expectedRev: number,
  store?: RegistryStore,
): RegistryWrite {
  const resolved = resolveStore(store);
  if (!resolved) return { ok: false, reason: "unreadable" };
  const current = loadRegistryDocument(resolved);
  if (!current.readable) return { ok: false, reason: "unreadable" };
  if (current.rev !== expectedRev) return { ok: false, reason: "stale" };
  const seen = new Set<string>();
  const agents: RegistryAgent[] = [];
  for (let index = 0; index < next.agents.length; index += 1) {
    const parsed = parseAgent(next.agents[index], index, seen);
    if ("reason" in parsed) return { ok: false, reason: "invalid" };
    agents.push(parsed);
  }
  const chats = parseChats(next.chats);
  if (!chats) return { ok: false, reason: "invalid" };
  const wrote = commit(resolved, expectedRev, { agents, chats });
  if (wrote === "ok") return { ok: true, rev: expectedRev + 1 };
  if (wrote === "stale") return { ok: false, reason: "stale" };
  return { ok: false, reason: "unreadable" };
}

type Draft =
  | { ok: true; agent: RegistryAgent }
  | { ok: false; reason: string };

function draftAgent(input: { name: string; command: string; args: string[]; env: RegistryEnv[]; id?: string }): Draft {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80 || /[\r\n\0]/.test(name)) return { ok: false, reason: NAME_EMPTY };
  const id = input.id?.trim() || slugify(name);
  if (!SLUG.test(id)) return { ok: false, reason: ID_SHAPE };
  if (BUILTIN_IDS.has(id)) return { ok: false, reason: ID_BUILTIN };
  const commandIssue = commandProblem(input.command);
  if (commandIssue) return { ok: false, reason: commandIssue };
  const argsIssue = argsProblem(input.args);
  if (argsIssue) return { ok: false, reason: argsIssue };
  const envIssue = envProblem(input.env);
  if (envIssue) return { ok: false, reason: envIssue };
  return {
    ok: true,
    agent: {
      id,
      name,
      command: input.command,
      args: [...input.args],
      protocol: "acp-v1",
      env: input.env.map((item) => ({ name: item.name, value: item.value })),
    },
  };
}

export function addRegistryAgent(
  input: { name: string; command: string; args: string[]; env: RegistryEnv[]; id?: string },
  store?: RegistryStore,
): { ok: true; rev: number; agent: RegistryAgent } | { ok: false; reason: string } {
  const resolved = resolveStore(store);
  if (!resolved) return { ok: false, reason: LIST_UNREADABLE };
  const drafted = draftAgent(input);
  if (!drafted.ok) return drafted;
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const current = loadRegistryDocument(resolved);
    if (!current.readable) return { ok: false, reason: LIST_UNREADABLE };
    if (current.agents.some((agent) => agent.id === drafted.agent.id)) {
      return { ok: false, reason: ID_TAKEN };
    }
    const wrote = commit(resolved, current.rev, {
      agents: [...current.agents, drafted.agent],
      chats: current.chats,
    });
    if (wrote === "ok") return { ok: true, rev: current.rev + 1, agent: drafted.agent };
    if (wrote === "unreadable") return { ok: false, reason: LIST_UNREADABLE };
  }
  return { ok: false, reason: LIST_CHANGED };
}

export function removeRegistryAgent(
  id: string,
  store?: RegistryStore,
): { ok: true; rev: number } | { ok: false; reason: string } {
  const resolved = resolveStore(store);
  if (!resolved) return { ok: false, reason: LIST_UNREADABLE };
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const current = loadRegistryDocument(resolved);
    if (!current.readable) return { ok: false, reason: LIST_UNREADABLE };
    if (!current.agents.some((agent) => agent.id === id)) return { ok: true, rev: current.rev };
    const wrote = commit(resolved, current.rev, {
      agents: current.agents.filter((agent) => agent.id !== id),
      chats: current.chats,
    });
    if (wrote === "ok") return { ok: true, rev: current.rev + 1 };
    if (wrote === "unreadable") return { ok: false, reason: LIST_UNREADABLE };
  }
  return { ok: false, reason: LIST_CHANGED };
}

export function linkRegistryChat(
  sessionId: string,
  agentId: string,
  store?: RegistryStore,
): { ok: true; rev: number } | { ok: false; reason: string } {
  const resolved = resolveStore(store);
  if (!resolved) return { ok: false, reason: LIST_UNREADABLE };
  if (!SESSION_KEY.test(sessionId) || !SLUG.test(agentId)) return { ok: false, reason: CHAT_ID };
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const current = loadRegistryDocument(resolved);
    if (!current.readable) return { ok: false, reason: LIST_UNREADABLE };
    if (!current.agents.some((agent) => agent.id === agentId)) return { ok: false, reason: AGENT_GONE };
    if (current.chats[sessionId] === agentId) return { ok: true, rev: current.rev };
    const wrote = commit(resolved, current.rev, {
      agents: current.agents,
      chats: { ...current.chats, [sessionId]: agentId },
    });
    if (wrote === "ok") return { ok: true, rev: current.rev + 1 };
    if (wrote === "unreadable") return { ok: false, reason: LIST_UNREADABLE };
  }
  return { ok: false, reason: LIST_CHANGED };
}

export function unlinkRegistryChat(
  sessionId: string,
  store?: RegistryStore,
): { ok: true; rev: number } | { ok: false; reason: string } {
  const resolved = resolveStore(store);
  if (!resolved) return { ok: false, reason: LIST_UNREADABLE };
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const current = loadRegistryDocument(resolved);
    if (!current.readable) return { ok: false, reason: LIST_UNREADABLE };
    if (!(sessionId in current.chats)) return { ok: true, rev: current.rev };
    const chats = { ...current.chats };
    delete chats[sessionId];
    const wrote = commit(resolved, current.rev, { agents: current.agents, chats });
    if (wrote === "ok") return { ok: true, rev: current.rev + 1 };
    if (wrote === "unreadable") return { ok: false, reason: LIST_UNREADABLE };
  }
  return { ok: false, reason: LIST_CHANGED };
}

export function registryAgentIdForSession(sessionId: string, store?: RegistryStore): string | undefined {
  const loaded = loadRegistryDocument(store);
  if (!loaded.readable) return undefined;
  const id = loaded.chats[sessionId];
  return typeof id === "string" && id ? id : undefined;
}

export function requestRegistryChat(
  agentId: string,
  options?: { enabled?: boolean; target?: Pick<Window, "dispatchEvent"> | null },
): void {
  const enabled = options?.enabled ?? loadMoreAgentsEnabled();
  if (!enabled) return;
  if (!SLUG.test(agentId)) return;
  const target = options && "target" in options
    ? options.target
    : typeof window === "undefined"
      ? null
      : window;
  if (!target) return;
  target.dispatchEvent(new CustomEvent(START_REGISTRY_CHAT_EVENT, { detail: { agentId } }));
}
