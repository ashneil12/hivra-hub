// Connectors a restored setup needs. Passwords and keys never travel in the
// setup file, so each one waits for Ash to sign in. Mock: no real auth.
import { useSyncExternalStore } from "react";

export type Connector = { id: string; name: string; projectId: string; signedIn: boolean };

const KEY = "monocode:hub-connectors";
const EVENT = "monocode:hub-connectors-changed";
let list: Connector[] = load();
let version = 0;

function load(): Connector[] {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "null") as Connector[] | null) ?? [];
  } catch {
    return [];
  }
}
function save(next: Connector[]): void {
  list = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* best effort */
  }
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useConnectorsVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
}

export function addConnectors(items: Omit<Connector, "signedIn">[]): void {
  const have = new Set(list.map((c) => c.id));
  save([...list, ...items.filter((c) => !have.has(c.id)).map((c) => ({ ...c, signedIn: false }))]);
}
/** Not yet signed in, for one project. */
export function pendingConnectors(projectId: string): Connector[] {
  return list.filter((c) => c.projectId === projectId && !c.signedIn);
}
/** Mock sign-in: the real flow opens the service's own sign-in. */
export function signIn(id: string): void {
  save(list.map((c) => (c.id === id ? { ...c, signedIn: true } : c)));
}

/** Every connector still waiting for a sign-in, app-wide. */
export function pendingSignIns(): Connector[] {
  return list.filter((c) => !c.signedIn);
}

// ---- Where logins live. Composio is off by default: every login stays on
// this Mac. Turning it on moves new logins to Composio's servers.
const COMPOSIO_KEY = "monocode:hub-composio";
export function composioOn(): boolean {
  try { return localStorage.getItem(COMPOSIO_KEY) === "1"; } catch { return false; }
}
export function setComposio(on: boolean): void {
  try { localStorage.setItem(COMPOSIO_KEY, on ? "1" : "0"); } catch { /* best effort */ }
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
/** All connectors, app-wide. */
export function allConnectors(): Connector[] {
  return list;
}
