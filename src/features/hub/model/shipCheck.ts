// SC-3b: the ship check (src-tauri/src/ship_check.rs). One pass over everything that landed since the last passed one:
// the project's checks and real-app check, the test guard and a review against the task briefs. This is the webview's
// half: the typed invokes, the record read from the app (untrusted, so checked here), and the words a person reads.
//
// The rule that matters: a step that could not run is never described as a pass. A record that says "passed" over a step
// that failed or could not run is read as the weaker outcome, and an answer this file can't read is an error, never a
// made-up result.
import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "../../../shared/lib/paths";

export type ShipCheckOutcome = "passed" | "failed" | "couldNotRun";
export type ShipStepOutcome = ShipCheckOutcome | "notRun";

export type ShipCheckStep = {
  name: string;
  outcome: ShipStepOutcome;
  /** One plain line: what ran, or why it didn't. */
  detail: string;
  command?: string;
  outputTail?: string;
};

export type ShipCheckRecord = {
  /** The project's main checkout. */
  project: string;
  /** The version (a full commit id) the check covered. */
  head: string;
  /** The version of the last passed check, where this one started. None on a first check. */
  base: string | null;
  commitsCovered: number;
  /** Epoch ms. */
  at: number;
  outcome: ShipCheckOutcome;
  /** "First ship check: covered the last 30 commits", or "Nothing landed since the last ship check". */
  note: string | null;
  steps: ShipCheckStep[];
  /** Plain lines: what ran. */
  tested: string[];
  /** Plain lines: what did not, and why. */
  notTested: string[];
  /**
   * PT-4: proof tools the project could use and lacks, put forward by this run (at most three; the app decides each run afresh).
   * Only a run's answer has them: a saved record never does. The first mate files each through PT-1's claim and ask.
   */
  proposals?: ShipProposal[];
  /**
   * PT-5: named findings that do not block: a real bug a test caught, a flaky test that is quarantined, a quarantine that ran
   * out. They are on the saved record, so a card that reads the latest one shows them.
   */
  findings?: ShipFinding[];
  /**
   * PT-5: the one test fixer task to start and the Needs-you items to put to the person. Only a run's answer has it; the first
   * mate's tool call acts on it (agentAppShipCheck.ts), a card never does.
   */
  testDebt?: unknown;
};

/** A proof tool a ship check puts forward: its catalogue id and the name a person reads. */
export type ShipProposal = { toolId: string; name: string };

/** PT-5: a named finding on a ship check record. `kind` is the app's word for it; `line` is the sentence a person reads. */
export type ShipFinding = { kind: "code-wrong" | "quarantined" | "quarantine-expired"; test: string; file: string; line: string };

const FINDING_KINDS: readonly string[] = ["code-wrong", "quarantined", "quarantine-expired"];
const FINDINGS_MAX = 100;

/** PT-5: the findings of a record, read defensively: a bad entry is dropped, text is trimmed and cut, at most a hundred. */
export function readShipFindings(value: unknown): ShipFinding[] {
  if (!Array.isArray(value)) return [];
  const out: ShipFinding[] = [];
  for (const entry of value) {
    if (out.length >= FINDINGS_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const kind = typeof row.kind === "string" && FINDING_KINDS.includes(row.kind) ? (row.kind as ShipFinding["kind"]) : undefined;
    const line = text(row.line)?.trim().slice(0, 300);
    if (!kind || !line) continue;
    out.push({
      kind,
      test: text(row.test)?.trim().slice(0, 300) ?? "",
      file: text(row.file)?.trim().slice(0, 300) ?? "",
      line,
    });
  }
  return out;
}

/** The app's side, as invokes. Answers are untrusted until `readShipCheckRecord` has read them. */
export type ShipCheckBackend = {
  run(cwd: string): Promise<unknown>;
  latest(cwd: string): Promise<unknown>;
  passed(cwd: string, head: string): Promise<boolean>;
  /** The project's main checkout's current version, or none when git can't say. */
  head(cwd: string): Promise<string | null>;
};

export const tauriShipCheck: ShipCheckBackend = {
  run: (cwd) => invoke("ship_check_run", { cwd }),
  latest: (cwd) => invoke("ship_check_latest", { cwd }),
  passed: (cwd, head) => invoke<boolean>("ship_check_passed", { cwd, head }),
  head: (cwd) => invoke<string | null>("ship_check_head", { cwd }),
};

// ---- the words --------------------------------------------------------------------------------------------------------

const OUTCOME_WORD: Record<ShipCheckOutcome, string> = {
  passed: "Passed",
  failed: "Failed",
  couldNotRun: "Couldn't run everything",
};

const STEP_WORD: Record<ShipStepOutcome, string> = {
  passed: "Passed",
  failed: "Failed",
  couldNotRun: "Couldn't run",
  notRun: "Not run",
};

export function outcomeWord(outcome: ShipCheckOutcome): string {
  return OUTCOME_WORD[outcome];
}

export function stepWord(outcome: ShipStepOutcome): string {
  return STEP_WORD[outcome];
}

/** The seven characters a person reads for a version. */
export function shortSha(sha: string | null | undefined): string {
  return typeof sha === "string" ? sha.trim().slice(0, 7) : "";
}

export function commitsLine(count: number): string {
  if (count <= 0) return "no commits";
  return count === 1 ? "1 commit" : `${count} commits`;
}

const COULD_NOT_RUN = "The ship check could not run.";

/** A refusal or failure in the app's own plain words ("another ship check is already running"). */
export function shipCheckError(e: unknown): string {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  return text.trim() || COULD_NOT_RUN;
}

// ---- reading a record -------------------------------------------------------------------------------------------------

const OUTCOMES: readonly string[] = ["passed", "failed", "couldNotRun"];
const STEP_OUTCOMES: readonly string[] = ["passed", "failed", "couldNotRun", "notRun"];

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function lines(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((line) => (text(line) ? [(line as string).trim()] : [])) : [];
}

function readStep(value: unknown): ShipCheckStep | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const outcome = typeof row.outcome === "string" && STEP_OUTCOMES.includes(row.outcome) ? (row.outcome as ShipStepOutcome) : "couldNotRun";
  const command = text(row.command);
  const outputTail = text(row.outputTail);
  return {
    name: text(row.name)?.trim() ?? "A step",
    outcome,
    detail: typeof row.detail === "string" ? row.detail.trim() : "",
    ...(command ? { command } : {}),
    ...(outputTail ? { outputTail } : {}),
  };
}

/** PT-4: the end-to-end step's name, and the two reasons it may "not run" without that counting against a pass (the app's words). */
const END_TO_END = "End-to-end";
const END_TO_END_FINE_NOT_RUN = ["no screen to test", "switched off for this project"];

/**
 * PT-4: whether a step is the end-to-end one and did not pass for this version: it failed, could not run, or did not run for any
 * reason but "no screen to test" or the person's own switch. The "ready to ship" hold reads a record over such a step as not passed.
 */
export function endToEndDidNotPass(step: ShipCheckStep): boolean {
  if (step.name !== END_TO_END) return false;
  if (step.outcome === "passed") return false;
  return !(step.outcome === "notRun" && END_TO_END_FINE_NOT_RUN.includes(step.detail));
}

/** PT-4: the proof tools a run put forward, read defensively: a bad entry is dropped, at most three, each tool once. */
export function readShipProposals(value: unknown): ShipProposal[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ShipProposal[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const toolId = text(row.toolId)?.trim();
    if (!toolId || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(toolId) || seen.has(toolId)) continue;
    seen.add(toolId);
    out.push({ toolId, name: text(row.name)?.trim().slice(0, 80) ?? toolId });
    if (out.length === 3) break;
  }
  return out;
}

/**
 * The app's record, checked. `null` when it isn't one: not an object, no version, or an outcome this build doesn't know.
 * A step outcome it doesn't know reads as one that could not run, and the whole record is never a pass over a step that
 * failed or could not run, or over an end-to-end step that did not pass (PT-4).
 */
export function readShipCheckRecord(value: unknown): ShipCheckRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const head = text(row.head)?.trim();
  if (!head || typeof row.outcome !== "string" || !OUTCOMES.includes(row.outcome)) return null;
  const steps = Array.isArray(row.steps) ? row.steps.flatMap((step) => readStep(step) ?? []) : [];
  let outcome = row.outcome as ShipCheckOutcome;
  if (outcome === "passed") {
    if (steps.some((step) => step.outcome === "failed")) outcome = "failed";
    else if (steps.some((step) => step.outcome === "couldNotRun" || endToEndDidNotPass(step))) outcome = "couldNotRun";
  } else if (outcome === "couldNotRun" && steps.some((step) => step.outcome === "failed")) {
    outcome = "failed";
  }
  const proposals = readShipProposals(row.proposals);
  const findings = readShipFindings(row.findings);
  const covered = typeof row.commitsCovered === "number" && Number.isInteger(row.commitsCovered) ? row.commitsCovered : 0;
  return {
    project: typeof row.project === "string" ? row.project : "",
    head,
    base: text(row.base)?.trim() ?? null,
    commitsCovered: Math.max(0, covered),
    at: typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0,
    outcome,
    note: text(row.note)?.trim() ?? null,
    steps,
    tested: lines(row.tested),
    notTested: lines(row.notTested),
    ...(proposals.length ? { proposals } : {}),
    ...(findings.length ? { findings } : {}),
    // PT-5: handed on as it came; agentAppTestDebt.ts reads it (an answer it can't read starts and files nothing).
    ...(row.testDebt && typeof row.testDebt === "object" ? { testDebt: row.testDebt } : {}),
  };
}

// ---- running it -------------------------------------------------------------------------------------------------------

/** The runs out now, by project. A second ask for the same project joins the first: there is never a second run. */
const flights = new Map<string, Promise<ShipCheckRecord>>();

/** A run starting or ending, wherever it was asked for (a card's button, a first mate's tool call). */
export type ShipCheckEvent =
  | { phase: "started"; cwd: string }
  | { phase: "settled"; cwd: string; record: ShipCheckRecord | null; error: string | null };

const listeners = new Set<(event: ShipCheckEvent) => void>();

/** Hears every run start and settle, so a card shows a run it didn't start. Returns the way to stop listening. */
export function subscribeShipChecks(listener: (event: ShipCheckEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(event: ShipCheckEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // One listener's trouble is not the run's, nor the next listener's.
    }
  }
}

export function shipCheckRunning(cwd: string): boolean {
  return flights.has(pathKey(cwd));
}

/**
 * Runs the ship check for the project `cwd` belongs to. It can take minutes. While one is out for that project, asking
 * again (a second click, another window's card, a first mate's tool call) returns that run's answer instead of starting
 * another. A run that fails says why in the app's own words; an answer that isn't a record is an error, not a result.
 */
export function runShipCheck(cwd: string, backend: Pick<ShipCheckBackend, "run"> = tauriShipCheck): Promise<ShipCheckRecord> {
  const key = pathKey(cwd);
  const running = flights.get(key);
  if (running) return running;
  const flight = (async () => {
    try {
      const record = readShipCheckRecord(await backend.run(cwd));
      if (!record) throw new Error("The ship check's answer couldn't be read, so no result is shown.");
      return record;
    } catch (error) {
      throw new Error(shipCheckError(error));
    }
  })();
  flights.set(key, flight);
  notify({ phase: "started", cwd });
  // Registered before any caller can await the flight, so the project is free and the listeners know before a caller
  // goes on. (Freeing it here, not in the run, also covers a backend that throws at once: that ends the run before it
  // is in the map.)
  const settle = (record: ShipCheckRecord | null, error: string | null) => {
    if (flights.get(key) === flight) flights.delete(key);
    notify({ phase: "settled", cwd, record, error });
  };
  flight.then(
    (record) => settle(record, null),
    (error: unknown) => settle(null, shipCheckError(error)),
  );
  return flight;
}

/** The last record for the project, `null` when there is none (or the app sent something that isn't one). A failed read throws. */
export async function latestShipCheck(
  cwd: string,
  backend: Pick<ShipCheckBackend, "latest"> = tauriShipCheck,
): Promise<ShipCheckRecord | null> {
  try {
    return readShipCheckRecord(await backend.latest(cwd));
  } catch (error) {
    throw new Error(shipCheckError(error));
  }
}
