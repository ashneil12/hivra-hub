// Harness care (board H1/H3; Ash, 14 Oct: "the harness looks after itself... errors it can see get fixed without Ash
// asking"). Self-repair (selfRepair.ts) looks after a delegated worker and harnessRepair.ts after a chat's own failed
// turn; this is the rest of the app's surroundings, looked after on the same half-minute tick. Five things the app can
// see about itself:
//
// - its database doesn't pass the build's own health check (src-tauri/src/instance.rs healthcheck: a copy is migrated
//   and checked, the live file only read). Nothing is safe to do but stop and tell Ash;
// - a shipped build's trial never committed: the ship is stuck between the runner and the new build. Nothing here can
//   move it; the app reads where the log is and tells Ash;
// - a pull request watch whose reads keep failing: paused (removed with reason "stopped"), which stops the polling, so
//   the same refused read isn't paid for every few minutes. Watching it again is Ash's call;
// - a chat whose turn the app stopped resuming after three restarts (inFlight.ts resumeStopped): continued once, on the
//   same terms as any retry (harnessRepair.ts autoRepairable: never a sign-in, billing or usage refusal, never a
//   question, never something Ash stopped), then left alone;
// - a delegation still marked running whose chat is gone: cancelled, since no turn can ever finish it.
//
// A fix that is safe and one-way (pausing a watch, cancelling work whose chat is gone, continuing a chat) waits its
// backoff (a minute, five, fifteen) and is tried up to that many times; every fix that goes through leaves a Bot
// changes row (botChanges.ts) saying what it did and why. What it cannot fix is told once, and only once: a Needs-you
// row for the app, or a quiet note in the chat it concerns. It runs no model and spawns nothing.
import type { QueuedMessage } from "../../sessions/model/session";
import type { HarnessFault } from "./harnessRepair";
import { autoRepairable } from "./harnessRepair";
import { forUser } from "../../hub/model/userName";

const MIN = 60_000;
/** The wait before each try, from when it went wrong; its length is the number of tries. */
export const CARE_BACKOFF_MS: readonly number[] = [MIN, 5 * MIN, 15 * MIN];
/** A fault that has been away this long starts over with fresh tries if it comes back. */
export const CARE_RESET_MS = 30 * MIN;

/** The one quiet line a chat gets when the app can't pick its stopped turn up by itself: a usage window, or a refused try. */
export function resumeStoppedNote(sessionId: string, at: number): QueuedMessage {
  const line =
    "This chat stopped continuing itself after repeated restarts, and the app couldn't pick its turn up by itself. Look at what it had running and carry on, or say in one line what you need.";
  return {
    id: `care-resume-${sessionId}-${Math.floor(at / MIN)}`,
    attachments: [],
    monoNote: { kind: "message", from: "Self-repair", line: line.length > 160 ? `${line.slice(0, 159)}…` : line },
    text: forUser`[MonoCode self-repair] ${line} (this is the app, not Ash.)`,
  };
}

export type CareKind = "database" | "ship" | "pr-watch" | "resume" | "orphan";

/** The fixes the app may carry out by itself: each is one-way, and none of them touches Ash's files or words. */
export type CareFix = "pause-pr-watch" | "continue-chat" | "cancel-orphan";

/** What each fix does, as the Bot changes row's own line. */
export const SAFE_FIXES: Record<CareFix, string> = {
  "pause-pr-watch": "Paused a pull request watch whose reads kept failing, so it stops polling until it is watched again",
  "continue-chat": "Continued a chat the app had stopped resuming after its restarts, once",
  "cancel-orphan": "Stopped delegated work whose chat is gone, so nothing waits on it",
};

/** One fault the app can see about itself. */
export type CareFault = {
  kind: CareKind;
  /** The same fault keeps the same id on every look; a different fault in the same place gets a new one. */
  id: string;
  /** What the app saw, in one plain line. The Needs-you row, the chat's note and the Bot changes row all read it. */
  line: string;
  /** The safe fix care may try. None means there is nothing safe to do but tell Ash. */
  fix?: CareFix;
  /** For a fix that tries a turn again: the failure's own facts (harnessRepair.ts autoRepairable). */
  failure?: Pick<HarnessFault, "reason" | "retryable" | "resetsAt" | "errorClass">;
  /** Where the app keeps this fault's detail (a ship folder), for the Needs-you row's "Show the log". */
  path?: string;
  /** What its fix acts on: the chat to continue, the watch to pause, the delegation row to cancel. */
  about?: { session?: string; watch?: { ownerSession: string; id: string }; delegation?: string };
  /** When it went wrong, for its first wait. Defaults to the first look that saw it. */
  since?: number;
};

export type CareHost = {
  now?(): number;
  /** Try the fault's safe fix. True when it was carried out; false when it couldn't be right now. */
  fix(fault: CareFault): Promise<boolean> | boolean;
  /** A fix went through: a Bot changes row that says what it did and why. */
  fixed(fault: CareFault): void;
  /** Nothing safe is left to try: a Needs-you row for the app, or a quiet note in the chat it concerns. */
  tell(fault: CareFault): void;
  /** A fault it had told about is gone: its Needs-you row comes off. */
  clear?(fault: Pick<CareFault, "id">): void;
  backoffMs?: readonly number[];
};

type Issue = { kind: CareKind; line: string; path?: string; tries: number; nextAt: number; told: boolean; done: boolean; okSince?: number };

/** Whether care may carry out this fault's fix by itself, or has to leave it to Ash. */
export function mayFix(fault: Pick<CareFault, "fix" | "failure">): boolean {
  if (!fault.fix) return false;
  // Continuing a chat is a retry, so it follows the same list as every other retry the app makes by itself.
  if (fault.fix === "continue-chat") return !fault.failure || autoRepairable(fault.failure);
  return true;
}

/**
 * One per main window, on the stall watcher's half-minute look. `tick` takes what the app can see about itself now; it
 * acts on what is due and forgets what has been gone for half an hour.
 */
export class HarnessCare {
  private issues = new Map<string, Issue>();
  private running = false;

  constructor(private host: CareHost) {}

  private now() {
    return (this.host.now ?? Date.now)();
  }

  /** Tests: what it holds for a fault. */
  state(id: string): Readonly<Issue> | undefined {
    return this.issues.get(id);
  }

  async tick(faults: readonly CareFault[]): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      const backoff = this.host.backoffMs ?? CARE_BACKOFF_MS;
      const seen = new Set(faults.map((fault) => fault.id));
      for (const [id, issue] of [...this.issues]) {
        if (seen.has(id)) continue;
        if (issue.told) this.host.clear?.({ id });
        // Gone: after half an hour of it, the same fault coming back starts over.
        issue.okSince ??= now;
        if (now - issue.okSince >= CARE_RESET_MS) this.issues.delete(id);
      }
      for (const fault of faults) {
        try {
          await this.look(fault, now, backoff);
        } catch (error) {
          // One fault it couldn't read or act on never stops the others or the look itself.
          console.error("Harness care could not look at a fault", error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async look(fault: CareFault, now: number, backoff: readonly number[]) {
    let issue = this.issues.get(fault.id);
    if (!issue) {
      issue = {
        kind: fault.kind,
        line: fault.line,
        ...(fault.path ? { path: fault.path } : {}),
        tries: 0,
        nextAt: (fault.since ?? now) + (backoff[0] ?? 0),
        told: false,
        done: false,
      };
      this.issues.set(fault.id, issue);
    }
    issue.kind = fault.kind;
    issue.line = fault.line;
    if (fault.path) issue.path = fault.path;
    delete issue.okSince;
    // A fix that went through, or a fault already handed to Ash: left alone while it stands.
    if (issue.done || issue.told) return;
    if (!mayFix(fault)) {
      // Nothing safe to try, or a retry it may never make: stop and tell, once.
      issue.told = true;
      this.host.tell(fault);
      return;
    }
    if (now < issue.nextAt) return;
    if (issue.tries >= backoff.length) {
      // Its safe tries ran out and the fault is still there: Ash's now.
      issue.told = true;
      this.host.tell(fault);
      return;
    }
    const ok = await Promise.resolve()
      .then(() => this.host.fix(fault))
      .catch(() => false);
    issue.tries += 1;
    issue.nextAt = now + (backoff[issue.tries] ?? backoff[backoff.length - 1]);
    if (ok) {
      issue.done = true;
      this.host.fixed(fault);
    }
  }
}
