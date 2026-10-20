// Each Mono's permanent home (src-tauri/src/mono_home.rs): the daily app keeps every Mono in ~/agent-memory/monos/,
// one folder per Mono plus the roster, MONOS.json. Only the app writes there, and checks each write before saving.
//
// The roster (who each Mono is, its look, engine, projects and chat id) used to live only in the WebView's storage
// (`monocode:mono-roster`), so a WebKit reset or a new origin lost every Mono's chat. Now:
// - MONOS.json is the durable copy. The WebView keeps its copy as a cache, because every reader is synchronous.
// - At launch (`hydrateRosterFromHome`, before the first render) the two are reconciled: a WebView that started with no
//   roster takes the file's (the Monos come back with their chats); a file newer than the cache wins; otherwise the
//   cache is written to the file (the first launch after the move imports it once this way).
// - After that, every roster change is written through to MONOS.json, one save at a time, newest last.
// - Each Mono's chat ids also go to its own `<id>/chats.json` ({ main, history }), whenever its chat changes.
import { invoke } from "@tauri-apps/api/core";

/** mono.ts's storage key and change event (not imported, so this file stays below mono.ts). */
export const ROSTER_KEY = "monocode:mono-roster";
const MONOS_CHANGED = "monocode:monos-changed";
/** When the WebView's roster was last saved (ms). */
export const ROSTER_SAVED_AT_KEY = "monocode:mono-roster-saved-at";

export type RosterFile = { version: 1; savedAt: number; monos: Record<string, unknown>[] };
export type ChatsFile = { main?: string; history: string[] };

export type HomeBackend = {
  loadRoster(): Promise<{ text: string | null; hash: string }>;
  saveRoster(text: string): Promise<string>;
  readChats(monoId: string): Promise<{ text: string | null; hash: string }>;
  saveChats(monoId: string, text: string, expectedHash: string): Promise<string>;
};

const tauriBackend: HomeBackend = {
  loadRoster: () => invoke("mono_roster_load"),
  saveRoster: (text) => invoke("mono_roster_save", { text, expectedHash: null }),
  readChats: (mono) => invoke("mono_read", { mono, legacyProject: null, path: "chats.json" }),
  saveChats: (mono, text, expectedHash) =>
    invoke("mono_save", { mono, legacyProject: null, path: "chats.json", text, expectedHash }),
};

let backend: HomeBackend | undefined;
/** Tests and proofs swap the backend; `undefined` turns the home off (a browser page, a unit test by default). */
export function setHomeBackend(next: HomeBackend | undefined): void {
  backend = next;
}
/** The app's own backend, once main.tsx knows it is running in the app. */
export function enableTauriHome(): void {
  backend = tauriBackend;
}

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the file still has it */
  }
}

/** Whether the WebView had a roster when this window started (before anything could add the built-in team to it). */
let startedWithRoster = get(ROSTER_KEY) != null;
/** For tests: what this window "started" with. */
export function resetHomeForTests(started = get(ROSTER_KEY) != null): void {
  startedWithRoster = started;
  hydrated = false;
  writing = Promise.resolve();
  pending = undefined;
}

let hydrated = false;
let writing: Promise<unknown> = Promise.resolve();
let pending: string | undefined;

function parseFile(text: string | null): RosterFile | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<RosterFile>;
    if (!value || !Array.isArray(value.monos)) return undefined;
    return {
      version: 1,
      savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
      monos: value.monos.filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string"),
    };
  } catch {
    return undefined;
  }
}

function localRoster(): Record<string, unknown>[] | undefined {
  try {
    const value = JSON.parse(get(ROSTER_KEY) ?? "null") as unknown;
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : undefined;
  } catch {
    return undefined;
  }
}

function fileText(monos: readonly Record<string, unknown>[], savedAt: number): string {
  return JSON.stringify({ version: 1, savedAt, monos: [...monos] } satisfies RosterFile, null, 2);
}

function adopt(monos: readonly Record<string, unknown>[], savedAt: number): void {
  set(ROSTER_KEY, JSON.stringify(monos));
  set(ROSTER_SAVED_AT_KEY, String(savedAt));
  try {
    window.dispatchEvent(new CustomEvent(MONOS_CHANGED));
  } catch {
    /* no window (a script): nothing to tell */
  }
}

export type HydrateResult = "off" | "restored" | "merged" | "file-newer" | "imported" | "saved" | "same";

/**
 * Reconciles the WebView's roster with MONOS.json, once per window, then turns write-through on. Never drops a Mono:
 * when the WebView started empty, Monos it made since (the built-in team, on first render) are kept after the file's,
 * and the file's entry wins for any id both have, so each keeps its chat.
 */
export async function hydrateRosterFromHome(): Promise<HydrateResult> {
  if (!backend) return "off";
  const loaded = await backend.loadRoster();
  const file = parseFile(loaded.text);
  const local = localRoster();
  const localSavedAt = Number(get(ROSTER_SAVED_AT_KEY)) || 0;
  let result: HydrateResult;
  if (!file) {
    result = local ? "imported" : "same";
    if (local) await backend.saveRoster(fileText(local, localSavedAt || Date.now()));
  } else if (!startedWithRoster) {
    const known = new Set(file.monos.map((m) => m.id));
    const extra = (local ?? []).filter((m) => !known.has(m.id));
    const owned = new Set(file.monos.map((m) => m.sessionId).filter(Boolean));
    // A Mono made since the reset never takes a chat the file gives to another.
    const merged = [...file.monos, ...extra.map((m) => (m.sessionId && owned.has(m.sessionId) ? { ...m, sessionId: undefined } : m))];
    adopt(merged, extra.length ? Date.now() : file.savedAt);
    result = extra.length ? "merged" : "restored";
    if (extra.length) await backend.saveRoster(fileText(merged, Date.now()));
  } else if (file.savedAt > localSavedAt) {
    adopt(file.monos, file.savedAt);
    result = "file-newer";
  } else if (JSON.stringify(file.monos) !== JSON.stringify(local ?? [])) {
    await backend.saveRoster(fileText(local ?? [], localSavedAt));
    result = "saved";
  } else {
    result = "same";
  }
  hydrated = true;
  startedWithRoster = true;
  if (pending) flush();
  await backfillChats();
  return result;
}

function flush(): void {
  const text = pending;
  pending = undefined;
  if (!text || !backend) return;
  const save = backend.saveRoster.bind(backend);
  writing = writing.then(() => save(text)).catch((error: unknown) => {
    console.error("Couldn't save MONOS.json; the WebView still has the roster", error);
  });
}

/** mono.ts calls this after each roster save: stamped, and written to MONOS.json once the launch reconcile is done. */
export function rosterSaved(roster: readonly unknown[]): void {
  const savedAt = Date.now();
  set(ROSTER_SAVED_AT_KEY, String(savedAt));
  if (!backend) return;
  pending = fileText(roster as Record<string, unknown>[], savedAt);
  if (hydrated) flush();
}

/** Resolves when every roster write queued so far has finished (tests, and a quit). */
export function rosterWritesSettled(): Promise<unknown> {
  return writing;
}

function parseChats(text: string | null): ChatsFile {
  try {
    const value = JSON.parse(text ?? "{}") as Partial<ChatsFile>;
    return {
      ...(typeof value.main === "string" && value.main ? { main: value.main } : {}),
      history: Array.isArray(value.history) ? value.history.filter((s): s is string => typeof s === "string") : [],
    };
  } catch {
    return { history: [] };
  }
}

/** The Mono's chat is now `sessionId`: written to its chats.json, the old one kept under history. */
export async function recordMonoChat(monoId: string, sessionId: string | undefined): Promise<boolean> {
  if (!backend) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await backend.readChats(monoId);
    const chats = parseChats(current.text);
    if (chats.main === sessionId && current.text != null) return false;
    const history = chats.main && chats.main !== sessionId && !chats.history.includes(chats.main) ? [...chats.history, chats.main] : chats.history;
    const next: ChatsFile = { ...(sessionId ? { main: sessionId } : {}), history };
    try {
      await backend.saveChats(monoId, JSON.stringify(next, null, 2), current.hash);
      return true;
    } catch (error) {
      if (error !== "conflict") throw error;
    }
  }
  return false;
}

/** After the reconcile: every Mono with a chat has it in its own chats.json too (the move out of the WebView). */
async function backfillChats(): Promise<void> {
  for (const mono of localRoster() ?? []) {
    if (typeof mono.id !== "string" || typeof mono.sessionId !== "string") continue;
    try {
      await recordMonoChat(mono.id, mono.sessionId);
    } catch {
      /* this Mono's folder can't be written right now: its chat id is still in the roster */
    }
  }
}
