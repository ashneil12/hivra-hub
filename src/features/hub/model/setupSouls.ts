// Each Mono's soul in a setup import: its role, rules (SOUL.md), memory (MEMORY.md), workflows (habits.json), notes,
// skills and engine. A Mono that isn't seated waits for Ash's OK and is never seated automatically.
import { useSyncExternalStore } from "react";
import { readAgentFile, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { addMono, engineFieldsOf, findMono, listMonos, updateMono, type MonoEngine } from "../../monos/model/mono";
import { cleanStoredDefault } from "../../crew/model/workerDefault";
import type { Pick as WorkerPick } from "../../crew/model/resolve";
import { ROLE_NAMES } from "./roleNames";

export type SetupSoul = {
  monoId: string;
  name: string;
  /** One plain line on what it does. */
  role: string;
  /** Ash's own sidebar role label, from a v2 export; "" means cleared. */
  roleLabel?: string;
  /** SOUL.md: its standing rules. */
  rules: string;
  /** MEMORY.md. */
  memory: string;
  /** habits.json: its workflows. */
  workflows: string;
  /** Skill names from the "## Skills" list in SOUL.md. */
  skills: string[];
  mascot?: string;
  // From a v2 export (Phase 5); a v1 file has none of these.
  color?: string;
  mascotPicked?: boolean;
  /** The engine its conversation runs on, never assumed to be Claude. */
  engine?: MonoEngine | null;
  /** Project folders it works on here (already mapped to this Mac's folders by the import). */
  projects?: string[];
  /** memory/<name>.md notes, by name. Only when memory was ticked. */
  topics?: Record<string, string>;
  /** WP-89: what its workers run on. Import only adds: a seated Mono that already has one keeps it. */
  workerDefault?: WorkerPick;
};

function roster(): { id: string; name?: string; mascot?: string }[] {
  return listMonos();
}

/** The role: the plain role name, else the first line under "## Role" in SOUL.md. */
export function roleOf(name: string, rules: string): string {
  const plain = ROLE_NAMES[name.trim().toLowerCase()];
  if (plain) return plain;
  const m = /^## Role\s*\n+([^\n]+)/m.exec(rules);
  return m ? m[1].trim() : "";
}
/** Skills listed under "## Skills" in SOUL.md, one "- name" per line. */
export function skillsOf(rules: string): string[] {
  const m = /^## Skills\s*\n((?:[-*] .+\n?)+)/m.exec(rules);
  return m ? m[1].split("\n").map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean) : [];
}

// ---- Waiting for your OK -----------------------------------------------------------------------------------------------
const WAIT_KEY = "monocode:hub-souls-waiting";
const EVENT = "monocode:hub-souls-waiting-changed";
let version = 0;
function readWaiting(): SetupSoul[] {
  try {
    const v = JSON.parse(localStorage.getItem(WAIT_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as SetupSoul[]) : [];
  } catch {
    return [];
  }
}
function saveWaiting(list: SetupSoul[]): void {
  try {
    localStorage.setItem(WAIT_KEY, JSON.stringify(list));
  } catch {
    /* best effort */
  }
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
export function useWaitingSoulsVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
}
export function waitingSouls(): SetupSoul[] {
  return readWaiting();
}
export function isSeated(monoId: string): boolean {
  return roster().some((m) => m.id === monoId);
}

/**
 * Import: souls of Monos that aren't seated wait for Ash's OK. Seated Monos keep their
 * current soul. Returns how many now wait.
 */
export function importSouls(souls: SetupSoul[]): number {
  const have = new Set(readWaiting().map((s) => s.monoId));
  const add = souls.filter((s) => s && s.monoId && !isSeated(s.monoId) && !have.has(s.monoId));
  if (add.length) saveWaiting([...readWaiting(), ...add]);
  return add.length;
}

type Writer = (monoId: string, path: AgentFilePath, text: string) => Promise<unknown>;
type Read = (monoId: string, path: AgentFilePath) => Promise<{ text: string | null }>;

/** A soul's files, by agent path. */
export function soulFiles(soul: Pick<SetupSoul, "rules" | "memory" | "workflows" | "topics">): [AgentFilePath, string][] {
  const out: [AgentFilePath, string][] = [];
  if (soul.rules) out.push(["SOUL.md", soul.rules]);
  if (soul.memory) out.push(["MEMORY.md", soul.memory]);
  if (soul.workflows) out.push(["habits.json", soul.workflows]);
  for (const [name, text] of Object.entries(soul.topics ?? {})) {
    if (text && /^[A-Za-z0-9 ._-]{1,80}$/.test(name) && !name.startsWith(".")) out.push([`memory/${name}.md`, text]);
  }
  return out;
}

export type SoulFilesResult = { written: AgentFilePath[]; kept: AgentFilePath[]; problems: string[] };

/**
 * Writes a soul's files into a Mono's folder without overwriting: a file that is already there with text stays, unless
 * `replace` (Ash ticked "use the file's" in the preview). A file that can't be read is kept as it is and reported: a
 * failed read is not a missing file. Returns the paths written, the ones kept, and each problem in plain words.
 */
export async function writeSoulFiles(
  monoId: string,
  files: [AgentFilePath, string][],
  {
    write = writeAgentFile as Writer,
    read = readAgentFile as Read,
    replace = false,
    stale,
  }: { write?: Writer; read?: Read; replace?: boolean; stale?: (path: AgentFilePath, current: string) => Promise<boolean> } = {},
): Promise<SoulFilesResult> {
  const written: AgentFilePath[] = [];
  const kept: AgentFilePath[] = [];
  const problems: string[] = [];
  for (const [path, text] of files) {
    let current: string | null;
    try {
      // `text: null` is a file that isn't there; a throw is one that is there but couldn't be read.
      current = (await read(monoId, path)).text;
    } catch (e) {
      kept.push(path);
      problems.push(`${path} couldn't be read (${e instanceof Error ? e.message : String(e)}), so it was left as it is.`);
      continue;
    }
    if (current === text) continue;
    // `stale`: a file that is only what the app seeded (no one's edit), which an import may take the place of.
    if (current?.trim() && !replace && !(stale && (await stale(path, current)))) {
      kept.push(path);
      continue;
    }
    await write(monoId, path, text);
    written.push(path);
  }
  return { written, kept, problems };
}

/**
 * Ash's OK: seats the Mono with its look, projects and engine, and writes its rules, memory and workflows. A Mono that
 * left files behind here before keeps them: only missing files are written. When one of its files couldn't be read,
 * it stays waiting (seated, nothing overwritten), so OK can try again; the problems are returned.
 */
export async function seatWaitingSoul(monoId: string, write: Writer = writeAgentFile, folders?: string[], read: Read = readAgentFile): Promise<string[]> {
  const soul = readWaiting().find((s) => s.monoId === monoId);
  if (!soul) return [];
  const workerDefault = cleanStoredDefault(soul.workerDefault);
  if (!isSeated(monoId)) {
    addMono({
      id: soul.monoId,
      name: soul.name,
      ...(soul.roleLabel !== undefined ? { role: soul.roleLabel } : {}),
      mascot: soul.mascot ?? "robot",
      ...(soul.mascotPicked ? { mascotPicked: true } : {}),
      color: soul.color ?? "hsl(210 8% 58%)",
      projects: folders ?? soul.projects ?? [],
      ...engineFieldsOf(soul.engine),
      ...(workerDefault ? { workerDefault } : {}),
    });
  } else if (workerDefault && !findMono(monoId)?.workerDefault) {
    // Seated while this was waiting, with no default of its own: add the file's. One already set stays.
    updateMono(monoId, (m) => (m.workerDefault ? m : { ...m, workerDefault }));
  }
  const { problems } = await writeSoulFiles(monoId, soulFiles(soul), { write, read });
  if (!problems.length) saveWaiting(readWaiting().filter((s) => s.monoId !== monoId));
  return problems;
}

/**
 * For a Mono that is already seated here: its engine when it has none, and the file's soul files that are missing (all
 * of them with `replace`), and with `projects` the file's projects it lacks. Nothing of its own is overwritten otherwise.
 */
export async function mergeIntoSeated(
  soul: SetupSoul,
  {
    replace = false,
    projects = false,
    write,
    read,
    stale,
  }: { replace?: boolean; /** Also add the file's projects it lacks. Off unless asked: a folder on a Mono is where it may start sessions and actions. */ projects?: boolean; write?: Writer; read?: Read; stale?: (path: AgentFilePath, current: string) => Promise<boolean> } = {},
): Promise<SoulFilesResult> {
  const mono = findMono(soul.monoId);
  if (!mono) return { written: [], kept: [], problems: [] };
  const engine = engineFieldsOf(soul.engine);
  const workerDefault = cleanStoredDefault(soul.workerDefault);
  updateMono(mono.id, (m) => ({
    ...m,
    ...(projects ? { projects: [...m.projects, ...(soul.projects ?? [])] } : {}),
    ...(engine.engine && (!m.engine || replace) ? engine : {}),
    ...(soul.roleLabel !== undefined && (m.role === undefined || replace) ? { role: soul.roleLabel } : {}),
    ...(workerDefault && (!m.workerDefault || replace) ? { workerDefault } : {}),
  }));
  return writeSoulFiles(mono.id, soulFiles(soul), { replace, ...(write ? { write } : {}), ...(read ? { read } : {}), ...(stale ? { stale } : {}) });
}
/** Not now: drops the waiting soul; nothing was seated or written. */
export function dismissWaitingSoul(monoId: string): void {
  saveWaiting(readWaiting().filter((s) => s.monoId !== monoId));
}

/**
 * What went wrong adding a waiting Mono, in Ash's words (Critiquito, r27c): no file names, no error codes, never "seat".
 * `problem` is one of writeSoulFiles' problems; `error` is what OK threw.
 */
export function plainAddProblem(name: string, from: { problem: string } | { error: unknown }): string {
  if ("problem" in from) {
    if (/couldn't be read/i.test(from.problem)) return `Couldn't read ${name}'s setup, so it was left as it was`;
    return `Some of ${name}'s setup couldn't be added, so it was left as it was`;
  }
  const raw = from.error instanceof Error ? `${from.error.name} ${from.error.message}` : String(from.error);
  const cause = plainCause(raw);
  return cause ? `Couldn't add ${name} because ${cause}` : `Couldn't add ${name}. Try OK again`;
}

const DISK_FULL = /disk (is )?full|no space|enospc|quota/i;
/** OK failed because the disk is full: OK again can't work until there is space (r28). */
export function isDiskFullError(error: unknown): boolean {
  return DISK_FULL.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));
}

const CAUSES: [RegExp, string][] = [
  [DISK_FULL, "the disk is full"],
  [/permission denied|eacces|eperm|not permitted|access is denied/i, "the app isn't allowed to write to its folder"],
  [/read-?only|erofs/i, "its folder is read-only"],
  [/conflict/i, "its setup changed while it was being added"],
  [/enoent|not found|no such file/i, "its folder isn't there"],
  [/timed? ?out|etimedout/i, "it took too long"],
];
function plainCause(raw: string): string | undefined {
  return CAUSES.find(([re]) => re.test(raw))?.[1];
}
