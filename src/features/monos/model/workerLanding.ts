// r84 (c02 r83: four of five finished workers' changes stayed in their own copies; the Lead, which may only read a
// worker's checkout, re-did one by hand and called the rest "not fixed"): the app puts a finished worker's changes into
// the project itself (land.rs), and tells its Lead what happened in the report, first, so a summary can't drop it.
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../../sessions/model/session";
import { waitsOnAshCall, type MonoSessionCompletionResult } from "./monoSessionCompletion";

export type Landing = { outcome: "landed" | "already" | "nothing" | "conflict"; files: string[]; why: string };
export type Lander = (input: { checkout: string; project: string }) => Promise<Landing | null>;

/**
 * A report whose work lands: a finished worker in its own copy, not stopped on a choice that is Ash's (s14: that work
 * waits for his answer) and not failed.
 */
/** A report that stopped to ask (a "Needs Ash:" line, a pick put to him, or "Stopped."): its work isn't finished. */
const STOPPED_TO_ASK = /^\s*Stopped\b|\bNeeds (?:Ash|the user)\s*:|^\s*My pick\s*:/im;

/** r84 (s14): the worker stopped on a choice that is Ash's; its decided work isn't built yet. */
export function stoppedForAsh(result: MonoSessionCompletionResult): boolean {
  return result.status === "completed" && (STOPPED_TO_ASK.test(result.result) || waitsOnAshCall(result.result) || (!!result.review && waitsOnAshCall(result.review.unsure)));
}

export function landingDue(result: MonoSessionCompletionResult, session: Pick<Session, "cwd" | "worktreeCwd"> | undefined): { checkout: string; project: string } | undefined {
  if (result.status !== "completed" || result.reviewProblem) return undefined;
  if (stoppedForAsh(result)) return undefined;
  const checkout = session?.worktreeCwd;
  const project = session?.cwd;
  if (!checkout || !project || checkout === project) return undefined;
  return { checkout, project };
}

const files = (list: readonly string[]) => (list.length > 4 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", "));

/** The line the Lead reads first: what the app did with the worker's changes. */
export function landingLine(landing: Landing): string {
  switch (landing.outcome) {
    case "landed":
      return `[MonoCode landed] The app put this worker's changes into the project (not committed): ${files(landing.files)}.`;
    case "already":
      return "[MonoCode landed] The project already had this worker's changes.";
    case "nothing":
      return "[MonoCode landed] This worker changed no files, so nothing went into the project.";
    case "conflict":
      return `[MonoCode not landed] This worker's changes (${files(landing.files)}) clash with the project as it is now, so the app left the project alone: ${landing.why || "they don't apply cleanly"}. Ask the worker to bring its copy up to date, or land it yourself.`;
  }
}

/**
 * The report with the landing first. r84 (c02: the inbox called a clashed job done): work that didn't land is not done;
 * its report settles failed with the clash as the reason.
 */
export function withLanding(result: MonoSessionCompletionResult, landing: Landing | null): MonoSessionCompletionResult {
  if (!landing) return result;
  const line = landingLine(landing);
  const told = { ...result, result: `${line}\n\n${result.result}` };
  return landing.outcome === "conflict" ? { ...told, status: "failed", error: line, reason: "failed: its changes clash with the project" } : told;
}

/** r84: after a clash, once: the project's changes are merged into the worker's copy (refresh_worker_copy). */
export const refreshWorkerCopy = async ({ checkout, project }: { checkout: string; project: string }): Promise<string[] | null> => {
  try {
    return await invoke<string[]>("refresh_worker_copy", { checkout, project });
  } catch (error) {
    console.warn("worker's copy couldn't be brought up to date", error);
    return null;
  }
};

/** What the worker is told after its copy was brought up to date. */
export function refreshAsk(landing: Landing, marked: readonly string[]): string {
  const where = marked.length
    ? `${files(marked)} now carry conflict markers (<<<<<<< your copy / >>>>>>> the project now) where you and another worker changed the same lines: keep what both meant and remove the markers.`
    : "They merged cleanly.";
  return `[MonoCode land] Your changes (${files(landing.files)}) clashed with changes other workers already put into the project, so the app merged the project's versions into your copy. ${where} Then run your check again and report done again, ending with your self-review as before. Change nothing else.`;
}

export function refreshAskNote(): { kind: "message"; from: string; line: string } {
  return { kind: "message", from: "MonoCode", line: "its changes clashed with the project; the app merged the project in and asked it to settle them" };
}

export const landWorkerCopy: Lander = async ({ checkout, project }) => {
  try {
    return await invoke<Landing>("land_worker_copy", { checkout, project });
  } catch (error) {
    console.warn("worker's changes couldn't land", error);
    return null;
  }
};
