// What "1 stuck" on the Monos rail opens (B6; Ash 20 Oct: "easy to see when a subagent is stuck ... being able to respond
// quickly or go into the chat"). A small glass panel beside the rail listing each stuck worker: what it is working on,
// why it is stuck in one plain line, a reply box that answers it (the same path the Lead's chat and Today use:
// stuckActions.ts), and Open chat. It is the same card Today shows, so an answer reads the same everywhere.
import type { PopoverAnchor } from "../../../shared/ui/Popover";
import { Popover } from "../../../shared/ui/Popover";
import type { StuckWorker } from "../model/workerStuck";
import { leadNameOf, StuckList } from "./StuckWorkerCard";

export function StuckPanel({
  anchor,
  title,
  stuck,
  now,
  showLead,
  onClose,
}: {
  anchor: PopoverAnchor;
  /** "EXO lead", or "Stuck" for every Mono at once (the folded section's summary). */
  title: string;
  stuck: readonly StuckWorker[];
  now: number;
  /** Name the Mono each worker answers to (the folded section lists several Monos' workers). */
  showLead?: boolean;
  onClose: () => void;
}) {
  const count = stuck.length;
  return (
    <Popover
      anchor={anchor}
      side="right"
      align="start"
      gap={6}
      width={360}
      maxHeight={480}
      onDismiss={onClose}
      // Its own trigger toggles it; a press there is not "outside".
      ignore="[data-stuck-trigger]"
      role="dialog"
      aria-label={`${title}: stuck work`}
      data-stuck-panel
      className="flex flex-col p-2"
    >
      <div className="flex items-baseline gap-1.5 px-2 pb-1 pt-0.5 text-[12px] text-content/60">
        <span className="min-w-0 truncate font-medium text-content/85" data-stuck-panel-title>
          {title}
        </span>
        <span className="shrink-0">{count ? `· ${count} stuck` : ""}</span>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <StuckList
          stuck={stuck}
          now={now}
          variant="row"
          where={showLead ? (s) => leadNameOf(s) : undefined}
          onOpened={onClose}
        />
        {count ? null : (
          <div className="px-2 py-2 text-[13px] text-content/60" data-stuck-panel-empty>
            Nothing is stuck now.
          </div>
        )}
      </div>
    </Popover>
  );
}
