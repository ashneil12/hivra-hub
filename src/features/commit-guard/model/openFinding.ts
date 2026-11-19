import { isGuardRefusal } from "./refusal";

/** Fired on window when a person asks to see a guard refusal in the source-control panel. */
export const OPEN_FINDING_EVENT = "hivra:commit-guard-open-finding";

let pending: string | null = null;

/** Asks for a guard refusal to be shown in the source-control panel. The panel makes the allow, not this link. */
export function openGuardFinding(message: string): void {
  if (!isGuardRefusal(message)) return;
  pending = message;
  window.dispatchEvent(new CustomEvent(OPEN_FINDING_EVENT, { detail: message }));
}

/** The refusal asked for and not yet shown; the source-control panel takes it once, when it shows. */
export function takePendingGuardFinding(): string | null {
  const next = pending;
  pending = null;
  return next;
}

/** Calls `handler` each time a refusal is asked to be shown. Returns the function that stops it. */
export function onGuardFindingOpen(handler: () => void): () => void {
  window.addEventListener(OPEN_FINDING_EVENT, handler);
  return () => window.removeEventListener(OPEN_FINDING_EVENT, handler);
}
