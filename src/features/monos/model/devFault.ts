// Dev-only fault injection for scripted tests (scorecard D5). Off by default: the app never arms it. A tester arms it by
// writing `<app data>/dev-faults/fail-next-workers` by hand (docs/DEV-FAULTS.md); the Rust side checks the exact first
// line, a count of 1-5 and a 2-hour expiry. Each delegated worker started while it is armed really starts and runs, and
// its turn then ends as a failure with a plain test error, so its Lead sees a real failed worker and handles it as usual.
import { invoke } from "@tauri-apps/api/core";
import type { ControlOutcome } from "../../orchestration/model/orchestration";

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

/** The outcome a faulted worker reports: failed with the test error. A stop by its owner stays a stop. */
export function faultedOutcome(outcome: ControlOutcome, error: string | undefined): ControlOutcome {
  if (!error || outcome.status === "cancelled") return outcome;
  return { status: "failed", text: outcome.text ?? "", error };
}
