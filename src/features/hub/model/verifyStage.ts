// The verify stage (board I2; src-tauri/src/verify_stage.rs): before a turn or a Lead says user-visible work is done,
// the app can run the project's own checks for the folder it changed and, for anything Ash would see, drive the real
// path in a throwaway copy. The recipe is declared in the project's already-imported `.monocode/project.json`
// (project_file.rs), so nothing here invents a trust path.
//
// This file is the webview's half: the invokes, the turn's own changed paths, and the words a claim cites. The one rule
// that matters is that a verdict which could not run is never described as a pass — "not run" and "couldn't be
// exercised" get their own plain lines, and `citeStage` is the only way the card is allowed to show one.
import { invoke } from "@tauri-apps/api/core";
import type { Block } from "../../sessions/model/session";

export type VerifyOutcome = "passed" | "failed" | "couldNotExercise" | "notRun";

export type VerifyCheck = {
  id: string;
  name: string;
  command: string;
  /** Checkout-relative folder it runs in; absent means the checkout root. It covers every change under it. */
  dir?: string;
  description?: string;
  timeoutSeconds?: number;
};

export type RealPathCheck = {
  /** Drives the real path; writes its verdict to `MONOCODE_VERIFY_VERDICT`. */
  command: string;
  /** Checkout-relative globs of the changes it applies to. Empty or absent: every change. */
  appliesTo?: string[];
  timeoutSeconds?: number;
};

export type VerifySettings = {
  checks?: VerifyCheck[];
  realPath?: RealPathCheck;
};

/** One line of a verdict: a check, the real path, or the reason nothing ran for it. */
export type VerifyStep = {
  /** `check` or `realPath`. */
  kind: string;
  id: string;
  name: string;
  outcome: VerifyOutcome;
  /** Plain English: what ran, or why it couldn't. */
  detail: string;
  runId: string | null;
  logPath: string | null;
  seconds: number;
};

export type VerifyRecord = {
  id: string;
  projectRoot: string;
  checkout: string;
  startedAt: number;
  endedAt: number;
  outcome: VerifyOutcome;
  summary: string;
  steps: VerifyStep[];
  /** Folders the change touched that the project declares no checks for. */
  gaps: string[];
  changedFiles: string[];
};

export type VerifyStatus = {
  projectRoot: string;
  checkout: string;
  /** The project file is imported, so its recipe may run. */
  imported: boolean;
  verify: VerifySettings;
  /** Why nothing can run, when that is the case. */
  note: string | null;
  latest: VerifyRecord | null;
};

export const verifyStageStatus = (cwd: string) => invoke<VerifyStatus>("verify_stage_status", { cwd });

/** `paths`: the turn's own changed files; when none are named, the stage reads `git status` in the checkout. */
export const runVerifyStage = (cwd: string, paths?: string[]) =>
  invoke<VerifyRecord>("verify_stage_run", { cwd, paths: paths?.length ? paths : null });

export const latestVerifyStage = (cwd: string) => invoke<VerifyRecord | null>("verify_stage_latest", { cwd });

const OUTCOME_WORD: Record<VerifyOutcome, string> = {
  passed: "passed",
  failed: "failed",
  couldNotExercise: "couldn't be exercised",
  notRun: "not run",
};

export function stageOutcomeWord(outcome: VerifyOutcome): string {
  return OUTCOME_WORD[outcome];
}

/** The app may show this verdict as proof of a done claim. Nothing else counts. */
export function stageProves(record: Pick<VerifyRecord, "outcome"> | null | undefined): boolean {
  return record?.outcome === "passed";
}

/** "just now", "4 min ago", "3 h ago": how old a verdict is, so a stale one never reads as this turn's. */
export function stageAge(endedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - endedAt) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stepLine(step: VerifyStep): string {
  const detail = oneLine(step.detail).replace(/\.$/, "");
  return `${step.name}: ${detail || stageOutcomeWord(step.outcome)}`;
}

/**
 * The one sentence a claim may cite. A pass says what passed; a failure says it is not proven; a verdict that could
 * not run says exactly that and is labelled not proven, so no reader can take it for a pass.
 */
export function citeStage(record: VerifyRecord, now = Date.now()): string {
  const when = `Verification (${stageAge(record.endedAt, now)})`;
  let detail = record.steps.map(stepLine).join("; ");
  if (detail.length > 280) detail = `${detail.slice(0, 279).trimEnd()}…`;
  detail = detail.replace(/\.$/, "");
  const names = detail ? ` (${detail})` : "";
  let line: string;
  switch (record.outcome) {
    case "passed":
      line = `${when}: every check that ran passed${names}.`;
      break;
    case "failed":
      line = `${when} failed${names}. Not proven.`;
      break;
    case "couldNotExercise":
      line = `${when} couldn't exercise this change${names}. Not proven.`;
      break;
    case "notRun":
      line = `${when} ran nothing${names}. Not a pass.`;
      break;
  }
  // A folder the change touched that no check covers is named, never hidden behind a green verdict.
  if (record.gaps.length) line += ` No checks are declared for ${record.gaps.join(", ")}.`;
  return line;
}

export type StageReadiness = { canRun: boolean; why: string };

/** Whether the card may offer to run the stage, and in plain words why not when it may not. */
export function stageReadiness(status: VerifyStatus | null): StageReadiness {
  if (!status) return { canRun: false, why: "Verification isn't available here." };
  if (!status.imported) {
    return {
      canRun: false,
      why: status.note ?? "This project's .monocode/project.json isn't imported, so nothing can run.",
    };
  }
  const checks = status.verify.checks ?? [];
  if (!checks.length && !status.verify.realPath) {
    return { canRun: false, why: "This project declares no checks or real path, so there is nothing to run." };
  }
  return { canRun: true, why: "" };
}

const MAX_PATHS = 200;

/**
 * The files this turn wrote, for the stage to check. Only writes count: a read or a shell command the app cannot parse
 * is not a change it can name, and with no paths the stage falls back to `git status` in the checkout.
 */
export function touchedPaths(turn: readonly Block[]): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const path = raw.trim();
    if (!path || out.includes(path) || out.length >= MAX_PATHS) return;
    out.push(path);
  };
  for (const block of turn) {
    const tool = block.tool;
    for (const path of tool?.paths ?? []) add(path);
    const preview = tool?.preview;
    if (preview?.kind === "write" && preview.path) add(preview.path);
  }
  return out;
}

/** A refusal or failure in the app's own plain words ("the run disappeared"). */
export function stageError(e: unknown): string {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  return text.trim() || "Verification could not run.";
}
