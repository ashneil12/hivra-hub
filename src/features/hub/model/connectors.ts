// Connectors a restored setup needs. Passwords and keys never travel in the
// setup file, so each one waits for Ash to sign in. A login is kept in the
// macOS Keychain (the hub plugin's connector_login_* commands, service
// `monocode-hub:login:<id>`); only the account name is remembered here, never the secret.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { examplesOn } from "./examples";
import { catalogEntryNamed, connectorsView, setComposioOn } from "./hubConnectors";

export type Connector = { id: string; name: string; projectId: string; signedIn: boolean; account?: string };

/** The app's door to the Keychain. Only `monocode-hub:login:<id>` services (Rust refuses any other, so a connector
 * can never name a model key); the secret never comes back. */
export type ConnectorKeychain = {
  store(service: string, account: string, secret: string): Promise<void>;
  exists(service: string, account: string): Promise<boolean>;
  remove(service: string, account: string): Promise<boolean>;
};
export const tauriKeychain: ConnectorKeychain = {
  store: (service, account, secret) => invoke("plugin:hub|connector_login_store", { service, account, secret }),
  exists: (service, account) => invoke("plugin:hub|connector_login_exists", { service, account }),
  remove: (service, account) => invoke("plugin:hub|connector_login_delete", { service, account }),
};
let keychain: ConnectorKeychain = tauriKeychain;
export function setConnectorKeychain(next: ConnectorKeychain): void {
  keychain = next;
}
/** Tests and proofs use `monocode-hub-test:login:<id>` (dev flag `monocode:hub-keychain-test`), never the real services. */
export function keychainService(id: string): string {
  let test = false;
  try { test = localStorage.getItem("monocode:hub-keychain-test") === "1"; } catch { /* no storage */ }
  return `${test ? "monocode-hub-test" : "monocode-hub"}:login:${id}`;
}

/** Sign-in state for a row: waiting on the Mac's Keychain prompt, or landed (until Ash leaves the page). */
const waiting = new Set<string>();
const landed = new Set<string>();
const problems = new Map<string, string>();
export function signInState(id: string): "waiting" | "on-this-mac" | undefined {
  return waiting.has(id) ? "waiting" : landed.has(id) ? "on-this-mac" : undefined;
}
export function signInProblem(id: string): string | undefined {
  return problems.get(id);
}
/** Ash left the page: landed rows go. */
export function clearLandedSignIns(): void {
  if (!landed.size) return;
  landed.clear();
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}

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
/** The login a connector's own sign-in hands back. The per-app sign-in flows (OAuth pages) are not wired yet. */
export type ConnectorLogin = { account: string; secret: string };
let loginFlow: ((c: Connector) => Promise<ConnectorLogin | null>) | null = null;
export function setConnectorLoginFlow(flow: typeof loginFlow): void {
  loginFlow = flow;
}

/**
 * Sign in: get the login from the app's own sign-in, put it in the Keychain, and only then mark it signed in. While
 * the Keychain call is out (macOS may show its password prompt) the row says so. With the examples flag and no
 * sign-in flow, the old example tick (no Keychain).
 */
export async function signIn(id: string, login?: ConnectorLogin): Promise<void> {
  const c = list.find((x) => x.id === id);
  if (!c || waiting.has(id)) return;
  if (!login && !loginFlow && examplesOn()) {
    save(list.map((x) => (x.id === id ? { ...x, signedIn: true } : x)));
    return;
  }
  problems.delete(id);
  waiting.add(id);
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
  try {
    const got = login ?? (loginFlow ? await loginFlow(c) : null);
    if (!got) throw new Error(`${c.name.replace(/^Example:\s*/, "")}'s sign-in isn't set up yet.`);
    const service = keychainService(id);
    await keychain.store(service, got.account, got.secret);
    if (!(await keychain.exists(service, got.account))) throw new Error("The Keychain didn't keep the login.");
    waiting.delete(id);
    landed.add(id);
    save(list.map((x) => (x.id === id ? { ...x, signedIn: true, account: got.account } : x)));
  } catch (e) {
    waiting.delete(id);
    problems.set(id, typeof e === "string" ? e : e instanceof Error ? e.message : "That sign-in didn't go through.");
    version++;
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

/** Sign out: the login leaves the Keychain, then the connector waits for a sign-in again. */
export async function signOut(id: string): Promise<void> {
  const c = list.find((x) => x.id === id);
  if (!c?.account) return;
  await keychain.remove(keychainService(id), c.account);
  save(list.map((x) => (x.id === id ? { ...x, signedIn: false, account: undefined } : x)));
}

/** Every connector still waiting for a sign-in, app-wide, plus ones that just landed (shown until Ash leaves). One
 * signed in on Settings > Connectors (hubConnectors.ts) isn't waiting any more. */
export function pendingSignIns(): Connector[] {
  return list.filter((c) => (!c.signedIn && !signedInOnConnectorsPage(c)) || landed.has(c.id));
}

function signedInOnConnectorsPage(c: Connector): boolean {
  const entry = catalogEntryNamed(c.name);
  return !!entry && !!connectorsView()?.settings.connectors[entry.id]?.signedIn;
}

/** A restored connector's Sign in opens it on Settings > Connectors when the catalog has it (App.tsx listens). */
export const OPEN_CONNECTOR_EVENT = "monocode:open-connector";
export function openConnectorSettings(name: string): boolean {
  const entry = catalogEntryNamed(name);
  if (!entry) return false;
  window.dispatchEvent(new CustomEvent(OPEN_CONNECTOR_EVENT, { detail: { id: entry.id } }));
  return true;
}

// ---- Where logins live. Composio is off by default: every login stays on this Mac. The switch is kept with the
// rest of the connector settings (Rust, `connectors.json`), so the launcher sees it too.
export function composioOn(): boolean {
  return connectorsView()?.settings.composio ?? false;
}
export function setComposio(on: boolean): void {
  void setComposioOn(on).finally(() => {
    version++;
    window.dispatchEvent(new CustomEvent(EVENT));
  });
}
/** All connectors, app-wide. */
export function allConnectors(): Connector[] {
  return list;
}

/** Main apps have a direct connector (the catalog, connectorCatalog.json), so their login always stays on this Mac.
 * Only rare apps without one go through Composio (when the switch is on). */
export function hasDirectConnector(c: Connector): boolean {
  const entry = catalogEntryNamed(c.name);
  return !!entry && !entry.composio;
}
export function loginLivesOn(c: Connector): "On this Mac" | "On Composio" | "Needs Composio" {
  if (hasDirectConnector(c)) return "On this Mac";
  // An app with no direct connector only works through Composio; with the switch off it has no login anywhere.
  return composioOn() ? "On Composio" : "Needs Composio";
}
