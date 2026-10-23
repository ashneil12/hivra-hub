// What harness care (harnessCare.ts, board H1/H3) can see about the app's surroundings, from what it already holds: the
// chats, the delegations, the pull request watches, the ship's state and the build's own database check. Pure — the stall
// watcher's tick reads those in and hands them here; tests hand in rows. Nothing here acts: HarnessCare decides what is
// safe to fix and what has to be told.
import type { ShipStatus } from "../../../app/model/ship";
import type { Session } from "../../sessions/model/session";
import type { PrWatch } from "../../pr-watch/model/prWatches";
import type { Delegation, DelegationTracker } from "./delegations";
import type { CareFault } from "./harnessCare";
import { resumeStopped } from "../../sessions/model/inFlight";
import { listTitle } from "../../../shared/text/plainTitle";

const MIN = 60_000;
/** A chat has to be gone this long before delegated work in it is orphaned (a session list still loading isn't a loss). */
export const ORPHAN_GRACE_MS = 10 * MIN;
/** A build may sit on trial this long before the ship is called stuck: its runner allows two minutes to commit. */
export const SHIP_TRIAL_GRACE_MS = 10 * MIN;
/** Failed reads a pull request watch may have before the watch is paused (pr_watch.rs retries by itself first). */
export const WATCH_FAILURES = 2;

/** The build's own database check (src-tauri/src/instance.rs db_health), as far as the line needs it. */
export type DatabaseHealth = {
  ok: boolean;
  /** healthcheck's exit code: 0 fine, 65 a database from a newer build, 1 a failure. */
  code?: number;
  /** healthcheck's own report: integrity, the schema it found, or what stopped it. */
  report?: Record<string, unknown>;
};

export type CareLook = {
  now: number;
  sessions: readonly Session[];
  tracker: DelegationTracker | null;
  /** The last check, or null when it hasn't run (outside the app, or an older build without the command). */
  database: DatabaseHealth | null;
  /** The watches the app holds, or null when they couldn't be read this time (a failure is not a finding). */
  watches: readonly PrWatch[] | null;
  ship: ShipStatus;
  /** When this window first saw this build on trial, for the ship's grace. */
  trialSeenAt?: number | null;
};

export function careFaults(look: CareLook): CareFault[] {
  const faults: CareFault[] = [];
  const database = databaseFault(look.database);
  if (database) faults.push(database);
  const ship = shipFault(look);
  if (ship) faults.push(ship);
  for (const watch of look.watches ?? []) {
    const fault = watchFault(watch);
    if (fault) faults.push(fault);
  }
  for (const session of look.sessions) {
    const fault = resumeFault(session);
    if (fault) faults.push(fault);
  }
  const ids = new Set(look.sessions.map((session) => session.id));
  // Rows are only ever more than the chats once the chats have loaded: an empty list is not a reason to cancel anything.
  if (look.tracker?.isLoaded() && ids.size) {
    for (const row of look.tracker.known()) {
      const fault = orphanFault(row, ids, look.now);
      if (fault) faults.push(fault);
    }
  }
  return faults;
}

function databaseFault(health: DatabaseHealth | null): CareFault | null {
  if (!health || health.ok) return null;
  const report = health.report ?? {};
  let line: string;
  if (report.refused === "newer-schema") {
    line = "The app's database was written by a newer build, so this one can't read it. Nothing was changed; use the newer build.";
  } else if (typeof report.integrity === "string" && report.integrity !== "ok") {
    line = `The app's database failed its own integrity check (${oneLine(report.integrity)}). Nothing was changed; back up this folder before more work goes in.`;
  } else {
    const code = health.code != null && health.code !== 0 ? ` (exit ${health.code})` : "";
    const error = typeof report.error === "string" ? `: ${oneLine(report.error)}` : "";
    line = `The app's database didn't pass the build's own health check${code}${error}. A copy was checked; the live file wasn't touched.`;
  }
  return { kind: "database", id: "database", line };
}

/** A build on trial that never commits: the runner restores the old build after two minutes, so this is stuck. */
function shipFault(look: CareLook): CareFault | null {
  const { ship } = look;
  if (!ship.enabled || !ship.holding || !ship.trial || ship.trial.committed) return null;
  if (look.trialSeenAt == null || look.now - look.trialSeenAt < SHIP_TRIAL_GRACE_MS) return null;
  const dir = ship.current && ship.current.id === ship.trial.id ? ship.current.shipDir : undefined;
  return {
    kind: "ship",
    id: `ship-${ship.trial.id}`,
    line: "The new build is still on trial and hasn't committed. The ship runner puts the old build back if it doesn't.",
    since: look.trialSeenAt,
    ...(dir ? { path: dir } : {}),
  };
}

function watchFault(row: PrWatch): CareFault | null {
  if (row.state !== "watching" || row.readFailures < WATCH_FAILURES || !row.lastError) return null;
  return {
    kind: "pr-watch",
    id: `pr-watch-${row.id}`,
    line: `Reading ${row.repo}#${row.number} has failed ${row.readFailures} times (${oneLine(row.lastError)}), and the watch keeps asking.`,
    fix: "pause-pr-watch",
    about: { watch: { ownerSession: row.ownerSession, id: row.id } },
    ...(row.lastReadAt != null ? { since: row.lastReadAt } : {}),
  };
}

function resumeFault(session: Session): CareFault | null {
  if (session.busy || !resumeStopped(session)) return null;
  // A usage window is a person's to resume: the same rule as any retry the app makes by itself.
  const failure = session.usageLimit
    ? {
        reason: "usage limit",
        retryable: true,
        ...(session.usageLimit.resetsAt != null ? { resetsAt: session.usageLimit.resetsAt } : {}),
      }
    : undefined;
  return {
    kind: "resume",
    id: `resume-${session.id}`,
    line: "The app stopped continuing this chat's own turn after repeated restarts.",
    fix: "continue-chat",
    about: { session: session.id },
    ...(failure ? { failure } : {}),
  };
}

function orphanFault(row: Delegation, chats: ReadonlySet<string>, now: number): CareFault | null {
  if (row.state !== "running" || row.follow || chats.has(row.childSession)) return null;
  if (now - row.updatedAt < ORPHAN_GRACE_MS) return null;
  const what = listTitle(row.title ?? "");
  return {
    kind: "orphan",
    id: `orphan-${row.id}`,
    line: `${what ? `${what}: delegated work` : "Delegated work"} is still marked running, but the chat it ran in is gone.`,
    fix: "cancel-orphan",
    about: { delegation: row.id },
  };
}

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119).trimEnd()}…` : flat;
};
