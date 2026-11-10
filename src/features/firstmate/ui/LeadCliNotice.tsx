// WP-120: the strip a lead chat shows when its CLI cannot lead yet. It offers
// only the CLIs Ash ticked at first launch that can lead and are installed here.
// It speaks of this chat only (a pick changes this chat's CLI, nothing else), and
// Ash can close it for a chat.
import { useSyncExternalStore } from "react";
import {
  getHarnessAvailabilitySnapshot,
  isHarnessAvailable,
  subscribeHarnessAvailability,
} from "../../../integrations/harness/core/availabilityState";
import type { HarnessId } from "../../sessions/model/session";
import {
  applyLeadSwitch,
  chosenLeadPresence,
  leadSwitchOffer,
} from "../model/leadCli";
import {
  dismissLeadStrip,
  leadStripDismissed,
  leadStripVersion,
  subscribeLeadStrip,
} from "../model/leadStripDismissal";

export function LeadCliNotice({
  harness,
  sessionId,
  hasCrew = false,
  onSwitch,
}: {
  harness: string;
  /** The chat this strip belongs to: Ash closes it per chat. */
  sessionId: string;
  /** This chat has handed work to workers, so the line says they stay. */
  hasCrew?: boolean;
  onSwitch?: (cli: HarnessId) => void;
}) {
  // A probe that finishes after this chat opens re-reads its result here.
  useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    () => 0,
  );
  useSyncExternalStore(subscribeLeadStrip, leadStripVersion, () => 0);
  const present = chosenLeadPresence((cli) => isHarnessAvailable(cli));
  const offer = leadSwitchOffer(harness, present);
  if (!offer || leadStripDismissed(sessionId)) return null;
  const choices = offer.choices;
  return (
    <div
      data-lead-cli-notice=""
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stroke px-3 py-1 text-xs text-content/70"
    >
      <p data-lead-cli-reason="">
        {offer.reason}
        {choices.length > 0
          ? ` Switch this chat to one that can. ${hasCrew ? "Its workers and history stay." : "Its history stays."}`
          : null}
      </p>
      {choices.length > 0 ? (
        <div data-lead-cli-picker="" className="flex flex-wrap gap-1">
          {choices.map((choice) => (
            <button
              key={choice.cli}
              type="button"
              data-lead-cli={choice.cli}
              aria-pressed={choice.cli === harness}
              className="rounded border border-stroke px-2 py-0.5 text-content hover:bg-content/10"
              onClick={() => {
                // `applyLeadSwitch` is the one gate: a pick that cannot lead, or a CLI
                // that has gone since the strip drew, is never applied.
                const next = isHarnessAvailable(choice.cli)
                  ? applyLeadSwitch(harness, choice.cli)
                  : null;
                if (next) onSwitch?.(next);
              }}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        data-lead-cli-dismiss=""
        className="ml-auto rounded px-2 py-0.5 text-content/60 hover:bg-content/10"
        onClick={() => dismissLeadStrip(sessionId)}
      >
        Dismiss
      </button>
    </div>
  );
}
