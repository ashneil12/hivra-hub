// C8 (Ash: "a few default dashboards that always come with every setup, that just explain the basics"): the four
// ready-made pages are there without asking, on every setup. r61 (PM's blind C8 on r60): before, only a fresh setup was
// seeded, so an install from before C8 (Ash's own) only got them offered while CoS said they "come with every setup".
// Now every install gets them once: each ready page is kept unless one with its title by "Ready-made" was ever kept here
// (removed ones included), so a page Ash took away is never put back and nothing is kept twice. Nothing they ask is
// approved by itself: each asks Keep and allow when first opened (needsAllow), and each has Undo.
import { keepPage, pageFromSpec, pagesEverKept, pagesLoaded } from "./pages";
import { READY_BY, READY_PAGES } from "./readyPages";

const PENDING = "monocode:ready-pages-pending";
/** r61: a new key, so installs that were skipped under the fresh-only rule are seeded once. */
const DONE = "monocode:ready-pages-seeded-v2";

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* best effort */ }
};

/** A fresh setup. Kept for the first-launch card; every install is seeded once now, fresh or not. */
export function markFreshSetup(): void {
  if (!get(DONE)) set(PENDING, "1");
}

/** The ready pages this install has never had (kept or taken away), in the order they are kept. */
export function missingReadyPages(): typeof READY_PAGES {
  const had = new Set(pagesEverKept().filter((p) => p.by === READY_BY).map((p) => p.title));
  return READY_PAGES.filter((r) => !had.has(r.title));
}

let running = false;
/** Keeps the ready pages this install never had, once. Resolves to how many it kept. Safe to call on every change. */
export async function seedReadyPages(now = Date.now()): Promise<number> {
  if (running || get(DONE) || !pagesLoaded()) return 0;
  running = true;
  try {
    let kept = 0;
    // Oldest first, so the list (newest first) reads Agents, Needs you, Being built, Projects.
    const list = [...missingReadyPages()].reverse();
    for (const [i, r] of list.entries()) {
      const at = now + i;
      if (await keepPage(pageFromSpec(r.spec, r.request, READY_BY, "today", [], at), at, { allow: false })) kept++;
    }
    // A keep Ash OS refused is tried again next launch; the ones that went in count, so none is kept twice.
    if (missingReadyPages().length === 0) {
      set(PENDING, null);
      set(DONE, "1");
    }
    return kept;
  } finally {
    running = false;
  }
}
