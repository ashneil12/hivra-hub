import { budgetOrDefault } from "./budget";
import { cliLabel, isCli } from "./clis";
import { failureKind } from "./failure";
import { sanitizePolicy, type CrewPolicy } from "./policy";
import type { Pick, Presence } from "./resolve";

export type AttemptOutcome = "rerouted" | "paused" | "resumed" | "first-mate" | "again" | "skipped";

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
  /** Untrusted. A missing policy keeps today's presence order and today's reasons. */
  policy?: unknown;
};

export type Decision = { skipped: Attempt[] } & (
  | { action: "reroute"; to: string; reason: string; attempt: Attempt }
  | { action: "pause"; until: number; reason: string; attempt: Attempt }
  | { action: "resume"; reason: string; attempt: Attempt }
  | { action: "again"; reason: string; attempt: Attempt }
  | { action: "first-mate"; reason: string; attempt: Attempt }
);

const LOCK_REASON = "Always use my default is on, so another CLI was not used.";

function spent(ledger: readonly Attempt[]): number {
  return ledger.filter((row) => row.outcome === "rerouted" || row.outcome === "again").length;
}

function tried(ledger: readonly Attempt[], id: string): boolean {
  // A skip is not an attempt (as in crew/reroute.rs): signing in, or taking a ban off, offers that CLI again.
  return ledger.some((row) => row.outcome !== "skipped" && row.cli === id);
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

function skipAttempt(input: FailureInput, cli: string, reason: string): Attempt {
  return { at: input.now, cli, model: null, effort: null, errorClass: reason, outcome: "skipped", to: null };
}

function sentence(reason: string): string {
  if (!reason) return reason;
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

function note(skipped: readonly Attempt[], reason: string): string {
  const line = sentence(reason);
  if (skipped.length === 0) return line;
  return `${skipped.map((row) => row.errorClass).join(" ")} ${line}`;
}

function switchReason(from: string | null | undefined, to: string): string {
  const who = from && isCli(from) ? cliLabel(from) : "This CLI";
  return `${who} can't take it, so this uses ${cliLabel(to)}.`;
}

type Choice = { cli: string | null; skipped: Attempt[] };

function consider(input: FailureInput, policy: CrewPolicy, id: string, listed: boolean, skipped: Attempt[]): boolean {
  if (!isCli(id) || tried(input.ledger, id)) return false;
  if (policy.neverUse.includes(id)) {
    skipped.push(skipAttempt(input, id, `${cliLabel(id)} is on Never use, so it was skipped.`));
    return false;
  }
  if (input.current.cli === id) return false;
  const row = input.present.find((item) => item.cli === id);
  if (!listed) return !!(row?.installed && row.signedIn);
  if (!row?.installed) {
    skipped.push(skipAttempt(input, id, `${cliLabel(id)} isn't installed here, so it was skipped.`));
    return false;
  }
  if (!row.signedIn) {
    skipped.push(skipAttempt(input, id, `${cliLabel(id)} isn't signed in, so it was skipped.`));
    return false;
  }
  return true;
}

/**
 * The next CLI. A saved fallback list is walked instead of presence order.
 * An empty list keeps today's order. Banned and unsigned entries on the list are skipped, with the reason.
 */
export function nextCandidate(input: FailureInput, policy: CrewPolicy): Choice {
  const skipped: Attempt[] = [];
  const listed = policy.fallback.length > 0;
  const order = listed ? policy.fallback : input.present.map((row) => row.cli);
  for (const id of order) {
    if (!consider(input, policy, id, listed, skipped)) continue;
    return { cli: id, skipped };
  }
  return { cli: null, skipped };
}

/**
 * Account failures move to the next CLI while the budget lasts. The work itself
 * never does. A usage limit with a known reset and no other CLI waits, then
 * the same CLI resumes. A timeout is not a final failure.
 * Always use my default does not invent another CLI.
 */
export function decide(input: FailureInput): Decision {
  const kind = failureKind(input.errorClass, input.text);
  const budget = budgetOrDefault(input.budget);
  const used = spent(input.ledger);
  const policy = sanitizePolicy(input.policy);
  const choice = nextCandidate(input, policy);
  const named = policy.fallback.length > 0 || choice.skipped.length > 0;
  const locked = policy.lockDefault && choice.cli != null;
  const next = locked ? null : choice.cli;

  if (kind === "task") {
    return { action: "first-mate", reason: "the work failed", attempt: attempt(input, "first-mate"), skipped: [] };
  }

  if (kind === "again") {
    if (used < budget) {
      return { action: "again", reason: "the CLI didn't answer", attempt: attempt(input, "again"), skipped: [] };
    }
    return { action: "first-mate", reason: "the CLI didn't answer", attempt: attempt(input, "first-mate"), skipped: [] };
  }

  if (locked) {
    if (kind === "usage" && input.resetsAt != null && input.resetsAt <= input.now) {
      return { action: "resume", reason: note([], "the usage limit has reset"), attempt: attempt(input, "resumed"), skipped: [] };
    }
    const reason = note(choice.skipped, LOCK_REASON);
    if (input.resetsAt != null && input.resetsAt > input.now) {
      return {
        action: "pause",
        until: input.resetsAt,
        reason,
        attempt: attempt(input, "paused"),
        skipped: choice.skipped,
      };
    }
    return { action: "first-mate", reason, attempt: attempt(input, "first-mate"), skipped: choice.skipped };
  }

  if (next && used < budget) {
    const reason = named ? note(choice.skipped, switchReason(input.current.cli, next)) : "the account can't take it";
    return { action: "reroute", to: next, reason, attempt: attempt(input, "rerouted", next), skipped: choice.skipped };
  }

  if (kind === "usage" && input.resetsAt != null && !next) {
    if (input.resetsAt <= input.now) {
      return {
        action: "resume",
        reason: note(choice.skipped, "the usage limit has reset"),
        attempt: attempt(input, "resumed"),
        skipped: choice.skipped,
      };
    }
    return {
      action: "pause",
      until: input.resetsAt,
      reason: note(choice.skipped, "waiting for a usage limit to reset"),
      attempt: attempt(input, "paused"),
      skipped: choice.skipped,
    };
  }

  if (!next) {
    return {
      action: "first-mate",
      reason: note(choice.skipped, "no other worker can take it"),
      attempt: attempt(input, "first-mate"),
      skipped: choice.skipped,
    };
  }
  return {
    action: "first-mate",
    reason: note(choice.skipped, "the retry budget is spent"),
    attempt: attempt(input, "first-mate"),
    skipped: choice.skipped,
  };
}
