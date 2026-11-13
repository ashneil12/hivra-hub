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
};

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

/**
 * The app's record, checked. `null` when it isn't one: not an object, no version, or an outcome this build doesn't know.
 * A step outcome it doesn't know reads as one that could not run, and the whole record is never a pass over a step that
 * failed or could not run.
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
    else if (steps.some((step) => step.outcome === "couldNotRun")) outcome = "couldNotRun";
  } else if (outcome === "couldNotRun" && steps.some((step) => step.outcome === "failed")) {
    outcome = "failed";
  }
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
