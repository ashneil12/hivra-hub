// Hivra WP-15: a brief line opens the Crew tab, filtered to that brief.

export const OPEN_CREW = "hivra:open-crew";

export type CrewFocus = { briefId: string | null; version: number; forOpen: number };

let focus: CrewFocus = { briefId: null, version: 0, forOpen: 0 };
let holders = 0;
const listeners = new Set<() => void>();

export function crewFocus(): CrewFocus {
  return focus;
}

export function subscribeCrewFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(briefId: string | null, forOpen = focus.forOpen) {
  focus = { briefId, version: focus.version + 1, forOpen };
  for (const listener of [...listeners]) listener();
}

/** Opens the Crew tab. A brief id shows that brief's workers for this open only. */
export function openCrew(briefId?: string | null) {
  set(briefId?.trim() || null, focus.forOpen + 1);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_CREW));
}

/**
 * The crew pane holds the filter for the open it was shown in. The last hold to
 * drop clears it, so the next open is not stuck on that brief. A newer open is
 * left alone. A strict-mode remount keeps the hold, so it does not clear itself.
 */
export function holdCrewOpen(): () => void {
  const token = focus.forOpen;
  holders += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holders -= 1;
    queueMicrotask(() => {
      if (holders !== 0 || focus.forOpen !== token || focus.briefId === null) return;
      set(null);
    });
  };
}

export function clearCrewFocus() {
  if (focus.briefId === null) return;
  set(null);
}

/** Tests start from a known filter. */
export function resetCrewFocus() {
  focus = { briefId: null, version: 0, forOpen: 0 };
  holders = 0;
  for (const listener of [...listeners]) listener();
}
