// When chats were running (busy), for the soul tamper check: a soul that changed while any agent or worker chat was
// running may have been changed by it, so it is put back. App.tsx notes every sessions update; windows are kept for a
// week, in the app's own storage.
const KEY = "monocode.sessionRuns.v1";
const KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX = 2000;

/** One run of one chat. `end` absent: still running (as of `seen`). */
export type RunWindow = { sessionId: string; cwd?: string; start: number; end?: number; seen: number };

let runs: RunWindow[] | undefined;
let persistedAt = 0;

function all(): RunWindow[] {
  if (runs) return runs;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as RunWindow[]) : [];
    // Open runs from an earlier launch ended when the app last saw them.
    runs = Array.isArray(parsed) ? parsed.map((r) => (r.end == null ? { ...r, end: r.seen } : r)) : [];
  } catch {
    runs = [];
  }
  return runs;
}

function persist(now: number): void {
  persistedAt = now;
  runs = all().filter((r) => r.end == null || now - r.end < KEEP_MS).slice(-MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(runs));
  } catch {
    /* storage full or gone: the windows still hold for this launch */
  }
}

/** Every session as it stands now: a busy one opens (or extends) its run, an idle one closes it. */
export function noteSessionRuns(sessions: readonly { id: string; busy?: boolean; cwd?: string }[], now: number = Date.now()): void {
  const list = all();
  const busy = new Map(sessions.filter((s) => s.busy).map((s) => [s.id, s]));
  let changed = false;
  for (const r of list) {
    if (r.end != null) continue;
    if (busy.has(r.sessionId)) {
      r.seen = now;
      busy.delete(r.sessionId);
    } else {
      r.end = now;
      changed = true;
    }
  }
  for (const s of busy.values()) {
    list.push({ sessionId: s.id, ...(s.cwd ? { cwd: s.cwd } : {}), start: now, seen: now });
    changed = true;
  }
  // A run still going is saved now and then, so a crash still leaves roughly when it ended.
  if (changed || (list.some((r) => r.end == null) && now - persistedAt > 30_000)) persist(now);
}

/** The chats that were running at `at` (give or take `slackMs`, for clocks and the save landing after the turn). */
export function runsAt(at: number, slackMs = 5_000, now: number = Date.now()): RunWindow[] {
  return all().filter((r) => r.start - slackMs <= at && at <= (r.end ?? now) + slackMs);
}

/** For tests. */
export function resetSessionRuns(): void {
  runs = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* none */
  }
}
