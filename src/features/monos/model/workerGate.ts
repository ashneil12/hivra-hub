// r82: the routes check, run by the app (gates.rs) when a delegated worker reports done, instead of by the bench. Its
// words go back to the worker; a worker that still fails it after two tries reaches its Lead as failed, with them.
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../../sessions/model/session";
import { gateLog } from "../../hub/model/waitingChats";
import { ashAnsweredOnProject, ashAnsweredWorkerSince } from "./ashAnswersWorker";
import { waitsOnAshCall, type MonoSessionCompletionResult } from "./monoSessionCompletion";

export type GateRun = { name: string; ok: boolean; output: string };
export type GateRunner = (input: { projectId: string; checkout: string; signedOff: boolean }) => Promise<GateRun | null>;

/** WP-91: the word a finished turn's check leaves on its task. `null` means the project has no check configured, so
 * nothing ran; a check that exists but could not run is `notRun`, never a pass. */
export type GateWord = "passed" | "failed" | "notRun";

/**
 * WP-91: WP-40's own word for a task, from the check on its own copy. A runner that throws could not run its check;
 * that is `notRun` rather than no gate, so the run's verdict names the task instead of reading silence as a pass.
 */
export async function workerGateWord(
  run: GateRunner,
  input: { projectId: string; checkout: string; signedOff: boolean },
): Promise<GateWord | null> {
  try {
    const answer = await run(input);
    return answer ? (answer.ok ? "passed" : "failed") : null;
  } catch {
    return "notRun";
  }
}

/** How many failed runs a worker gets before its Lead hears it failed. The routes check's cap, and the cap for a brief's
 * gates when a record carries no decision of its own (see `ROUNDS_BEFORE_RETHINK`). */
export const GATE_TRIES = 2;

/**
 * SC-5: how many failed rounds one task has before the raw findings stop going back to the worker and one stronger-model
 * step rewrites its brief or hands it up. The number is Rust's (firstmate/rounds.rs `FAILED_BEFORE_RETHINK`), which keeps
 * the task's ledger of rounds on its gate records and tells the webview what to do (`briefGateAction` reads `next`); this
 * copy is for a test that fails when the two drift apart. After that rethink, the next failure goes to the person as one
 * decision in Needs you, never straight back to the worker.
 */
export const ROUNDS_BEFORE_RETHINK = 2;

export type GateVerdict = "deliver" | "resend" | "deliver-failed";

/** What happens to a finished worker's report after its check ran (`failures`: failed runs so far, this one included). */
export function gateVerdict(run: GateRun | null, failures: number): GateVerdict {
  if (!run || run.ok) return "deliver";
  return failures < GATE_TRIES ? "resend" : "deliver-failed";
}

/**
 * A report the check runs on: a delegated worker's finished one with its self-review. A worker that stopped on a choice
 * only Ash can make goes to its Lead as it is: the check would only say again what it is waiting on.
 */
export function gateDue(result: MonoSessionCompletionResult): boolean {
  if (result.status !== "completed" || !result.reviewRequired || result.reviewProblem) return false;
  return !(waitsOnAshCall(result.result) || (!!result.review && waitsOnAshCall(result.review.unsure)));
}

/** The words the worker gets back, as a MonoCode note, not as Ash. */
export function gateAsk(run: GateRun): string {
  return `[MonoCode check] ${run.name} failed on your copy. It runs from outside your copy, so it can't be edited to pass; fix the work, or stop and ask your Lead if it needs a decision that isn't yours. Then report done again, ending with your self-review as before.\n\n${run.output || "(it said nothing)"}`;
}

export function gateAskNote(run: GateRun): { kind: "message"; from: string; line: string } {
  return { kind: "message", from: "MonoCode", line: `${run.name} failed; its words went back to the worker` };
}

/** The report its Lead gets when the check still fails after the worker's tries. */
export function gateFailedResult(result: MonoSessionCompletionResult, run: GateRun): MonoSessionCompletionResult {
  const said = run.output || "it said nothing";
  return { ...result, status: "failed", error: `${run.name} still failed after ${GATE_TRIES} tries: ${said}` };
}

/** Ash signs the check's items off by answering: an answer of his in the Lead's chat since the worker started. */
export function signedOffSince(ownerSession: string, since: number, log = gateLog()): boolean {
  return log.some((r) => r.sessionId === ownerSession && !!r.answer && r.answer.at >= since);
}

/** How far back a job of the same Lead and project still counts as the same piece of work for Ash's sign-off. */
export const SIGN_OFF_REACH_MS = 2 * 60 * 60 * 1000;

/**
 * Where Ash's sign-off counts from (s14 r87 #1): the earliest job the same Lead started on the same project within
 * reach, not only this worker's start. Ash answered the first job's question; the Lead then started a second job for
 * the 30-day version, and its check never counted that answer, so it failed after two tries.
 */
export function signOffFrom(
  workerStarted: number,
  owner: string,
  project: string | null | undefined,
  rows: readonly { ownerSession: string; project: string | null; createdAt: number }[],
): number {
  if (!project) return workerStarted;
  return rows.reduce(
    (from, r) =>
      r.ownerSession === owner && r.project === project && r.createdAt >= workerStarted - SIGN_OFF_REACH_MS && r.createdAt < from
        ? r.createdAt
        : from,
    workerStarted,
  );
}

/**
 * Whether Ash has signed the check's items off for this worker: an answer of his in the Lead's chat (a card or Today),
 * or (r88, Ash) his words typed straight into the chat of one of this Lead's jobs on the project, since `signOffFrom`.
 */
export function signedOffFor(
  workerStarted: number,
  owner: string,
  project: string | null | undefined,
  rows: readonly { id: string; ownerSession: string; project: string | null; createdAt: number }[],
  log = gateLog(),
): boolean {
  const from = signOffFrom(workerStarted, owner, project, rows);
  if (signedOffSince(owner, from, log)) return true;
  // r89: his answer to an earlier job whose row the window already let go still counts, within reach.
  if (project && ashAnsweredOnProject(owner, project, Math.min(from, workerStarted - SIGN_OFF_REACH_MS))) return true;
  const jobs = rows.filter((r) => r.ownerSession === owner && (!project || r.project === project) && r.createdAt >= from);
  return ashAnsweredWorkerSince(
    jobs.map((r) => r.id),
    from,
  );
}

/**
 * The worker's own copy: an isolated worker keeps the project as its `cwd` and its checkout in `worktreeCwd` (s14 r82 #2:
 * the check was handed the project folder, refused it, and never ran).
 */
export function gateCheckout(session: Pick<Session, "cwd" | "worktreeCwd"> | undefined): string | undefined {
  return session?.worktreeCwd || session?.cwd || undefined;
}

export const runWorkerGate: GateRunner = async ({ projectId, checkout, signedOff }) => {
  try {
    return await invoke<GateRun | null>("run_worker_gate", { projectId, checkout, signedOff });
  } catch (error) {
    // A check that can't run (bad settings, not a worker's copy) never blocks the report: it says so.
    console.warn("worker check couldn't run", error);
    return null;
  }
};

/**
 * The same check, for a WP-91 task, where "there is no check" and "the check couldn't run" must not look alike: only
 * a project with no check returns `null`; a failure to run it is thrown, so the task records `notRun`.
 */
export const runTaskGate: GateRunner = async ({ projectId, checkout, signedOff }) =>
  invoke<GateRun | null>("run_worker_gate", { projectId, checkout, signedOff });
