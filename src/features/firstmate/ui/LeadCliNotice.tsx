// WP-120: the lead picker, and the line when this CLI cannot lead yet.
import { useSyncExternalStore } from "react";
import {
  getHarnessAvailabilitySnapshot,
  isHarnessAvailable,
  subscribeHarnessAvailability,
} from "../../../integrations/harness/core/availabilityState";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { leadPickerChoices, leadSwitchOffer } from "../model/leadCli";

export function LeadCliNotice({
  harness,
  onSwitch,
}: {
  harness: string;
  onSwitch?: (cli: HarnessId) => void;
}) {
  const version = useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    () => 0,
  );
  void version;
  const present = HARNESSES.filter((id) => isHarnessAvailable(id)).map((cli) => ({
    cli,
    installed: true,
    signedIn: true,
  }));
  const choices = leadPickerChoices(present);
  const offer = leadSwitchOffer(harness, present);
  if (!offer && choices.length === 0) return null;
  return (
    <div
      data-lead-cli-notice=""
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stroke px-3 py-1 text-xs text-content/70"
    >
      {offer ? (
        <p data-lead-cli-reason="">{offer.reason} Switch the lead. This crew and its memory stay.</p>
      ) : (
        <p>Choose the lead.</p>
      )}
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
                if (choice.cli !== harness) onSwitch?.(choice.cli);
              }}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
