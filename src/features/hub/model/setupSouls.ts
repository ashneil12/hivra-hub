// Each Mono's soul in the setup file: its role, rules (SOUL.md), memory
// (MEMORY.md), workflows (habits.json) and skills. On import, a Mono that
// isn't seated waits for Ash's OK and is never seated automatically.
import { useSyncExternalStore } from "react";
import { readAgentFile, writeAgentFile, type AgentFilePath } from "../../monos/model/monoFiles";
import { addMono, listMonos } from "../../monos/model/mono";
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
/** Ash's OK: seats the Mono and writes its rules, memory and workflows. */
export async function seatWaitingSoul(monoId: string, write: Writer = writeAgentFile, folders: string[] = []): Promise<void> {
  const soul = readWaiting().find((s) => s.monoId === monoId);
  if (!soul) return;
  if (!isSeated(monoId)) addMono({ id: soul.monoId, name: soul.name, mascot: soul.mascot ?? "robot", color: "hsl(210 8% 58%)", projects: folders });
  if (soul.rules) await write(monoId, "SOUL.md", soul.rules);
  if (soul.memory) await write(monoId, "MEMORY.md", soul.memory);
  if (soul.workflows) await write(monoId, "habits.json", soul.workflows);
  saveWaiting(readWaiting().filter((s) => s.monoId !== monoId));
}
/** Not now: drops the waiting soul; nothing was seated or written. */
export function dismissWaitingSoul(monoId: string): void {
  saveWaiting(readWaiting().filter((s) => s.monoId !== monoId));
}
