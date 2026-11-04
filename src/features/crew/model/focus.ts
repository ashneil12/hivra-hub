// Hivra WP-15: a brief line opens the Crew tab, filtered to that brief.

export const OPEN_CREW = "hivra:open-crew";

export type CrewFocus = { briefId: string | null; version: number };

let focus: CrewFocus = { briefId: null, version: 0 };
const listeners = new Set<() => void>();

export function crewFocus(): CrewFocus {
  return focus;
}

export function subscribeCrewFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(briefId: string | null) {
  focus = { briefId, version: focus.version + 1 };
  for (const listener of [...listeners]) listener();
}

/** Opens the Crew tab. A brief id shows that brief's workers; anything else shows everyone. */
export function openCrew(briefId?: string | null) {
  set(briefId?.trim() || null);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_CREW));
}

export function clearCrewFocus() {
  if (focus.briefId === null) return;
  set(null);
}

/** Tests start from a known filter. */
export function resetCrewFocus() {
  focus = { briefId: null, version: 0 };
  for (const listener of [...listeners]) listener();
}
