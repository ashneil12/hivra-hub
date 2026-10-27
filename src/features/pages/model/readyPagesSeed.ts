// C8 (Ash: "a few default dashboards that always come with every setup, that just explain the basics"): on a fresh
// setup the four ready-made pages are there without asking. Only a fresh setup (the first-launch card's own signal,
// needsOnboarding) is marked; the pages are kept once Ash OS's list is back and only if no page was ever kept, so an
// install that already has pages, or one where Ash took them away, is never touched. Nothing they ask is approved by
// itself: each asks Keep and allow when first opened (needsAllow), and each has Undo.
import { anyPageEver, keepPage, pageFromSpec, pagesLoaded } from "./pages";
import { READY_BY, READY_PAGES } from "./readyPages";

const PENDING = "monocode:ready-pages-pending";
const DONE = "monocode:ready-pages-seeded";

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* best effort */ }
};

/** A fresh setup: the ready pages are to be kept once the pages are known. */
export function markFreshSetup(): void {
  if (!get(DONE)) set(PENDING, "1");
}

let running = false;
/** Keeps the four ready pages on a fresh setup, once. Resolves to how many it kept. Safe to call on every change. */
export async function seedReadyPages(now = Date.now()): Promise<number> {
  if (running || !get(PENDING) || get(DONE) || !pagesLoaded()) return 0;
  if (anyPageEver()) {
    set(PENDING, null);
    set(DONE, "1");
    return 0;
  }
  running = true;
  try {
    let kept = 0;
    // Oldest first, so the list (newest first) reads Agents, Needs you, Being built, Projects.
    const list = [...READY_PAGES].reverse();
    for (const [i, r] of list.entries()) {
      const at = now + i;
      if (await keepPage(pageFromSpec(r.spec, r.request, READY_BY, "today", [], at), at, { allow: false })) kept++;
    }
    // A keep Ash OS refused is tried again next launch; the ones that went in count, so none is kept twice.
    if (kept === list.length || anyPageEver()) {
      set(PENDING, null);
      set(DONE, "1");
    }
    return kept;
  } finally {
    running = false;
  }
}
