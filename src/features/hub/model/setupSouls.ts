// Each Mono's soul in the setup file: its role, rules (SOUL.md), memory
// (MEMORY.md), workflows (habits.json) and skills. On import, a Mono that
// isn't seated waits for Ash's OK and is never seated automatically.
import { useSyncExternalStore } from "react";
import { readAgentFile, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { addMono, findMono, listMonos, parseMonoEngine, updateMono, type MonoEngine } from "../../monos/model/mono";
import { ROLE_NAMES } from "./roleNames";

export type SetupSoul = {
  monoId: string;
  name: string;
  /** One plain line on what it does. */
  role: string;
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
};

type Reader = (monoId: string, path: AgentFilePath) => Promise<{ text: string | null }>;
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

/** Reads every seated Mono's soul. A Mono whose files can't be read is skipped, not faked. */
export async function collectSouls(read: Reader = readAgentFile): Promise<SetupSoul[]> {
  const out: SetupSoul[] = [];
  for (const m of roster()) {
    try {
      const [soul, memory, habits] = await Promise.all([read(m.id, "SOUL.md"), read(m.id, "MEMORY.md"), read(m.id, "habits.json")]);
      const rules = soul.text ?? "";
      const name = m.name ?? m.id;
      out.push({ monoId: m.id, name, role: roleOf(name, rules), rules, memory: memory.text ?? "", workflows: habits.text ?? "", skills: skillsOf(rules), mascot: m.mascot });
    } catch {
      /* files not reachable (no backend): leave this soul out */
    }
  }
  return out;
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

/**
 * Writes a soul's files into a Mono's folder without overwriting: a file that is already there with text stays, unless
 * `replace` (Ash ticked "use the file's" in the preview). Returns the paths written and the ones kept.
 */
export async function writeSoulFiles(
  monoId: string,
  files: [AgentFilePath, string][],
  { write = writeAgentFile as Writer, read = readAgentFile as Read, replace = false }: { write?: Writer; read?: Read; replace?: boolean } = {},
): Promise<{ written: AgentFilePath[]; kept: AgentFilePath[] }> {
  const written: AgentFilePath[] = [];
  const kept: AgentFilePath[] = [];
  for (const [path, text] of files) {
    let current: string | null = null;
    try {
      current = (await read(monoId, path)).text;
    } catch {
      current = null;
    }
    if (current === text) continue;
    if (current?.trim() && !replace) {
      kept.push(path);
      continue;
    }
    await write(monoId, path, text);
    written.push(path);
  }
  return { written, kept };
}

/**
 * Ash's OK: seats the Mono with its look, projects and engine, and writes its rules, memory and workflows. A Mono that
 * left files behind here before keeps them: only missing files are written.
 */
export async function seatWaitingSoul(monoId: string, write: Writer = writeAgentFile, folders?: string[], read: Read = readAgentFile): Promise<void> {
  const soul = readWaiting().find((s) => s.monoId === monoId);
  if (!soul) return;
  if (!isSeated(monoId)) {
    const engine = parseMonoEngine(soul.engine);
    addMono({
      id: soul.monoId,
      name: soul.name,
      mascot: soul.mascot ?? "robot",
      ...(soul.mascotPicked ? { mascotPicked: true } : {}),
      color: soul.color ?? "hsl(210 8% 58%)",
      projects: folders ?? soul.projects ?? [],
      ...(engine ? { engine } : {}),
    });
  }
  await writeSoulFiles(monoId, soulFiles(soul), { write, read });
  saveWaiting(readWaiting().filter((s) => s.monoId !== monoId));
}

/**
 * For a Mono that is already seated here: adds the file's projects it lacks, its engine when it has none, and the
 * file's soul files that are missing (all of them with `replace`). Nothing of its own is overwritten otherwise.
 */
export async function mergeIntoSeated(
  soul: SetupSoul,
  { replace = false, write, read }: { replace?: boolean; write?: Writer; read?: Read } = {},
): Promise<{ written: AgentFilePath[]; kept: AgentFilePath[] }> {
  const mono = findMono(soul.monoId);
  if (!mono) return { written: [], kept: [] };
  const engine = parseMonoEngine(soul.engine);
  updateMono(mono.id, (m) => ({
    ...m,
    projects: [...m.projects, ...(soul.projects ?? [])],
    ...(!m.engine && engine ? { engine } : replace && engine ? { engine } : {}),
  }));
  return writeSoulFiles(mono.id, soulFiles(soul), { replace, ...(write ? { write } : {}), ...(read ? { read } : {}) });
}
/** Not now: drops the waiting soul; nothing was seated or written. */
export function dismissWaitingSoul(monoId: string): void {
  saveWaiting(readWaiting().filter((s) => s.monoId !== monoId));
}
