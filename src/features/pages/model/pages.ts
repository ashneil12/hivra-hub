import { useSyncExternalStore } from "react";
import { recordPageChange, recordPinChange, setPageHooks, setPinHook } from "../../hub/model/botChanges";
import type { DesignIssue } from "./designCheck";
import type { Capability, PageBlock, PageSpec } from "./pageSpec";
import { validatePageSpec } from "./pageSpec";
import { stubPageSpec } from "./stubPages";

export type { BlockKind, PageBlock } from "./pageSpec";

/**
 * Pages: a seated Mono builds a page (bundled blocks or a bespoke page) through buildPage; Ash previews it, then
 * Keep (or Keep and allow, approving the page's asks) or Throw away. Kept pages and their approved permissions are
 * saved per project; Undo in Bot changes takes a page away and revokes its permissions.
 */
export type Page = {
  id: string;
  projectId: string;
  title: string;
  request: string;
  by: string;
  spec: PageSpec;
  /** What Ash approved with Keep and allow. Empty after Undo. */
  permissions: Capability[];
  warnings?: DesignIssue[];
  keptAt?: number;
  removed?: boolean;
  /** Shown in the sidebar. Pinned by Ash, or by the Mono that built it. */
  pinned?: boolean;
  pinnedBy?: string;
};

/** A preview from a build result. */
export function pageFromSpec(spec: PageSpec, request: string, by: string, projectId: string, warnings: DesignIssue[] = [], now = Date.now()): Page {
  return { id: `page-${now.toString(36)}`, projectId, title: spec.title, request, by, spec, permissions: [], warnings };
}
/** Tests and the dev stub: a preview from the keyword stub. */
export function buildPreview(request: string, by: string, now = Date.now(), projectId = "today"): Page {
  return pageFromSpec(stubPageSpec(request), request, by, projectId, [], now);
}
/** A page's blocks (bespoke pages have none of their own). */
export function pageBlocks(page: Page): PageBlock[] {
  return page.spec.kind === "blocks" ? page.spec.blocks : [];
}

// ---- kept pages -------------------------------------------------------------------------------------------------------
const KEY = "monocode:pages";
function load(): Page[] {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "[]") as Page[]).filter((p) => p && p.id && p.spec && Array.isArray(p.permissions));
  } catch {
    return [];
  }
}
let pages: Page[] = load();
let version = 0;
const subs = new Set<() => void>();
function changed() {
  try {
    localStorage.setItem(KEY, JSON.stringify(pages));
  } catch {
    /* best effort */
  }
  version++;
  subs.forEach((f) => f());
}
export function usePagesVersion(): number {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
}
/** Each project has its own Pages; "today" holds pages for all projects. Older pages without a project count as "today". */
export function keptPages(projectId: string): Page[] {
  return pages.filter((p) => !p.removed && (p.projectId ?? "today") === projectId).sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0));
}
/** Keep (blocks) or Keep and allow (bespoke): the page's asks are approved and stored with it. */
export function keepPage(page: Page, now = Date.now()): void {
  const permissions = page.spec.kind === "bespoke" ? page.spec.permissions : [];
  pages = [{ ...page, permissions, keptAt: now, removed: false }, ...pages.filter((p) => p.id !== page.id)];
  changed();
  recordPageChange(page.id, page.by, page.title);
}
/** Undo takes the page away and revokes what it was allowed; Redo puts both back. */
function setRemoved(id: string, removed: boolean) {
  pages = pages.map((p) => (p.id === id ? { ...p, removed, permissions: removed || p.spec.kind !== "bespoke" ? [] : p.spec.permissions } : p));
  changed();
}
setPageHooks({ remove: (id) => setRemoved(id, true), restore: (id) => setRemoved(id, false) });
/** What a kept page may do right now (nothing once undone). */
export function approvedPermissions(id: string): Capability[] {
  const p = pages.find((x) => x.id === id);
  return p && !p.removed ? p.permissions : [];
}
/** A kept bespoke page whose asks aren't approved yet (it came from a setup file). */
export function needsAllow(page: Page): boolean {
  return !page.removed && page.spec.kind === "bespoke" && page.spec.permissions.length > 0 && page.permissions.length === 0;
}
/** Keep and allow on an imported page: approves its asks, with a Bot changes row so Undo revokes them. */
export function allowPage(id: string): void {
  const p = pages.find((x) => x.id === id);
  if (!p || !needsAllow(p) || p.spec.kind !== "bespoke") return;
  const permissions = p.spec.permissions;
  pages = pages.map((x) => (x.id === id ? { ...x, permissions } : x));
  changed();
  recordPageChange(p.id, p.by, p.title);
}
/** Every kept page, for the setup file. */
export function allKeptPages(): Page[] {
  return pages.filter((p) => !p.removed && p.keptAt);
}
/**
 * Pages from a setup file. They come back with no permissions: a file can't grant
 * a page anything, so its asks wait for Ash to allow them again.
 */
export function importPages(list: Page[]): number {
  const have = new Set(pages.map((p) => p.id));
  const add = list
    .filter((p) => p && p.id && p.spec && !have.has(p.id) && validatePageSpec(p.spec).ok)
    .map((p) => ({ ...p, permissions: [] as Capability[], removed: false, keptAt: p.keptAt ?? Date.now() }));
  if (add.length) {
    pages = [...add, ...pages];
    changed();
  }
  return add.length;
}
/** Every kept page, newest first, across all projects. */
export function allPages(): Page[] {
  return pages.filter((p) => !p.removed && p.keptAt).sort((a, b) => (b.keptAt ?? 0) - (a.keptAt ?? 0));
}
/** Pinned pages, for the sidebar. */
export function pinnedPages(): Page[] {
  return allPages().filter((p) => p.pinned);
}
/** Ash's pin toggle (by "you"), or a Mono pinning the page it built (by its name). */
export function setPinned(id: string, on: boolean, by = "you"): void {
  const page = pages.find((p) => p.id === id);
  if (!page || !!page.pinned === on) return;
  pages = pages.map((p) => (p.id === id ? { ...p, pinned: on, pinnedBy: on ? by : undefined } : p));
  changed();
  // A Mono's pin or unpin goes in Bot changes under that Mono, so Undo (and Undo all from) covers it.
  if (by !== "you") recordPinChange(id, by, page.title, on);
}
setPinHook((id, pinned) => {
  pages = pages.map((p) => (p.id === id ? { ...p, pinned, pinnedBy: pinned ? p.pinnedBy ?? "you" : undefined } : p));
  changed();
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
/** Tests only. */
export function resetPagesForTest(): void {
  pages = [];
  changed();
}
