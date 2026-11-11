// Connectors, the real ones: every app a Mono's Claude Code sessions can use, local-first.
//
// The catalog (connectorCatalog.json) is shared with Rust (src-tauri/src/connectors). The state lives in the app's data
// folder (`connectors.json`: which are signed in, which projects allow each, per-Mono choices, the Composio switch) and
// the logins live only in the Keychain. This module never holds a secret after handing it to Rust: a sign-in sends the
// pasted value once, and nothing comes back but names, states and messages.
//
// A Mono's chat gets entries in its one `--mcp-config` (hubMcp.ts) that point at `<app> connector-run <id> --mono <id>
// --project <key>…`, with no login in them. The launcher checks the same rules again at start and reads the login from the Keychain.
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import catalogJson from "./connectorCatalog.json";
import { findMono, listMonos, type Mono } from "../../monos/model/mono";
import { projectKey } from "../../../shared/lib/paths";

export type AuthMethod = "token" | "oauth" | "none";
export type ConnectorField = { key: string; label: string; secret: boolean; placeholder?: string; optional?: boolean };
export type CatalogEntry = {
  id: string;
  name: string;
  category: string;
  blurb: string;
  server: string;
  docs?: string;
  composio?: boolean;
  launch: { kind: "remote" | "stdio" | "builtin"; url?: string; command?: string };
  auth: {
    methods: AuthMethod[];
    fields?: ConnectorField[];
    getUrl?: string;
    help?: string;
    oauth?: { mode: "mcp" | "google"; scopes?: string[] };
  };
};

export const CATALOG = catalogJson.connectors as CatalogEntry[];
export const GOOGLE_CLIENT_HELP = catalogJson.googleClient;
/** Allowed in every project and for Monos outside one. */
export const EVERYWHERE = "*";
/** Allowed for Monos that aren't in any project. */
export const OUTSIDE = "~";

export type ConnectorStatus = { ok: boolean; message: string; at: number };
export type ConnectorState = {
  signedIn?: boolean;
  method?: AuthMethod;
  allow?: string[];
  account?: string;
  status?: ConnectorStatus;
};
export type MonoChoice = { mode: "all"; except: string[] } | { mode: "only"; ids: string[] };
export type ConnectorSettings = {
  composio: boolean;
  googleClient: boolean;
  connectors: Record<string, ConnectorState>;
  monos: Record<string, MonoChoice>;
};
export type ConnectorsView = { settings: ConnectorSettings; launcher: string; subcommand: string; kind: "daily" | "dev" };
export type TestOutcome = { ok: boolean; message: string; account?: string; tools?: number };

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** The catalog entry for a name from a setup file ("GitHub", "Example: Gmail", "Google Calendar"). */
export function catalogEntryNamed(name: string): CatalogEntry | undefined {
  const n = name.replace(/^example:\s*/i, "").trim().toLowerCase();
  return CATALOG.find((e) => e.name.toLowerCase() === n || e.id === n) ?? CATALOG.find((e) => !e.composio && n.split(/\s+/)[0] === e.id);
}

/** The Composio server is the long tail, behind its switch; everything else connects directly. */
export function directEntries(): CatalogEntry[] {
  return CATALOG.filter((e) => !e.composio);
}

// ---- The store: one view from Rust, re-read after every change.

type Backend = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const tauriBackend: Backend = (command, args) => invoke(`plugin:hub|${command}`, args);
let backend: Backend = tauriBackend;
/** Tests swap in a stand-in. */
export function setConnectorsBackend(next: Backend | undefined): void {
  backend = next ?? tauriBackend;
  view = null;
  loadError = undefined;
  loading = undefined;
  autoLoaded = false;
  changed();
}

let view: ConnectorsView | null = null;
let loadError: string | undefined;
let loading: Promise<void> | undefined;
/** The first reader starts one read; after that only actions and window focus read again (never a render loop). */
let autoLoaded = false;
let version = 0;
const EVENT = "monocode:hub-connectors-view";
function changed(): void {
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}

function message(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "That didn't work.";
}

/** Only a real view from Rust is kept: anything else (an older build, a stand-in) is an error, never a retry. */
function checked(next: unknown): ConnectorsView {
  const v = next as ConnectorsView | null | undefined;
  if (!v || typeof v !== "object" || !v.settings || typeof v.settings !== "object" || typeof v.launcher !== "string")
    throw new Error("This build doesn't have connectors.");
  const settings: Partial<ConnectorSettings> = v.settings;
  return {
    ...v,
    settings: {
      composio: settings.composio ?? false,
      googleClient: settings.googleClient ?? false,
      connectors: settings.connectors ?? {},
      monos: settings.monos ?? {},
    },
  };
}

export function connectorsView(): ConnectorsView | null {
  return view;
}
export function connectorsLoadError(): string | undefined {
  return loadError;
}

/** Read the state again (the page, a window regaining focus, after any change elsewhere). */
export function loadConnectors(): Promise<void> {
  loading ??= backend<ConnectorsView>("connectors_state")
    .then((next) => {
      view = checked(next);
      loadError = undefined;
      pruneRetiredMonos();
    })
    .catch((error) => {
      loadError = message(error);
    })
    .finally(() => {
      loading = undefined;
      changed();
    });
  return loading;
}

// ---- r66 (Alfred A10): a retired Mono's per-Mono entry leaves connectors.json with it, and stays gone.

const RETIRED_KEY = "monocode:retired-mono-ids";
function retiredIds(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RETIRED_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveRetiredIds(ids: string[]): void {
  try {
    localStorage.setItem(RETIRED_KEY, JSON.stringify([...new Set(ids)].slice(-200)));
  } catch {
    // Storage full or off: the entry was still removed now; only the sweep at the next start is lost.
  }
}
/** The Monos retired on this Mac and not brought back (their entries must never come back in connectors.json). */
export function retiredMonoIds(): readonly string[] {
  return retiredIds();
}
/** A Mono's own connector choice in connectors.json, when the state has been read. */
export function monoConnectorChoice(monoId: string): MonoChoice | undefined {
  return view?.settings.monos[monoId];
}
/** Retiring: its entry is removed now and remembered, so a later read (a restart, another writer) removes it again. */
export async function forgetRetiredMonoConnectors(monoId: string): Promise<void> {
  saveRetiredIds([...retiredIds(), monoId]);
  if (!view) await loadConnectors();
  if (view && !(monoId in view.settings.monos)) return;
  await setMonoConnectors(monoId, null);
}
/** Undo of the retire: the Mono is back, so its entry is too (the choice it had when it was retired). */
export async function restoreRetiredMonoConnectors(monoId: string, choice: MonoChoice | undefined): Promise<void> {
  saveRetiredIds(retiredIds().filter((id) => id !== monoId));
  if (choice) await setMonoConnectors(monoId, choice);
}
/** Every read: an entry for a retired Mono that isn't on the roster again is removed (never a Mono that is). */
function pruneRetiredMonos(): void {
  const retired = new Set(retiredIds());
  if (!view || !retired.size) return;
  for (const id of Object.keys(view.settings.monos))
    if (retired.has(id) && !findMono(id)) void setMonoConnectors(id, null).catch((e: unknown) => console.warn("Could not remove a retired Mono's connectors", e));
}

/** Re-render on change; the first reader starts the read. */
export function useConnectorsView(): ConnectorsView | null {
  useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
  useEffect(() => {
    if (autoLoaded) return;
    autoLoaded = true;
    void loadConnectors();
  }, []);
  return view;
}

async function apply(command: string, args?: Record<string, unknown>): Promise<ConnectorsView> {
  const next = checked(await backend<ConnectorsView>(command, args));
  view = next;
  loadError = undefined;
  changed();
  return next;
}

/** Ash pasted a key or token: to the Keychain, then signed in. `allow` sets the projects in the same step. */
export function saveConnectorLogin(id: string, fields: Record<string, string>, allow?: string[]): Promise<ConnectorsView> {
  return apply("connector_save_login", { id, fields, allow: allow ?? null });
}
/** A connector with no login (Context7, Figma on this Mac). */
export function turnOnConnector(id: string, allow?: string[]): Promise<ConnectorsView> {
  return apply("connector_turn_on", { id, allow: allow ?? null });
}
/** Opens the provider's sign-in page in the browser; resolves once Ash has finished there (or cancelled). */
export function signInWithBrowser(id: string, allow?: string[]): Promise<ConnectorsView> {
  return apply("connector_oauth", { id, allow: allow ?? null });
}
export function cancelBrowserSignIn(): Promise<void> {
  return backend("connector_oauth_cancel");
}
export function saveGoogleClient(clientId: string, clientSecret: string): Promise<ConnectorsView> {
  return apply("connector_save_google_client", { clientId, clientSecret });
}
export function forgetGoogleClient(): Promise<ConnectorsView> {
  return apply("connector_forget_google_client");
}
export function signOutConnector(id: string): Promise<ConnectorsView> {
  return apply("connector_sign_out", { id });
}
/** WP-92: move a saved key into the vault, leaving a reference. The page asks once first. */
export function moveLoginToVault(id: string): Promise<ConnectorsView> {
  return apply("connector_move_login_to_vault", { id });
}
export function setConnectorAllow(id: string, allow: string[]): Promise<ConnectorsView> {
  return apply("connector_set_allow", { id, allow });
}
export function setMonoConnectors(monoId: string, choice: MonoChoice | null): Promise<ConnectorsView> {
  return apply("connector_set_mono", { monoId, choice });
}
export function setComposioOn(on: boolean): Promise<ConnectorsView> {
  return apply("connectors_set_composio", { on });
}

const testing = new Set<string>();
export function isTesting(id: string): boolean {
  return testing.has(id);
}
/** The Test button: a real check against the provider, then the state again (it records the result). */
export async function testConnector(id: string): Promise<TestOutcome> {
  testing.add(id);
  changed();
  try {
    return await backend<TestOutcome>("connector_test", { id });
  } finally {
    testing.delete(id);
    await loadConnectors();
  }
}

// ---- The rules (the same as src-tauri/src/connectors/settings.rs `allowed`, which decides at launch).

export type Denied =
  | { why: "not-signed-in" }
  | { why: "needs-composio" }
  | { why: "project-off"; project: string }
  | { why: "outside-off" }
  | { why: "mono-off" };

/** Why this Mono, working in these projects, can't use the connector; undefined when it can. */
export function connectorDenied(settings: ConnectorSettings, entry: CatalogEntry, monoId: string, projects: string[]): Denied | undefined {
  const state = settings.connectors[entry.id];
  if (!state?.signedIn) return { why: "not-signed-in" };
  if (entry.composio && !settings.composio) return { why: "needs-composio" };
  const allow = state.allow ?? [];
  const everywhere = allow.includes(EVERYWHERE);
  if (!projects.length) {
    if (!everywhere && !allow.includes(OUTSIDE)) return { why: "outside-off" };
  } else if (!everywhere) {
    const off = projects.find((p) => !allow.includes(p));
    if (off) return { why: "project-off", project: off };
  }
  const choice = settings.monos[monoId];
  if (!choice) return undefined;
  if (choice.mode === "all" ? choice.except.includes(entry.id) : !choice.ids.includes(entry.id)) return { why: "mono-off" };
  return undefined;
}

/** A Mono's project keys, as the launcher compares them. */
export function monoProjectKeys(mono: Pick<Mono, "projects">): string[] {
  return [...new Set(mono.projects.map(projectKey))];
}

export function connectorsFor(settings: ConnectorSettings, monoId: string, projects: string[]): CatalogEntry[] {
  return CATALOG.filter((entry) => !connectorDenied(settings, entry, monoId, projects));
}

/** The MCP servers a Mono's session starts with: the launcher, the connector, the Mono and its projects. No logins. */
export function mcpServersFor(v: ConnectorsView, monoId: string, projects: string[]): Record<string, { command: string; args: string[] }> {
  const servers: Record<string, { command: string; args: string[] }> = {};
  for (const entry of connectorsFor(v.settings, monoId, projects)) {
    servers[entry.id] = {
      command: v.launcher,
      args: [v.subcommand, entry.id, "--mono", monoId, ...projects.flatMap((p) => ["--project", p])],
    };
  }
  return servers;
}

/**
 * A Mono's connector entries for its chat's one --mcp-config (hubMcp.ts adds them beside the delegate tool):
 * what its projects and its own choices allow right now, or nothing (state not read yet, no such Mono).
 */
export function connectorServersForMono(monoId: string): Record<string, { command: string; args: string[] }> {
  const mono = view ? findMono(monoId) : undefined;
  return view && mono ? mcpServersFor(view, mono.id, monoProjectKeys(mono)) : {};
}

/** For the page: which Monos get this connector right now, and which are kept off and why. */
export function monosFor(settings: ConnectorSettings, entry: CatalogEntry, monos: Mono[] = listMonos()): { mono: Mono; denied?: Denied }[] {
  return monos.map((mono) => ({ mono, denied: connectorDenied(settings, entry, mono.id, monoProjectKeys(mono)) }));
}

/** Turn one connector on or off for one Mono, keeping its other choices. */
export function toggledChoice(current: MonoChoice | undefined, id: string, on: boolean): MonoChoice | null {
  const choice = current ?? { mode: "all", except: [] };
  if (choice.mode === "all") {
    const except = on ? choice.except.filter((x) => x !== id) : [...new Set([...choice.except, id])];
    return except.length ? { mode: "all", except } : null;
  }
  const ids = on ? [...new Set([...choice.ids, id])] : choice.ids.filter((x) => x !== id);
  return { mode: "only", ids };
}

export type RowState = "connected" | "needs-sign-in" | "error" | "off";
/** The one word a row shows. */
export function rowState(settings: ConnectorSettings, entry: CatalogEntry): RowState {
  const state = settings.connectors[entry.id];
  if (entry.composio && !settings.composio) return "off";
  if (!state?.signedIn) return "needs-sign-in";
  if (state.status && !state.status.ok) return "error";
  return "connected";
}

/**
 * A failed check only Ash can fix (sign in again, a new key): the one connector error that goes red, with its reason.
 * Any other failure (a timeout, the service down) stays grey; the red rule has no amber (CoS, 22 Oct).
 */
export function connectorNeedsAsh(status?: ConnectorStatus): boolean {
  if (!status || status.ok) return false;
  return /sign(ed)?[ -]?(in|out)|log(ged)?[ -]?(in|out)|expired|revoked|unauthori[sz]ed|forbidden|\b40[13]\b|(invalid|wrong|bad) (api )?(key|token)|re-?auth|permission/i.test(
    status.message,
  );
}
