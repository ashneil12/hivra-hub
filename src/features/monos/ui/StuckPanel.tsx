// What "1 stuck" on the Monos rail opens (B6; Ash 20 Oct: "easy to see when a subagent is stuck ... being able to respond
// quickly or go into the chat"). A small glass panel beside the rail listing each stuck worker: what it is working on,
// why it is stuck in one plain line, a reply box that answers it (the same path the Lead's chat and Today use:
// stuckActions.ts), and Open chat. It is the same card Today shows, so an answer reads the same everywhere.
import type { PopoverAnchor } from "../../../shared/ui/Popover";
import { Popover } from "../../../shared/ui/Popover";
import type { StuckWorker } from "../model/workerStuck";
import { leadNameOf, StuckList } from "./StuckWorkerCard";
import type { Worker } from "../../hub/model/types";
import { rowReason } from "../../hub/model/rowReason";
import { workerChip } from "../../hub/model/statusChip";
import { ChipMark, OpenLeadLink } from "../../hub/ui/StatusMark";
import { openMonoChat } from "../../hub/model/hubNav";
import { openLead } from "../model/stuckActions";

export function StuckPanel({
  anchor,
  title,
  stuck,
  jobs = [],
  asks = [],
  now,
  showLead,
  onClose,
}: {
  anchor: PopoverAnchor;
  /** "EXO lead", or "Stuck" for every Mono at once (the folded section's summary). */
  title: string;
  stuck: readonly StuckWorker[];
  /** r51: the red rows with no worker behind them (a job its Lead gave up on, a Lead that can't answer), from the same list. */
  jobs?: readonly Worker[];
  /** Questions and approvals from the one Needs you list, so the panel matches the red number. */
  asks?: readonly { id: string; sentence: string; actions: readonly { label: string; run: () => void }[] }[];
  now: number;
  /** Name the Mono each worker answers to (the folded section lists several Monos' workers). */
  showLead?: boolean;
  onClose: () => void;
}) {
  // The header counts the workers plus the asks the red number includes.
  const count = stuck.length + jobs.length + asks.length;
  return (
    <Popover
      anchor={anchor}
      side="right"
      align="start"
      gap={6}
      width={380}
      maxHeight={480}
      onDismiss={onClose}
      // Its own trigger toggles it; a press there is not "outside".
      ignore="[data-stuck-trigger]"
      role="dialog"
      aria-label={`${title}: needs you`}
      data-stuck-panel
      className="flex flex-col p-2"
    >
      <div className="flex items-baseline gap-1.5 px-2 pb-1 pt-0.5 text-[12px] text-content/60">
        <span className="min-w-0 truncate font-medium text-content/85" data-stuck-panel-title>
          {title}
        </span>
        <span className="shrink-0">{count ? `· ${count} needs you` : ""}</span>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <StuckList
          stuck={stuck}
          now={now}
          variant="row"
          where={showLead ? (s) => leadNameOf(s) : undefined}
          onOpened={onClose}
        />
        {jobs.map((w) => (
          <NeedsYouJobRow key={w.id} job={w} onOpened={onClose} />
        ))}
        {asks.map((ask) => (
          <div key={ask.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5" data-stuck-panel-ask={ask.id}>
            <div className="min-w-0 flex-1 truncate text-[13px] text-content/85">{ask.sentence}</div>
            {ask.actions.slice(0, 2).map((action) => (
              <button
                key={action.label}
                type="button"
                className="shrink-0 text-[12px] text-content/80"
                onClick={() => {
                  action.run();
                  onClose();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ))}
        {count ? null : (
          <div className="px-2 py-2 text-[13px] text-content/60" data-stuck-panel-empty>
            Nothing needs you now.
          </div>
        )}
      </div>
    </Popover>
  );
}

/** A red row with no worker behind it: what the job is, why only Ash can sort it, and its Lead's chat. */
function NeedsYouJobRow({ job, onOpened }: { job: Worker; onOpened: () => void }) {
  const reason = rowReason(job.stuckReason);
  const chip = workerChip(job);
  return (
    <div className="flex items-start gap-2 rounded-lg px-2 py-1.5" data-stuck-panel-job={job.id}>
      {chip ? <ChipMark chip={chip} /> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-content/85">{job.doing}</div>
        {reason ? <div className="text-[12px] text-content/60">{reason}</div> : null}
      </div>
      {job.lead ? (
        <OpenLeadLink
          name={job.who}
          onOpen={() => {
            if (!openLead(job.lead)) openMonoChat(job.lead!);
            onOpened();
          }}
        />
      ) : null}
    </div>
  );
}
