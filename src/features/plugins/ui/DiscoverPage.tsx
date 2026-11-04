// WP-32. Settings → Plugins: search, filter, the detail (licence, source, what it adds, permissions) and Install.
// Install calls WP-31's `plugins_install`. Listing only reads indexes.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ADD_FILTERS,
  DEFAULT_SOURCES,
  EMPTY_LISTING,
  SOURCES_KEY,
  addSource,
  addsText,
  commitSources,
  indexSourceText,
  installOutcome,
  installSourceText,
  licenceText,
  listPlugins,
  loadSources,
  offersInstall,
  readDiscoverPayload,
  removeSource,
  retryableFailure,
  settleListing,
  sourceDraft,
  startListing,
  statusText,
  visiblePlugins,
  type IndexResult,
  type IndexSource,
  type ListedPlugin,
  type Listing,
  type SourceList,
} from "../model/discover";
import { InstalledPlugins } from "./InstalledPlugins";
// WP-43: profiles sit on the installed list, not on Discover's first paint.
import { BrowserProfiles } from "../../browser/ui/BrowserProfiles";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";
const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-50";

function readStored(): SourceList {
  try {
    return loadSources(localStorage.getItem(SOURCES_KEY));
  } catch {
    return { revision: 0, sources: DEFAULT_SOURCES, dropped: 0 };
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

function resultFor(results: IndexResult[], source: IndexSource, index: number): IndexResult | undefined {
  const at = results[index];
  if (at && JSON.stringify(at.source) === JSON.stringify(source)) return at;
  return results.find((item) => JSON.stringify(item.source) === JSON.stringify(source));
}

export function PluginsPage() {
  const stored = readStored();
  const [revision, setRevision] = useState(stored.revision);
  const [sources, setSources] = useState<IndexSource[]>(stored.sources);
  const [dropped, setDropped] = useState(stored.dropped);
  const [notice, setNotice] = useState<string | null>(null);
  const listingRef = useRef<Listing>(EMPTY_LISTING);
  const [listing, setListing] = useState<Listing>(EMPTY_LISTING);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [installNote, setInstallNote] = useState<{ key: string; message: string } | null>(null);
  const [tab, setTab] = useState<"discover" | "installed">("discover");
  const [kind, setKind] = useState<"url" | "github" | "file">("url");
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback((next: IndexSource[]) => {
    const started = startListing(listingRef.current);
    listingRef.current = started;
    setListing(started);
    const generation = started.generation;
    invoke("plugins_discover", { sources: next })
      .then((raw) => {
        if (!mounted.current) return;
        const settled = settleListing(listingRef.current, generation, readDiscoverPayload(raw));
        listingRef.current = settled;
        setListing(settled);
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        const settled = settleListing(listingRef.current, generation, {
          ok: false,
          message: errorText(error, "The index didn't answer. Nothing was listed."),
        });
        listingRef.current = settled;
        setListing(settled);
      });
  }, []);

  useEffect(() => {
    run(sources);
  }, [sources, run]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key != null && event.key !== SOURCES_KEY) return;
      const loaded = loadSources(event.newValue);
      setRevision(loaded.revision);
      setSources(loaded.sources);
      setDropped(loaded.dropped);
      setNotice("The index list changed in another window. Showing that list.");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const plugins = listPlugins(listing.results);
  const shown = visiblePlugins(plugins, query, filter);
  const shownKey = shown.map((plugin) => plugin.key).join("\n");
  const chosen = shown.find((plugin) => plugin.key === selected) ?? null;

  useEffect(() => {
    if (selected && shownKey.split("\n").includes(selected)) return;
    const first = shownKey.split("\n").find((key) => key) ?? null;
    if (first === selected) return;
    setSelected(first);
  }, [selected, shownKey]);

  function save(next: IndexSource[]) {
    let committed;
    try {
      committed = commitSources(window.localStorage, revision, next);
    } catch {
      setNotice("Couldn't save the index list on this computer.");
      return;
    }
    setRevision(committed.revision);
    setSources(committed.sources);
    setDropped(0);
    setNotice(committed.ok ? null : committed.message);
  }

  function onAdd(event: { preventDefault(): void }) {
    event.preventDefault();
    const drafted = sourceDraft(kind, draft);
    if (!drafted.ok) {
      setDraftError(drafted.message);
      return;
    }
    const added = addSource(sources, drafted.source);
    if (!added.ok) {
      setDraftError(added.message);
      return;
    }
    setDraft("");
    setDraftError(null);
    save(added.sources);
  }

  async function onInstall(plugin: ListedPlugin) {
    if (!offersInstall(plugin.entry) || !plugin.entry.source || installing) return;
    const key = plugin.key;
    const source = plugin.entry.source;
    setInstalling(key);
    setInstallNote(null);
    try {
      const outcome = installOutcome(await invoke("plugins_install", { source, requestedBy: { kind: "person" } }));
      if (!mounted.current) return;
      if (outcome.ok) setInstalled((prev) => ({ ...prev, [key]: outcome.message }));
      else setInstallNote({ key, message: outcome.message });
    } catch (error) {
      if (!mounted.current) return;
      setInstallNote({ key, message: errorText(error, "It wasn't installed.") });
    } finally {
      if (mounted.current) setInstalling(null);
    }
  }

  async function onOpen(url: string) {
    try {
      await openUrl(url);
    } catch (error) {
      setNotice(errorText(error, "Couldn't open that link."));
    }
  }

  return (
    <div data-discover className="flex flex-col gap-8">
      <div role="tablist" aria-label="Plugins" className="flex flex-wrap gap-1">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "discover"}
          onClick={() => setTab("discover")}
          className={tab === "discover" ? PRIMARY : BTN}
        >
          Discover
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "installed"}
          onClick={() => setTab("installed")}
          className={tab === "installed" ? PRIMARY : BTN}
        >
          Installed
        </button>
      </div>
      {tab === "installed" ? (
        <>
          <InstalledPlugins />
          {/* WP-43: each agent's browser profile. */}
          <BrowserProfiles />
        </>
      ) : (
      <>
      <div data-setting-id="plugin-discover" className="flex flex-col gap-4">
        {notice ? (
          <p data-discover-notice className="text-[13px] text-content/70">{notice}</p>
        ) : null}
        {listing.phase === "error" && listing.error ? (
          <p className="text-[13px] text-content/70" data-listing-error>
            {listing.error}{" "}
            {retryableFailure(listing.error) ? "Nothing was marked not compatible." : null}{" "}
            <button type="button" className={BTN} onClick={() => run(sources)}>Try again</button>
          </p>
        ) : null}
        {listing.phase === "loading" && plugins.length === 0 ? (
          <p className="text-[13px] text-content/50">Reading indexes…</p>
        ) : null}

        <div className="flex flex-col gap-2">
          <input
            aria-label="Search plugins"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search plugins"
            className="w-full rounded-md border border-stroke bg-transparent px-3 py-1.5 text-[13px] text-content outline-none placeholder:text-content/40"
          />
          <div role="group" aria-label="Filter by what a plugin adds" className="flex flex-wrap gap-1">
            {ADD_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
                className={filter === item.id ? PRIMARY : BTN}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {shown.length === 0 && listing.phase === "ready" ? (
          <p className="text-[13px] text-content/50">No plugins match.</p>
        ) : shown.length > 0 ? (
          <ul aria-label="Plugins" className="flex flex-col gap-1">
            {shown.map((plugin) => (
              <li key={plugin.key}>
                <button
                  type="button"
                  data-plugin={plugin.entry.name}
                  data-status={plugin.entry.status}
                  aria-current={plugin.key === chosen?.key}
                  onClick={() => setSelected(plugin.key)}
                  className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-content/5 ${plugin.key === chosen?.key ? "bg-content/8" : ""}`}
                >
                  <span className="text-[13px] text-content">{plugin.entry.title}</span>
                  <span className="text-[13px] text-content/60">
                    {plugin.entry.adds.map(addsText).join(", ") || plugin.entry.description}
                    {plugin.entry.status !== "available" ? ` · ${statusText(plugin.entry.status)}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {chosen ? <Detail plugin={chosen} installed={installed[chosen.key]} note={installNote?.key === chosen.key ? installNote.message : null} installing={installing === chosen.key} onInstall={() => void onInstall(chosen)} onOpen={(url) => void onOpen(url)} /> : null}
      </div>

      <section data-setting-id="plugin-indexes" className="flex flex-col gap-3">
        <h2 className="text-[13px] font-medium text-content">Indexes</h2>
        <p className="text-[13px] leading-5 text-content/60">
          Discover reads these lists. It never runs a plugin to list it.
        </p>
        {dropped > 0 ? (
          <p className="text-[13px] text-content/60">Discover reads at most 20 indexes. {dropped} were left out.</p>
        ) : null}
        <ul aria-label="Indexes" className="flex flex-col gap-2">
          {sources.map((source, index) => {
            const result = resultFor(listing.results, source, index);
            return (
              <li key={`${indexSourceText(source)}:${index}`} data-index-source={indexSourceText(source)} className="flex flex-col gap-1 rounded-lg px-3 py-2 ring-1 ring-surface-ring">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-content">{indexSourceText(source)}</span>
                  <button type="button" className={BTN} aria-label={`Remove ${indexSourceText(source)}`} onClick={() => save(removeSource(sources, index))}>
                    Remove
                  </button>
                </div>
                {result?.index ? <span className="text-[13px] text-content/50">{result.index.title}</span> : null}
                {result?.error ? (
                  <p data-index-error className="text-[13px] text-content/70">
                    {result.error}{" "}
                    <button type="button" className={BTN} onClick={() => run(sources)}>Try again</button>
                  </p>
                ) : null}
                {result?.index && result.index.skipped.length > 0 ? (
                  <p className="text-[13px] text-content/50">{result.index.skipped.length} {result.index.skipped.length === 1 ? "entry was" : "entries were"} left out of this index.</p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <form onSubmit={onAdd} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-[13px] text-content/70">
            Add an index
            <select aria-label="Kind of index" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="rounded-md border border-stroke bg-transparent px-2 py-1 text-content">
              <option value="url">Web address</option>
              <option value="github">GitHub marketplace</option>
              <option value="file">A file on this computer</option>
            </select>
          </label>
          <input
            aria-label="Index address"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setDraftError(null); }}
            placeholder={kind === "file" ? "~/plugins/index.json" : kind === "github" ? "owner/repository" : "https://"}
            className="w-full rounded-md border border-stroke bg-transparent px-3 py-1.5 text-[13px] text-content outline-none placeholder:text-content/40"
          />
          {draftError ? <p data-draft-error className="text-[13px] text-content/70">{draftError}</p> : null}
          <button type="submit" className={`${PRIMARY} self-start`}>Add</button>
        </form>
      </section>
      </>
      )}
    </div>
  );
}

function Detail({ plugin, installed, note, installing, onInstall, onOpen }: {
  plugin: ListedPlugin;
  installed?: string;
  note: string | null;
  installing: boolean;
  onInstall: () => void;
  onOpen: (url: string) => void;
}) {
  const entry = plugin.entry;
  return (
    <section data-detail aria-label={entry.title} className="flex flex-col gap-3 rounded-lg px-3 py-3 ring-1 ring-surface-ring">
      <div>
        <h2 className="text-[15px] text-content">{entry.title}</h2>
        {entry.description ? <p className="mt-1 text-[13px] leading-5 text-content/70">{entry.description}</p> : null}
        {entry.status !== "available" ? <p className="mt-1 text-[13px] text-content/70" data-reason>{entry.reason ?? statusText(entry.status)}</p> : null}
      </div>
      <Field label="Licence"><span data-licence>{licenceText(entry)}</span></Field>
      <Field label="Source">
        <span data-source>{entry.source ? installSourceText(entry.source) : "No pinned source."}</span>
      </Field>
      <Field label="Adds">
        {entry.adds.length === 0 ? <span data-adds>The index doesn't say.</span> : (
          <ul data-adds className="flex flex-col gap-1">
            {entry.adds.map((add) => (
              <li key={add.kind}>
                {addsText(add)}
                {add.names.length > 0 ? `: ${add.names.join(", ")}` : ""}
              </li>
            ))}
          </ul>
        )}
      </Field>
      <Field label="Permissions">
        {entry.permissions.length === 0 ? <span data-permissions>None stated.</span> : (
          <ul data-permissions className="flex flex-col gap-1">
            {entry.permissions.map((permission) => <li key={permission}>{permission}</li>)}
          </ul>
        )}
      </Field>
      {entry.leftOut.length > 0 ? <p className="text-[13px] text-content/60">Left out: {entry.leftOut.join(", ")}.</p> : null}
      {entry.homepage ? (
        <button type="button" className={`${BTN} self-start`} onClick={() => onOpen(entry.homepage!)}>Website</button>
      ) : null}
      {installed ? <p data-installed className="text-[13px] text-content">{installed}</p> : null}
      {note ? <p data-install-error className="text-[13px] text-content/70">{note}</p> : null}
      {!installed && offersInstall(entry) ? (
        <button type="button" data-install className={`${PRIMARY} self-start`} disabled={installing} onClick={onInstall}>
          {installing ? "Installing…" : "Install"}
        </button>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-[13px] font-medium text-content">{label}</h3>
      <div className="text-[13px] leading-5 text-content/70">{children}</div>
    </div>
  );
}
