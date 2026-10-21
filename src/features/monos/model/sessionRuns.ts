// When chats were running (busy), for the soul tamper check: a soul that changed while any agent or worker chat was
// running may have been changed by it, so it is put back. Two records, joined:
// - the page's: App.tsx notes every sessions update, and a heartbeat every few seconds while a chat is busy, so a
//   reload or crash leaves the run ending within seconds of when the page last saw it (not at its start). Kept for a
//   week in the app's own storage, so it covers app restarts;
// - the app process's (src-tauri/src/harness_runs.rs): when each chat's own process was in a turn, from the message
//   the app sent it to the line that ended the turn, or the process's exit. A window reload doesn't touch the app
//   process, so a turn whose process ran on after a reload (Mac round 2, 21 Oct) is still counted while it runs.
const KEY = "monocode.sessionRuns.v1";
const KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX = 2000;
/** How often a running chat's window is saved: how far a reload or crash can cut it short. */
export const RUN_HEARTBEAT_MS = 5_000;

/** One run of one chat. `end` absent: still running (as of `seen`). `pid`: from the app process's record. */
export type RunWindow = { sessionId: string; cwd?: string; start: number; end?: number; seen: number; pid?: number };

/** One chat process as the app process saw it (`harness_runs`): when it lived, and its turns. */
export type ProcessRun = {
  sessionId: string;
  pid: number;
  cwd?: string;
  start: number;
  end?: number;
  turns: { start: number; end?: number }[];
};

let runs: RunWindow[] | undefined;
let persistedAt = 0;
let processRuns: ProcessRun[] = [];
let processSource: ((since: number) => Promise<ProcessRun[]>) | null = null;

function all(): RunWindow[] {
  if (runs) return runs;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as RunWindow[]) : [];
    // Open runs from an earlier page ended, as far as the page knows, when it last saw them (at most a heartbeat
    // ago). A process that ran on past that is in the app process's record.
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
  // A run still going is saved every heartbeat, so a reload or crash leaves roughly when it ended.
  if (changed || (list.some((r) => r.end == null) && now - persistedAt >= RUN_HEARTBEAT_MS)) persist(now);
}

/** Where the app process's record comes from (App.tsx: `harness_runs`). */
export function setProcessRunSource(source: ((since: number) => Promise<ProcessRun[]>) | null): void {
  processSource = source;
  processRuns = [];
}

/** Read the app process's record again; kept as it was if it can't be read (a headless host has none). */
export async function refreshProcessRuns(now: number = Date.now()): Promise<ProcessRun[]> {
  if (!processSource) return processRuns;
  try {
    const fresh = await processSource(Math.max(0, now - KEEP_MS));
    if (Array.isArray(fresh)) processRuns = fresh;
  } catch {
    /* unreadable now: the last copy stands */
  }
  return processRuns;
}

/** The app process's chats that are alive now, as last read. */
export function liveProcessRuns(): ProcessRun[] {
  return processRuns.filter((r) => r.end == null);
}

function processWindows(now: number): RunWindow[] {
  return processRuns.flatMap((p) =>
    p.turns.map((t) => ({
      sessionId: p.sessionId,
      ...(p.cwd ? { cwd: p.cwd } : {}),
      start: t.start,
      ...(t.end != null ? { end: t.end } : {}),
      seen: t.end ?? now,
      pid: p.pid,
    })),
  );
}

/**
 * The chats that were running at `at` (give or take `slackMs`, for clocks and the save landing after the turn), by
 * the page's record or the app process's, one entry per chat.
 */
export function runsAt(at: number, slackMs = 5_000, now: number = Date.now()): RunWindow[] {
  const hit = (r: RunWindow) => r.start - slackMs <= at && at <= (r.end ?? now) + slackMs;
  const out = new Map<string, RunWindow>();
  for (const r of [...all(), ...processWindows(now)]) if (hit(r) && !out.has(r.sessionId)) out.set(r.sessionId, r);
  return [...out.values()];
}

/** For tests: also forgets the page's in-memory copy, so the next read is what a freshly loaded page would see. */
export function reloadSessionRunsForTest(): void {
  runs = undefined;
}

/** For tests. */
export function resetSessionRuns(): void {
  runs = [];
  processRuns = [];
  processSource = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* none */
  }
}
