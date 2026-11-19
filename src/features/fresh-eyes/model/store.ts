// WP-144: the project's fresh-eyes setting and the reviews waiting on a brief.
// Both live in one hub document (`fresh-eyes`, in the app's database: src-tauri/src/local_hub.rs), so a held brief
// survives a restart and every window reads the same one. A write lands only on the revision just read; another
// window's write means read again and apply on top. A save that did not happen says so; nothing is held in memory as
// if it had been kept. The records are capped and old ones are pruned, so the document stays small.

import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import type { Finding } from "./review";
import type { Persona } from "./personas";
import { readSetting, type FreshEyesSetting } from "./setting";

export type ReviewStatus = "pending" | "approved" | "skipped_by_person" | "editing";

/** One window's hold on a step (a review run, or the start of a brief), until `until`. */
export type Lease = { kind: "review" | "start"; by: string; until: number };

export type ReviewRecord = {
  project: string;
  requestId: string;
  revision: number;
  status: ReviewStatus;
  findings: Finding[];
  failed: Persona[];
  /** Ask the reviewers again. A timeout is not a final result. */
  retry: boolean;
  /** The Inbox question was asked. A failed ask stays false so the next try asks again. */
  asked: boolean;
  plan: string;
  /** The chat that asked. A decision counts only for the brief this chat asked about. */
  owner?: string;
  /** The delegate call kept while builders wait, plain JSON. Disk values are untrusted. */
  held?: Record<string, unknown>;
  /** A hash of the owner and the held call. A different brief under the same request ID is a new review. */
  hash?: string;
  /** The Inbox key of this brief's question. */
  key?: string;
  /** The reviewers are working on it (here, or in a window that has since died: see `lease`). */
  running?: boolean;
  /** Why the last ask of the Inbox failed. Shown, never swallowed. */
  askError?: string;
  /** The held brief went back through tasks.delegate. It is not started a second time. */
  launched?: boolean;
  /** Starts that failed, the last error, and when the next try is due. */
  startFailures?: number;
  startError?: string;
  nextTryAt?: number;
  /** Every try failed: the owner chat and the person were told, and it waits for their word. */
  startGaveUp?: boolean;
  /** How many times every try has failed. Each give-up asks its own question. */
  startRound?: number;
  /** The window running the reviewers, or starting the brief. Another window leaves it alone until it runs out. */
  lease?: Lease;
  updatedAt?: number;
};

export type FileShape = {
  /** The revision of the document this was read from or written as. */
  revision: number;
  settings: Record<string, unknown>;
  reviews: ReviewRecord[];
};

/** The hub document (lowercase, as local_hub.rs requires). */
export const FRESH_EYES_DOC_KEY = "fresh-eyes";

/** Reviews kept. Past it the oldest finished ones go; with none finished a new brief is refused, not an old one lost. */
export const REVIEW_KEEP = 40;
/** A review untouched this long is dropped, held brief or not. */
export const REVIEW_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** A held brief (the delegate call as JSON) over this is refused, not stored in part. */
export const HELD_MAX_CHARS = 150_000;
const PLAN_MAX_CHARS = 60_000;
const READ_TRIES = 5;

const STATUSES = new Set<ReviewStatus>(["pending", "approved", "skipped_by_person", "editing"]);

export type PutResult = {
  ok: boolean;
  current: ReviewRecord | null;
  /** Why a write did not land: another writer won, the store failed, or a cap held. */
  why?: "conflict" | "failed" | "full" | "too-big";
};

export interface EyesStorage {
  /** Who this window is, for the leases it takes. */
  readonly windowId: string;
  now(): number;
  /** Read the document once. Throws when the store does not answer, so a read that failed is never taken for "off". */
  load(): Promise<void>;
  /** Read it again now (another window may have written). */
  refresh(): Promise<void>;
  /** What is held now. */
  snapshot(): FileShape;
  /**
   * Change the document on the revision just read. `fn` edits a copy and returns true to keep the change. A write lost
   * to another window is made again on a fresh read. "failed" means nothing was saved.
   */
  change(fn: (draft: FileShape) => boolean): Promise<"saved" | "skipped" | "failed">;
  subscribe(fn: () => void): () => void;
}

/** Tests hold a write so a late reply can be checked. Production leaves this unset. */
let hold: Promise<void> | null = null;

export function holdFreshEyesWrites(next: Promise<void> | null): void {
  hold = next;
}

function emptyFile(): FileShape {
  return { revision: 0, settings: {}, reviews: [] };
}

/** A plain JSON object, or nothing. Cycles and non-objects are dropped. */
export function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) return undefined;
    return cloned as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1_000 ? value : undefined;
}

function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function leaseFrom(value: unknown): Lease | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as { kind?: unknown; by?: unknown; until?: unknown };
  const by = text(row.by, 100);
  const until = time(row.until);
  if (row.kind !== "review" && row.kind !== "start") return undefined;
  return by && until !== undefined ? { kind: row.kind, by, until } : undefined;
}

function normalize(row: ReviewRecord): ReviewRecord {
  const next: ReviewRecord = {
    project: row.project,
    requestId: row.requestId,
    revision: row.revision,
    status: row.status,
    findings: Array.isArray(row.findings) ? row.findings : [],
    failed: Array.isArray(row.failed) ? row.failed : [],
    retry: row.retry === true,
    asked: row.asked === true,
    plan: typeof row.plan === "string" ? row.plan.slice(0, PLAN_MAX_CHARS) : "",
  };
  const held = plainRecord(row.held);
  if (held) next.held = held;
  const owner = text(row.owner, 256);
  if (owner) next.owner = owner;
  const hash = text(row.hash, 128);
  if (hash) next.hash = hash;
  const key = text(row.key, 120);
  if (key) next.key = key;
  if (row.running === true) next.running = true;
  const askError = text(row.askError, 300);
  if (askError) next.askError = askError;
  if (row.launched === true) next.launched = true;
  const failures = count(row.startFailures);
  if (failures) next.startFailures = failures;
  const startError = text(row.startError, 300);
  if (startError) next.startError = startError;
  const nextTryAt = time(row.nextTryAt);
  if (nextTryAt) next.nextTryAt = nextTryAt;
  if (row.startGaveUp === true) next.startGaveUp = true;
  const startRound = count(row.startRound);
  if (startRound) next.startRound = startRound;
  const lease = leaseFrom(row.lease);
  if (lease) next.lease = lease;
  const updatedAt = time(row.updatedAt);
  if (updatedAt !== undefined) next.updatedAt = updatedAt;
  return next;
}

function isReview(value: unknown): value is ReviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<ReviewRecord>;
  return (
    typeof row.project === "string" &&
    typeof row.requestId === "string" &&
    typeof row.revision === "number" &&
    typeof row.status === "string" &&
    STATUSES.has(row.status as ReviewStatus) &&
    Array.isArray(row.findings)
  );
}

/** The document as read: untrusted, so anything that is not a review this build understands is dropped. */
function parseDoc(value: unknown, revision: number): FileShape {
  const doc = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const settings =
    doc.settings && typeof doc.settings === "object" && !Array.isArray(doc.settings)
      ? (doc.settings as Record<string, unknown>)
      : {};
  const reviews = Array.isArray(doc.reviews) ? doc.reviews.filter(isReview).map(normalize) : [];
  return { revision, settings, reviews };
}

function copyOf(file: FileShape): FileShape {
  return {
    revision: file.revision,
    settings: { ...file.settings },
    reviews: file.reviews.map((row) => ({ ...row })),
  };
}

function sameFile(a: FileShape, b: FileShape): boolean {
  return JSON.stringify({ s: a.settings, r: a.reviews }) === JSON.stringify({ s: b.settings, r: b.reviews });
}

/** A review is finished when nothing waits on it: started, or never held a brief. */
function isFinished(row: ReviewRecord): boolean {
  return row.launched === true || !row.held;
}

/** Old reviews go, then (past the cap) the oldest finished ones. Never an unfinished one: that is a held brief. */
export function pruneReviews(reviews: readonly ReviewRecord[], now: number): ReviewRecord[] {
  let kept = reviews.filter((row) => row.updatedAt === undefined || now - row.updatedAt <= REVIEW_KEEP_MS);
  while (kept.length > REVIEW_KEEP) {
    const index = kept.findIndex(isFinished);
    if (index < 0) break;
    kept = kept.filter((_, at) => at !== index);
  }
  return kept;
}

/** The app's database inside Tauri, memory in a plain browser (the preview pages, where `invoke` isn't there). */
function defaultDisk(): LocalHubDisk {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return inTauri ? tauriLocalHubDisk : memoryDisk();
}

let counter = 0;

/** A store over a disk. One per window; two over one memory disk behave like two windows on one database. */
export function createEyesStorage(
  disk: LocalHubDisk = defaultDisk(),
  options: { windowId?: string; now?: () => number } = {},
): EyesStorage {
  counter += 1;
  const windowId = options.windowId ?? `w${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 8)}`;
  const now = options.now ?? Date.now;
  let file = emptyFile();
  let loaded = false;
  let loading: Promise<void> | null = null;
  let watching = false;
  let chain: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const fn of [...listeners]) fn();
  };

  /** Take a document in. A read that finished after a newer write is older than what is held. */
  const adopt = (next: FileShape): boolean => {
    if (next.revision < file.revision) return false;
    const changed = next.revision !== file.revision || !sameFile(file, next);
    file = next;
    return changed;
  };

  const readDocument = async (): Promise<FileShape> => {
    const doc = await disk.readDoc(FRESH_EYES_DOC_KEY);
    return parseDoc(doc.value, doc.rev);
  };

  const refresh = async (): Promise<void> => {
    const next = await readDocument();
    if (adopt(next)) notify();
  };

  const watch = () => {
    if (watching) return;
    watching = true;
    disk.watch?.((key, rev) => {
      if (key === FRESH_EYES_DOC_KEY && rev > file.revision) void refresh().catch(() => undefined);
    });
  };

  const queued = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(
      async () => {
        if (hold) await hold;
        return fn();
      },
      async () => {
        if (hold) await hold;
        return fn();
      },
    );
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    windowId,
    now,
    load() {
      if (loaded) return Promise.resolve();
      loading ??= refresh()
        .then(() => {
          loaded = true;
          watch();
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    },
    refresh,
    snapshot: () => file,
    change(fn) {
      return queued(async () => {
        for (let attempt = 0; attempt < READ_TRIES; attempt += 1) {
          let base: FileShape;
          try {
            base = await readDocument();
          } catch {
            // A timeout is not a final no. Read again.
            continue;
          }
          if (adopt(base)) notify();
          loaded = true;
          watch();
          const draft = copyOf(base);
          if (!fn(draft)) return "skipped";
          let rev: number | null;
          try {
            rev = await disk.write(FRESH_EYES_DOC_KEY, { settings: draft.settings, reviews: draft.reviews }, base.revision);
          } catch {
            // A write that threw may still have landed. Read again: the change is made on top of what is there.
            continue;
          }
          // null: another window wrote since the read. Read again and apply on top.
          if (rev == null) continue;
          if (adopt({ ...draft, revision: rev })) notify();
          return "saved";
        }
        return "failed";
      });
    },
    subscribe(fn) {
      listeners.add(fn);
      void this.load().catch(() => undefined);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** A store in memory: tests, and a webview with no Tauri. */
export function memoryStorage(): EyesStorage {
  return createEyesStorage(memoryDisk());
}

let active: EyesStorage | undefined;
let standard: EyesStorage | undefined;

export function setFreshEyesStorage(storage: EyesStorage | undefined): void {
  active = storage;
}

export function freshEyesStorage(): EyesStorage {
  if (active) return active;
  standard ??= createEyesStorage();
  return standard;
}

export function projectKey(project: string): string {
  return project.replace(/\\/g, "/").trim();
}

export function subscribeFreshEyes(fn: () => void): () => void {
  return freshEyesStorage().subscribe(fn);
}

export function loadFreshEyes(storage: EyesStorage = freshEyesStorage()): FileShape {
  return storage.snapshot();
}

export function freshEyesRevision(storage: EyesStorage = freshEyesStorage()): number {
  return storage.snapshot().revision;
}

export function settingFor(project: string, storage: EyesStorage = freshEyesStorage()): FreshEyesSetting {
  const key = projectKey(project);
  if (!key) return readSetting(undefined);
  return readSetting(storage.snapshot().settings[key]);
}

export async function writeSetting(
  project: string,
  patch: Partial<FreshEyesSetting>,
  storage: EyesStorage = freshEyesStorage(),
): Promise<FreshEyesSetting> {
  const key = projectKey(project);
  if (!key) return readSetting(undefined);
  let written = readSetting(undefined);
  await storage.change((draft) => {
    const current = readSetting(draft.settings[key]);
    written = readSetting({
      enabled: patch.enabled ?? current.enabled,
      autoAcceptClean: patch.autoAcceptClean ?? current.autoAcceptClean,
      reviewerCount: patch.reviewerCount ?? current.reviewerCount,
      model: patch.model === undefined ? current.model : patch.model,
    });
    draft.settings = { ...draft.settings, [key]: written };
    return true;
  });
  return settingFor(key, storage);
}

/** One review is one chat's brief under one request ID in one project. */
function isRow(row: ReviewRecord, project: string, requestId: string, owner: string | undefined): boolean {
  return row.project === project && row.requestId === requestId && (row.owner ?? "") === (owner ?? "");
}

function exactRow(storage: EyesStorage, project: string, requestId: string, owner: string | undefined): ReviewRecord | null {
  return storage.snapshot().reviews.find((row) => isRow(row, projectKey(project), requestId, owner)) ?? null;
}

/** The review of a request. With `owner`, that chat's; without, the latest of any chat's. */
export function reviewFor(
  project: string,
  requestId: string,
  storage: EyesStorage = freshEyesStorage(),
  owner?: string,
): ReviewRecord | null {
  const key = projectKey(project);
  const rows = storage
    .snapshot()
    .reviews.filter((row) => row.project === key && row.requestId === requestId && (owner === undefined || row.owner === owner));
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

export function latestReview(project: string, storage: EyesStorage = freshEyesStorage()): ReviewRecord | null {
  const key = projectKey(project);
  const rows = storage.snapshot().reviews.filter((row) => row.project === key);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

/** The same brief: the chat that asked and the call itself. A record with neither is no brief's. */
export function sameBrief(row: Pick<ReviewRecord, "owner" | "hash"> | null | undefined, owner: string, hash: string): boolean {
  return !!row && !!row.owner && !!row.hash && row.owner === owner.trim() && row.hash === hash;
}

function cleanForWrite(record: ReviewRecord, revision: number, at: number): ReviewRecord {
  const next = normalize({ ...record, revision });
  next.updatedAt = at;
  return next;
}

/**
 * Replace one chat's review of a request if it is still at `expectedRevision` (0 when it is new). A stale writer loses
 * and the newer review stays. A review of another call (the brief was edited) replaces the old one whole and goes last;
 * a change to the same brief stays where it is. A new review past the cap, or a held brief too large, is refused.
 */
export async function putReview(
  record: ReviewRecord,
  expectedRevision: number,
  storage: EyesStorage = freshEyesStorage(),
): Promise<PutResult> {
  const where = (): ReviewRecord | null => exactRow(storage, record.project, record.requestId, record.owner);
  const held = record.held ? JSON.stringify(record.held) : "";
  if (held.length > HELD_MAX_CHARS) return { ok: false, current: where(), why: "too-big" };
  let why: PutResult["why"];
  const saved = await storage.change((draft) => {
    const at = draft.reviews.findIndex((row) => isRow(row, record.project, record.requestId, record.owner));
    const current = at >= 0 ? draft.reviews[at] : null;
    if ((current?.revision ?? 0) !== expectedRevision) {
      why = "conflict";
      return false;
    }
    const next = cleanForWrite(record, expectedRevision + 1, storage.now());
    if (current && current.hash === next.hash) {
      draft.reviews = draft.reviews.map((row, index) => (index === at ? next : row));
      return true;
    }
    const reviews = pruneReviews([...draft.reviews.filter((_, index) => index !== at), next], storage.now());
    if (reviews.length > REVIEW_KEEP) {
      why = "full";
      return false;
    }
    draft.reviews = reviews;
    return true;
  });
  const current = where();
  if (saved === "saved") return { ok: true, current };
  return { ok: false, current, why: saved === "failed" ? "failed" : (why ?? "conflict") };
}

/**
 * Read-modify-write one chat's review on the freshest copy. `fn` gets it and returns the new one, or null to leave it.
 * Used for the small changes (a lease, a start that landed, a failure noted) that must not lose to another window.
 */
export async function updateReview(
  ref: { project: string; requestId: string; owner?: string },
  fn: (current: ReviewRecord) => ReviewRecord | null,
  storage: EyesStorage = freshEyesStorage(),
): Promise<{ ok: boolean; current: ReviewRecord | null }> {
  const project = projectKey(ref.project);
  const saved = await storage.change((draft) => {
    const at = draft.reviews.findIndex((row) => isRow(row, project, ref.requestId, ref.owner));
    if (at < 0) return false;
    const next = fn(draft.reviews[at]);
    if (!next) return false;
    const stamped = cleanForWrite(next, draft.reviews[at].revision + 1, storage.now());
    draft.reviews = draft.reviews.map((row, index) => (index === at ? stamped : row));
    return true;
  });
  return { ok: saved === "saved", current: exactRow(storage, project, ref.requestId, ref.owner) };
}

/** Forget one chat's review of a request (its brief was cancelled). True when it was there and is gone. */
export async function dropReview(
  ref: { project: string; requestId: string; owner?: string },
  storage: EyesStorage = freshEyesStorage(),
): Promise<boolean> {
  const project = projectKey(ref.project);
  const saved = await storage.change((draft) => {
    if (!draft.reviews.some((row) => isRow(row, project, ref.requestId, ref.owner))) return false;
    draft.reviews = draft.reviews.filter((row) => !isRow(row, project, ref.requestId, ref.owner));
    return true;
  });
  return saved === "saved";
}
