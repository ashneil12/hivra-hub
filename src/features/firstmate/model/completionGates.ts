// Hivra WP-40: what the webview does with a finished worker's gates (src-tauri/src/firstmate/gates.rs).
//
// The gates and the verdict check run in Rust. This module only decides the round: a pass lands, a failure goes back
// to the worker once, and anything that couldn't be decided (a gate that didn't run, an unsure or missing answer, a
// check that threw) is not a pass. The first mate accepts or refuses that one with task_accept.

import { invoke } from "@tauri-apps/api/core";
import type { MonoSessionCompletionResult } from "../../monos/model/monoSessionCompletion";
import { GATE_TRIES, gateAsk, gateFailedResult, type GateRun } from "../../monos/model/workerGate";

/** The fixed set (gates.rs GateKind). */
export const GATE_WORDS = ["diff", "checks", "committed", "ratchet", "routes"] as const;

const GATE_WORD = new Set<string>(GATE_WORDS);

/** What delegate_task may name. Absent means the brief has no gates of its own. */
export type GateRequest = {
  gates?: string[];
  checks?: string[];
  code?: boolean;
};

/**
 * The brief's gates, checked before anything starts. `undefined`: nothing was named, so the worker's report keeps the
 * routes check alone. A word that isn't a gate, or a checks list that doesn't fit, is refused in the same words as Rust.
 */
export function gateRequest(input: {
  gates?: unknown;
  checks?: unknown;
  code?: unknown;
}): GateRequest | undefined {
  if (input.code !== undefined && typeof input.code !== "boolean")
    throw new Error("code must be true or false");
  const gates = wordList(input.gates, "gates");
  const checks = checkList(input.checks);
  if (!input.code && !gates?.length && !checks?.length) return undefined;
  return {
    ...(gates?.length ? { gates } : {}),
    ...(checks?.length ? { checks } : {}),
    ...(input.code ? { code: true } : {}),
  };
}

/** A gate name, trimmed. An unknown word is refused with the original text, as Rust does. */
function wordList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be a list of names`);
  const seen = new Set<string>();
  const words: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${field} must be a list of names`);
    const word = item.trim();
    if (!GATE_WORD.has(word))
      throw new Error(`"${item}" isn't a gate. Use diff, checks, committed, ratchet or routes.`);
    if (seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}

/** Named project checks: at most 20, each a short id. Empty entries are dropped, as Rust drops them. */
function checkList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("checks must be a list of names");
  const seen = new Set<string>();
  const checks: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("checks must be a list of names");
    const check = item.trim();
    if (!check || seen.has(check)) continue;
    seen.add(check);
    checks.push(check);
  }
  if (checks.length > 20 || checks.some((check) => check.length > 60))
    throw new Error("Name at most 20 checks, by their ids in the project's file.");
  return checks;
}

/** The verdict Rust stored, as the webview needs it. Anything else is not a pass. */
export type GateRecordView = {
  verdict: string;
  summary?: string;
};

export type BriefGateStep =
  | { action: "pass" }
  | {
      action: "resend";
      ask: string;
      note: { kind: "message"; from: string; line: string };
      /** The report its first mate gets when the fix round can't be sent. */
      failed: (result: MonoSessionCompletionResult) => MonoSessionCompletionResult;
    }
  | {
      action: "fail" | "unsure";
      apply: (result: MonoSessionCompletionResult) => MonoSessionCompletionResult;
    };

const RESEND_NOTE = {
  kind: "message" as const,
  from: "MonoCode",
  line: "Checks failed; their words went back to the worker",
};

function failedRun(summary: string | undefined): GateRun {
  return { name: "The checks", ok: false, output: summary?.trim() || "(it said nothing)" };
}

/**
 * One round. `failures` is how many failed rounds this worker already had, not counting this one. A pass lands. The
 * first failure goes back to the worker; the second is failed. Unsure never uses that fix round and never lands: the
 * row stays completed so its first mate can accept or refuse it.
 */
export function briefGateAction(record: GateRecordView, failures: number): BriefGateStep {
  if (record.verdict === "passed") return { action: "pass" };
  if (record.verdict === "failed" && failures + 1 < GATE_TRIES) {
    const run = failedRun(record.summary);
    return {
      action: "resend",
      ask: gateAsk(run),
      note: RESEND_NOTE,
      failed: (result) => gateFailedResult(result, run),
    };
  }
  if (record.verdict === "failed") {
    const run = failedRun(record.summary);
    return { action: "fail", apply: (result) => gateFailedResult(result, run) };
  }
  const summary = record.summary?.trim() || "The checks couldn't say the brief was met.";
  return {
    action: "unsure",
    apply: (result) => ({ ...result, status: "completed", gatesNote: summary }),
  };
}

export type BriefGateInput = {
  delegationId: string;
  checkout: string;
  projectId?: string;
  signedOff: boolean;
  report: string;
  failures: number;
};

/** Runs the stored plan. `null`: the brief has no gates, and the routes check runs as before. */
export async function runBriefGates(input: BriefGateInput): Promise<GateRecordView | null> {
  return invoke<GateRecordView | null>("firstmate_run_gates", {
    input: {
      delegationId: input.delegationId,
      checkout: input.checkout,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      signedOff: input.signedOff,
      report: input.report,
    },
  });
}

/**
 * The brief's gates for this report. A throw (the command failed, the app was gone) is unsure, never a pass: a check
 * that couldn't run is not done.
 */
export async function briefGatesFor(
  input: BriefGateInput,
  run: (input: BriefGateInput) => Promise<GateRecordView | null> = runBriefGates,
): Promise<BriefGateStep | null> {
  let record: GateRecordView | null;
  try {
    record = await run(input);
  } catch {
    record = {
      verdict: "unsure",
      summary: "The checks couldn't run, so this isn't done until you decide.",
    };
  }
  if (!record) return null;
  return briefGateAction(record, input.failures);
}

/** Keeps a started task's gates (firstmate_gates_plan). An empty plan keeps nothing. */
export function saveGatePlan(id: string, request: GateRequest, folder?: string): Promise<unknown> {
  return invoke("firstmate_gates_plan", {
    id,
    input: request,
    ...(folder ? { folder } : {}),
  });
}

/** The first mate's call on an unsure verdict (firstmate_gates_decide). */
export function decideGateVerdict(
  ownerSession: string,
  id: string,
  accept: boolean,
  reason?: string,
): Promise<unknown> {
  return invoke("firstmate_gates_decide", {
    ownerSession,
    id,
    accept,
    ...(reason ? { reason } : {}),
  });
}
