// The web sources Ash connected a page to (C4). A page's record in Ash OS has no room for an address (its permission
// list is a fixed set of capabilities), so the grants live here, on this Mac: one list per page, written when Ash
// connects a source on the page itself (PagesView.tsx, PageConnections) and taken away when he disconnects it. Every
// connect and disconnect is a Bot changes row (botChanges.ts's `source`), so Undo is a second way to take one back.
//
// A grant is the only way out: the bridge refuses `http.fetch` for any address this list doesn't cover, in plain words,
// and the Rust side (page_http.rs) is handed the same grants, path included, and refuses anything else — a redirect out
// of the granted path too — so a page can never reach a host or path nobody allowed, even if the renderer's check were
// skipped.
import { useSyncExternalStore } from "react";
import { setSourceHook } from "../../hub/model/botChanges";

export type PageGrant = {
  /** Origin plus the path it may read (`https://api.example.com/v1/`); a bare origin grants every path on it. */
  url: string;
  /** What Ash calls it, shown back to him; the host when he didn't name one. */
  label: string;
  /** When it was connected (epoch ms). */
  at: number;
};

export type ValidGrant = { ok: true; value: { url: string; origin: string; label: string } } | { ok: false; error: string };

const KEY = "monocode:hub-page-sources";
export const MAX_PER_PAGE = 10;
const MAX_URL = 2000;
/** Whatever can never be a page's internet source: this Mac, this network, or a name only this network knows. */
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|0\.0\.0\.0)/i;

type Store = Record<string, PageGrant[]>;
const EMPTY: PageGrant[] = [];

function load(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Store = {};
    for (const [pageId, rows] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      const list = rows.filter((r): r is PageGrant => {
        const g = r as PageGrant;
        return !!g && typeof g.url === "string" && !!g.url && typeof g.at === "number";
      }).map((g) => ({ url: g.url, label: typeof g.label === "string" && g.label ? g.label : g.url, at: g.at }));
      if (list.length) out[pageId] = list;
    }
    return out;
  } catch {
    return {};
  }
}
let store: Store = load();

let version = 0;
const subs = new Set<() => void>();
function changed(): void {
  version++;
  subs.forEach((f) => f());
}
function save(): void {
  try {
    if (Object.keys(store).length) localStorage.setItem(KEY, JSON.stringify(store));
    else localStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
}
/** Tests and a fresh start: forget every grant on this Mac. */
export function forgetAllGrants(): void {
  store = {};
  save();
  changed();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The address Ash typed, made into a grant, or why it can't be one. https only, no name and password in it, no
 * `#fragment`; this Mac and the local network are refused (the fetch checks again, resolving the name for real).
 */
export function validSource(raw: string, label?: string): ValidGrant {
  const text = raw.trim();
  if (!text) return { ok: false, error: "Type the web address the hub should read." };
  if (text.length > MAX_URL) return { ok: false, error: "That web address is too long." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That isn't a web address. It should start with https://" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "A hub can only read https:// addresses, so the data can't be read or changed on the way." };
  if (url.username || url.password) return { ok: false, error: "Leave the name and password out of the address. If it needs a token, add it here and the app keeps it, not the hub." };
  if (PRIVATE.test(url.host) || /\.(local|localhost|internal)$/i.test(url.hostname)) {
    return { ok: false, error: "That's this Mac or your local network. A hub can only read a public web address." };
  }
  if (!url.hostname) return { ok: false, error: "That isn't a web address. It should start with https://" };
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  const url0 = `${url.origin}${path}`;
  return { ok: true, value: { url: url0, origin: url.origin, label: (label ?? "").trim() || url.host } };
}

/** Whether `raw` is the same place as `grant` (same origin, and under the granted path). */
export function covers(grant: Pick<PageGrant, "url">, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  let g: URL;
  try {
    g = new URL(grant.url);
  } catch {
    return false;
  }
  if (url.origin !== g.origin) return false;
  const base = g.pathname === "/" ? "/" : g.pathname.replace(/\/+$/, "");
  if (base === "/") return true;
  return url.pathname === base || url.pathname.startsWith(`${base}/`);
}

/** A page's grants right now, oldest first (a stable array, so React doesn't re-render for nothing). */
export function grantsFor(pageId: string): readonly PageGrant[] {
  return store[pageId] ?? EMPTY;
}
/** A page's grants as Rust reads them (origin plus the path under it), handed with every fetch and checked there too. */
export function grantedUrls(pageId: string): string[] {
  return grantsFor(pageId).map((g) => g.url);
}
export function allowsUrl(pageId: string, raw: string): boolean {
  return grantsFor(pageId).some((g) => covers(g, raw));
}

/** Connect a source to a page. Says why not, in plain words, when the address can't be one. */
export function connectSource(pageId: string, raw: string, label?: string): { ok: true; grant: PageGrant } | { ok: false; error: string } {
  const valid = validSource(raw, label);
  if (!valid.ok) return valid;
  const mine = grantsFor(pageId);
  const already = mine.find((g) => g.url === valid.value.url);
  if (already) return { ok: false, error: `The hub is already connected to ${already.label}.` };
  if (mine.length >= MAX_PER_PAGE) return { ok: false, error: `A hub can be connected to ${MAX_PER_PAGE} sources at once. Disconnect one first.` };
  const grant: PageGrant = { url: valid.value.url, label: valid.value.label, at: Date.now() };
  store = { ...store, [pageId]: [...mine, grant] };
  save();
  changed();
  return { ok: true, grant };
}

/** Disconnect one source from a page. False when it wasn't connected. */
export function disconnectSource(pageId: string, url: string): boolean {
  const mine = grantsFor(pageId);
  const rest = mine.filter((g) => g.url !== url);
  if (rest.length === mine.length) return false;
  const next = { ...store };
  if (rest.length) next[pageId] = rest;
  else delete next[pageId];
  store = next;
  save();
  changed();
  return true;
}

/** What Undo and Redo of a source row run. */
setSourceHook(async (pageId, url, connected) => {
  if (connected) {
    const out = connectSource(pageId, url);
    return out.ok ? undefined : out.error;
  }
  return disconnectSource(pageId, url) ? undefined : "That source was already disconnected.";
});

/** A page's grants, kept in step with connects and disconnects. */
export function usePageGrants(pageId: string): readonly PageGrant[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => store[pageId] ?? EMPTY,
  );
}

/** What a host is called back to Ash: its own name, never the whole address (a path can hold a secret). */
export function hostLabel(url: string): string {
  return hostOf(url);
}
