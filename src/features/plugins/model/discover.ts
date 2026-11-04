// Discover (WP-32). The list of index sources, and the pure reading of what `plugins_discover` returns.
// Listing never runs a plugin: this module only validates text the command already read.
// Install is WP-31's `plugins_install`, and only for an entry the readers marked available with a pinned source.

export const SOURCES_KEY = "monocode.pluginIndexSources";
/** The same cap as the Rust command (`MAX_SOURCES`). */
export const MAX_SOURCES = 20;
export const DEFAULT_SOURCES: IndexSource[] = [{ kind: "bundled" }];

export type IndexSource =
  | { kind: "bundled" }
  | { kind: "url"; url: string }
  | { kind: "github"; repo: string; ref?: string }
  | { kind: "file"; path: string };

export type InstallSource =
  | { kind: "git"; url: string; commit: string; path?: string }
  | { kind: "npm"; package: string; version: string; registry?: string }
  | { kind: "local"; path: string };

export type Status = "available" | "planned" | "not-compatible" | "listed-only" | "not-this-platform";
export type Format = "hivra" | "dsh" | "claude-marketplace";

export type Adds = { kind: string; count?: number; names: string[] };

export type Entry = {
  name: string;
  title: string;
  description: string;
  author?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  category?: string;
  keywords: string[];
  platforms: string[];
  adds: Adds[];
  leftOut: string[];
  permissions: string[];
  version?: string;
  source?: InstallSource;
  status: Status;
  reason?: string;
  format: Format;
};

export type ListedIndex = {
  title: string;
  description?: string;
  format: Format;
  entries: Entry[];
  skipped: string[];
};

export type IndexResult = {
  source: IndexSource;
  index?: ListedIndex;
  error?: string;
};

export type ListedPlugin = {
  key: string;
  indexTitle: string;
  entry: Entry;
};

export type SourceList = { revision: number; sources: IndexSource[]; dropped: number };

export type SourceStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type Commit =
  | { ok: true; revision: number; sources: IndexSource[] }
  | { ok: false; revision: number; sources: IndexSource[]; message: string };

export type DiscoverOutcome = { ok: true; results: IndexResult[] } | { ok: false; message: string };

export type Listing = {
  generation: number;
  phase: "idle" | "loading" | "ready" | "error";
  results: IndexResult[];
  error: string | null;
};

export const EMPTY_LISTING: Listing = { generation: 0, phase: "idle", results: [], error: null };

export const ADD_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "skills", label: "Skills" },
  { id: "mcpServers", label: "MCP servers" },
  { id: "panels", label: "Panels" },
  { id: "personas", label: "Personas" },
  { id: "monoTemplates", label: "Mono templates" },
  { id: "crewRules", label: "Crew rules" },
  { id: "commands", label: "Commands" },
];

const ADD_WORDS: Record<string, [string, string]> = {
  skills: ["skill", "skills"],
  mcpServers: ["MCP server", "MCP servers"],
  panels: ["panel", "panels"],
  personas: ["persona", "personas"],
  monoTemplates: ["Mono template", "Mono templates"],
  crewRules: ["crew rule", "crew rules"],
  commands: ["command", "commands"],
};

const STATUSES = new Set<Status>(["available", "planned", "not-compatible", "listed-only", "not-this-platform"]);
const FORMATS = new Set<Format>(["hivra", "dsh", "claude-marketplace"]);
const ADD_KINDS = new Set(Object.keys(ADD_WORDS));

/** A content problem with the index itself. Anything else (no answer, a missing file) can be tried again. */
const FINAL_READ = /isn't valid JSON|format Hivra doesn't know|isn't a JSON object|isn't a plugin index|has no title|has no plugins list/i;

export function retryableFailure(message: string): boolean {
  return !FINAL_READ.test(message);
}

export function loadSources(raw: string | null): SourceList {
  if (raw == null || raw.trim() === "") return { revision: 0, sources: DEFAULT_SOURCES, dropped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { revision: 0, sources: DEFAULT_SOURCES, dropped: 0 };
  }
  if (Array.isArray(parsed)) {
    const normalized = normalizeSources(parsed);
    return { revision: 0, ...normalized };
  }
  if (!parsed || typeof parsed !== "object") return { revision: 0, sources: DEFAULT_SOURCES, dropped: 0 };
  const record = parsed as { revision?: unknown; sources?: unknown };
  const revision = Number.isInteger(record.revision) && (record.revision as number) >= 0 ? (record.revision as number) : 0;
  if (!Array.isArray(record.sources)) return { revision, sources: DEFAULT_SOURCES, dropped: 0 };
  return { revision, ...normalizeSources(record.sources) };
}

export function commitSources(store: SourceStore, expectedRevision: number, sources: IndexSource[]): Commit {
  const current = loadSources(store.getItem(SOURCES_KEY));
  if (current.revision !== expectedRevision) {
    return {
      ok: false,
      revision: current.revision,
      sources: current.sources,
      message: "The index list changed in another window. Showing that list.",
    };
  }
  const next = normalizeSources(sources).sources;
  const revision = expectedRevision + 1;
  try {
    store.setItem(SOURCES_KEY, JSON.stringify({ revision, sources: next }));
  } catch {
    const again = loadSources(store.getItem(SOURCES_KEY));
    return {
      ok: false,
      revision: again.revision,
      sources: again.sources,
      message: "Couldn't save the index list on this computer.",
    };
  }
  return { ok: true, revision, sources: next };
}

export function sourceDraft(
  kind: "url" | "github" | "file",
  text: string,
): { ok: true; source: IndexSource } | { ok: false; message: string } {
  if (kind === "url") return urlDraft(text);
  if (kind === "github") return githubDraft(text);
  return fileDraft(text);
}

export function addSource(
  sources: IndexSource[],
  source: IndexSource,
): { ok: true; sources: IndexSource[] } | { ok: false; message: string } {
  const normalized = normalizeSource(source);
  if (!normalized) return { ok: false, message: "That index isn't one Hivra can read." };
  if (sources.some((item) => sameSource(item, normalized))) {
    return { ok: false, message: "That index is already in the list." };
  }
  if (sources.length >= MAX_SOURCES) return { ok: false, message: "Discover reads at most 20 indexes." };
  return { ok: true, sources: [...sources, normalized] };
}

export function removeSource(sources: IndexSource[], index: number): IndexSource[] {
  const next = sources.filter((_, position) => position !== index);
  return next.length === 0 ? DEFAULT_SOURCES : next;
}

export function startListing(listing: Listing): Listing {
  return { generation: listing.generation + 1, phase: "loading", results: listing.results, error: null };
}

export function settleListing(listing: Listing, generation: number, outcome: DiscoverOutcome): Listing {
  if (generation !== listing.generation) return listing;
  if (outcome.ok) return { generation, phase: "ready", results: outcome.results, error: null };
  return { generation, phase: "error", results: listing.results, error: outcome.message };
}

export function readDiscoverPayload(raw: unknown): DiscoverOutcome {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "Discover returned nothing. Nothing was listed." };
  }
  const results: IndexResult[] = [];
  for (const item of raw) {
    const result = sanitizeResult(item);
    if (result) results.push(result);
  }
  return { ok: true, results };
}

export function listPlugins(results: IndexResult[]): ListedPlugin[] {
  const plugins: ListedPlugin[] = [];
  results.forEach((result, index) => {
    const title = result.index?.title ?? indexSourceText(result.source);
    result.index?.entries.forEach((entry, position) => {
      plugins.push({ key: `${index}:${entry.name}:${position}`, indexTitle: title, entry });
    });
  });
  return plugins;
}

export function visiblePlugins(plugins: ListedPlugin[], query: string, filter: string): ListedPlugin[] {
  const needle = query.trim().toLowerCase();
  return plugins.filter((plugin) => {
    if (filter !== "all" && !plugin.entry.adds.some((add) => add.kind === filter)) return false;
    if (!needle) return true;
    const haystack = [
      plugin.entry.name,
      plugin.entry.title,
      plugin.entry.description,
      plugin.entry.author,
      plugin.entry.license,
      plugin.entry.category,
      ...plugin.entry.keywords,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function offersInstall(entry: Entry): boolean {
  return entry.status === "available" && entry.source != null;
}

export function installOutcome(result: unknown): { ok: boolean; message: string } {
  // WP-31's InstallResult is `{ status: "installed", entry, reports }` or `{ status: "waiting", request }`.
  // A click with no `requestedBy: { kind: "person" }` comes back waiting. Anything else is not an install.
  if (result == null) return { ok: false, message: "Install isn't in this build yet. Nothing was installed." };
  if (typeof result !== "object") return { ok: false, message: "It wasn't installed." };
  const record = result as { status?: unknown; entry?: unknown; request?: unknown };
  if (record.status === "installed") {
    const name = installedName(record.entry);
    if (!name) return { ok: false, message: "It wasn't installed." };
    return { ok: true, message: `Installed ${name}. It's off until you switch it on in Settings > Plugins.` };
  }
  if (record.status === "waiting") {
    const commands = waitingCommands(record.request);
    const message = commands.length === 0
      ? "Waiting for your OK in the Inbox"
      : `Waiting for your OK in the Inbox. ${commands.join("; ")}`;
    return { ok: true, message };
  }
  return { ok: false, message: "It wasn't installed." };
}

function installedName(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return;
  const name = (entry as { name?: unknown }).name;
  if (typeof name !== "string") return;
  const text = name.replace(/\r/g, "").trim();
  if (!text || text.includes("\0")) return;
  return text;
}

function waitingCommands(request: unknown): string[] {
  if (!request || typeof request !== "object") return [];
  const steps = (request as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const commands: string[] = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const run = (step as { run?: unknown }).run;
    if (!Array.isArray(run)) continue;
    const parts = run.filter((part): part is string => typeof part === "string" && part.trim() !== "");
    if (parts.length > 0) commands.push(parts.join(" "));
  }
  return commands;
}

export function statusText(status: Status): string {
  switch (status) {
    case "available":
      return "Available";
    case "planned":
      return "Not published yet";
    case "not-compatible":
      return "Not compatible";
    case "listed-only":
      return "Listed only";
    case "not-this-platform":
      return "Not for this computer";
  }
}

export function licenceText(entry: Entry): string {
  const license = entry.license?.trim();
  return license ? license : "The index doesn't say.";
}

export function installSourceText(source: InstallSource): string {
  if (source.kind === "git") {
    const where = source.path ? ` (${source.path})` : "";
    return `${source.url} at ${source.commit.slice(0, 7)}${where}`;
  }
  if (source.kind === "local") return source.path;
  const registry = source.registry ? ` from ${source.registry}` : "";
  return `${source.package} ${source.version}${registry}`;
}

export function indexSourceText(source: IndexSource): string {
  switch (source.kind) {
    case "bundled":
      return "Hivra's own index";
    case "url":
      return source.url;
    case "github":
      return source.ref ? `${source.repo} @ ${source.ref}` : source.repo;
    case "file":
      return source.path;
  }
}

export function addsText(adds: Adds): string {
  const [one, many] = ADD_WORDS[adds.kind] ?? [adds.kind, adds.kind];
  const count = adds.count ?? (adds.names.length > 0 ? adds.names.length : undefined);
  if (count == null) return many;
  return `${count} ${count === 1 ? one : many}`;
}

function normalizeSources(raw: unknown[]): { sources: IndexSource[]; dropped: number } {
  const sources: IndexSource[] = [];
  let dropped = 0;
  for (const item of raw) {
    const source = normalizeSource(item);
    if (!source || sources.some((kept) => sameSource(kept, source))) continue;
    if (sources.length >= MAX_SOURCES) {
      dropped += 1;
      continue;
    }
    sources.push(source);
  }
  if (sources.length === 0) return { sources: DEFAULT_SOURCES, dropped };
  return { sources, dropped };
}

function normalizeSource(value: unknown): IndexSource | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as { kind?: unknown; url?: unknown; repo?: unknown; ref?: unknown; path?: unknown };
  if (record.kind === "bundled") return { kind: "bundled" };
  if (record.kind === "url" && typeof record.url === "string") {
    const url = httpsUrl(record.url.trim());
    return url ? { kind: "url", url } : undefined;
  }
  if (record.kind === "github" && typeof record.repo === "string") {
    const drafted = githubDraft(record.ref ? `${record.repo}@${record.ref}` : record.repo);
    return drafted.ok ? drafted.source : undefined;
  }
  if (record.kind === "file" && typeof record.path === "string") {
    const drafted = fileDraft(record.path);
    return drafted.ok ? drafted.source : undefined;
  }
  return;
}

function sameSource(a: IndexSource, b: IndexSource): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function urlDraft(text: string): { ok: true; source: IndexSource } | { ok: false; message: string } {
  const value = text.replace(/\r/g, "").trim();
  if (!value) return { ok: false, message: "Type the https address of the index." };
  try {
    const url = new URL(value);
    if (url.username || url.password) return { ok: false, message: "An index address can't contain a password." };
  } catch {
    return { ok: false, message: "An index address has to be https." };
  }
  const url = httpsUrl(value);
  if (!url) return { ok: false, message: "An index address has to be https." };
  return { ok: true, source: { kind: "url", url } };
}

function githubDraft(text: string): { ok: true; source: IndexSource } | { ok: false; message: string } {
  let value = text.replace(/\r/g, "").trim().replace(/^https:\/\/github\.com\//i, "");
  value = value.replace(/\.git(?=@|$)/i, "").replace(/\/$/, "");
  const at = value.indexOf("@");
  const repo = at === -1 ? value : value.slice(0, at);
  const ref = at === -1 ? undefined : value.slice(at + 1);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, message: "A GitHub index is written owner/repository." };
  if (ref !== undefined && !/^[\w./-]+$/.test(ref)) {
    return { ok: false, message: "That branch or tag name isn't one GitHub allows." };
  }
  return { ok: true, source: ref ? { kind: "github", repo, ref } : { kind: "github", repo } };
}

function fileDraft(text: string): { ok: true; source: IndexSource } | { ok: false; message: string } {
  // A trailing newline is just a paste. A newline in the middle is two paths, and not one file.
  if (text.replace(/\r/g, "").trim().includes("\n")) return { ok: false, message: "A file path can't be more than one line." };
  const path = text.replace(/\r/g, "").trim();
  if (!path || path.includes("\0")) return { ok: false, message: "Type the path of the index file." };
  return { ok: true, source: { kind: "file", path } };
}

function httpsUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.host) return;
  return url.toString();
}

function gitUrl(value: string): string | undefined {
  const href = httpsUrl(value);
  if (!href) return;
  const url = new URL(href);
  if (url.search || url.hash) return;
  const segments = url.pathname.split("/").filter(Boolean);
  const path = url.pathname.toLowerCase();
  if (segments.length < 2 || path.endsWith(".tgz") || path.endsWith(".tar.gz")) return;
  return href.replace(/\/$/, "");
}

function repoPath(value: string): string | undefined {
  const trimmed = value.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (!trimmed || trimmed.includes("\\")) return;
  const ok = trimmed.split("/").every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes("\0"));
  return ok ? trimmed : undefined;
}

function exactVersion(value: string): boolean {
  const [core, build] = value.split("+").length > 2 ? ["", ""] : splitOnce(value, "+");
  if (value.split("+").length > 2) return false;
  if (build != null && !/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(build)) return false;
  const [release, pre] = splitOnce(core, "-");
  const parts = release.split(".");
  const numeric = (part: string) => /^\d+$/.test(part) && (part === "0" || !part.startsWith("0"));
  if (parts.length !== 3 || !parts.every(numeric)) return false;
  if (pre == null) return true;
  return pre.split(".").every((part) => part !== "" && /^[0-9A-Za-z-]+$/.test(part) && (!/^\d+$/.test(part) || numeric(part)));
}

function splitOnce(value: string, mark: string): [string, string | undefined] {
  const at = value.indexOf(mark);
  return at === -1 ? [value, undefined] : [value.slice(0, at), value.slice(at + mark.length)];
}

function npmOk(name: string): boolean {
  if (name.length === 0 || name.length > 214) return false;
  const body = name.startsWith("@") ? name.slice(1) : name;
  const parts = name.startsWith("@") ? body.split("/") : [body];
  if (name.startsWith("@") && parts.length !== 2) return false;
  return parts.every((part) => /^[a-z0-9]/.test(part) && /^[a-z0-9._~-]+$/.test(part));
}

function sanitizeResult(value: unknown): IndexResult | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as { source?: unknown; index?: unknown; error?: unknown };
  const source = normalizeSource(record.source);
  if (!source) return;
  const error = typeof record.error === "string" && record.error.trim() ? record.error.trim() : undefined;
  const index = sanitizeIndex(record.index);
  if (!index && !error) return { source, error: "This index didn't list anything. Nothing was listed." };
  return index ? { source, index, ...(error ? { error } : {}) } : { source, error };
}

function sanitizeIndex(value: unknown): ListedIndex | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as { title?: unknown; description?: unknown; format?: unknown; entries?: unknown; skipped?: unknown };
  if (typeof record.format !== "string" || !FORMATS.has(record.format as Format)) return;
  const format = record.format as Format;
  const title = cleanText(record.title) || "Untitled";
  const entries = Array.isArray(record.entries)
    ? record.entries.flatMap((item) => {
        const entry = sanitizeEntry(item, format);
        return entry ? [entry] : [];
      })
    : [];
  return {
    title,
    description: cleanText(record.description),
    format,
    entries,
    skipped: stringList(record.skipped),
  };
}

function sanitizeEntry(value: unknown, format: Format): Entry | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const name = cleanText(record.name);
  if (!name || name.length > 214 || /[\0-\x1f]/.test(name)) return;
  const rawStatus = typeof record.status === "string" ? record.status : "";
  let status: Status = STATUSES.has(rawStatus as Status) ? (rawStatus as Status) : "not-compatible";
  let reason = cleanText(record.reason);
  let source = installSource(record.source);
  if (!STATUSES.has(rawStatus as Status)) {
    status = "not-compatible";
    reason = "Hivra doesn't know this entry's status, so it isn't offered for install.";
    source = undefined;
  } else if (status === "available" && !source) {
    status = "listed-only";
    reason = "Its install source isn't pinned, so it can't be installed.";
  }
  return {
    name,
    title: cleanText(record.title) || name,
    description: cleanText(record.description) ?? "",
    author: cleanText(record.author),
    license: cleanText(record.license),
    homepage: typeof record.homepage === "string" ? httpsUrl(record.homepage) ?? webUrl(record.homepage) : undefined,
    repository: typeof record.repository === "string" ? webUrl(record.repository) : undefined,
    category: cleanText(record.category),
    keywords: stringList(record.keywords),
    platforms: stringList(record.platforms),
    adds: sanitizeAdds(record.adds),
    leftOut: stringList(record.leftOut),
    permissions: stringList(record.permissions),
    version: cleanText(record.version),
    source,
    status,
    reason,
    format,
  };
}

function sanitizeAdds(value: unknown): Adds[] {
  if (!Array.isArray(value)) return [];
  const adds: Adds[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { kind?: unknown; count?: unknown; names?: unknown };
    if (typeof record.kind !== "string" || !ADD_KINDS.has(record.kind)) continue;
    const names = stringList(record.names);
    const count = typeof record.count === "number" && Number.isInteger(record.count) && record.count >= 0 ? record.count : undefined;
    if ((count ?? names.length) === 0) continue;
    adds.push({ kind: record.kind, ...(count != null ? { count } : {}), names });
  }
  return adds;
}

/** An absolute folder with no `..` segment. A relative path, or one that leaves its root, is dropped. */
function localInstallPath(value: string): string | undefined {
  if (value.includes("\0")) return;
  const path = value.trim();
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
  if (!absolute) return;
  if (path.split(/[\\/]/).includes("..")) return;
  return path;
}

function installSource(value: unknown): InstallSource | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as { kind?: unknown; url?: unknown; commit?: unknown; path?: unknown; package?: unknown; version?: unknown; registry?: unknown };
  if (record.kind === "local") {
    if (typeof record.path !== "string") return;
    const path = localInstallPath(record.path);
    if (!path) return;
    return { kind: "local", path };
  }
  if (record.kind === "git") {
    if (typeof record.url !== "string" || typeof record.commit !== "string") return;
    const url = gitUrl(record.url);
    if (!url || !/^[0-9a-fA-F]{40}$/.test(record.commit)) return;
    if (record.path != null) {
      if (typeof record.path !== "string") return;
      const path = repoPath(record.path);
      if (!path) return;
      return { kind: "git", url, commit: record.commit.toLowerCase(), path };
    }
    return { kind: "git", url, commit: record.commit.toLowerCase() };
  }
  if (record.kind === "npm") {
    if (typeof record.package !== "string" || typeof record.version !== "string") return;
    if (!npmOk(record.package) || !exactVersion(record.version)) return;
    if (record.registry != null) {
      if (typeof record.registry !== "string") return;
      const registry = httpsUrl(record.registry);
      if (!registry) return;
      return { kind: "npm", package: record.package, version: record.version, registry };
    }
    return { kind: "npm", package: record.package, version: record.version };
  }
  return;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.replace(/\r/g, "").trim();
  return text && !text.includes("\0") ? text : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = cleanText(item);
    return text ? [text] : [];
  });
}

function webUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.host) return;
  return url.toString();
}
