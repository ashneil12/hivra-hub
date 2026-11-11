export type StopPhase = "closed" | "asking" | "stopped";

/** The first click asks. It does not stop. */
export function requestStop(phase: StopPhase): { phase: StopPhase; stop: boolean } {
  if (phase === "closed") return { phase: "asking", stop: false };
  return { phase, stop: false };
}

/** Confirming the one question stops. A second confirm does not ask or stop again. */
export function confirmStop(phase: StopPhase): { phase: StopPhase; stop: boolean } {
  if (phase === "asking") return { phase: "stopped", stop: true };
  return { phase, stop: false };
}

export function cancelStop(phase: StopPhase): StopPhase {
  return phase === "asking" ? "closed" : phase;
}

/** The row has to still be there. A late confirm does not stop whoever is in its place. */
export function stopTarget(id: string | null, ids: readonly string[]): string | null {
  if (!id) return null;
  return ids.includes(id) ? id : null;
}
