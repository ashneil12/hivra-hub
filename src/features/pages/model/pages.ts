import { useSyncExternalStore } from "react";
import { recordPageChange, recordPinChange, setPageHooks, setPinHook } from "../../hub/model/botChanges";
import { liveHubStore } from "../../hub/model/hubData";
import type { HubStore } from "../../hub/model/hubStore";
import { toHubError } from "../../hub/model/hubTransport";
import type { DesignIssue } from "./designCheck";
import type { Capability, PageBlock, PageSpec } from "./pageSpec";
import { validatePageSpec } from "./pageSpec";
import { stubPageSpec } from "./stubPages";
import { forUser } from "../../hub/model/userName";
import { hasOwnCode, setOwnCode } from "./ownCode";

export type { BlockKind, PageBlock } from "./pageSpec";

/**
 * Pages: a seated Mono builds a page (bundled blocks or a bespoke page) through buildPage; Ash previews it, then
 * Keep (or Keep and allow, approving the page's asks) or Throw away. Undo in Bot changes takes a page away and revokes
 * its permissions.
 *
 * Where kept pages live: the hub's local record (`pages`, `page-update`, `page-remove`; hub/model/localHub, WP-04,
 * the record WP-33 takes over), so every window sees the same pages and a Mono's pin shows. Pages kept in this window's
 * own storage before that are sent to the record once (and a copy stays under `monocode:pages.before-record`). Only the
 * example data keeps pages in this window's own storage, as before.
 */
export type Page = {
  id: string;
  projectId: string;
  title: string;
  request: string;
  by: string;
  /** The Mono that built it (its roster id), when known. */
  monoId?: string;
  spec: PageSpec;
  /** What Ash approved with Keep and allow. Empty after Undo. */
  permissions: Capability[];
  warnings?: DesignIssue[];
  keptAt?: number;
  removed?: boolean;
  /** Shown in the sidebar. Pinned by Ash, or by the Mono that built it. */
  pinned?: boolean;
  pinnedBy?: string;
  /** Ash OS already has this page (its build made it, or it was kept there): Keep only marks it kept. */
  inRecord?: boolean;
  /** A rebuild from Ash's words (his Rebuild, or a Mono's from its chat) waiting on the page for his tap. */
  newVersion?: NewVersion;
};
/** A kept page's new version: `id` is its row in Ash OS's record. */
export type NewVersion = { id: string; request: string; by: string; monoId?: string; at: number; spec: PageSpec };

/** A preview from a build result. `pageId` is the record's id when Ash OS built it. */
export function pageFromSpec(spec: PageSpec, request: string, by: string, projectId: string, warnings: DesignIssue[] = [], now = Date.now(), pageId?: string, monoId?: string): Page {
  return {
    id: pageId ?? `page-${now.toString(36)}`, projectId, title: spec.title, request, by, spec, permissions: [], warnings,
    ...(monoId ? { monoId } : {}), ...(pageId ? { inRecord: true } : {}),
  };
}
/** Tests and the dev stub: a preview from the keyword stub. */
export function buildPreview(request: string, by: string, now = Date.now(), projectId = "today"): Page {
  return pageFromSpec(stubPageSpec(request), request, by, projectId, [], now);
}
/** A page's blocks (bespoke pages have none of their own). */
export function pageBlocks(page: Page): PageBlock[] {
  return page.spec.kind === "blocks" ? page.spec.blocks : [];
}

// ---- where pages live ---------------------------------------------------------------------------------------------------
type Backend = { kind: "local" } | { kind: "record"; store: HubStore };
let forced: Backend | undefined;
function backend(): Backend {
  if (forced) return forced;
  const store = liveHubStore();
  return store ? { kind: "record", store } : { kind: "local" };
}
/** Tests: read and write pages through this store's Ash OS (or this Mac's storage with "local"). */
export function setPagesBackend(next: HubStore | "local" | undefined): void {
  forced = next === undefined ? undefined : next === "local" ? { kind: "local" } : { kind: "record", store: next };
  record = { raw: undefined, list: [] };
  overlay.clear();
  confirmed.clear();
  problem = undefined;
  importTried = false;
  changed();
}

// ---- this Mac's own pages (the example data; and what is sent to the record once) ---------------------------------------
const KEY = "monocode:pages";
const BACKUP_KEY = "monocode:pages.before-record";
function loadLocal(): Page[] {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "[]") as Page[]).filter((p) => p && p.id && p.spec && Array.isArray(p.permissions));
  } catch {
    return [];
  }
}
function saveLocal(list: Page[]): void {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
}
let local: Page[] = loadLocal();

// ---- the record's pages ---------------------------------------------------------------------------------------------
/** What Ash OS last sent (kept and removed pages), mapped once per answer. */
let record: { raw: unknown[] | undefined; list: Page[] } = { raw: undefined, list: [] };
/** Ash's tap shows at once; the record's answer replaces it when the call comes back. */
const overlay = new Map<string, Page>();
/** Pages a write just got back, shown until Ash OS's next list arrives. */
const confirmed = new Map<string, Page>();
let confirmedFor: unknown[] | undefined;
/** The last write Ash OS refused or couldn't take, in plain words (Pages shows it once). */
let problem: string | undefined;

/** A page as Ash OS sends it (`Page` in docs/HUB-BACKEND.md); one whose spec doesn't validate is left out. */
export function pageFromRecord(raw: unknown): Page | undefined {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const spec = validatePageSpec(r.spec);
  if (typeof r.id !== "string" || !spec.ok) return undefined;
  const removed = r.state === "removed" || r.removed === true;
  const kept = typeof r.keptAt === "number" ? r.keptAt : undefined;
  return {
    id: r.id,
    projectId: typeof r.projectId === "string" ? r.projectId : "today",
    title: typeof r.title === "string" ? r.title : spec.value.title,
    request: typeof r.request === "string" ? r.request : "",
    by: typeof r.by === "string" ? r.by : "",
    ...(typeof r.monoId === "string" ? { monoId: r.monoId } : {}),
    spec: spec.value,
    permissions: removed || !Array.isArray(r.permissions) ? [] : (r.permissions.filter((p) => typeof p === "string") as Capability[]),
    ...(kept !== undefined && (r.state === "kept" || removed) ? { keptAt: kept } : {}),
    ...(removed ? { removed: true } : {}),
    ...(r.pinned === true ? { pinned: true, pinnedBy: typeof r.pinnedBy === "string" ? r.pinnedBy : "you" } : {}),
    ...(!removed && newVersionFrom(r.newVersion) ? { newVersion: newVersionFrom(r.newVersion) } : {}),
    inRecord: true,
  };
}
function newVersionFrom(raw: unknown): NewVersion | undefined {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const spec = validatePageSpec(v.spec);
  if (typeof v.id !== "string" || !v.id || !spec.ok) return undefined;
  return {
    id: v.id, request: typeof v.request === "string" ? v.request : "", by: typeof v.by === "string" ? v.by : "",
    ...(typeof v.monoId === "string" ? { monoId: v.monoId } : {}), at: typeof v.at === "number" ? v.at : 0, spec: spec.value,
  };
}

function recordPages(store: HubStore): Page[] {
  const raw = store.getSnapshot().pages;
  if (raw !== record.raw) {
    record = { raw, list: (raw ?? []).map(pageFromRecord).filter((p): p is Page => !!p) };
    if (raw !== confirmedFor) confirmed.clear();
    if (raw) void importLocalOnce(store);
  }
  const byId = new Map(record.list.map((p) => [p.id, p]));
  for (const [id, p] of confirmed) byId.set(id, p);
  for (const [id, p] of overlay) byId.set(id, p);
  return [...byId.values()];
}

/** Whether the pages are known yet: this Mac's at once, Ash OS's once its first list has come back. */
export function pagesLoaded(): boolean {
  const b = backend();
  return b.kind === "local" || b.store.getSnapshot().pages !== undefined;
}
/** Whether any page was ever kept here, removed ones included (so a page Ash took away is never put back). */
export function anyPageEver(): boolean {
  return pages().some((p) => p.keptAt || p.removed);
}
/** Every page ever kept here, removed ones included (r61: so a ready-made page Ash took away is never put back). */
export function pagesEverKept(): Page[] {
  return pages().filter((p) => p.keptAt || p.removed);
}

/** Every page there is right now: the record's, or this Mac's. */
function pages(): Page[] {
  const b = backend();
  return b.kind === "record" ? recordPages(b.store) : local;
}

let version = 0;
const subs = new Set<() => void>();
function changed() {
  version++;
  subs.forEach((f) => f());
}
let seenRaw: unknown;
/** Re-renders on a page change here or a new answer from Ash OS. */
export function usePagesVersion(): number {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      const b = backend();
      const off = b.kind === "record" ? b.store.subscribe(f) : undefined;
      return () => {
        subs.delete(f);
        off?.();
      };
    },
    () => {
      const b = backend();
      const raw = b.kind === "record" ? b.store.getSnapshot().pages : undefined;
      if (raw !== seenRaw) {
        seenRaw = raw;
        version++;
      }
      return version;
    },
  );
}

/** Ash OS's last refusal of a page tap (or that it couldn't be reached), once. */
export function pagesProblem(): string | undefined {
  return problem;
}
export function clearPagesProblem(): void {
  if (!problem) return;
  problem = undefined;
  changed();
}

/**
 * One tap through Ash OS: `next` shows at once (or the page goes, for null), the call runs, and its answer (or the
 * record's next list) takes over. A refusal puts back what was there and says why.
 */
async function write(store: HubStore, id: string, next: Page | null, action: string, payload: Record<string, unknown>): Promise<boolean> {
  if (next) overlay.set(id, next);
  problem = undefined;
  changed();
  try {
    const out = await store.act(action, payload, ["pages"]);
    const page = pageFromRecord(out);
    if (page) {
      confirmed.set(page.id, page);
      confirmedFor = store.getSnapshot().pages;
    }
    return true;
  } catch (e) {
    const err = toHubError(e);
    problem = err.isDown ? "The harness service isn't running, so that wasn't saved. Start it and try again." : err.message || "That didn't go through.";
    return false;
  } finally {
    overlay.delete(id);
    changed();
  }
}

/** Pages kept on this Mac before Ash OS kept them: sent to the record once, each with what Ash had allowed it. */
let importTried = false;
async function importLocalOnce(store: HubStore): Promise<void> {
  if (importTried) return;
  importTried = true;
  const mine = loadLocal().filter((p) => p.keptAt && !p.removed);
  if (!mine.length) return;
  try {
    if (!localStorage.getItem(BACKUP_KEY)) localStorage.setItem(BACKUP_KEY, localStorage.getItem(KEY) ?? "[]");
  } catch {
    return; // no copy, no move: leave them where they are
  }
  const have = new Set(record.list.map((p) => p.id));
  const left: Page[] = [];
  for (const p of mine) {
    if (have.has(p.id)) continue;
    try {
      await store.act("page-update", {
        pageId: p.id, spec: p.spec, projectId: p.projectId ?? "today", ...(p.monoId ? { monoId: p.monoId } : {}), by: p.by, request: p.request,
        kept: true, permissions: p.permissions, ...(p.pinned ? { pinned: true, pinnedBy: p.pinnedBy ?? "you" } : {}),
      });
    } catch {
      left.push(p); // tried again next time the app starts
    }
  }
  saveLocal(left);
  local = left;
  await store.reload(["pages"]);
}

// ---- reading ---------------------------------------------------------------------------------------------------------
/** Each project has its own Pages; "today" holds pages for all projects. Older pages without a project count as "today". */
export function keptPages(projectId: string): Page[] {
  return pages().filter((p) => !p.removed && p.keptAt && (p.projectId ?? "today") === projectId).sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0));
}
/** One page by id (kept, removed or still a preview here). */
export function findPage(id: string): Page | undefined {
  return pages().find((p) => p.id === id);
}
/** What a kept page may do right now (nothing once undone). */
export function approvedPermissions(id: string): Capability[] {
  const p = pages().find((x) => x.id === id);
  return p && !p.removed ? p.permissions : [];
}
/** A kept bespoke page whose asks aren't approved yet (it came from a setup file). */
export function needsAllow(page: Page): boolean {
  return !page.removed && page.spec.kind === "bespoke" && page.spec.permissions.length > 0 && page.permissions.length === 0;
}
/** Every kept page, for the setup file. */
export function allKeptPages(): Page[] {
  return pages().filter((p) => !p.removed && p.keptAt);
}
/** Every kept page, newest first, across all projects. */
export function allPages(): Page[] {
  return allKeptPages().sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0));
}
/** Pinned pages, for the sidebar. */
export function pinnedPages(): Page[] {
  return allPages().filter((p) => p.pinned);
}

// ---- Ash's taps --------------------------------------------------------------------------------------------------------
/**
 * Keep (blocks) or Keep and allow (bespoke): the page's asks are approved and stored with it. With `allow: false` the
 * page is kept with nothing approved, so it asks Keep and allow when opened (needsAllow), like a page from a setup file.
 */
export function keepPage(page: Page, now = Date.now(), opts: { allow?: boolean } = {}): Promise<boolean> {
  const permissions = page.spec.kind === "bespoke" && opts.allow !== false ? page.spec.permissions : [];
  const kept: Page = { ...page, permissions, keptAt: now, removed: false };
  const b = backend();
  if (b.kind === "local") {
    recordPageChange(page.id, page.by, page.title);
    local = [kept, ...local.filter((p) => p.id !== page.id)];
    saveLocal(local);
    changed();
    return Promise.resolve(true);
  }
  const payload = page.inRecord
    ? { pageId: page.id, kept: true, permissions }
    : { pageId: page.id, spec: page.spec, projectId: page.projectId, ...(page.monoId ? { monoId: page.monoId } : {}), by: page.by, request: page.request, kept: true, permissions };
  // The Bot changes row (with its Undo) only once Ash OS has kept it.
  return write(b.store, page.id, kept, "page-update", payload).then((ok) => {
    if (ok) recordPageChange(page.id, page.by, page.title);
    return ok;
  });
}
/** Undo takes the page away and revokes what it was allowed; Redo puts both back. Resolves to a refusal, if any. */
async function setRemoved(id: string, removed: boolean): Promise<string | undefined> {
  const b = backend();
  const p = pages().find((x) => x.id === id);
  if (b.kind === "local") {
    local = local.map((x) => (x.id === id ? { ...x, removed, permissions: removed || x.spec.kind !== "bespoke" ? [] : x.spec.permissions } : x));
    saveLocal(local);
    changed();
    return undefined;
  }
  const next = p ? { ...p, removed, permissions: removed || p.spec.kind !== "bespoke" ? [] : p.spec.permissions } : null;
  return (await write(b.store, id, next, "page-remove", { pageId: id, ...(removed ? {} : { restore: true }) })) ? undefined : problem;
}
setPageHooks({ remove: (id) => setRemoved(id, true), restore: (id) => setRemoved(id, false) });

/** Keep and allow on an imported page: approves its asks, with a Bot changes row so Undo revokes them. */
export function allowPage(id: string): void {
  const p = pages().find((x) => x.id === id);
  if (!p || !needsAllow(p) || p.spec.kind !== "bespoke") return;
  const permissions = p.spec.permissions;
  const b = backend();
  if (b.kind === "local") {
    recordPageChange(p.id, p.by, p.title);
    local = local.map((x) => (x.id === id ? { ...x, permissions } : x));
    saveLocal(local);
    changed();
    return;
  }
  void write(b.store, id, { ...p, permissions }, "page-update", { pageId: id, permissions }).then((ok) => ok && recordPageChange(p.id, p.by, p.title));
}
/**
 * Pages from a setup file. They come back with no permissions: a file can't grant a page anything, so its asks wait
 * for Ash to allow them again. Resolves once Ash OS has answered for each: how many it kept, and each one it didn't
 * (its title and why).
 */
export async function importPages(list: Page[]): Promise<{ added: number; failed: string[] }> {
  const have = new Set(pages().map((p) => p.id));
  const add = list
    .filter((p) => p && p.id && p.spec && !have.has(p.id) && validatePageSpec(p.spec).ok)
    .map((p) => ({ ...p, permissions: [] as Capability[], removed: false, keptAt: p.keptAt ?? Date.now(), inRecord: false }));
  const b = backend();
  if (b.kind === "local") {
    if (add.length) {
      local = [...add, ...local];
      saveLocal(local);
      changed();
    }
    return { added: add.length, failed: [] };
  }
  let added = 0;
  const failed: string[] = [];
  // One at a time: each refusal's reason is read before the next write replaces it.
  for (const p of add) {
    const ok = await write(b.store, p.id, p, "page-update", {
      pageId: p.id, spec: p.spec, projectId: p.projectId ?? "today", ...(p.monoId ? { monoId: p.monoId } : {}), by: p.by, request: p.request, kept: true, permissions: [],
    });
    if (ok) added++;
    else failed.push(`${p.title}: ${problem ?? forUser("Ash OS didn't take it.")}`);
  }
  return { added, failed };
}
/** What a page's new version asks that Ash hasn't allowed the page yet. */
export function newAsks(page: Page, spec: PageSpec): Capability[] {
  return spec.kind === "bespoke" ? spec.permissions.filter((a) => !page.permissions.includes(a)) : [];
}
/** What the page keeps with a new version: what Ash allowed that it still asks for (and, with allowNew, its new asks). */
function keptWith(page: Page, spec: PageSpec, allowNew: boolean): Capability[] {
  if (spec.kind !== "bespoke") return [];
  return spec.permissions.filter((a) => page.permissions.includes(a) || allowNew);
}
/**
 * "Use this version": the page takes its new version's code in place (same page, pin and place on Today) and keeps what
 * Ash allowed that it still asks for; `allowNew` (his "Use it and allow") approves its new asks too. A version with an
 * `id` is the record's (`page-update useVersion`); one without is the example data's, used on this Mac.
 */
export function useNewVersion(page: Page, version: { id?: string; spec: PageSpec }, opts: { allowNew?: boolean } = {}): Promise<boolean> {
  const allowNew = !!opts.allowNew;
  const permissions = keptWith(page, version.spec, allowNew);
  const next: Page = { ...page, spec: version.spec, title: version.spec.title, permissions, newVersion: undefined };
  // The version Ash used is his page's code from now on (ownCode.ts); a refused write leaves it as it was.
  const had = hasOwnCode(page.id);
  setOwnCode(page.id, true);
  const kept = (ok: boolean) => { if (!ok) setOwnCode(page.id, had); return ok; };
  const b = backend();
  if (b.kind === "local" || !version.id) {
    if (b.kind === "record") return write(b.store, page.id, next, "page-update", { pageId: page.id, spec: version.spec, permissions }).then(kept);
    local = local.map((p) => (p.id === page.id ? next : p));
    saveLocal(local);
    changed();
    return Promise.resolve(true);
  }
  return write(b.store, page.id, next, "page-update", { pageId: page.id, useVersion: version.id, ...(allowNew ? { permissions } : {}) }).then(kept);
}
/** "Throw away" on a new version: the page stays as it was. */
export function dropNewVersion(page: Page, versionId: string): Promise<boolean> {
  const b = backend();
  if (b.kind === "local") return Promise.resolve(true);
  return write(b.store, page.id, { ...page, newVersion: undefined }, "page-update", { pageId: page.id, dropVersion: versionId });
}

/** Ash's pin toggle (by "you"), or a Mono pinning the page it built (by its name). */
export function setPinned(id: string, on: boolean, by = "you"): void {
  const page = pages().find((p) => p.id === id);
  if (!page || !!page.pinned === on) return;
  void applyPin(page, on, on ? by : undefined);
  // A Mono's pin or unpin goes in Bot changes under that Mono, so Undo (and Undo all from) covers it.
  if (by !== "you") recordPinChange(id, by, page.title, on);
}
async function applyPin(page: Page, pinned: boolean, pinnedBy: string | undefined): Promise<string | undefined> {
  const next: Page = { ...page, pinned, pinnedBy: pinned ? pinnedBy ?? "you" : undefined };
  const b = backend();
  if (b.kind === "local") {
    local = local.map((p) => (p.id === page.id ? next : p));
    saveLocal(local);
    changed();
    return undefined;
  }
  const ok = await write(b.store, page.id, next, "page-update", { pageId: page.id, pinned, ...(pinned ? { pinnedBy: next.pinnedBy } : {}) });
  return ok ? undefined : problem;
}
setPinHook(async (id, pinned) => {
  const page = pages().find((p) => p.id === id);
  return page ? applyPin(page, pinned, page.pinnedBy) : "That hub isn't there any more.";
});

// The sidebar asks Pages to open one page.
let openRequest: string | undefined;
export function requestOpenPage(id: string | undefined): void {
  openRequest = id;
  changed();
}
export function pendingOpenPage(): string | undefined {
  return openRequest;
}
export function takeOpenRequest(): string | undefined {
  const id = openRequest;
  openRequest = undefined;
  return id;
}
// Dropwave: the sidebar's Pages row always lands on the list, even when a pinned page is the one open.
let listRequests = 0;
export function requestPagesList(): void {
  openRequest = undefined;
  listRequests += 1;
  changed();
}
export function pagesListRequests(): number {
  return listRequests;
}
// Dropwave: the page Pages shows now, so the sidebar can mark a pinned page as the open one.
let shownPage: string | undefined;
export function noteShownPage(id: string | undefined): void {
  if (shownPage === id) return;
  shownPage = id;
  changed();
}
export function shownPageId(): string | undefined {
  return shownPage;
}
/** Tests only: this Mac's storage, empty. */
export function resetPagesForTest(): void {
  local = [];
  setPagesBackend("local");
}
