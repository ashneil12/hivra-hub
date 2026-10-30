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

export function landingDue(result: MonoSessionCompletionResult, session: Pick<Session, "cwd" | "worktreeCwd"> | undefined): { checkout: string; project: string } | undefined {
  if (result.status !== "completed" || result.reviewProblem) return undefined;
  if (STOPPED_TO_ASK.test(result.result) || waitsOnAshCall(result.result) || (!!result.review && waitsOnAshCall(result.review.unsure))) return undefined;
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

export function withLanding(result: MonoSessionCompletionResult, landing: Landing | null): MonoSessionCompletionResult {
  return landing ? { ...result, result: `${landingLine(landing)}\n\n${result.result}` } : result;
}

export const landWorkerCopy: Lander = async ({ checkout, project }) => {
  try {
    return await invoke<Landing>("land_worker_copy", { checkout, project });
  } catch (error) {
    console.warn("worker's changes couldn't land", error);
    return null;
  }
};
