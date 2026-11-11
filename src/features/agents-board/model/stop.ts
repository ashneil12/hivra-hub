import { plainFailure } from "./words";

export type StopPhase = "closed" | "asking" | "stopping" | "stopped" | "failed";

/** The first click asks. A failed stop can be asked again. It does not stop. */
export function requestStop(phase: StopPhase): { phase: StopPhase; stop: boolean } {
  if (phase === "closed" || phase === "failed") return { phase: "asking", stop: false };
  return { phase, stop: false };
}

/** Confirming the one question starts the stop. It is not stopped until that finishes. */
export function confirmStop(phase: StopPhase): { phase: StopPhase; stop: boolean } {
  if (phase === "asking") return { phase: "stopping", stop: true };
  return { phase, stop: false };
}

/**
 * A result counts only while this row is still stopping.
 * A late result, or a result for a stop that was replaced, does not change the phase.
 */
export function finishStop(phase: StopPhase, ok: boolean): StopPhase {
  if (phase !== "stopping") return phase;
  return ok ? "stopped" : "failed";
}

export function cancelStop(phase: StopPhase): StopPhase {
  return phase === "asking" ? "closed" : phase;
}

/** The row has to still be there. A late confirm does not stop whoever is in its place. */
export function stopTarget(id: string | null, ids: readonly string[]): string | null {
  if (!id) return null;
  return ids.includes(id) ? id : null;
}

/** What the panel says when a stop did not happen. */
export function stopFailureText(name: string, reason: string): string {
  const who = name.replace(/[—–]/g, ",").replace(/\s+/g, " ").trim() || "this chat";
  const why = plainFailure(reason) ?? "it did not stop";
  return `Couldn't stop ${who}: ${why}`;
}
