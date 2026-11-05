import { useMemo, useState, useSyncExternalStore } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, ExternalLink, Lock, Search } from "../../../shared/ui/icons";
import { projectKey, projectName } from "../../../shared/lib/paths";
import { listMonos, monoLook, monosSnapshot, subscribeMonos, type Mono } from "../../monos/model/mono";
import { hubData, useHubDataVersion } from "../model/hubData";
import { allConnectors, useConnectorsVersion } from "../model/connectors";
import {
  CATALOG,
  EVERYWHERE,
  catalogEntryNamed,
  GOOGLE_CLIENT_HELP,
  OUTSIDE,
  cancelBrowserSignIn,
  connectorNeedsAsh,
  connectorsLoadError,
  directEntries,
  forgetGoogleClient,
  isTesting,
  monosFor,
  moveLoginToVault,
  rowState,
  saveConnectorLogin,
  saveGoogleClient,
  setComposioOn,
  setConnectorAllow,
  setMonoConnectors,
  signInWithBrowser,
  signOutConnector,
  testConnector,
  toggledChoice,
  turnOnConnector,
  useConnectorsView,
  type AuthMethod,
  type CatalogEntry,
  type ConnectorsView,
  type Denied,
  type RowState,
} from "../model/hubConnectors";

/** Where a Sign in from Today asked to land (consumed by the page once). */
let focusRequest: string | null = null;
export function focusConnector(id: string): void {
  focusRequest = id;
}

export type Scope = { key: string; label: string };

/** The projects a connector can be allowed in: the hub's projects with a folder, then any other folder a Mono works on. */
export function scopeOptions(monos: Mono[]): Scope[] {
  const out = new Map<string, string>();
  for (const p of hubData().listProjects()) if (p.folder) out.set(projectKey(p.folder), p.name);
  for (const mono of monos)
    for (const project of monoLook(mono).projects) {
      const key = projectKey(project.path);
      if (!out.has(key)) out.set(key, project.name || projectName(project.path));
    }
  return [...out].map(([key, label]) => ({ key, label }));
}

function useMonos(): Mono[] {
  const snap = useSyncExternalStore(subscribeMonos, monosSnapshot, monosSnapshot);
  return useMemo(() => listMonos(), [snap]); // eslint-disable-line react-hooks/exhaustive-deps
}

const STATE_WORD: Record<RowState, string> = {
  connected: "Connected",
  "needs-sign-in": "Needs sign-in",
  error: "Error",
  off: "Off",
};

function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "That didn't work.";
}

const open = (url: string) => void openUrl(url).catch(() => undefined);

/**
 * Settings → Connectors: every app a Mono can use, direct connections first. Logins stay in this Mac's Keychain; each
 * connector is given to projects (and through them to their Monos) on purpose. Composio is a switch at the bottom.
 */
export function ConnectorsPage() {
  useHubDataVersion();
  useConnectorsVersion();
  const view = useConnectorsView();
  const monos = useMonos();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(() => {
    const id = focusRequest;
    focusRequest = null;
    return id;
  });
  if (!view) {
    const problem = connectorsLoadError();
    return (
      <p className="text-[13px] text-content/60" data-hub-connectors-loading>
        {problem ? `Connectors aren't available here: ${problem}` : "Reading your connectors…"}
      </p>
    );
  }
  const scopes = scopeOptions(monos);
  const q = query.trim().toLowerCase();
  const matches = (e: CatalogEntry) =>
    !q || e.name.toLowerCase().includes(q) || e.blurb.toLowerCase().includes(q) || e.category.toLowerCase().includes(q);
  const direct = directEntries().filter(matches);
  const connected = direct.filter((e) => view.settings.connectors[e.id]?.signedIn);
  const rest = direct.filter((e) => !view.settings.connectors[e.id]?.signedIn);
  const categories = [...new Set(rest.map((e) => e.category))];
  const row = (entry: CatalogEntry) => (
    <ConnectorRow
      key={entry.id}
      entry={entry}
      view={view}
      scopes={scopes}
      monos={monos}
      open={openId === entry.id}
      onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
    />
  );
  return (
    <div className="flex flex-col gap-7" data-hub-connectors>
      <div className="flex flex-col gap-3">
        <p className="flex items-start gap-2 text-[13px] leading-5 text-content/70">
          <Lock className="mt-0.5 size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
          <span>
            Logins stay in this Mac's Keychain and are handed to a connector only when a session starts. A Mono gets a
            connector only when its project allows it.
            {view.kind === "dev" ? " This dev copy keeps its own logins (monocode-hub-dev), never the daily app's." : ""}
          </span>
        </p>
        <label className="flex h-8 items-center gap-2 rounded-lg bg-content/5 px-2.5 text-[13px]">
          <Search className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={`Search ${directEntries().length} connectors`}
            aria-label="Search connectors"
            data-hub-connector-search
            className="min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/40"
          />
        </label>
      </div>

      {connected.length ? (
        <section data-hub-connectors-connected>
          <h3 className="mb-1 px-3 text-xs text-content/60">Connected</h3>
          <div className="flex flex-col gap-px">{connected.map(row)}</div>
        </section>
      ) : null}

      {categories.map((category) => (
        <section key={category} data-hub-connector-category={category}>
          <h3 className="mb-1 px-3 text-xs text-content/60">{category}</h3>
          <div className="flex flex-col gap-px">{rest.filter((e) => e.category === category).map(row)}</div>
        </section>
      ))}
      {!direct.length ? <p className="px-3 text-[13px] text-content/60">No connector matches “{query}”.</p> : null}

      {view.settings.googleClient ? (
        <div className="flex items-center gap-3 px-3 text-xs text-content/50" data-hub-google-client-saved>
          <span className="flex-1">Your Google OAuth client (for Gmail, Calendar, Drive, Docs and Sheets) is in the Keychain.</span>
          <button type="button" className="hover:text-content" onClick={() => void forgetGoogleClient()}>
            Remove it
          </button>
        </div>
      ) : null}

      <ComposioSection view={view} scopes={scopes} monos={monos} openId={openId} setOpenId={setOpenId} />
    </div>
  );
}

/** Grey, except a failure only Ash can fix: red "Needs you" (the row's second line says why). No amber. */
function StatePill({ state, ash }: { state: RowState; ash: boolean }) {
  const tone = ash ? "text-red-400" : state === "connected" ? "text-content/75" : "text-content/50";
  return (
    <span className={`shrink-0 text-xs ${tone}`} data-hub-connector-state={state} data-hub-connector-needs-you={ash || undefined}>
      {ash ? "Needs you" : STATE_WORD[state]}
    </span>
  );
}

function ConnectorRow({
  entry,
  view,
  scopes,
  monos,
  open: expanded,
  onToggle,
}: {
  entry: CatalogEntry;
  view: ConnectorsView;
  scopes: Scope[];
  monos: Mono[];
  open: boolean;
  onToggle: () => void;
}) {
  const state = rowState(view.settings, entry);
  const info = view.settings.connectors[entry.id];
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div id={`setting-connector-${entry.id}`} data-hub-connector={entry.id} className={`rounded-lg ${expanded ? "bg-content/4" : ""}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-content/5"
      >
        <Chevron className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-content">{entry.name}</span>
          <span className="block truncate text-xs text-content/50">
            {info?.signedIn && info.status?.message ? info.status.message : entry.blurb}
          </span>
        </span>
        <StatePill state={state} ash={state === "error" && connectorNeedsAsh(info?.status)} />
      </button>
      {expanded ? (
        <div className="flex flex-col gap-4 px-9 pb-4 pt-1" data-hub-connector-detail={entry.id}>
          <p className="text-xs text-content/55">
            {entry.server}
            {entry.docs ? (
              <>
                {" · "}
                <button type="button" onClick={() => open(entry.docs!)} className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
                  Docs <ExternalLink className="size-3" strokeWidth={1.75} />
                </button>
              </>
            ) : null}
          </p>
          {info?.signedIn ? <SignedIn entry={entry} view={view} /> : <SignIn entry={entry} view={view} scopes={scopes} />}
          {info?.signedIn ? (
            <>
              <AllowPicker
                value={info.allow ?? []}
                scopes={scopes}
                onChange={(allow) => void setConnectorAllow(entry.id, allow)}
              />
              <MonoAccess entry={entry} view={view} monos={monos} scopes={scopes} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const buttonClass =
  "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";
const inputClass =
  "h-7.5 min-w-0 flex-1 rounded-md bg-content/6 px-2 text-[13px] text-content outline-none placeholder:text-content/35 focus:bg-content/10";

function SignedIn({ entry, view }: { entry: CatalogEntry; view: ConnectorsView }) {
  const info = view.settings.connectors[entry.id];
  const [problem, setProblem] = useState<string>();
  const testing = isTesting(entry.id);
  const how = info?.method === "oauth" ? "Signed in through its own page" : info?.method === "none" ? "On (no login needed)" : "Key saved in the Keychain";
  return (
    <div className="flex flex-col gap-2" data-hub-connector-signed-in>
      <p className="text-[13px] text-content/80">
        {how}
        {info?.account ? ` · ${info.account}` : ""}
      </p>
      {info?.status ? (
        <p className={`text-xs ${connectorNeedsAsh(info.status) ? "text-red-400" : "text-content/60"}`} data-hub-connector-status>
          {info.status.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={testing}
          className={buttonClass}
          data-hub-connector-test
          onClick={() => void testConnector(entry.id).catch((e) => setProblem(errorText(e)))}
        >
          {testing ? "Testing…" : "Test"}
        </button>
        <button
          type="button"
          className={buttonClass}
          data-hub-connector-sign-out
          onClick={() => void signOutConnector(entry.id).catch((e) => setProblem(errorText(e)))}
        >
          {info?.method === "none" ? "Turn off" : "Sign out"}
        </button>
        {info?.method === "token" ? (
          <button
            type="button"
            className={buttonClass}
            data-hub-connector-move-to-vault
            onClick={() => {
              if (!window.confirm(`Move ${entry.name}'s saved key into the vault? The connector keeps working, and the key is managed under Settings > Secrets.`)) return;
              void moveLoginToVault(entry.id).catch((e) => setProblem(errorText(e)));
            }}
          >
            Move key to vault
          </button>
        ) : null}
      </div>
      {problem ? <p className="text-xs text-content/60">{problem}</p> : null}
    </div>
  );
}

function SignIn({ entry, view, scopes }: { entry: CatalogEntry; view: ConnectorsView; scopes: Scope[] }) {
  const methods = entry.auth.methods;
  const [method, setMethod] = useState<AuthMethod>(methods[0]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [allow, setAllow] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const google = entry.auth.oauth?.mode === "google";
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    void work()
      .then(() => void testConnector(entry.id).catch(() => undefined))
      .catch((e) => setProblem(errorText(e)))
      .finally(() => setBusy(false));
  };
  const fields = entry.auth.fields ?? [];
  const filled = fields.every((f) => f.optional || values[f.key]?.trim());
  return (
    <div className="flex flex-col gap-3" data-hub-connector-sign-in>
      {methods.length > 1 ? (
        <div className="flex gap-1" role="radiogroup" aria-label="How to sign in">
          {methods.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              className={`rounded-md px-2 py-0.5 text-xs ${method === m ? "bg-content/12 text-content" : "text-content/60 hover:bg-content/6"}`}
            >
              {m === "oauth" ? "Sign in on its page" : "Paste a key"}
            </button>
          ))}
        </div>
      ) : null}
      {entry.auth.help ? <p className="text-xs leading-5 text-content/60">{entry.auth.help}</p> : null}

      {method === "token" ? (
        <div className="flex flex-col gap-2">
          {fields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1">
              <span className="text-xs text-content/60">{field.label}</span>
              <input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues({ ...values, [field.key]: e.currentTarget.value })}
                data-hub-connector-field={field.key}
                className={inputClass}
              />
            </label>
          ))}
          {entry.auth.getUrl ? (
            <button type="button" onClick={() => open(entry.auth.getUrl!)} className="inline-flex w-fit items-center gap-1 text-xs text-content/60 hover:text-content">
              Make one on {new URL(entry.auth.getUrl).host} <ExternalLink className="size-3" strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      ) : null}

      {method === "oauth" && google && !view.settings.googleClient ? <GoogleClientForm /> : null}

      <AllowPicker value={allow} scopes={scopes} onChange={setAllow} />

      <div className="flex items-center gap-2">
        {method === "token" ? (
          <button
            type="button"
            disabled={busy || !filled}
            className={buttonClass}
            data-hub-connector-save
            onClick={() => run(() => saveConnectorLogin(entry.id, values, allow))}
          >
            {busy ? "Saving…" : "Save to Keychain"}
          </button>
        ) : method === "oauth" ? (
          <>
            <button
              type="button"
              disabled={busy || (google && !view.settings.googleClient)}
              className={buttonClass}
              data-hub-connector-oauth
              onClick={() => run(() => signInWithBrowser(entry.id, allow))}
            >
              Sign in with {entry.name}
            </button>
            {busy ? (
              <>
                <span className="text-xs text-content/60">Finish signing in in your browser…</span>
                <button type="button" className="text-xs text-content/60 hover:text-content" onClick={() => void cancelBrowserSignIn()}>
                  Cancel
                </button>
              </>
            ) : null}
          </>
        ) : (
          <button type="button" disabled={busy} className={buttonClass} data-hub-connector-turn-on onClick={() => run(() => turnOnConnector(entry.id, allow))}>
            Turn on
          </button>
        )}
      </div>
      {problem ? <p className="text-xs text-content/60" data-hub-connector-problem>{problem}</p> : null}
    </div>
  );
}

/** Google has no app registration, so Ash makes one OAuth client in his own Google Cloud project, once. */
function GoogleClientForm() {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [problem, setProblem] = useState<string>();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stroke p-3" data-hub-google-client>
      <p className="text-xs leading-5 text-content/65">{GOOGLE_CLIENT_HELP.help}</p>
      <button type="button" onClick={() => open(GOOGLE_CLIENT_HELP.getUrl)} className="inline-flex w-fit items-center gap-1 text-xs text-content/60 hover:text-content">
        Open Google Cloud clients <ExternalLink className="size-3" strokeWidth={1.75} />
      </button>
      <input value={id} onChange={(e) => setId(e.currentTarget.value)} placeholder="Client ID (….apps.googleusercontent.com)" autoComplete="off" className={inputClass} />
      <input type="password" value={secret} onChange={(e) => setSecret(e.currentTarget.value)} placeholder="Client secret" autoComplete="off" className={inputClass} />
      <div className="flex gap-2">
        <button type="button" disabled={!id.trim() || !secret.trim()} className={buttonClass} onClick={() => void saveGoogleClient(id, secret).catch((e) => setProblem(errorText(e)))}>
          Save Google client
        </button>
      </div>
      {problem ? <p className="text-xs text-content/60">{problem}</p> : null}
    </div>
  );
}

/** Which projects may use a connector. Nothing is ticked until Ash ticks it. */
function AllowPicker({ value, scopes, onChange }: { value: string[]; scopes: Scope[]; onChange: (allow: string[]) => void }) {
  const everywhere = value.includes(EVERYWHERE);
  const toggle = (key: string, on: boolean) => onChange(on ? [...new Set([...value, key])] : value.filter((v) => v !== key));
  const box = (key: string, label: string, disabled = false) => (
    <label key={key} className={`flex items-center gap-2 text-[13px] ${disabled ? "text-content/40" : "text-content/80"}`}>
      <input type="checkbox" checked={everywhere || value.includes(key)} disabled={disabled} onChange={(e) => toggle(key, e.currentTarget.checked)} />
      {label}
    </label>
  );
  return (
    <fieldset className="flex flex-col gap-1.5" data-hub-connector-allow>
      <legend className="mb-1 text-xs text-content/60">
        Who can use it {value.length ? "" : <span className="text-content/45">(nobody yet)</span>}
      </legend>
      {box(EVERYWHERE, "Every project, and Monos outside one")}
      {scopes.map((s) => box(s.key, s.label, everywhere))}
      {box(OUTSIDE, "Monos outside a project (the leadership team)", everywhere)}
    </fieldset>
  );
}

function deniedText(denied: Denied, scopes: Scope[]): string {
  switch (denied.why) {
    case "project-off":
      return `Off in ${scopes.find((s) => s.key === denied.project)?.label ?? projectName(denied.project)}`;
    case "outside-off":
      return "Not in a project";
    case "mono-off":
      return "Turned off for this Mono";
    case "needs-composio":
      return "Composio is off";
    case "not-signed-in":
      return "Not signed in";
  }
}

/** Every Mono, whether it gets this connector, and a switch to keep one Mono off it. */
function MonoAccess({ entry, view, monos, scopes }: { entry: CatalogEntry; view: ConnectorsView; monos: Mono[]; scopes: Scope[] }) {
  if (!monos.length) return null;
  const rows = monosFor(view.settings, entry, monos);
  return (
    <div className="flex flex-col gap-1" data-hub-connector-monos>
      <span className="mb-1 text-xs text-content/60">Monos</span>
      {rows.map(({ mono, denied }) => {
        const choice = view.settings.monos[mono.id];
        const turnedOn = choice ? (choice.mode === "all" ? !choice.except.includes(entry.id) : choice.ids.includes(entry.id)) : true;
        return (
          <label key={mono.id} className="flex items-center gap-2 text-[13px]" data-hub-connector-mono={mono.id}>
            <input
              type="checkbox"
              checked={turnedOn}
              onChange={(e) => void setMonoConnectors(mono.id, toggledChoice(choice, entry.id, e.currentTarget.checked))}
            />
            <span className="min-w-0 flex-1 truncate text-content/80">{monoLook(mono).name}</span>
            <span className="shrink-0 text-xs text-content/50">{denied ? deniedText(denied, scopes) : "Gets it"}</span>
          </label>
        );
      })}
    </div>
  );
}

function ComposioSection({
  view,
  scopes,
  monos,
  openId,
  setOpenId,
}: {
  view: ConnectorsView;
  scopes: Scope[];
  monos: Mono[];
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  const on = view.settings.composio;
  const entry = CATALOG.find((e) => e.composio)!;
  // Apps a restored setup named that have no direct connector: only Composio can reach them.
  const restored = allConnectors().filter((c) => !catalogEntryNamed(c.name));
  return (
    <section className="flex flex-col gap-2 border-t border-stroke pt-5" data-hub-composio-section>
      <div className="flex items-center gap-3 px-3">
        <span className="flex-1">
          <span className="block text-[13px] text-content">Use Composio for rare apps</span>
          <span className="block text-xs text-content/50">Off by default. The apps above always connect directly.</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Use Composio for rare apps"
          data-hub-composio
          onClick={() => void setComposioOn(!on)}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-content/60" : "bg-content/20"}`}
        >
          <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`} />
        </button>
      </div>
      {on ? (
        <div className="hub-fade-in flex flex-col gap-1">
          <p className="px-3 text-[13px] text-content/60" data-hub-composio-note>
            Logins for the apps you link inside Composio are stored on Composio's servers. GitHub, Gmail and the other
            apps above stay on this Mac.
          </p>
          <ConnectorRow
            entry={entry}
            view={view}
            scopes={scopes}
            monos={monos}
            open={openId === entry.id}
            onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
          />
        </div>
      ) : null}
      {restored.length ? (
        <div className="flex flex-col gap-px pt-1" data-hub-connectors-restored>
          <span className="px-3 text-xs text-content/60">From your setup file, with no direct connector</span>
          {restored.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-1.5 text-[13px]" data-hub-connector={c.id}>
              <span className="min-w-0 flex-1 truncate text-content/80">{c.name}</span>
              <span className="shrink-0 text-xs text-content/50" data-hub-connector-needs-composio={on ? undefined : ""}>
                {on ? "Link it inside Composio" : "Needs Composio"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
