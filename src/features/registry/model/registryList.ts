// WP-134b. The More agents list the chat screens read, and the chat link for each More agents chat.
// The list lives in the app's data folder with the person's approvals (src-tauri/src/more_agents.rs, read and written
// through src/features/providers/model/moreAgents.ts). This module keeps a copy the chat screens can read synchronously.
// A copy is only what the screens show: the Rust side reads its own list when a chat starts and runs only an approved
// entry, so nothing here is trusted to pick a command.

import { loadMoreAgents, subscribeMoreAgents } from "../../providers/model/moreAgents";
import { loadMoreAgentsEnabled } from "../../settings/model/settings";
import { stopMoreAgentRuns } from "../../../integrations/harness/moreAgents/moreAgentAdapter";
import { AGENT_GONE } from "./registryCopy";

export const START_REGISTRY_CHAT_EVENT = "monocode:start-registry-chat";
/** Dispatched when a Start a chat request is refused, so Settings can say why. */
export const REGISTRY_CHAT_REFUSED_EVENT = "monocode:registry-chat-refused";

export function reportRegistryChatRefused(sentence: string): void {
  window.dispatchEvent(new CustomEvent(REGISTRY_CHAT_REFUSED_EVENT, { detail: { sentence } }));
}

/** Which chat belongs to which entry. Browser storage: a link for display and restore only, never a command. */
export const REGISTRY_CHAT_LINKS_KEY = "monocode.moreAgentChats";

const SESSION_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type RegistryAgent = {
  id: string;
  name: string;
  command: string;
  args: string[];
  protocol: "acp-v1";
  /** The person has allowed this entry's current command to run. */
  approved: boolean;
  /** What an allow sends back so the app refuses a changed entry; null when it cannot be shown. */
  fingerprint: string | null;
  /** The absolute file this entry resolves to right now, or null when it is not found. */
  resolved: string | null;
};

export type LoadedRegistry = {
  rev: number;
  agents: RegistryAgent[];
  /** Entries Hivra cannot run, with the reason, in the order they were saved. */
  rejected: { index: number; label: string; reason: string }[];
  readable: boolean;
};

export type RegistryStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

let loaded: LoadedRegistry = { rev: 0, agents: [], rejected: [], readable: true };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** The last list read from the app. Empty until `refreshRegistry` has run once. */
export function loadRegistryDocument(): LoadedRegistry {
  return loaded;
}

/** Read the list from the app's data folder and keep it for the chat screens. A failed read keeps the last copy. */
export async function refreshRegistry(): Promise<LoadedRegistry> {
  try {
    const list = await loadMoreAgents();
    const agents: RegistryAgent[] = [];
    const rejected: LoadedRegistry["rejected"] = [];
    list.rows.forEach((row, index) => {
      if (row.usable) {
        const { entry } = row;
        agents.push({
          id: entry.id,
          name: entry.name,
          command: entry.command,
          args: entry.args,
          protocol: "acp-v1",
          approved: list.approved.includes(entry.id),
          fingerprint: list.fingerprints?.[entry.id] ?? null,
          resolved: list.resolved?.[entry.id] ?? null,
        });
      } else {
        rejected.push({
          index,
          label: row.name ?? row.id ?? `Entry ${index + 1}`,
          reason: row.reason,
        });
      }
    });
    // A run stops when its entry is withdrawn, removed or edited, and a turn in a chat that is still open is checked
    // against the app before it goes out (moreAgentAdapter).
    for (const before of loaded.agents) {
      if (!before.approved) continue;
      const now = agents.find((agent) => agent.id === before.id);
      if (!now?.approved || now.fingerprint !== before.fingerprint) stopMoreAgentRuns(before.id);
    }
    loaded = { rev: list.revision, agents, rejected, readable: true };
  } catch {
    loaded = { ...loaded, readable: false };
  }
  emit();
  return loaded;
}

/** Called when the list changes in this window (add, remove, approve). */
export function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribe = subscribeMoreAgents(() => {
    void refreshRegistry();
  });
  return () => {
    listeners.delete(listener);
    unsubscribe();
  };
}

function resolveStore(store?: RegistryStore): RegistryStore | null {
  if (store) return store;
  try {
    if (typeof localStorage === "undefined" || localStorage == null) return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readLinks(store: RegistryStore): Record<string, string> {
  try {
    const text = store.getItem(REGISTRY_CHAT_LINKS_KEY);
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const links: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (SESSION_KEY.test(key) && typeof value === "string" && SLUG.test(value)) links[key] = value;
    }
    return links;
  } catch {
    return {};
  }
}

function writeLinks(store: RegistryStore, links: Record<string, string>): boolean {
  try {
    store.setItem(REGISTRY_CHAT_LINKS_KEY, JSON.stringify(links));
    return true;
  } catch {
    return false;
  }
}

export function linkRegistryChat(
  sessionId: string,
  agentId: string,
  store?: RegistryStore,
): { ok: true } | { ok: false; reason: string } {
  const resolved = resolveStore(store);
  if (!resolved) return { ok: false, reason: AGENT_GONE };
  if (!SESSION_KEY.test(sessionId) || !SLUG.test(agentId)) return { ok: false, reason: AGENT_GONE };
  if (!writeLinks(resolved, { ...readLinks(resolved), [sessionId]: agentId })) {
    return { ok: false, reason: AGENT_GONE };
  }
  return { ok: true };
}

export function unlinkRegistryChat(sessionId: string, store?: RegistryStore): void {
  const resolved = resolveStore(store);
  if (!resolved) return;
  const links = readLinks(resolved);
  if (!(sessionId in links)) return;
  delete links[sessionId];
  writeLinks(resolved, links);
}

export function registryAgentIdForSession(sessionId: string, store?: RegistryStore): string | undefined {
  const resolved = resolveStore(store);
  if (!resolved) return undefined;
  const id = readLinks(resolved)[sessionId];
  return typeof id === "string" && id ? id : undefined;
}

type LinkStore = RegistryStore & { removeItem?(key: string): void };

/**
 * Copies each browser link onto the session row once. A link whose write fails stays for the next start.
 * A missing chat or a bad id is dropped. After this, the row is the link and browser storage is not read for it.
 */
export async function moveRegistryChatLinks(
  adopt: (sessionId: string, agentId: string) => Promise<unknown>,
  store?: LinkStore,
): Promise<void> {
  const resolved = resolveStore(store);
  if (!resolved) return;
  const links = readLinks(resolved);
  const ids = Object.keys(links);
  const dropKey = () => {
    const removable = resolved as LinkStore;
    if (typeof removable.removeItem !== "function") return;
    try {
      removable.removeItem(REGISTRY_CHAT_LINKS_KEY);
    } catch {
      // The next start tries again. A row that already has the entry is left as it is.
    }
  };
  if (ids.length === 0) {
    if (resolved.getItem(REGISTRY_CHAT_LINKS_KEY) != null) dropKey();
    return;
  }
  const kept: Record<string, string> = {};
  for (const sessionId of ids) {
    const agentId = links[sessionId];
    if (!agentId) continue;
    try {
      await adopt(sessionId, agentId);
    } catch {
      kept[sessionId] = agentId;
    }
  }
  if (Object.keys(kept).length === 0) {
    dropKey();
    return;
  }
  writeLinks(resolved, kept);
}

export function requestRegistryChat(
  agentId: string,
  options?: { enabled?: boolean; cwd?: string; target?: Pick<Window, "dispatchEvent"> | null },
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
  const cwd = options?.cwd;
  const detail = typeof cwd === "string" && cwd.length > 0 && cwd.length <= 4096 && !/[\0\r\n]/.test(cwd)
    ? { agentId, cwd }
    : { agentId };
  target.dispatchEvent(new CustomEvent(START_REGISTRY_CHAT_EVENT, { detail }));
}
