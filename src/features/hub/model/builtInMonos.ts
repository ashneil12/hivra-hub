// WP-05: no Mono is built in. A person adds one from a template (starterMonos.ts). This file only
// remembers which Monos the person removed, so a later repair cannot bring those back.
import { defaultClaudeModelId } from "../../sessions/model/defaultClaudeModel";

/** A Mono description older callers still pass. Nothing is shipped under one. */
export type TeamSpec = { id: string; name: string; engine: "claude"; addon?: true };

const LOOK = { mascot: "robot", color: "hsl(210 8% 58%)" };
const BUILT_IN: readonly TeamSpec[] = [];
/** Nothing is offered here. Starter templates are starterMonos.ts. */
export const TEAM_ADDONS: readonly TeamSpec[] = [];

/** A roster entry for a spec a caller already has. No soul is filled in. */
export function teamRosterEntry(spec: TeamSpec, projects: string[] = []) {
  return { id: spec.id, name: spec.name, ...LOOK, projects, engine: spec.engine, engineModel: defaultClaudeModelId(), instructions: undefined as string | undefined };
}

/** Ids the person removed on purpose. Only restoring the Mono (Undo) clears an entry. */
const REMOVED_KEY = "monocode:mono-team-removed-by-user";
/** A10: the list travels with an export (setupDoc PORTABLE_SETTINGS), so a Mono Ash deleted stays deleted on import. */
export const REMOVED_BY_USER_KEY = REMOVED_KEY;

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

function readRemoved(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(REMOVED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(norm) : []);
  } catch {
    return new Set();
  }
}
function writeRemoved(set: Set<string>): void {
  localStorage.setItem(REMOVED_KEY, JSON.stringify([...set]));
}

/** The default-team id a Mono stands for (matched by id or name), or undefined for anyone else. */
export function teamIdOf(m: { id?: unknown; name?: unknown }): string | undefined {
  return BUILT_IN.find((b) => norm(m.id) === b.id || norm(m.name) === norm(b.name))?.id;
}

/** The team spec (default four or an add-on) a Mono stands for, by id or name. */
export function teamSpecOf(m: { id?: unknown; name?: unknown }): TeamSpec | undefined {
  return [...BUILT_IN, ...TEAM_ADDONS].find((b) => norm(m.id) === b.id || norm(m.name) === norm(b.name));
}

/** Call when Ash removes or retires a Mono. Team Monos are recorded so the repair never brings them back. */
export function markMonoRemovedByUser(id: string, name?: string): void {
  try {
    const team = teamIdOf({ id, name });
    const set = readRemoved();
    set.add(team ?? norm(id));
    writeRemoved(set);
  } catch {
    /* storage unavailable: nothing to record */
  }
}

/** Call when a removed or retired Mono is restored (Undo). The only thing that clears an entry. */
export function clearMonoRemovedByUser(id: string, name?: string): void {
  try {
    const team = teamIdOf({ id, name });
    const set = readRemoved();
    if (set.delete(team ?? norm(id))) writeRemoved(set);
  } catch {
    /* storage unavailable */
  }
}

export function isMonoRemovedByUser(id: string): boolean {
  return readRemoved().has(norm(id));
}

/** A Mono (by its team id, or its own id) is on Ash's deleted list. */
export function monoDeletedByUser(m: { id?: unknown; name?: unknown }): boolean {
  return readRemoved().has(teamIdOf(m) ?? norm(m.id));
}

/**
 * A10 import: add an export's deleted list to this Mac's (a union: never un-deletes anything here). Returns the ids the
 * export marks deleted, so the import can take a default-team Mono this copy seeded on first launch back off.
 */
export function adoptRemovedByUser(raw: string): Set<string> {
  let incoming: Set<string>;
  try {
    const v = JSON.parse(raw) as unknown;
    incoming = new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(norm) : []);
  } catch {
    return new Set();
  }
  try {
    writeRemoved(new Set([...readRemoved(), ...incoming]));
  } catch {
    /* storage unavailable */
  }
  return incoming;
}

/**
 * Every launch used to insert a fixed team. It no longer adds anyone, and it does not rewrite a roster that is
 * already there. Returns how many it added, which is always none.
 */
export function ensureBuiltInMonos(): number {
  return 0;
}

/** No Mono is on a default team. */
export function isDefaultTeamMono(_m: { id?: unknown; name?: unknown }): boolean {
  return false;
}

export const DEFAULT_TEAM: readonly string[] = [];
export const DEFAULT_TEAM_IDS: readonly string[] = [];
