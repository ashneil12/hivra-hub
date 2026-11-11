/**
 * WP-176. The stored limits, the spend ledger, and the verdicts the launch and turn gates read.
 *
 * Spend comes from the app's ledger (src-tauri/src/spend_ledger.rs): one record per turn, written when the turn ends,
 * with its project and whether its price was reported. Chat delete and trash never touch it. The gate reads day totals
 * from the ledger every few seconds and adds this app's own turns that are not yet saved.
 *
 * One admission point (`admitSpendTurn`) judges every turn before it starts. A turn is a person's only when the
 * composer sent it (origin "person"). Anything else is automated, including turns of unknown origin: a limit refuses
 * those and warns a person's chat. A per-task ceiling on a billed model refuses any further turn of that run once its
 * total is past the cap.
 *
 * Limits are keyed by the project's hub id. A folder, a worktree or a pool slot maps to its project through git, so a
 * limit saved by name, by folder or from Settings is the same limit.
 */

import { pathKey } from "../../../shared/lib/paths";
import { isBilledModel } from "../../sessions/model/customModels";
import { cliReportsCost, readTurnPrice } from "./cliCost";
import { dayKey, type UsageSession } from "./history";
import { formatUsd, MICRO, toMicro } from "./money";
import {
  bookFromStored,
  daysFromSessions,
  dropLimit,
  emptyBook,
  importSpendLimits,
  resetSpendWarnings,
  sanitizeSpendLimit,
  spendAllowed,
  spendStatusLine,
  subjectOf,
  sumDays,
  warnOnce,
  type SpendBook,
  type SpendDay,
  type SpendLimit,
  type SpendPeriod,
  type SpendReading,
  type SpendScope,
  type SpendVerdict,
  type WarnSink,
} from "./spend";
import { ceilingDecision, sanitizeTaskCeiling, type CeilingVerdict, type TaskCeiling } from "./taskCeiling";

export type { SpendVerdict } from "./spend";

export const LOCAL_KEY = "monocode:spend-limits";
/** Records are read again after this long. A check in between uses what it has. */
const TTL_MS = 5_000;
/** Records older than this are not trusted: a check reports unreadable instead of an old total. */
const STALE_MS = 10 * 60_000;

export const RAISE_LIMIT = "Raise limit";
/** The reason a clear gives when no limit matches. Callers say so instead of "cleared". */
export const NO_SPEND_LIMIT_TO_CLEAR = "There is no spend limit to clear.";

export type SpendWriter = "person" | "first-mate" | "habit" | "worker" | "checker";
/** Who started a turn. Only the composer is a person; everything else is automated. */
export type TurnOrigin = "person" | "automated";

export type SpendSinkEvent = { kind: string; summary: string; project: string };

/** A turn this app has measured, kept until the ledger has it. */
type Pending = { record: SpendDay; at: number; savedAt?: number };
type Stored = { book: SpendBook; ceilings: Record<string, TaskCeiling> };
export type ProjectLookup = {
  /** The hub id of the project a folder belongs to. */
  idOf(folder: string): string | undefined;
  /** The folder of a hub project id. */
  folderOf(id: string): string | undefined;
  /** The project's first mate chat, which hears a warning. */
  firstMateOf?(key: string): string | undefined;
  /** The project a chat belongs to, when the chat itself says (a habit run runs from home, for example). */
  projectOfSession?(sessionId: string): string | undefined;
  /**
   * The main checkout a working copy belongs to, from git, as a canonical real path (symlinks resolved, so /var and
   * /private/var are one folder). Without it a folder is compared as written.
   */
  resolveFolder?(cwd: string): Promise<string>;
  /** The redo this chat continues: its parent chat, whose ceiling this run keeps counting against. */
  redoParentOf?(sessionId: string): string | undefined;
};
/** The ledger's writer. The app sets it; without one, turns stay in memory. */
export type SpendPersist = (entry: {
  sessionId: string;
  projectKey: string;
  at: number;
  micros: number;
  priced: boolean;
  /** The CLI that reported the cost (round 5). */
  source?: string;
}) => Promise<void>;
/** The ledger's reader: day totals from `since` on. The app sets it; tests set records directly. */
export type SpendLoader = (since: number) => Promise<SpendDay[]>;

const UNSET: SpendVerdict = { status: "unset", reason: "" };
const OK: SpendVerdict = { status: "ok", reason: "" };
const UNMEASURED: SpendVerdict = {
  status: "unmeasured",
  reason: "This CLI reports no cost, so this limit cannot count its work.",
};
const UNREADABLE_STORE: SpendVerdict = {
  status: "over",
  reason: "Spend limits could not be read from storage. New builders wait until you replace them in Settings.",
};
const UNREADABLE_DB: SpendVerdict = {
  status: "over",
  reason: "Spend limits could not be read from the app's database. Automated turns wait until it answers.",
};
const LOADING_BOOK: SpendVerdict = {
  status: "over",
  reason: "Spend limits are still loading from the app's database. Automated turns wait until they load.",
};
const SAVING_BOOK = "Spend limits are still being saved. Automated turns wait until they are.";
const UNPLACED_LIMIT =
  "A spend limit's project is not known yet, so this run cannot be matched to its limit. It is held until the projects load.";
const NO_PROJECTS: ProjectLookup = { idOf: () => undefined, folderOf: () => undefined };

/** The limits book as the app's database holds it. The database is the source; localStorage is not read once it is set. */
export type StoredBook = { revision: number; limits: SpendLimit[]; ceilings: Record<string, TaskCeiling> };
export type SpendBookStore = {
  /** The stored book, or null when none was ever saved. Throws when the store cannot answer. */
  read(): Promise<StoredBook | null>;
  /** Saves the book when the stored revision is still `expected`. Throws on a conflict or a failed write. */
  write(next: StoredBook & { expected: number }): Promise<void>;
};

let booted = false;
let book: SpendBook = emptyBook();
let ceilings: Record<string, TaskCeiling> = {};
let storeUnreadable = false;
/** The ledger's day records, or null until one read has landed. */
let records: SpendDay[] | null = null;
let loadedAt = -Infinity;
let loader: SpendLoader | null = null;
let loading: Promise<void> | null = null;
let persist: SpendPersist | null = null;
let clock: () => number = () => Date.now();
let sink: WarnSink | null = null;
let lookup: ProjectLookup = NO_PROJECTS;
const folders = new Map<string, string>();
const asked = new Set<string>();
/** The redo links the app keeps: a chat's child session to the session it redid. Read with the ledger each TTL. */
let redoLinks = new Map<string, string>();
/** Links merged in at once, not yet seen in the stored links. */
const pendingRedoLinks = new Map<string, string>();
/** Chats the person has continued after a soft ask. The ask is not repeated for them. */
const continued = new Set<string>();
/** Chats whose unmeasured ceiling has been reported once. */
const unmeasuredNoticed = new Set<string>();
let pending: Pending[] = [];
const listeners = new Set<() => void>();
/** The app's database store for the book. Null in tests and before the app wires it. */
let dbStore: SpendBookStore | null = null;
let legacyBook: (() => StoredBook | null) | null = null;
/** Set when the database read has answered (true) or failed (false). */
let dbLoaded = false;
let dbFailed = false;
/** The revision the database confirmed. A turn waits while the in-memory book is ahead of it. */
let dbSynced = -1;
let dbLoad: Promise<boolean> | null = null;
let dbWriting: Promise<void> = Promise.resolve();
/** A save the database has not confirmed. It is retried as a write, never by re-reading (a re-read would drop it). */
let pendingSave: (StoredBook & { revision: number }) | null = null;
/** Time that only moves forward. TTLs and staleness use it, so a wall clock change cannot freeze or expire them. */
const defaultMonotonic = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
let monotonic: () => number = defaultMonotonic;

function notify(): void {
  for (const listener of listeners) listener();
}

// ---- projects -----------------------------------------------------------------------------------------------------

const WORKTREES = "-worktrees";

/**
 * A heuristic for a working copy's folder, used only until git has answered: `<folder>-worktrees/<branch>` is the
 * folder. Any other folder is itself.
 */
export function projectFolderOfCwd(cwd: string): string {
  const text = cwd.trim().replace(/[\\/]+$/, "");
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (cut <= 0) return text;
  const parent = text.slice(0, cut);
  const parentCut = Math.max(parent.lastIndexOf("/"), parent.lastIndexOf("\\"));
  const name = parent.slice(parentCut + 1);
  if (name.length <= WORKTREES.length || !name.endsWith(WORKTREES)) return text;
  return `${parent.slice(0, parentCut + 1)}${name.slice(0, -WORKTREES.length)}`;
}

function folderOfCwdCached(cwd: string): string {
  return folders.get(cwd.trim()) ?? projectFolderOfCwd(cwd);
}

/** The hub project ids the book refers to, for mapping a folder back to its project. */
function bookProjectIds(): string[] {
  const ids = new Set<string>();
  for (const limit of book.limits) if (limit.scope === "project" && limit.project) ids.add(limit.project);
  for (const key of Object.keys(ceilings)) ids.add(key);
  return [...ids].filter((id) => lookup.folderOf(id) !== undefined);
}

/**
 * The hub id whose canonical folder is `folder`. The hub may store a project under a symlinked path, so each id's
 * folder is compared after git's canonical answer for it. Unknown answers are asked for and used by the next check.
 */
function idForCanonical(folder: string): string | undefined {
  const direct = lookup.idOf(folder);
  if (direct !== undefined) return direct;
  for (const id of bookProjectIds()) {
    const stored = lookup.folderOf(id);
    if (stored === undefined) continue;
    const canonical = folders.get(stored);
    if (canonical === undefined) {
      askFolder(stored);
      continue;
    }
    if (canonical === folder) return id;
  }
  return undefined;
}

/** The key a project's limits and ceilings are stored under: the hub id. A folder maps to it; a hub id stays. */
export function spendKey(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (lookup.folderOf(text) !== undefined) return text;
  const folder = folderOfCwdCached(text);
  return idForCanonical(folder) ?? pathKey(folder);
}

async function folderOfCwd(cwd: string): Promise<string> {
  const text = cwd.trim();
  const known = folders.get(text);
  if (known !== undefined) return known;
  if (lookup.resolveFolder) {
    try {
      const folder = await lookup.resolveFolder(text);
      if (folder) {
        folders.set(text, folder);
        return folder;
      }
    } catch {
      /* git did not answer: the heuristic stands, and the next check asks again */
    }
  }
  return projectFolderOfCwd(text);
}

/** Starts git's answer for a working copy without waiting for it. The next check uses it. */
function askFolder(cwd: string): void {
  const text = cwd.trim();
  if (!lookup.resolveFolder || !text || folders.has(text)) return;
  void folderOfCwd(text);
}

/** The project a turn belongs to. Waits for git's canonical answer for the turn's folder and for each project's folder. */
async function keyForTurn(sessionId: string, cwd: string): Promise<string> {
  const own = lookup.projectOfSession?.(sessionId);
  if (own) return spendKey(own);
  for (const id of bookProjectIds()) {
    const stored = lookup.folderOf(id);
    if (stored !== undefined && !folders.has(stored)) await folderOfCwd(stored);
  }
  return spendKey(await folderOfCwd(cwd));
}

/** The same key without waiting. Asks git for the answer, so the next call has it. */
function keyForTurnNow(sessionId: string, cwd: string): string {
  const own = lookup.projectOfSession?.(sessionId);
  if (own) return spendKey(own);
  askFolder(cwd);
  return spendKey(folderOfCwdCached(cwd));
}

/**
 * One redo link, merged in at once when a redo is started, so the chat's first turn already sees its parent (the app
 * keeps the same link on the row; a later read of the links replaces this map with the stored ones).
 */
export function addSpendRedoLink(child: string, parent: string): void {
  if (!child || !parent || child === parent) return;
  pendingRedoLinks.set(child, parent);
  redoLinks.set(child, parent);
}

/** The redo links from the app's delegation rows. A redo's chat sums its parent's spend (lineageOf). */
export function setSpendRedoLinks(links: readonly { child: string; parent: string }[] | null | undefined): void {
  const stored = new Map(Array.isArray(links) ? links.map((link) => [link.child, link.parent] as const) : []);
  // A link merged in before its row was stored stays until the stored links have it (a read in between must not drop it).
  for (const [child, parent] of pendingRedoLinks) {
    if (stored.has(child)) pendingRedoLinks.delete(child);
    else stored.set(child, parent);
  }
  redoLinks = stored;
}

/** Tests and the app register the hub's project lookup. The default knows no projects. */
export function setSpendProjectLookup(next: ProjectLookup | null): void {
  lookup = next ?? NO_PROJECTS;
  folders.clear();
}

const automated = (origin: TurnOrigin | undefined): boolean => origin !== "person";

// ---- storage ------------------------------------------------------------------------------------------------------

function ceilingsFrom(raw: unknown): Record<string, TaskCeiling> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TaskCeiling> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const clean = sanitizeTaskCeiling(value);
    // Kept as stored: a folder or an id is matched when it is read, so a cold start cannot re-key it.
    const project = typeof key === "string" ? key.trim() : "";
    if (clean && project && project !== "/") out[project] = clean;
  }
  return out;
}

/** A stored book's text, parsed. Null when it cannot be read: a broken file is unreadable, never an empty book. */
function parseStored(raw: string | null): Stored | null {
  if (raw == null) return { book: emptyBook(), ceilings: {} };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      book: bookFromStored(value),
      ceilings: ceilingsFrom((value as { ceilings?: unknown }).ceilings),
    };
  } catch {
    return null;
  }
}

/** The book as the database and the migration read it. Null when the object is not a book. */
export function parseStoredBook(value: unknown): StoredBook | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = parseStored(JSON.stringify(value));
  if (!stored) return null;
  return { revision: stored.book.revision, limits: stored.book.limits, ceilings: stored.ceilings };
}

/** The localStorage copy, read once for migration. Null when it is missing or cannot be read. */
export function readLocalSpendBook(): StoredBook | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw == null) return null;
    return parseStoredBook(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * A file that cannot be parsed, or a store that throws, is unreadable, not an empty book to overwrite. A runtime with no
 * localStorage at all holds no book here (the app's database holds it, see setSpendBookStore).
 */
function readStored(): Stored | null {
  if (typeof localStorage === "undefined") return { book: emptyBook(), ceilings: {} };
  let raw: string | null;
  try {
    raw = localStorage.getItem(LOCAL_KEY);
  } catch {
    return null;
  }
  return parseStored(raw);
}

function boot(): void {
  if (booted) return;
  booted = true;
  // With the app's database set, the database answers for the book (see loadDb); localStorage is not read.
  if (dbStore) return;
  const stored = readStored();
  if (!stored) {
    storeUnreadable = true;
    return;
  }
  storeUnreadable = false;
  book = stored.book;
  ceilings = stored.ceilings;
}

function persistStored(nextBook: SpendBook, nextCeilings: Record<string, TaskCeiling>): boolean {
  if (storeUnreadable) return false;
  if (dbStore) {
    // Nothing is written until the database has answered once. The change is queued for it.
    if (!dbLoaded || dbFailed) return false;
    book = nextBook;
    ceilings = nextCeilings;
    notify();
    queueDbWrite();
    return true;
  }
  try {
    const stored = readStored();
    if (stored == null) return false;
    if (stored.book.revision > book.revision) {
      book = stored.book;
      ceilings = stored.ceilings;
      notify();
      return false;
    }
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ revision: nextBook.revision, limits: nextBook.limits, ceilings: nextCeilings }));
    book = nextBook;
    ceilings = nextCeilings;
    notify();
    return true;
  } catch {
    return false;
  }
}

function adoptIfNewer(expected: number): boolean {
  if (dbStore) return book.revision === expected;
  const stored = readStored();
  if (stored && stored.book.revision !== expected) {
    book = stored.book;
    ceilings = stored.ceilings;
    notify();
    return false;
  }
  if (stored == null) return false;
  return book.revision === expected;
}

export function subscribeSpend(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes when a limit is saved or a ceiling changes, so an open task can show it. */
export function spendPulse(): string {
  boot();
  const database = dbStore ? (dbFailed ? "f" : dbLoaded ? "l" : "w") : "-";
  return `${book.revision}:${storeUnreadable ? "x" : "ok"}:${database}`;
}

/** True when the app's database holds the book (the replace control does not apply to it). */
export function spendStoreIsDatabase(): boolean {
  return dbStore !== null;
}

/** True while the app's database has not answered for the book yet. */
export function spendStoreLoading(): boolean {
  return dbStore !== null && !dbLoaded && !dbFailed;
}

export function spendSnapshot(): { book: SpendBook; ceilings: Record<string, TaskCeiling> } {
  boot();
  return { book, ceilings: { ...ceilings } };
}

/** True when the stored limits cannot be read. Launches hold until the person replaces them in Settings. */
export function spendUnreadable(): boolean {
  boot();
  return storeUnreadable || dbFailed;
}

// ---- the app's database -------------------------------------------------------------------------------------------

/** Reads the book from the database. A read that fails leaves the book unreadable until it answers. */
function loadDb(): Promise<boolean> {
  const store = dbStore;
  if (!store) return Promise.resolve(false);
  dbLoaded = false;
  return store
    .read()
    .then((got) => {
      if (dbStore !== store) return false;
      pendingSave = null;
      if (got) {
        book = { revision: got.revision, limits: got.limits };
        ceilings = got.ceilings;
        dbSynced = got.revision;
      } else {
        // No book saved yet. Limits kept from before the database existed are carried over, once.
        const legacy = legacyBook?.() ?? null;
        book = legacy ? { revision: legacy.revision, limits: legacy.limits } : emptyBook();
        ceilings = legacy ? legacy.ceilings : {};
        dbSynced = 0;
        if (legacy && (legacy.limits.length > 0 || Object.keys(legacy.ceilings).length > 0)) queueDbWrite();
      }
      dbLoaded = true;
      dbFailed = false;
      notify();
      return true;
    })
    .catch(() => {
      if (dbStore !== store) return false;
      dbFailed = true;
      notify();
      return false;
    });
}

/** Queues a save of the in-memory book. Saves run in order. A refused save stays pending and holds automated turns. */
function queueDbWrite(): void {
  const store = dbStore;
  if (!store) return;
  pendingSave = { revision: book.revision, limits: book.limits, ceilings: { ...ceilings } };
  dbWriting = dbWriting.then(() => attemptSave(store));
}

async function attemptSave(store: SpendBookStore): Promise<void> {
  const snapshot = pendingSave;
  if (dbStore !== store || !snapshot) return;
  if (snapshot.revision <= dbSynced) {
    if (pendingSave === snapshot) pendingSave = null;
    dbFailed = false;
    notify();
    return;
  }
  try {
    await store.write({ ...snapshot, expected: dbSynced });
    if (dbStore !== store) return;
    dbSynced = snapshot.revision;
    if (pendingSave === snapshot) pendingSave = null;
    dbFailed = false;
  } catch {
    if (dbStore !== store) return;
    // The database refused it (a conflict, or no answer). It stays pending: automated turns are held until it lands.
    if (!dbFailed) activity("spend.changed", "A spend limit change did not save. Set it again in Settings.", "app", "app");
    dbFailed = true;
  }
  notify();
}

/** Waits for the database to answer and for queued saves; retries a refused save. False when the book is not saved. */
async function settleBook(): Promise<boolean> {
  const store = dbStore;
  if (!store) return !storeUnreadable;
  if (dbFailed && !pendingSave) dbLoad = loadDb();
  else if (dbLoad && !dbLoaded) await dbLoad;
  if (dbFailed && !pendingSave && dbLoad) await dbLoad;
  if (pendingSave) dbWriting = dbWriting.then(() => attemptSave(store));
  await dbWriting;
  return dbLoaded && !dbFailed && !pendingSave && dbSynced === book.revision;
}

function bookHoldReason(): string {
  if (dbFailed) return UNREADABLE_DB.reason;
  if (!dbLoaded) return LOADING_BOOK.reason;
  return SAVING_BOOK;
}

/**
 * Sets the database store for the book and reads it. `legacy` is the localStorage copy, carried over once when the
 * database has none. Passing null goes back to localStorage (tests and runtimes with no database).
 */
export function setSpendBookStore(next: SpendBookStore | null, legacy?: () => StoredBook | null): Promise<boolean> {
  dbStore = next;
  legacyBook = legacy ?? null;
  dbSynced = -1;
  dbLoaded = false;
  dbFailed = false;
  dbLoad = null;
  dbWriting = Promise.resolve();
  pendingSave = null;
  if (!next) {
    booted = false;
    return Promise.resolve(true);
  }
  booted = true;
  dbLoad = loadDb();
  return dbLoad;
}

/** Sets the clock for TTLs and staleness. It must only move forward; tests set it to control time. */
export function setSpendMonotonicClock(next: (() => number) | null): void {
  monotonic = next ?? defaultMonotonic;
}

/** The person's own choice in Settings: drop what cannot be read and start an empty book. Logged like any change. */
export function replaceUnreadableSpendStore(): boolean {
  boot();
  if (dbStore || !storeUnreadable) return false;
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    return false;
  }
  storeUnreadable = false;
  book = emptyBook();
  ceilings = {};
  const wrote = persistStored({ revision: 1, limits: [] }, {});
  activity("spend.changed", "The unreadable spend limits were replaced with none. Set them again in Settings.", "app", "app");
  notify();
  return wrote;
}

/** Another window saved the limits. Read them again on the next check. */
export function refreshSpendFromStorage(): void {
  if (dbStore) {
    dbLoad = loadDb();
    notify();
    return;
  }
  booted = false;
  book = emptyBook();
  ceilings = {};
  resetSpendWarnings();
  notify();
}

// ---- the ledger ---------------------------------------------------------------------------------------------------

export function setSpendClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

/** The ledger's day records, set directly. Tests use this; the app's loader sets them every TTL. */
export function setSpendRecords(next: readonly SpendDay[] | null): void {
  records = next == null ? null : [...next];
  loadedAt = monotonic();
}

/** Chat rows as day records, for tests that start from chats. */
export function setSpendSessions(next: readonly UsageSession[] | null): void {
  setSpendRecords(daysFromSessions(next, isBilledModel));
}

/** The app's reader of the ledger. The app sets it at start (spendWiring.ts). */
export function setSpendLoader(next: SpendLoader | null): void {
  loader = next;
}

/** The app's writer of a turn to the ledger. Without one, turns stay in memory. */
export function setSpendPersist(next: SpendPersist | null): void {
  persist = next;
}

function startOfMonth(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function refreshIfStale(): void {
  if (!loader || loading) return;
  const now = clock();
  const started = monotonic();
  if (records !== null && started - loadedAt < TTL_MS) return;
  loading = loader(startOfMonth(now))
    .then((rows) => {
      if (!Array.isArray(rows)) return;
      records = rows;
      loadedAt = started;
      // A turn saved before this read began is in the rows now.
      pending = pending.filter((row) => row.savedAt === undefined || row.savedAt > started);
      notify();
    })
    .catch(() => {
      /* a failed read keeps the last one; the staleness limit still applies */
    })
    .finally(() => {
      loading = null;
    });
  for (const row of pending) if (row.savedAt === undefined) saveTurn(row);
}

/** The day records as of now, or null when they cannot be trusted. Includes turns this app has not saved yet. */
function currentRecords(): SpendDay[] | null {
  if (records === null) return null;
  if (loader && monotonic() - loadedAt >= STALE_MS) return null;
  return [...records, ...pending.map((row) => row.record)];
}

async function ensureLoaded(): Promise<void> {
  refreshIfStale();
  const wait = loading;
  if (wait) await wait;
}

function saveTurn(row: Pending): void {
  if (!persist) return;
  const { record } = row;
  persist({
    sessionId: record.sessionId,
    projectKey: record.projectKey,
    at: row.at,
    micros: record.micros,
    priced: record.priced === 1,
    source: record.source,
  })
    .then(() => {
      row.savedAt = monotonic();
    })
    .catch(() => {
      /* kept in memory and tried again on the next read */
    });
}

/** A turn's price, written once when the turn ends. Counted at once; saved to the ledger in the background. */
function recordTurn(sessionId: string, projectKey: string, price: ReturnType<typeof readTurnPrice>, source?: string): void {
  if (price.kind === "empty") return;
  const at = clock();
  const day = dayKey(at);
  if (!day) return;
  const micros = price.kind === "priced" ? (toMicro(price.usd) ?? 0) : 0;
  const row: Pending = {
    record: {
      projectKey,
      sessionId,
      day,
      micros,
      priced: price.kind === "priced" ? 1 : 0,
      unpriced: price.kind === "priced" ? 0 : 1,
      ...(source ? { source } : {}),
    },
    at,
  };
  pending.push(row);
  saveTurn(row);
}

/** One limit's reading: the ledger for its period and project. */
function readingFor(limit: SpendLimit, reportsCost: boolean): SpendReading {
  const key = limit.scope === "app" ? null : spendKey(limit.project);
  const base = sumDays(currentRecords(), {
    now: clock(),
    period: limit.period,
    match: key === null ? () => true : (projectKey) => spendKey(projectKey) === key,
  });
  return { ...base, reportsCost };
}

/** A chat and the redo chain it continues, newest first. A redo keeps counting against its parent's ceiling. */
function lineageOf(sessionId: string): Set<string> {
  const chain = new Set<string>([sessionId]);
  let current = sessionId;
  for (let hop = 0; hop < 50; hop += 1) {
    const parent = lookup.redoParentOf?.(current) ?? redoLinks.get(current);
    if (!parent || chain.has(parent)) break;
    chain.add(parent);
    current = parent;
  }
  return chain;
}

/**
 * A run's total from the ledger rows the reader holds (the ledger is read from the start of the month), including the
 * chats it redid. A redo's parent spent earlier in the month counts only if its rows are in that read.
 */
export function sessionTotal(sessionId: string): { micros: number; priced: number; unpriced: number; unreadable: boolean; claude: boolean } {
  const rows = currentRecords();
  if (rows === null) return { micros: 0, priced: 0, unpriced: 0, unreadable: true, claude: false };
  const chain = lineageOf(sessionId);
  let micros = 0;
  let priced = 0;
  let unpriced = 0;
  let claude = false;
  for (const row of rows) {
    if (!chain.has(row.sessionId)) continue;
    micros += row.micros;
    priced += row.priced;
    unpriced += row.unpriced;
    if (row.source === "claude" && row.priced > 0) claude = true;
  }
  return { micros, priced, unpriced, unreadable: false, claude };
}

// ---- limits -------------------------------------------------------------------------------------------------------

function limitsFor(key: string): SpendLimit[] {
  return book.limits.filter((limit) => limit.scope === "app" || spendKey(limit.project) === key);
}

/** The stored limit for a project and period, matched by its key, so a folder and a hub id are one limit. */
function findLimit(scope: SpendScope, key: string, period: SpendPeriod): SpendLimit | undefined {
  return book.limits.find((row) => row.scope === scope && row.period === period && (scope === "app" || spendKey(row.project) === key));
}

function ceilingFor(key: string): TaskCeiling | null {
  boot();
  for (const [stored, value] of Object.entries(ceilings)) {
    if (spendKey(stored) === key) return value;
  }
  return null;
}

/** The limits that apply to a project: its own and the whole app's. */
export function spendFor(project: string): SpendLimit[] {
  boot();
  return limitsFor(spendKey(project));
}

export function ceilingForProject(project: string): TaskCeiling | null {
  boot();
  return ceilingFor(spendKey(project));
}

/** Who may write a limit. A first mate may only set a first limit or lower one; the whole app is Settings only. */
export function chatMayWrite(
  writer: SpendWriter,
  next: SpendLimit | null,
  existing: SpendLimit | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (writer === "person") return { ok: true };
  if (writer !== "first-mate") return { ok: false, reason: "Only a first mate can set a spend limit, from its own chat." };
  const scope = next?.scope ?? existing?.scope;
  if (scope === "app") return { ok: false, reason: "The whole-app spend limit is set in Settings." };
  if (next === null) return { ok: false, reason: "Clearing a spend limit needs your tap in Settings." };
  if (existing && (next.amountUsd > existing.amountUsd || next.warnAt > existing.warnAt)) {
    return { ok: false, reason: "Raising a spend limit needs your tap in Settings. A first mate can only lower it." };
  }
  return { ok: true };
}

function activity(kind: string, summary: string, project: string, target: string): void {
  if (!sink) return;
  try {
    sink.activity({ kind, summary, project, target });
  } catch {
    /* an activity line that cannot be written does not undo the change */
  }
}

function whoWrote(by: SpendWriter): string {
  return by === "person" ? "You" : "The first mate";
}

export function saveSpendLimit(
  limit: SpendLimit,
  expectedRevision: number,
  opts: { by: SpendWriter } = { by: "person" },
): { book: SpendBook; written: boolean; reason?: string } {
  boot();
  if (storeUnreadable) return { book, written: false, reason: UNREADABLE_STORE.reason };
  if (!adoptIfNewer(expectedRevision)) return { book, written: false };
  const parsed = sanitizeSpendLimit(limit);
  if (!parsed) return { book, written: false };
  const clean = parsed.scope === "app" ? parsed : { ...parsed, project: spendKey(parsed.project) };
  const existing = findLimit(clean.scope, clean.project, clean.period);
  const allowed = chatMayWrite(opts.by, clean, existing);
  if (!allowed.ok) return { book, written: false, reason: allowed.reason };
  const kept = book.limits.filter(
    (row) => !(row.scope === clean.scope && row.period === clean.period && (clean.scope === "app" || spendKey(row.project) === clean.project)),
  );
  const nextBook = { revision: book.revision + 1, limits: [...kept, clean] };
  const written = persistStored(nextBook, ceilings);
  if (written) {
    const when = clean.period === "day" ? "today" : "this month";
    const target = clean.scope === "app" ? "app" : clean.project;
    activity("spend.changed", `${whoWrote(opts.by)} set the spend limit for ${subjectOf(clean)} to ${formatUsd(clean.amountUsd)} ${when}.`, target, target);
  }
  return { book, written };
}

export function clearSpendLimit(
  scope: SpendScope,
  project: string,
  period: SpendPeriod,
  expectedRevision: number,
  opts: { by: SpendWriter } = { by: "person" },
): { book: SpendBook; written: boolean; reason?: string } {
  boot();
  if (storeUnreadable) return { book, written: false, reason: UNREADABLE_STORE.reason };
  if (!adoptIfNewer(expectedRevision)) return { book, written: false };
  const key = scope === "app" ? "" : spendKey(project);
  const existing = findLimit(scope, key, period);
  if (!existing) return { book, written: false, reason: NO_SPEND_LIMIT_TO_CLEAR };
  const allowed = chatMayWrite(opts.by, null, existing);
  if (!allowed.ok) return { book, written: false, reason: allowed.reason };
  const dropped = dropLimit(book, scope, existing.project, period, expectedRevision);
  if (!dropped.written) return { book, written: false };
  const written = persistStored(dropped.book, ceilings);
  if (written) {
    const label = scope === "app" ? "the whole app" : key;
    activity("spend.changed", `${whoWrote(opts.by)} cleared the spend limit for ${label}.`, scope === "app" ? "app" : key, scope === "app" ? "app" : key);
  }
  return { book, written };
}

/** A project's task ceiling. Person-only. The number saved is the number enforced. */
export function saveTaskCeiling(project: string, ceiling: TaskCeiling | null, expectedRevision: number): { book: SpendBook; written: boolean } {
  boot();
  if (storeUnreadable) return { book, written: false };
  if (!adoptIfNewer(expectedRevision)) return { book, written: false };
  const key = spendKey(project);
  if (!key || key === "/") return { book, written: false };
  let nextCeilings = ceilingsWithout(key);
  if (ceiling) {
    const clean = sanitizeTaskCeiling(ceiling);
    if (!clean) return { book, written: false };
    nextCeilings = { ...nextCeilings, [key]: clean };
  }
  const written = persistStored({ ...book, revision: book.revision + 1 }, nextCeilings);
  if (written) {
    const text = ceiling?.hardUsd != null ? `a task ceiling of ${formatUsd(ceiling.hardUsd)}` : "no task ceiling";
    activity("spend.changed", `You set ${text} for this project.`, key, key);
  }
  return { book, written };
}

function ceilingsWithout(key: string): Record<string, TaskCeiling> {
  const next: Record<string, TaskCeiling> = {};
  for (const [stored, value] of Object.entries(ceilings)) if (spendKey(stored) !== key) next[stored] = value;
  return next;
}

/**
 * A crew rule's task ceiling, saved by the person on the rules page. Exact: the number saved is the one enforced, a
 * higher one raises it, and null clears it.
 */
export function applyProjectRuleCeiling(project: string, usd: number | null): void {
  boot();
  const current = ceilingForProject(project);
  if (usd == null) {
    // The rules page owns the task ceiling only. A daily ceiling it never set stays.
    if (current?.hardUsd != null) {
      saveTaskCeiling(project, current.dailyUsd != null ? { dailyUsd: current.dailyUsd } : null, book.revision);
    }
    return;
  }
  const hard = sanitizeTaskCeiling({ hardUsd: usd });
  if (!hard?.hardUsd) return;
  saveTaskCeiling(
    project,
    sanitizeTaskCeiling({
      hardUsd: hard.hardUsd,
      ...(current?.softAt != null ? { softAt: current.softAt } : {}),
      ...(current?.dailyUsd != null ? { dailyUsd: current.dailyUsd } : {}),
    }),
    book.revision,
  );
}

/** Import only adds. A limit or ceiling already here is never raised. Logged when anything was added. */
export function takeImportedSpend(raw: unknown): SpendBook {
  boot();
  if (storeUnreadable) return book;
  const next = importSpendLimits(book, raw);
  const incoming = raw && typeof raw === "object" && !Array.isArray(raw) ? ceilingsFrom((raw as { ceilings?: unknown }).ceilings) : {};
  let merged = { ...ceilings };
  let changed = next.revision !== book.revision || next.limits.length !== book.limits.length;
  for (const [key, value] of Object.entries(incoming)) {
    const have = merged[key];
    if (!have) {
      merged = { ...merged, [key]: value };
      changed = true;
      continue;
    }
    const kept = tighterCeiling(have, value);
    if (kept && JSON.stringify(kept) !== JSON.stringify(have)) {
      merged = { ...merged, [key]: kept };
      changed = true;
    }
  }
  if (!changed) return book;
  const storedBook = next.revision !== book.revision ? next : { ...book, revision: book.revision + 1 };
  if (persistStored(storedBook, merged)) {
    activity("spend.changed", "Spend limits were imported. Limits already set were not raised.", "app", "app");
  }
  return book;
}

function tighterCeiling(here: TaskCeiling, incoming: TaskCeiling): TaskCeiling | null {
  const min = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.min(a, b));
  const hardUsd = min(here.hardUsd, incoming.hardUsd);
  const dailyUsd = min(here.dailyUsd, incoming.dailyUsd);
  const softAt = min(here.softAt, incoming.softAt);
  return sanitizeTaskCeiling({
    ...(hardUsd != null ? { hardUsd, ...(softAt != null ? { softAt } : {}) } : {}),
    ...(dailyUsd != null ? { dailyUsd } : {}),
  });
}

export function spendLimitsSetting(): string | null {
  boot();
  if (!book.limits.length && !Object.keys(ceilings).length) return null;
  return JSON.stringify({ revision: book.revision, limits: book.limits, ceilings });
}

// ---- verdicts -----------------------------------------------------------------------------------------------------

/**
 * The verdict a new builder reads, and the queue re-reads. Over refuses for any CLI, because a CLI that reports no cost
 * cannot be a way around a limit that is already reached. Reads only: it sends no warning.
 */
export function judgeLaunch(input: { project: string; harness: string; ownerSession?: string; warn?: boolean }): SpendVerdict {
  boot();
  if (storeUnreadable) return UNREADABLE_STORE;
  // A builder waits for the database's book, as an automated turn does: a launch is never allowed on an unknown book.
  if (dbStore && (!dbLoaded || dbFailed)) return dbFailed ? UNREADABLE_DB : LOADING_BOOK;
  const key = spendKey(input.project);
  const limits = limitsFor(key);
  if (!limits.length) return UNSET;
  refreshIfStale();
  const reportsCost = cliReportsCost(input.harness);
  const verdicts = limits.map((limit) => ({ limit, verdict: spendAllowed(readingFor(limit, reportsCost), limit) }));
  const over = verdicts.find((row) => row.verdict.status === "over");
  if (over) return over.verdict;
  const warn = verdicts.find((row) => row.verdict.status === "warn");
  if (warn) {
    if (input.warn !== false) warnFirstMate(warn.limit, key, input.ownerSession);
    return warn.verdict;
  }
  if (!reportsCost) return UNMEASURED;
  const unmeasured = verdicts.find((row) => row.verdict.status === "unmeasured");
  return unmeasured ? unmeasured.verdict : OK;
}

function warnFirstMate(limit: SpendLimit, key: string, fallback: string | undefined): void {
  if (!sink) return;
  const owner = lookup.firstMateOf?.(key) ?? fallback ?? "";
  if (!owner) return;
  void warnOnce({
    limit,
    now: clock(),
    ownerSession: owner,
    sink,
    label: limit.scope === "app" ? "the whole app" : key,
    // Labelled by the spend's source: Claude's cost figure is its price table's estimate.
    estimated: readingFor(limit, true).claudeMeasured === true,
  });
}

/** Set by the app: the wake queue and activity line. Tests inject a sink instead. */
export function setSpendWarnSink(next: WarnSink | null): void {
  sink = next;
}

/** The app's own wake queue and activity line. */
export function useLiveSpendSink(): void {
  sink = {
    wake: async (input) => {
      const mod = await import("../../firstmate/watcher/wakeQueue");
      const result = await mod.tauriWakeQueue.add(input);
      return { fresh: result?.fresh === true };
    },
    activity: (input) => {
      void import("@tauri-apps/api/core")
        .then(({ invoke }) =>
          invoke("activity_note", {
            kind: input.kind,
            summary: input.summary,
            project: input.project,
            target: input.target,
            actorId: "",
            actorName: "",
          }),
        )
        .catch(() => undefined);
    },
  };
}

/** True when a limit or a ceiling is set, or the stored limits cannot be read: only then does a turn need admission. */
export function spendGateActive(): boolean {
  boot();
  return storeUnreadable || dbStore !== null || book.limits.length > 0 || Object.keys(ceilings).length > 0;
}

/**
 * The one admission point. Every turn passes it before it starts. Returns why a turn is refused. A person's own
 * composer turn is never refused by a limit: it is warned instead. An automated turn is held while the book is not
 * known to be saved, held when its folder cannot be matched to a project whose limit is still unplaced, refused over
 * a limit or past its run's ceiling. Unreadable storage refuses every automated turn.
 */
export async function admitSpendTurn(input: {
  sessionId: string;
  cwd: string;
  harness: string;
  model?: string;
  origin?: TurnOrigin;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  boot();
  const isAutomated = automated(input.origin);
  // The person continues a chat that was asked about its soft ceiling by sending a turn from the composer.
  if (!isAutomated && asked.has(input.sessionId)) continued.add(input.sessionId);
  // Nothing set, nothing stored that cannot be read: the common case answers without waiting, so a turn starts as it did.
  if (!dbStore && !storeUnreadable && !book.limits.length && !Object.keys(ceilings).length) return { ok: true };
  if (dbStore) {
    const settled = await settleBook();
    if (!settled && isAutomated) return { ok: false, reason: bookHoldReason() };
  }
  if (storeUnreadable) return isAutomated ? { ok: false, reason: UNREADABLE_STORE.reason } : { ok: true };
  const key = await keyForTurn(input.sessionId, input.cwd);
  const unplaced = (value: string) => lookup.folderOf(spendKey(value)) === undefined;
  if (isAutomated && lookup.folderOf(key) === undefined && (book.limits.some((limit) => limit.scope === "project" && unplaced(limit.project)) || Object.keys(ceilings).some(unplaced))) {
    return { ok: false, reason: UNPLACED_LIMIT };
  }
  const billed = isBilledModel(input.model);
  const ceiling = ceilingFor(key);
  const limits = limitsFor(key);
  if (!limits.length && !ceiling) return { ok: true };
  await ensureLoaded();

  if (billed && ceiling?.hardUsd != null) {
    const task = sessionTotal(input.sessionId);
    if (task.unreadable) {
      if (isAutomated) return { ok: false, reason: "Spend for this task could not be read. The run is held until it can." };
    } else if (task.micros >= Math.round(ceiling.hardUsd * MICRO)) {
      return {
        ok: false,
        reason: `Task ceiling reached: ${formatUsd(task.micros / MICRO)} of ${formatUsd(ceiling.hardUsd)}. This run is held. Raise the task ceiling in Crew rules to continue.${task.claude ? " Estimated from Claude Code's price table." : ""}`,
      };
    }
  }
  if (billed && isAutomated && ceiling?.dailyUsd != null) {
    const daily = dailyReading(key);
    if (daily.unreadable) return { ok: false, reason: "Spend for today could not be read. The run is held until it can." };
    if (daily.micros >= Math.round(ceiling.dailyUsd * MICRO)) {
      return {
        ok: false,
        reason: `Daily ceiling reached: ${formatUsd(daily.micros / MICRO)} of ${formatUsd(ceiling.dailyUsd)} today. This run is held.${daily.claude ? " Estimated from Claude Code's price table." : ""}`,
      };
    }
  }
  const reportsCost = cliReportsCost(input.harness);
  for (const limit of limits) {
    const verdict = spendAllowed(readingFor(limit, reportsCost), limit);
    if (verdict.status === "over" && isAutomated) return { ok: false, reason: verdict.reason };
    if (verdict.status === "over" || verdict.status === "warn") warnFirstMate(limit, key, input.sessionId);
  }
  return { ok: true };
}

/** A project's day total from the ledger. Unreadable when the ledger has never been read. */
function dailyReading(key: string): { micros: number; unreadable: boolean; claude: boolean } {
  const base = sumDays(currentRecords(), { now: clock(), period: "day", match: (projectKey) => spendKey(projectKey) === key });
  return { micros: toMicro(base.measuredUsd) ?? 0, unreadable: base.unreadable === true, claude: base.claudeMeasured === true };
}

/** The ceiling line for a task row, and whether its run is held now. Derived from the ledger, so a restart keeps it. */
export function taskCeilingNote(project: string, chatId?: string | null): { line: string; held: string } | null {
  boot();
  const ceiling = ceilingForProject(project);
  if (!ceiling) return null;
  const parts: string[] = [];
  if (ceiling.hardUsd != null) parts.push(`Task ceiling ${formatUsd(ceiling.hardUsd)}.`);
  if (ceiling.dailyUsd != null) parts.push(`Unattended runs stop at ${formatUsd(ceiling.dailyUsd)} today.`);
  const line = parts.join(" ").trim();
  if (!line) return null;
  let held = "";
  if (chatId && ceiling.hardUsd != null) {
    const task = sessionTotal(chatId);
    if (!task.unreadable && task.micros >= Math.round(ceiling.hardUsd * MICRO)) {
      held = `Task ceiling reached: ${formatUsd(task.micros / MICRO)} of ${formatUsd(ceiling.hardUsd)}. This run is held.`;
    }
  }
  if (!held && chatId && ceiling.dailyUsd != null) {
    const daily = dailyReading(spendKey(project));
    if (!daily.unreadable && daily.micros >= Math.round(ceiling.dailyUsd * MICRO)) {
      held = `Daily ceiling reached: ${formatUsd(daily.micros / MICRO)} of ${formatUsd(ceiling.dailyUsd)} today. This run is held.`;
    }
  }
  return { line, held };
}

/**
 * A turn whose CLI reports no cost (a text prompt, a cheap memory call): counted as unpriced, so the ledger shows that
 * it ran. It adds no money, and no limit counts it as $0.
 */
export function noteUnpricedTurn(input: { sessionId: string; cwd: string }): void {
  boot();
  if (!input.sessionId) return;
  recordTurn(input.sessionId, keyForTurnNow(input.sessionId, input.cwd), { kind: "unpriced" });
}

/**
 * One finished turn. Records its price in the ledger, whatever the model, and judges the run's total for the soft ask
 * and the hard stop. A project or app limit is not judged here: it is judged at admission.
 */
export function reviewReportedTurn(input: {
  sessionId: string;
  cwd: string;
  model?: string;
  harness: string;
  metrics?: { costUsd?: number; inputTokens?: number; outputTokens?: number } | null;
  /** Omitted means automated: a turn of unknown origin is treated as automated. */
  origin?: TurnOrigin;
}): CeilingVerdict {
  const idle: CeilingVerdict = { status: "unset", reason: "", stopRun: false, ask: false };
  boot();
  if (!input.sessionId) return idle;
  const billed = isBilledModel(input.model);
  const key = keyForTurnNow(input.sessionId, input.cwd);
  recordTurn(input.sessionId, key, readTurnPrice(input.metrics ?? undefined, { billed }), input.harness.trim().toLowerCase());
  if (!billed) return idle;
  const ceiling = ceilingFor(key);
  if (!ceiling) return idle;
  refreshIfStale();
  const task = sessionTotal(input.sessionId);
  const daily = dailyReading(key);
  const verdict = ceilingDecision({
    ceiling,
    billed: true,
    reportsCost: cliReportsCost(input.harness),
    taskMeasuredUsd: task.micros / MICRO,
    taskPricedTurns: task.priced,
    taskUnpricedTurns: task.unpriced,
    dailyMeasuredUsd: daily.unreadable ? Number.NaN : daily.micros / MICRO,
    unattended: automated(input.origin),
    asked: asked.has(input.sessionId),
    continued: continued.has(input.sessionId),
  });
  if (verdict.ask) asked.add(input.sessionId);
  // Reported once per chat: the soft ask, and the first time a task has only unpriced turns (so it cannot be counted).
  const firstUnmeasured = verdict.status === "unmeasured" && !unmeasuredNoticed.has(input.sessionId);
  if (firstUnmeasured) unmeasuredNoticed.add(input.sessionId);
  if (verdict.stopRun) notify();
  return { ...verdict, notice: verdict.ask || firstUnmeasured };
}

// ---- lifecycle ----------------------------------------------------------------------------------------------------

export function resetSpendGate(): void {
  booted = true;
  book = emptyBook();
  ceilings = {};
  storeUnreadable = false;
  dbStore = null;
  legacyBook = null;
  dbLoaded = false;
  dbFailed = false;
  dbSynced = -1;
  dbLoad = null;
  dbWriting = Promise.resolve();
  pendingSave = null;
  monotonic = defaultMonotonic;
  continued.clear();
  unmeasuredNoticed.clear();
  redoLinks = new Map();
  pendingRedoLinks.clear();
  records = null;
  loadedAt = -Infinity;
  loader = null;
  loading = null;
  persist = null;
  clock = () => Date.now();
  sink = null;
  lookup = NO_PROJECTS;
  folders.clear();
  asked.clear();
  pending = [];
  resetSpendWarnings();
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* the next read still sees whatever is there */
  }
  notify();
}

/** Drop the in-memory book so the next read comes back from storage, as after a restart. The ledger stays. */
export function forgetSpendMemory(): void {
  if (dbStore) {
    dbLoad = loadDb();
    asked.clear();
    return;
  }
  booted = false;
  book = emptyBook();
  ceilings = {};
  asked.clear();
  resetSpendWarnings();
}

/**
 * The one line a project shows. A project's own limit when it has one, otherwise the whole app's, since that one still
 * applies to this project.
 */
export function spendLine(project: string, harness: string, scope: SpendScope = "project"): string {
  boot();
  // A book the database could not answer is not "no limit". The person restarts the app to retry it.
  if (dbStore && dbFailed) return `${UNREADABLE_DB.reason} Restart MonoCode Hub to retry.`;
  if (dbStore && !dbLoaded) return "Loading saved spend limits.";
  const key = scope === "app" ? "" : spendKey(project);
  const own = findLimit(scope, key, "month") ?? findLimit(scope, key, "day");
  const limit = own ?? (scope === "project" ? book.limits.find((row) => row.scope === "app") : undefined);
  if (!limit) return "No spend limit is set.";
  const reading = readingFor(limit, cliReportsCost(harness));
  if (reading.unreadable) return spendAllowed(reading, limit).reason;
  // The estimate label comes from the spend's source (spendStatusLine), not from the harness asked about.
  return spendStatusLine(reading, limit);
}
