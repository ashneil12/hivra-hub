// WP-51: the memory a person reviews. Disk is untrusted: a bad file becomes an empty doc.

import { sha256Hex } from "../../historyImport/model/hash";
import { hasSecretText } from "../../portable/model/secrets";

export type MemoryAction = "add" | "update" | "remove" | "skill";
export type MemoryState = "unreviewed" | "confirmed" | "edited";

export type MemorySource = {
  kind: "turn" | "import";
  ref: string;
  label: string;
};

export type MemorySkill = { name: string; lesson: string };

/** WP-103: which tier wrote a memory. Absent on old data and on imports. */
export type MemoryVia = "rules" | "cheap" | "crew";

export type MemoryItem = {
  id: string;
  mateId: string;
  action: MemoryAction;
  text: string;
  skill?: MemorySkill;
  targetId?: string;
  state: MemoryState;
  /** WP-100: the engine whose conversation wrote this (claude, codex, …). Absent on old data. */
  by?: string;
  /** WP-103: the tier that wrote it (rules, cheap, crew). Absent on old data and on imports. */
  via?: MemoryVia;
  source: MemorySource;
  evidence: string;
  support: number;
  against: number;
  createdAt: number;
  updatedAt: number;
  /** WP-100: how strong the memory is, 0 to 1. Absent on old data, which reads as full. */
  fade?: number;
  /** WP-100: when a use signal last topped it up (ms). Absent on old data. */
  lastUsedAt?: number;
  /** WP-100: how many times the "still true?" ask has been shown for it. Absent on old data, which reads as 0. */
  asked?: number;
  /** WP-111: this fact disagrees with another one. Absent when nothing is parked. */
  dispute?: MemoryDispute;
  /** WP-240: what sort of fact this is. Absent on old data and when the curator did not say. */
  kind?: FactKind;
  /** WP-240: the names the fact is about, as the person wrote them. Absent when none were given. */
  entities?: string[];
  /** WP-240: the day an event happened (`2026-10-01`). Absent when unknown. */
  occurredOn?: string;
  /** WP-240: the first day the fact holds. Absent when unknown. */
  validFrom?: string;
  /** WP-240: the last day the fact holds. The repair pass lets it go once this day is past. Absent when it lasts. */
  validTo?: string;
  /** WP-240: why and when this item was let go. Only set on items in `MemoryDoc.archived`. */
  letGo?: LetGo;
  /** WP-241: the person said to send this fact in every chat (true) or never as part of that set (false). Absent: unmarked. */
  essential?: boolean;
  /** WP-241: how many times a first mate read this fact through its own memory tool. Absent on old data, read as 0. */
  uses?: number;
};

/** WP-240: the sort of fact, so the repair pass knows an event from a guess. */
export type FactKind = "fact" | "preference" | "plan" | "event" | "possession";
export const FACT_KINDS: readonly FactKind[] = ["fact", "preference", "plan", "event", "possession"];

/** WP-240: why an item left the kept list. */
export type LetGoReason = "superseded" | "duplicate" | "expired" | "stale" | "contradicted" | "manual";
export const LET_GO_REASONS: readonly LetGoReason[] = ["superseded", "duplicate", "expired", "stale", "contradicted", "manual"];

/** WP-240: a let-go item remembers why, which item replaced it (when one did) and when. */
export type LetGo = { reason: LetGoReason; by?: string; at: number };

/** WP-111: a parked clash. `was` is the state the older fact had, and is absent on the newer fact. */
export type MemoryDispute = {
  otherId: string;
  reason: string;
  was?: "confirmed" | "edited";
};

/** WP-100: why the curator dropped a turn's fact. */
export type DropReason = "late" | "secret" | "ungrounded" | "invalid" | "orders" | "forgotten";

/** WP-100: how memory has been going, for the Memory screen's health card. Absent on old data, which reads as zeros. */
export type MemoryHealth = {
  /** Turns the curator has looked at. */
  turns: number;
  stored: number;
  deferred: number;
  dropped: Record<DropReason, number>;
  /** When the curator last looked at a turn (ms). */
  lastRunAt?: number;
};

export type MemoryDoc = {
  revision: number;
  generation: number;
  items: MemoryItem[];
  doneTurns: string[];
  imports: Record<string, "confirmed" | "rejected">;
  /** WP-100: the days (UTC `2026-10-01`) the app was used, which memory fades over. Absent on old data. */
  livedDays?: string[];
  /** WP-100: the item last asked about in a sitting, and when that sitting began (ms). Absent on old data. */
  askSession?: { id: string; at: number };
  /** WP-100: what the curator has done, since this build began counting. Absent on old data. */
  health?: MemoryHealth;
  /**
   * Facts the person deleted, as forgetKey digests (never the text), so the curator does not learn them again from a
   * passing mention. Only the person saying "remember that ..." brings one back. Absent on old data. (Idea: OpenBot by
   * CopilotKit, MIT, deleted-fact digests.)
   */
  forgotten?: string[];
  /**
   * WP-240: the "Let go" list. Items the repair pass or the person set aside, each with `letGo` saying why. They are
   * never recalled, asked about or counted; "Bring back" puts one back. At most ARCHIVE_CAP, oldest out first.
   * Absent on old data.
   */
  archived?: MemoryItem[];
  /**
   * WP-240: the batch curator's watermark. For each first-mate chat (`<mate>:<session>`), the last message of the
   * person's it has read. Saved in the same write as the facts that batch learned, so a batch applies once. Absent on
   * old data.
   */
  reflected?: Record<string, string>;
  /** WP-240: how many times the current batch has failed to get an answer. Absent means none. */
  batchTries?: number;
};

/** WP-240: the "Let go" list keeps at most this many items. */
export const ARCHIVE_CAP = 500;
/** WP-240: the watermark keeps at most this many chats. */
const REFLECTED_CAP = 500;
const REFLECTED_KEY = /^[a-z0-9][a-z0-9-]{0,79}:[A-Za-z0-9._:-]{1,200}$/;
const BLOCK_ID = /^[A-Za-z0-9._:-]{1,200}$/;

const FORGET_KEY = /^fgt-[a-f0-9]{16}$/;
const FORGOTTEN_CAP = 2000;

/** The digest a deleted fact leaves behind: one mate, the fact's words, case and spacing ignored. */
export function forgetKey(mateId: string, text: string): string {
  return `fgt-${sha256Hex(`${mateId}\n${normalizeFact(text).toLowerCase()}`).slice(0, 16)}`;
}

export function isForgotten(doc: MemoryDoc, mateId: string, text: string): boolean {
  return doc.forgotten?.includes(forgetKey(mateId, text)) ?? false;
}

/** Remembers that a fact was deleted. The oldest digests go first past the cap. */
export function withForgotten(doc: MemoryDoc, mateId: string, text: string): MemoryDoc {
  const key = forgetKey(mateId, text);
  const have = doc.forgotten ?? [];
  if (have.includes(key)) return doc;
  return { ...doc, forgotten: [...have, key].slice(-FORGOTTEN_CAP) };
}

/** Takes a digest out again, when the person asks for the fact back in their own words. */
export function withoutForgotten(doc: MemoryDoc, mateId: string, text: string): MemoryDoc {
  const key = forgetKey(mateId, text);
  if (!doc.forgotten?.includes(key)) return doc;
  const forgotten = doc.forgotten.filter((have) => have !== key);
  const next: MemoryDoc = { ...doc, forgotten };
  if (!forgotten.length) delete next.forgotten;
  return next;
}

const ITEM_ID = /^mem-[a-f0-9]{16}$/;
const MATE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const IMPORT_ID = /^[a-z0-9-]{1,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** An engine id: a harness name, lowercase, like `claude` or `codex`. */
export const ENGINE_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Plain names for engines a person might read, keyed by harness id (session.ts HARNESS_LABEL's ids). */
const ENGINE_NAME: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "OMP",
  fx: "FX",
  hermes: "Hermes",
  antigravity: "Antigravity",
  devin: "Devin",
};

/** The name a person reads for an engine, or the id itself when it is one this screen does not know. */
export function engineName(id: string): string {
  return ENGINE_NAME[id] ?? id;
}

export function emptyDoc(revision = 0): MemoryDoc {
  return { revision, generation: 0, items: [], doneTurns: [], imports: {} };
}

/** A secret, including one hiding behind a path separator. */
export function mentionsSecret(text: string): boolean {
  if (hasSecretText(text)) return true;
  if (!text.includes("/") && !text.includes("\\") && !text.includes(":")) return false;
  return hasSecretText(text.replace(/[/\\:]/g, " "));
}

/** One line, LF, trimmed. A fact is one sentence, not a pasted transcript. */
export function normalizeFact(text: string): string {
  const line = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  return line.length > 400 ? `${line.slice(0, 397).trimEnd()}…` : line;
}

export function memoryId(parts: readonly string[]): string {
  return `mem-${sha256Hex(parts.join("\n")).slice(0, 16)}`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSource(value: unknown): value is MemorySource {
  if (!value || typeof value !== "object") return false;
  const source = value as MemorySource;
  return (
    (source.kind === "turn" || source.kind === "import") &&
    typeof source.ref === "string" &&
    source.ref.length > 0 &&
    source.ref.length <= 200 &&
    typeof source.label === "string" &&
    source.label.length > 0 &&
    source.label.length <= 200 &&
    !mentionsSecret(source.ref) &&
    !mentionsSecret(source.label)
  );
}

function isItem(value: unknown): value is MemoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as MemoryItem;
  if (typeof item.id !== "string" || !ITEM_ID.test(item.id)) return false;
  if (typeof item.mateId !== "string" || !MATE_ID.test(item.mateId)) return false;
  if (item.action !== "add" && item.action !== "update" && item.action !== "remove" && item.action !== "skill") return false;
  if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 500) return false;
  if (item.state !== "unreviewed" && item.state !== "confirmed" && item.state !== "edited") return false;
  if (!isSource(item.source)) return false;
  if (typeof item.evidence !== "string" || item.evidence.length > 500) return false;
  if (mentionsSecret(item.text) || mentionsSecret(item.evidence)) return false;
  if (!finite(item.support) || !finite(item.against) || !finite(item.createdAt) || !finite(item.updatedAt)) return false;
  if (item.targetId !== undefined && (typeof item.targetId !== "string" || !ITEM_ID.test(item.targetId))) return false;
  if (item.action === "skill") {
    if (!item.skill || typeof item.skill.name !== "string" || typeof item.skill.lesson !== "string") return false;
    if (!item.skill.name || !item.skill.lesson || mentionsSecret(item.skill.name) || mentionsSecret(item.skill.lesson)) return false;
  }
  return true;
}

/**
 * An item as it loads: a field that cannot be read (`by`, `fade`, `lastUsedAt`, `asked`) is dropped and the memory
 * itself is kept, because disk is untrusted and a wrong number is no reason to forget a fact.
 */
function loadedItem(value: unknown): MemoryItem | undefined {
  if (!isItem(value)) return undefined;
  const rest: MemoryItem = { ...value };
  if (rest.by !== undefined && !(typeof rest.by === "string" && ENGINE_ID.test(rest.by))) delete rest.by;
  if (rest.via !== undefined && rest.via !== "rules" && rest.via !== "cheap" && rest.via !== "crew") delete rest.via;
  if (rest.fade !== undefined && !(finite(rest.fade) && rest.fade <= 1)) delete rest.fade;
  if (rest.lastUsedAt !== undefined && !finite(rest.lastUsedAt)) delete rest.lastUsedAt;
  if (rest.asked !== undefined && !(finite(rest.asked) && Number.isInteger(rest.asked))) delete rest.asked;
  loadDetails(rest);
  const rawDispute = (value as { dispute?: unknown }).dispute;
  if (rawDispute !== undefined) {
    const dispute = loadedDispute(rest.id, rawDispute);
    if (dispute) rest.dispute = dispute;
    else delete rest.dispute;
  }
  return rest;
}

/** A real calendar day, `2026-10-01`. */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/** The names a fact is about: short, no secrets, one of each, at most ten. Undefined when none survive. */
export function cleanEntities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = [
    ...new Set(
      value
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.replace(/\s+/g, " ").trim())
        .filter((name) => name.length > 0 && name.length <= 80 && !mentionsSecret(name)),
    ),
  ].slice(0, 10);
  return names.length ? names : undefined;
}

/** WP-240: the typed details and the WP-241 marks, each dropped on its own when it cannot be read. */
function loadDetails(item: MemoryItem): void {
  if (item.kind !== undefined && !FACT_KINDS.includes(item.kind)) delete item.kind;
  if (item.entities !== undefined) {
    const entities = cleanEntities(item.entities);
    if (entities) item.entities = entities;
    else delete item.entities;
  }
  if (item.occurredOn !== undefined && !isDay(item.occurredOn)) delete item.occurredOn;
  if (item.validFrom !== undefined && !isDay(item.validFrom)) delete item.validFrom;
  if (item.validTo !== undefined && !isDay(item.validTo)) delete item.validTo;
  if (item.essential !== undefined && typeof item.essential !== "boolean") delete item.essential;
  if (item.uses !== undefined && !(finite(item.uses) && Number.isInteger(item.uses))) delete item.uses;
  // Only the archive's own reader keeps a let-go mark; a kept item never carries one.
  delete item.letGo;
}

function loadedLetGo(value: unknown): LetGo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as { reason?: unknown; by?: unknown; at?: unknown };
  if (!LET_GO_REASONS.includes(raw.reason as LetGoReason) || !finite(raw.at)) return undefined;
  const letGo: LetGo = { reason: raw.reason as LetGoReason, at: raw.at };
  if (typeof raw.by === "string" && ITEM_ID.test(raw.by)) letGo.by = raw.by;
  return letGo;
}

/** The "Let go" list: each item read like a kept one, plus its let-go mark. One without a readable mark is dropped. */
function loadedArchive(value: unknown): MemoryItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: MemoryItem[] = [];
  for (const raw of value) {
    const item = loadedItem(raw);
    const letGo = loadedLetGo((raw as { letGo?: unknown } | null)?.letGo);
    if (!item || !letGo || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ ...item, letGo });
  }
  return out.slice(-ARCHIVE_CAP);
}

function loadedReflected(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, id] of Object.entries(value).slice(-REFLECTED_CAP)) {
    if (REFLECTED_KEY.test(key) && typeof id === "string" && BLOCK_ID.test(id) && !mentionsSecret(key)) out[key] = id;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A clash that cannot be read is dropped. The fact it was on is kept. */
function loadedDispute(itemId: string, value: unknown): MemoryDispute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as { otherId?: unknown; reason?: unknown; was?: unknown };
  if (typeof raw.otherId !== "string" || !ITEM_ID.test(raw.otherId) || raw.otherId === itemId) return undefined;
  if (typeof raw.reason !== "string") return undefined;
  const reason = raw.reason.trim();
  if (!reason || reason.length > 200 || mentionsSecret(reason)) return undefined;
  if (raw.was === undefined) return { otherId: raw.otherId, reason };
  if (raw.was !== "confirmed" && raw.was !== "edited") return undefined;
  return { otherId: raw.otherId, reason, was: raw.was };
}

/** The lived days the doc can read: real UTC dates, one of each, oldest first. */
function loadedDays(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((day): day is string => typeof day === "string" && DAY.test(day)))].sort();
}

/** The sit-in record, when both parts can be read. */
function loadedSession(value: unknown): { id: string; at: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { id?: unknown; at?: unknown };
  if (typeof row.id !== "string" || !ITEM_ID.test(row.id) || !finite(row.at)) return undefined;
  return { id: row.id, at: row.at };
}

/** A count a person's eye will never see wrong: whole, never negative, missing reads as 0. */
function count(value: unknown): number {
  return finite(value) ? Math.floor(value) : 0;
}

/** The health record: each count read on its own, so one bad number does not throw the rest away. */
function loadedHealth(value: unknown): MemoryHealth | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<MemoryHealth> & { dropped?: Record<string, unknown> };
  const dropped = (raw.dropped && typeof raw.dropped === "object" ? raw.dropped : {}) as Record<string, unknown>;
  const health: MemoryHealth = {
    turns: count(raw.turns),
    stored: count(raw.stored),
    deferred: count(raw.deferred),
    dropped: {
      late: count(dropped.late),
      secret: count(dropped.secret),
      ungrounded: count(dropped.ungrounded),
      invalid: count(dropped.invalid),
      orders: count(dropped.orders),
      forgotten: count(dropped.forgotten),
    },
  };
  if (finite(raw.lastRunAt)) health.lastRunAt = raw.lastRunAt;
  return health;
}

/** Anything that is not a memory doc, or a doc with secrets in it, comes back empty of those parts. */
export function parseDoc(value: unknown): MemoryDoc {
  if (!value || typeof value !== "object") return emptyDoc();
  const raw = value as Partial<MemoryDoc>;
  const seen = new Set<string>();
  const items = (Array.isArray(raw.items) ? raw.items : []).flatMap((raw) => loadedItem(raw) ?? []).filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const doneTurns = (Array.isArray(raw.doneTurns) ? raw.doneTurns : [])
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200 && !mentionsSecret(id))
    .slice(-2000);
  const imports: Record<string, "confirmed" | "rejected"> = {};
  if (raw.imports && typeof raw.imports === "object") {
    for (const [key, status] of Object.entries(raw.imports)) {
      if (!IMPORT_ID.test(key)) continue;
      if (status === "confirmed" || status === "rejected") imports[key] = status;
    }
  }
  const livedDays = loadedDays(raw.livedDays);
  const askSession = loadedSession(raw.askSession);
  const health = loadedHealth(raw.health);
  const forgotten = (Array.isArray(raw.forgotten) ? raw.forgotten : [])
    .filter((key): key is string => typeof key === "string" && FORGET_KEY.test(key))
    .slice(-FORGOTTEN_CAP);
  const archived = loadedArchive(raw.archived);
  const reflected = loadedReflected(raw.reflected);
  const batchTries = finite(raw.batchTries) ? Math.floor(raw.batchTries) : 0;
  return {
    revision: finite(raw.revision) ? Math.floor(raw.revision) : 0,
    generation: finite(raw.generation) ? Math.floor(raw.generation) : 0,
    items,
    doneTurns,
    imports,
    ...(livedDays ? { livedDays } : {}),
    ...(askSession ? { askSession } : {}),
    ...(health ? { health } : {}),
    ...(forgotten.length ? { forgotten } : {}),
    ...(archived.length ? { archived } : {}),
    ...(reflected ? { reflected } : {}),
    ...(batchTries ? { batchTries } : {}),
  };
}

export function bump(doc: MemoryDoc): MemoryDoc {
  return { ...doc, generation: doc.generation + 1 };
}
