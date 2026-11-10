// WP-141: the person's locks and fallback order, kept with the crew settings.
// A value from disk or another window is untrusted: a broken field is dropped.

import { CLI_ORDER, cliLabel, isCli, isEffort, type CliName } from "./clis";
import type { CrewRule } from "./rules";

export const ROLE_SLOTS = ["builder", "reviewer", "researcher"] as const;

export type RoleSlot = (typeof ROLE_SLOTS)[number];

export type SlotPick = {
  cli?: string;
  model?: string;
  effort?: string;
};

/** Always use my default, the never-use list, and the person's fallback order. */
export type CrewPolicy = {
  lockDefault: boolean;
  neverUse: string[];
  fallback: string[];
};

export type PolicyWhere = "system" | "project" | "mono";

export type PolicyBook = {
  system?: CrewPolicy;
  projects: Record<string, CrewPolicy>;
  monos: Record<string, CrewPolicy>;
};

const MAX_IDS = 32;
const MAX_ID = 64;
const MAX_KEY = 1024;

export const EMPTY_POLICY: CrewPolicy = { lockDefault: false, neverUse: [], fallback: [] };

/** The rules page and the defaults screen tell each other a save landed, so a quiet editor reloads. */
export const CREW_SAVED_EVENT = "hivra-crew-saved";

const ROLE_NAME: Record<RoleSlot, string> = {
  builder: "Builder",
  reviewer: "Reviewer",
  researcher: "Researcher",
};

export function isRoleSlot(value: string): value is RoleSlot {
  return (ROLE_SLOTS as readonly string[]).includes(value);
}

export function roleSlotName(role: RoleSlot): string {
  return ROLE_NAME[role];
}

function oneLine(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[\r\n]/g, "").trim();
}

/**
 * The CLI id a typed name stands for: its id or its label, in any letter case ("Codex", "Claude Code"). Undefined when
 * it names no CLI. Stored as the id, so the resolver's exact match sees it (Rust: policy.rs cli_id_of).
 */
export function cliIdOf(value: string): CliName | undefined {
  const key = value.trim().toLowerCase();
  return CLI_ORDER.find((cli) => key === cli || key === cliLabel(cli).toLowerCase());
}

/** A Mono id or a CLI id. A newline is not joined into a different id. Paths, blanks and duplicates are dropped. */
function cleanId(value: string): string | undefined {
  if (/[\r\n]/.test(value)) return undefined;
  const mapped = cliIdOf(value);
  if (mapped) return mapped;
  const text = value.trim();
  if (!text || text.length > MAX_ID || text.includes("..") || text.includes("/") || text.includes("\\")) return undefined;
  if (isCli(text)) return text;
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text;
  return undefined;
}

function cleanIds(value: unknown, cliOnly: boolean): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = cleanId(item);
    if (!id) continue;
    if (cliOnly && !isCli(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= (cliOnly ? CLI_ORDER.length : MAX_IDS)) break;
  }
  return out;
}

/** A stored or imported policy. Unknown fields are dropped. Only `true` turns the lock on. */
export function sanitizePolicy(value: unknown): CrewPolicy {
  if (!value || typeof value !== "object") return { lockDefault: false, neverUse: [], fallback: [] };
  const raw = value as Record<string, unknown>;
  return {
    lockDefault: raw.lockDefault === true,
    neverUse: cleanIds(raw.neverUse, false),
    fallback: cleanIds(raw.fallback, true),
  };
}

export function emptyBook(): PolicyBook {
  return { projects: {}, monos: {} };
}

function cleanKey(value: string, mono: boolean): string | undefined {
  const text = oneLine(value);
  if (!text || text.length > (mono ? MAX_ID : MAX_KEY) || text.includes("..")) return undefined;
  if (mono && !/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  return text;
}

/** What was stored. A broken book comes back empty rather than throwing. */
export function loadBook(value: unknown): PolicyBook {
  if (!value || typeof value !== "object") return emptyBook();
  const raw = value as Record<string, unknown>;
  const projects: Record<string, CrewPolicy> = {};
  const monos: Record<string, CrewPolicy> = {};
  if (raw.projects && typeof raw.projects === "object") {
    for (const [key, row] of Object.entries(raw.projects as Record<string, unknown>)) {
      const id = cleanKey(key, false);
      if (!id) continue;
      projects[id] = sanitizePolicy(row);
    }
  }
  if (raw.monos && typeof raw.monos === "object") {
    for (const [key, row] of Object.entries(raw.monos as Record<string, unknown>)) {
      const id = cleanKey(key, true);
      if (!id) continue;
      monos[id] = sanitizePolicy(row);
    }
  }
  return {
    ...(raw.system == null ? {} : { system: sanitizePolicy(raw.system) }),
    projects,
    monos,
  };
}

/** The book as it would be written. Same checks as a load. */
export function saveBook(book: PolicyBook): PolicyBook {
  return loadBook(book);
}

/**
 * A Mono uses its own saved policy. With no Mono row, a project uses its own, then the system.
 */
export function policyInForce(
  book: PolicyBook,
  where: { mono?: string; project?: string },
): CrewPolicy {
  if (where.mono) {
    const id = cleanKey(where.mono, true);
    if (id && book.monos[id]) return book.monos[id];
  }
  if (where.project) {
    const id = cleanKey(where.project, false);
    if (id && book.projects[id]) return book.projects[id];
  }
  return book.system ?? { lockDefault: false, neverUse: [], fallback: [] };
}

export function writePolicy(
  book: PolicyBook,
  where: { mono?: string; project?: string },
  policy: unknown,
): PolicyBook {
  const next = loadBook(book);
  const clean = sanitizePolicy(policy);
  if (where.mono) {
    const id = cleanKey(where.mono, true);
    if (!id) return next;
    next.monos = { ...next.monos, [id]: clean };
    return next;
  }
  if (where.project) {
    const id = cleanKey(where.project, false);
    if (!id) return next;
    next.projects = { ...next.projects, [id]: clean };
    return next;
  }
  next.system = clean;
  return next;
}

/**
 * Two windows share one revision. A save whose revision is behind does not write.
 * The caller keeps the copy it already has.
 */
export function casPolicy(
  expected: number,
  current: number,
  policy: unknown,
): { ok: true; revision: number; policy: CrewPolicy } | { ok: false; reason: string } {
  if (!Number.isInteger(expected) || !Number.isInteger(current) || expected !== current) {
    return { ok: false, reason: "Someone else saved these settings. Reload and try again." };
  }
  return { ok: true, revision: expected + 1, policy: sanitizePolicy(policy) };
}

/** A person rule whose only label is a role slot and that sets no path. A plugin rule is not one. */
export function isRoleSlotRule(rule: { labels: readonly string[]; paths: readonly string[]; source?: string }): boolean {
  if (rule.source === "plugin") return false;
  if (rule.paths.some((path) => oneLine(path).length > 0)) return false;
  if (rule.labels.length !== 1) return false;
  return isRoleSlot(oneLine(rule.labels[0]).toLowerCase());
}

export function roleSlotOf(rule: CrewRule): RoleSlot | null {
  if (rule.source === "plugin" || !isRoleSlotRule(rule)) return null;
  const label = oneLine(rule.labels[0]).toLowerCase();
  return isRoleSlot(label) ? label : null;
}

function cleanModel(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return undefined;
  return text;
}

/** The person-owned rule for one role, or null when the row is cleared. */
export function roleSlotRule(role: string, pick: SlotPick | undefined): CrewRule | null {
  const label = oneLine(role).toLowerCase();
  if (!isRoleSlot(label)) return null;
  const cli = pick?.cli && isCli(pick.cli.trim()) ? pick.cli.trim() : undefined;
  const effort = pick?.effort && isEffort(pick.effort.trim()) ? pick.effort.trim() : undefined;
  const model = cleanModel(pick?.model);
  if (!cli && !model && !effort) return null;
  return { labels: [label], paths: [], cli, model, effort, source: "person" };
}

/**
 * Put each role's current pick back where its first rule was. A later rule for the same role stays.
 * A role with no rule yet is added at the end, in the role order.
 */
export function placeRoleSlots(rules: readonly CrewRule[], slots: Partial<Record<RoleSlot, SlotPick>>): CrewRule[] {
  const seen = new Set<RoleSlot>();
  const out: CrewRule[] = [];
  for (const rule of rules) {
    const role = roleSlotOf(rule);
    if (!role || seen.has(role)) {
      out.push(rule);
      continue;
    }
    seen.add(role);
    const next = roleSlotRule(role, slots[role]);
    if (next) out.push(next);
  }
  for (const role of ROLE_SLOTS) {
    if (seen.has(role)) continue;
    const next = roleSlotRule(role, slots[role]);
    if (next) out.push(next);
  }
  return out;
}

/** Role rules stay where they were. Edited rows fill the other places, in order, and extras go at the end. */
export function weaveRoleSlots<T extends { labels: readonly string[]; paths: readonly string[]; source?: string }>(
  original: readonly T[],
  editedShown: readonly T[],
): T[] {
  const shown = [...editedShown];
  const out: T[] = [];
  for (const rule of original) {
    if (isRoleSlotRule(rule)) {
      out.push(rule);
      continue;
    }
    const next = shown.shift();
    if (next) out.push(next);
  }
  out.push(...shown);
  return out;
}

/**
 * The roles that have more than one person rule. The Crew Defaults row shows the first; the second still applies, so
 * the screen names it rather than hiding it.
 */
export function roleSlotsWithExtraRules(rules: readonly CrewRule[]): RoleSlot[] {
  const seen = new Set<RoleSlot>();
  const extra = new Set<RoleSlot>();
  for (const rule of rules) {
    const role = roleSlotOf(rule);
    if (!role) continue;
    if (seen.has(role)) extra.add(role);
    seen.add(role);
  }
  return ROLE_SLOTS.filter((role) => extra.has(role));
}

/** Replace that role's rule in place. Other rules, including plugin rules, stay. */
export function upsertRoleSlot(rules: readonly CrewRule[], role: RoleSlot, pick: SlotPick | undefined): CrewRule[] {
  const next = roleSlotRule(role, pick);
  const index = rules.findIndex((rule) => roleSlotOf(rule) === role);
  if (index < 0) return next ? [...rules, next] : [...rules];
  if (!next) return rules.filter((_, at) => at !== index);
  return rules.map((rule, at) => (at === index ? next : rule));
}

export function roleSlotsFrom(rules: readonly CrewRule[]): Partial<Record<RoleSlot, SlotPick>> {
  const out: Partial<Record<RoleSlot, SlotPick>> = {};
  for (const rule of rules) {
    const role = roleSlotOf(rule);
    if (!role || out[role]) continue;
    out[role] = {
      ...(rule.cli ? { cli: rule.cli } : {}),
      ...(rule.model ? { model: rule.model } : {}),
      ...(rule.effort ? { effort: rule.effort } : {}),
    };
  }
  return out;
}
