// Hivra WP-40: what the webview does with a finished worker's gates (src-tauri/src/firstmate/gates.rs).
//
// The gates and the verdict check run in Rust. This module only decides the round: a pass lands, a failure goes back
// to the worker once, and anything that couldn't be decided (a gate that didn't run, an unsure or missing answer, a
// check that threw) is not a pass. The first mate accepts or refuses that one with task_accept.

import { invoke } from "@tauri-apps/api/core";
import type { MonoSessionCompletionResult } from "../../monos/model/monoSessionCompletion";
import { GATE_TRIES, gateAsk, gateFailedResult, type GateRun } from "../../monos/model/workerGate";
import type { Block } from "../../sessions/model/session";
import { factsFromBlocks, type FactTurn } from "./factGaps";

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

/**
 * SC-5: what Rust decided to do after a failed round (firstmate/rounds.rs `NextStep`), from the task's ledger of rounds:
 * `send-back` (the numbered findings go to the worker), `rewrite` (a stronger model rewrote the brief; `text` is the message
 * that goes to the worker as the next round), `up` (a two-line summary goes to the first mate as a new turn) or `person`
 * (one decision is open in Needs you; `text` tells the first mate to wait for it).
 */
export type NextStepView = {
  kind: string;
  text?: string;
};

/** The verdict Rust stored, as the webview needs it. Anything else is not a pass. */
export type GateRecordView = {
  verdict: string;
  summary?: string;
  /** SC-5: absent on a record from before the ledger, and on one with no failed round. */
  next?: NextStepView;
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
 * The first line of a fact-gap summary, when it is a real reason. A stored summary is untrusted: a blank, a control
 * character, or a line too long to show falls back to the usual checks note.
 */
function sentBackLine(summary: string | undefined): string | undefined {
  const line = summary?.split(/\r?\n/)[0]?.trim() ?? "";
  if (!line.startsWith("Sent back:")) return undefined;
  const rest = line.slice("Sent back:".length).trim();
  if (!rest || line.length > 180) return undefined;
  if (/[\u0000-\u001F\u007F]/.test(line)) return undefined;
  return line;
}

function sentBackFailure(result: MonoSessionCompletionResult, line: string): MonoSessionCompletionResult {
  return { ...result, status: "failed", error: `${line} Still failed after ${GATE_TRIES} tries.` };
}

const REWRITE_NOTE = {
  kind: "message" as const,
  from: "MonoCode",
  line: "Checks failed twice; a stronger model rewrote the brief and it went to the worker",
};

/** What a hand-up or a decision tells the first mate when Rust gave no words. */
const HANDED_UP = "The checks failed again and a decision is open; wait for it.";

/**
 * SC-5: what Rust decided for a failed round, or nothing when it said nothing readable. A stored record is untrusted: a
 * kind this build doesn't know, or a rewrite with no brief to send, is read as no decision, so the old cap still applies.
 */
function nextOf(record: GateRecordView): { kind: "send-back" | "rewrite" | "up" | "person"; text: string } | undefined {
  if (record.verdict !== "failed") return undefined;
  const kind = record.next?.kind;
  const text = typeof record.next?.text === "string" ? record.next.text.trim() : "";
  if (kind === "send-back") return { kind, text };
  if (kind === "rewrite") return text ? { kind, text } : undefined;
  if (kind === "up" || kind === "person") return { kind, text: text || HANDED_UP };
  return undefined;
}

/**
 * One round. `failures` is how many failed rounds this worker already had, not counting this one. A pass lands. After a
 * failure Rust's ledger of the task's rounds says what happens (`next`): the first failure's numbered findings go back to
 * the worker; the second stops them and a stronger model rewrites the brief (the new brief goes to the worker as the next
 * round) or hands the work up (the first mate hears it as a new turn); the failure after that waits for the person's
 * decision, and the first mate is told to wait. A record with no `next` (from before the ledger) keeps the old cap: the
 * first failure goes back, the second is failed. Unsure never uses a fix round and never lands: the row stays completed so
 * its first mate can accept or refuse it.
 */
export function briefGateAction(record: GateRecordView, failures: number): BriefGateStep {
  if (record.verdict === "passed") return { action: "pass" };
  const next = nextOf(record);
  if (next?.kind === "rewrite") {
    const run = failedRun(record.summary);
    return {
      action: "resend",
      ask: next.text,
      note: REWRITE_NOTE,
      failed: (result) => gateFailedResult(result, run),
    };
  }
  if (next?.kind === "up" || next?.kind === "person") {
    return {
      action: "unsure",
      apply: (result) => ({ ...result, status: "completed", gatesNote: next.text }),
    };
  }
  const sentBack = record.verdict === "failed" ? sentBackLine(record.summary) : undefined;
  // SC-5: a failure the ledger says to send back goes back whatever this window counted: the ledger is the task's, kept
  // across restarts and windows; the count here starts again with each report loop.
  if (record.verdict === "failed" && (next?.kind === "send-back" || failures + 1 < GATE_TRIES)) {
    const run = failedRun(record.summary);
    return {
      action: "resend",
      ask: gateAsk(run),
      note: sentBack ? { kind: "message", from: "MonoCode", line: sentBack } : RESEND_NOTE,
      failed: (result) => (sentBack ? sentBackFailure(result, sentBack) : gateFailedResult(result, run)),
    };
  }
  if (record.verdict === "failed") {
    const run = failedRun(record.summary);
    return {
      action: "fail",
      apply: (result) => (sentBack ? sentBackFailure(result, sentBack) : gateFailedResult(result, run)),
    };
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
  /** WP-145: this turn's blocks. Facts are read from them when `facts` is absent. */
  blocks?: readonly Block[];
  /** WP-145: already-read facts. These win over `blocks`. */
  facts?: FactTurn;
};

/** Facts from this turn's blocks. Missing blocks are not invented from the report. */
function withFacts(input: BriefGateInput): BriefGateInput {
  if (input.facts) return input;
  if (!Array.isArray(input.blocks)) return input;
  return { ...input, facts: factsFromBlocks(input.blocks, input.report) };
}

/** Runs the stored plan. `null`: the brief has no gates, and the routes check runs as before. */
export async function runBriefGates(input: BriefGateInput): Promise<GateRecordView | null> {
  const ready = withFacts(input);
  return invoke<GateRecordView | null>("firstmate_run_gates", {
    input: {
      delegationId: ready.delegationId,
      checkout: ready.checkout,
      ...(ready.projectId ? { projectId: ready.projectId } : {}),
      signedOff: ready.signedOff,
      report: ready.report,
      ...(ready.facts ? { facts: ready.facts } : {}),
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
  const ready = withFacts(input);
  let record: GateRecordView | null;
  try {
    record = await run(ready);
  } catch {
    record = {
      verdict: "unsure",
      summary: "The checks couldn't run, so this isn't done until you decide.",
    };
  }
  if (!record) return null;
  return briefGateAction(record, ready.failures);
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
