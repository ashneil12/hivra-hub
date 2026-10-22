// Dev-only fault injection for scripted tests (scorecard D5). Off by default: the app never arms it. A tester arms it by
// writing `<app data>/dev-faults/fail-next-workers` by hand (docs/DEV-FAULTS.md); the Rust side checks the exact first
// line, a count of 1-5 and a 2-hour expiry. Each delegated worker started while it is armed really starts and runs, and
// its turn then ends as a failure with a plain error ("Stopped with an error.", never a test marker) and no report, so its Lead sees a real failed worker and
// handles it as usual (retry, or Needs you).
import { invoke } from "@tauri-apps/api/core";
import type { ControlOutcome } from "../../orchestration/model/orchestration";

/** The only words a faulted worker's failure ever shows, on screen and to its Lead: a plain real-looking failure. */
export const FAULT_ERROR = "Stopped with an error.";

const TEST_MARKER = /\btest fault\b|dev-faults|on purpose for a test|set to fail on purpose/i;

/**
 * A stored failure as Ash or a Lead may read it: an older build's test-fault text ("Test fault: this worker was set to
 * fail on purpose for a test (dev-faults/…)") reads FAULT_ERROR, so a blind test is never given away. Else unchanged.
 */
export function withoutTestMarker<T extends string | null | undefined>(text: T): T | string {
  return typeof text === "string" && TEST_MARKER.test(text) ? FAULT_ERROR : text;
}

/** Asked once per delegated worker as it starts. The error text when this worker is to fail, else undefined. */
export async function takeWorkerFault(ask: () => Promise<string | null | undefined> = () =>
  invoke<string | null>("dev_fault_take_worker_failure")): Promise<string | undefined> {
  try {
    const got = await ask();
    return typeof got === "string" && got.trim() ? got : undefined;
  } catch {
    return undefined; // no command (browser dev), no file: the normal case
  }
}

/**
 * The outcome a faulted worker reports: failed with the plain FAULT_ERROR (whatever the Rust side said) and NO report. Its work never reaches its Lead (PM's
 * blind D5 run, 22 Oct: the worker was marked failed but its whole report still went to Hivra lead, which told Ash it
 * was done), so the Lead sees only a failed worker and retries or escalates as for a real one. A stop stays a stop.
 */
export function faultedOutcome(outcome: ControlOutcome, error: string | undefined): ControlOutcome {
  if (!error || outcome.status === "cancelled") return outcome;
  return { status: "failed", text: "", error: FAULT_ERROR };
}

/** What the completion reads as the worker's reply: nothing for a faulted worker (its transcript is not its report). */
export function faultedReply(outcome: ControlOutcome, error: string | undefined): { reply?: string } {
  return error && outcome.status !== "cancelled" ? { reply: "" } : {};
}
