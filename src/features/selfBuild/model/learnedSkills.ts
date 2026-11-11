// WP-242: at most LEARNED_CAP learned skills per home. Hivra keeps a small record beside the skills
// (`~/.agents/skills/.hivra-learned.json`): for each skill a lesson made or changed, when it was last used and the
// digest of the file as Hivra last wrote it. Past the cap, the least recently used goes first, never one the person
// edited since (its digest no longer matches) and never one Hivra did not make. An evicted skill is moved to
// `~/.agents/skills-let-go/<when>/`, not deleted.
// (Idea: Nod by n8n, Apache-2.0, src/server/learned-skills.ts `makeRoom`. No code copied.)

import { sha256Hex } from "../../historyImport/model/hash";

export const LEARNED_CAP = 40;
export const REGISTRY_FILE = ".agents/skills/.hivra-learned.json";
export const LET_GO_FOLDER = ".agents/skills-let-go";

export type LearnedEntry = { usedAt: number; digest: string };
export type LearnedRegistry = Record<string, LearnedEntry>;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function digestOf(text: string): string {
  return sha256Hex(text);
}

/** The record as read from disk, untrusted: a row that cannot be read is left out. */
export function parseRegistry(text: string | undefined): LearnedRegistry {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: LearnedRegistry = {};
  for (const [name, row] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME.test(name) || !row || typeof row !== "object") continue;
    const { usedAt, digest } = row as { usedAt?: unknown; digest?: unknown };
    if (typeof usedAt !== "number" || !Number.isFinite(usedAt) || typeof digest !== "string" || !DIGEST.test(digest)) continue;
    out[name] = { usedAt, digest };
  }
  return out;
}

/** The record after Hivra wrote `text` to this skill now. */
export function noteLearned(registry: LearnedRegistry, name: string, at: number, text: string): LearnedRegistry {
  return { ...registry, [name]: { usedAt: at, digest: digestOf(text) } };
}

/**
 * Which skills to move out so at most `cap` learned skills stay. `current` is each recorded skill's file as it is now
 * (undefined when it is gone). The skill just written is never one of them, nor one whose file changed since Hivra
 * wrote it, because the person edited it. Gone files leave the record.
 */
export function evictions(
  registry: LearnedRegistry,
  current: Record<string, string | undefined>,
  keep: string,
  cap = LEARNED_CAP,
): { evict: string[]; registry: LearnedRegistry } {
  const live: LearnedRegistry = {};
  for (const [name, entry] of Object.entries(registry)) if (current[name] !== undefined) live[name] = entry;
  const names = Object.keys(live);
  const over = names.length - cap;
  if (over <= 0) return { evict: [], registry: live };
  const movable = names
    .filter((name) => name !== keep && digestOf(current[name] ?? "") === live[name].digest)
    .sort((a, b) => live[a].usedAt - live[b].usedAt || a.localeCompare(b));
  const evict = movable.slice(0, over);
  const left = { ...live };
  for (const name of evict) delete left[name];
  return { evict, registry: left };
}
