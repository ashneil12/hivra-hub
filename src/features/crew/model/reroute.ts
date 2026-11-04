import { budgetOrDefault } from "./budget";
import { isCli } from "./clis";
import { failureKind } from "./failure";
import type { Pick, Presence } from "./resolve";

export type AttemptOutcome = "rerouted" | "paused" | "resumed" | "first-mate" | "again";

/** One try, kept on the task's row. */
export type Attempt = {
  at: number;
  cli: string | null;
  model: string | null;
  effort: string | null;
  errorClass: string;
  outcome: AttemptOutcome;
  to?: string | null;
};

export type FailureInput = {
  errorClass?: string | null;
  /** Read only when the class is missing, unknown, or a generic provider error. Never stored. */
  text?: string | null;
  resetsAt?: number | null;
  now: number;
  current: Pick;
  present: readonly Presence[];
  ledger: readonly Attempt[];
  /** Untrusted. A missing budget is 2. A boolean is not a count. */
  budget?: unknown;
};

export type Decision =
  | { action: "reroute"; to: string; reason: string; attempt: Attempt }
  | { action: "pause"; until: number; reason: string; attempt: Attempt }
  | { action: "resume"; reason: string; attempt: Attempt }
  | { action: "again"; reason: string; attempt: Attempt }
  | { action: "first-mate"; reason: string; attempt: Attempt };

function spent(ledger: readonly Attempt[]): number {
  return ledger.filter((row) => row.outcome === "rerouted" || row.outcome === "again").length;
}

function usedClis(current: Pick, ledger: readonly Attempt[]): Set<string> {
  const used = new Set<string>();
  if (current.cli) used.add(current.cli);
  for (const row of ledger) {
    if (row.cli) used.add(row.cli);
  }
  return used;
}

/** The next installed, signed-in CLI that has not already failed this task, in the given order. */
export function nextCandidate(current: Pick, present: readonly Presence[], ledger: readonly Attempt[]): string | null {
  const used = usedClis(current, ledger);
  for (const row of present) {
    if (!row.installed || !row.signedIn || !isCli(row.cli) || used.has(row.cli)) continue;
    return row.cli;
  }
  return null;
}

function attempt(input: FailureInput, outcome: AttemptOutcome, to?: string): Attempt {
  return {
    at: input.now,
    cli: input.current.cli ?? null,
    model: input.current.model ?? null,
    effort: input.current.effort ?? null,
    errorClass: (input.errorClass ?? "").trim() || "unknown",
    outcome,
    to: to ?? null,
  };
}

/**
 * Account failures move to the next CLI while the budget lasts. The work itself
 * never does. A usage limit with a known reset and no other CLI waits, then
 * the same CLI resumes. A timeout is not a final failure.
 */
export function decide(input: FailureInput): Decision {
  const kind = failureKind(input.errorClass, input.text);
  const budget = budgetOrDefault(input.budget);
  const used = spent(input.ledger);
  const next = nextCandidate(input.current, input.present, input.ledger);

  if (kind === "task") {
    return {
      action: "first-mate",
      reason: "the work failed",
      attempt: attempt(input, "first-mate"),
    };
  }

  if (kind === "again") {
    if (used < budget) {
      return { action: "again", reason: "the CLI didn't answer", attempt: attempt(input, "again") };
    }
    return {
      action: "first-mate",
      reason: "the CLI didn't answer",
      attempt: attempt(input, "first-mate"),
    };
  }

  if (next && used < budget) {
    return {
      action: "reroute",
      to: next,
      reason: "the account can't take it",
      attempt: attempt(input, "rerouted", next),
    };
  }

  if (kind === "usage" && input.resetsAt != null && !next) {
    if (input.resetsAt <= input.now) {
      return {
        action: "resume",
        reason: "the usage limit has reset",
        attempt: attempt(input, "resumed"),
      };
    }
    return {
      action: "pause",
      until: input.resetsAt,
      reason: "waiting for a usage limit to reset",
      attempt: attempt(input, "paused"),
    };
  }

  if (!next) {
    return {
      action: "first-mate",
      reason: "no other worker can take it",
      attempt: attempt(input, "first-mate"),
    };
  }
  return {
    action: "first-mate",
    reason: "the retry budget is spent",
    attempt: attempt(input, "first-mate"),
  };
}
