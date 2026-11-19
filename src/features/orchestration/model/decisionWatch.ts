// WP-91: an irreversible step parks as a decision (src-tauri/src/decisions.rs) and only the person answers it, in the
// Inbox, on Home or in a chat. Whichever it is, the store emits `hivra:decisions-changed` once the answer is kept, and
// this is where the run hears it, so the step starts when the person says so and not when the lead next happens to ask.
import { DECISIONS_CHANGED } from "../../firstmate/model/steering";

/** The event bus's `listen`, as far as this needs it. Tauri's takes the same two arguments. */
export type DecisionListen = (
  event: string,
  handler: () => void,
) => Promise<() => void>;

/**
 * Call `changed` for every decision event until the returned function is called. A listener that is still starting
 * when it is stopped is stopped as soon as it is ready, a listener that cannot start (no event bus outside the app)
 * is nothing to watch, and a callback that throws never ends the watch.
 */
export function watchDecisions(
  listen: DecisionListen,
  changed: () => void,
): () => void {
  let stopped = false;
  let off: (() => void) | undefined;
  void listen(DECISIONS_CHANGED, () => {
    if (stopped) return;
    try {
      changed();
    } catch (error) {
      console.error("Could not act on a decision change", error);
    }
  })
    .then((stop) => {
      if (stopped) stop();
      else off = stop;
    })
    .catch(() => undefined);
  return () => {
    if (stopped) return;
    stopped = true;
    off?.();
  };
}
