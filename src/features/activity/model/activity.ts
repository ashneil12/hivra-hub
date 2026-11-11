/** One person, the app, or an agent. Matches `activity::Who` (WP-78). */
export type Who =
  | { role: "person" }
  | { role: "app" }
  | { role: "first-mate" | "mono" | "worker"; id?: string; name?: string };

/** One stored row, as `activity_list` returns it. */
export type ActivityEntry = {
  id: string;
  seq: number;
  kind: string;
  actor: Who;
  initiator: Who;
  project: string;
  target: string;
  summary: string;
  link: string;
  at: number;
};

export type ActivityFilter = {
  project?: string;
  agent?: string;
  kind?: string;
  search?: string;
};

const KINDS: Record<string, string> = {
  "git.merge": "Merge",
  "git.push": "Push",
  "git.pr": "Pull request",
  "git.commit": "Commit",
  "plugin.install": "Plugin install",
  "plugin.update": "Plugin update",
  "plugin.rollback": "Plugin rollback",
  "plugin.remove": "Plugin removal",
  "browser.start": "Browser started",
  "browser.stop": "Browser stopped",
  "desktop.start": "Desktop started",
  "desktop.stop": "Desktop stopped",
  "ship": "Ship",
  "ship.trial": "Trial",
  "ship.rollback": "Rollback",
  "permission.grant": "Permission",
  "sandbox.refuse": "Sandbox refused",
  "protected.report": "Protected files changed",
  // WP-182: a change on a Mono's card.
  "mono.settings": "Mono settings",
  // WP-180a: the automations screen writes these. The words match the line.
  "automation.started": "Automation started",
  "automation.completed": "Automation finished",
  "automation.failed": "Automation failed",
};

/** WP-178: the kind of a first mate's report of a protected or secret place it touched (checkoutGuard.ts). */
export const ACTIVITY_PROTECTED_REPORT = "protected.report";

/** WP-180a: `activity::CHANGED`. The runs screen refetches when this fires. */
export const ACTIVITY_CHANGED = "monocode:activity-changed";

/** A blank filter means no filter. Surrounding spaces don't count. */
function filled(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  return text ? text : undefined;
}

/** ASCII only, matching SQLite's default LIKE. */
function asciiLower(text: string): string {
  let out = "";
  for (const c of text) {
    const code = c.charCodeAt(0);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : c;
  }
  return out;
}

/**
 * SQLite `column LIKE '%' || escaped || '%' ESCAPE '\'`.
 * `%`, `_` and `\` in the query are literal characters, not wildcards.
 */
function likeIncludes(haystack: string, needle: string): boolean {
  return asciiLower(haystack).includes(asciiLower(needle));
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function whoId(who: Who): string {
  return who.role === "person" || who.role === "app" ? "" : textOf(who.id);
}

function whoName(who: Who): string {
  return who.role === "person" || who.role === "app" ? "" : textOf(who.name);
}

function readWho(value: unknown): Who {
  if (!value || typeof value !== "object") return { role: "app" };
  const role = (value as { role?: unknown }).role;
  if (role === "person") return { role: "person" };
  if (role === "first-mate" || role === "mono" || role === "worker") {
    const row = value as { id?: unknown; name?: unknown };
    return { role, id: textOf(row.id), name: textOf(row.name) };
  }
  return { role: "app" };
}

function readEntry(value: unknown): ActivityEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.kind !== "string") return undefined;
  if (typeof row.summary !== "string") return undefined;
  const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : undefined;
  if (at === undefined) return undefined;
  return {
    id: row.id,
    seq: typeof row.seq === "number" && Number.isFinite(row.seq) ? row.seq : 0,
    kind: row.kind,
    actor: readWho(row.actor),
    initiator: readWho(row.initiator),
    project: textOf(row.project),
    target: textOf(row.target),
    summary: row.summary,
    link: textOf(row.link),
    at,
  };
}

export type ActivityCursor = { at: number; seq: number };

/** The page the server sent, including the cursor for the next older rows. */
export function readPage(page: unknown): { entries: ActivityEntry[]; next: ActivityCursor | null } {
  const entries = readEntries(page);
  if (!page || typeof page !== "object") return { entries, next: null };
  const next = (page as { next?: unknown }).next;
  if (!next || typeof next !== "object") return { entries, next: null };
  const at = (next as { at?: unknown }).at;
  const seq = (next as { seq?: unknown }).seq;
  if (typeof at !== "number" || !Number.isFinite(at)) return { entries, next: null };
  if (typeof seq !== "number" || !Number.isFinite(seq)) return { entries, next: null };
  return { entries, next: { at, seq } };
}

/** A missing or odd payload is an empty page, never a throw. */
export function readEntries(page: unknown): ActivityEntry[] {
  if (!page || typeof page !== "object") return [];
  const entries = (page as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: ActivityEntry[] = [];
  for (const row of entries) {
    const entry = readEntry(row);
    if (entry) out.push(entry);
  }
  return out;
}

function matchesAgent(entry: ActivityEntry, agent: string): boolean {
  if (whoId(entry.actor) === agent || whoId(entry.initiator) === agent) return true;
  return [whoName(entry.actor), whoName(entry.initiator), whoId(entry.actor), whoId(entry.initiator)].some(
    (value) => likeIncludes(value, agent),
  );
}

function matchesSearch(entry: ActivityEntry, search: string): boolean {
  return [
    entry.summary,
    entry.target,
    entry.project,
    entry.kind,
    whoName(entry.actor),
    whoName(entry.initiator),
    whoId(entry.actor),
    whoId(entry.initiator),
  ].some((value) => likeIncludes(value, search));
}

/**
 * The same rows `activity::list` would keep. A live page is already filtered
 * by the server; this is for a seeded list only.
 */
export function filterEntries(entries: readonly ActivityEntry[], filter: ActivityFilter): ActivityEntry[] {
  const project = filled(filter.project);
  const agent = filled(filter.agent);
  const kind = filled(filter.kind);
  const search = filled(filter.search);
  return entries.filter((entry) => {
    if (project !== undefined && entry.project !== project) return false;
    if (kind !== undefined && entry.kind !== kind) return false;
    if (agent !== undefined && !matchesAgent(entry, agent)) return false;
    if (search !== undefined && !matchesSearch(entry, search)) return false;
    return true;
  });
}

export function newestFirst(a: ActivityEntry, b: ActivityEntry): number {
  if (a.at !== b.at) return b.at - a.at;
  return b.seq - a.seq;
}

export function whoLabel(who: Who): string {
  if (who.role === "person") return "You";
  if (who.role === "app") return "The app";
  const name = whoName(who).trim();
  if (name) return name;
  const id = whoId(who).trim();
  if (id) return id;
  return "The app";
}

export function sameWho(a: Who, b: Who): boolean {
  return a.role === b.role && whoId(a) === whoId(b) && whoName(a) === whoName(b);
}

export function kindLabel(kind: string): string {
  return KINDS[kind] ?? kind;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A stable clock reading. Local time would move between machines. */
export function whenLabel(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.getUTCDate();
  const month = MONTHS[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hh}:${mm} UTC`;
}
