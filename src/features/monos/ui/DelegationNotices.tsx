// The two lines the delegation tree adds around a chat's composer (H4):
// - a worker's chat runs on its own, so it shows "Runs on its own · Open <Lead>" instead of the composer; the Lead
//   does the talking, and Ash can still jump in;
// - a Lead with delegated work out reads its rollup ("Delegated 3: 2 working, 1 failed"; "Waiting on N" without one),
//   with one Stop for everything beneath it, and above it a card for each worker that is stuck (StuckWorkerCard.tsx).
import { useState } from "react";
import { Square } from "../../../shared/ui/icons";
import type { StuckWorker } from "../model/workerStuck";
import { StuckList } from "./StuckWorkerCard";

export function DelegatedChatNotice({
  ownerName,
  state,
  onOpenOwner,
  onJumpIn,
}: {
  ownerName: string;
  /** Where its work stands: still running, asking its Lead, or finished. */
  state: "running" | "asking" | "finished";
  onOpenOwner?: () => void;
  onJumpIn: () => void;
}) {
  const lead =
    state === "asking"
      ? `Asked ${ownerName} a question`
      : state === "finished"
        ? `Worked for ${ownerName}`
        : "Runs on its own";
  return (
    <div
      data-delegated-chat
      className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-2xl border border-content/10 px-4 py-3 font-sans text-[13px] text-content/60"
    >
      <span className="min-w-0 truncate">
        {lead}
        <span aria-hidden className="px-1.5 opacity-60">
          ·
        </span>
        {onOpenOwner ? (
          <button
            type="button"
            onClick={onOpenOwner}
            className="rounded text-content underline-offset-2 hover:underline"
          >
            Open {ownerName}
          </button>
        ) : (
          <span>{ownerName} talks to it</span>
        )}
      </span>
      <button
        type="button"
        data-jump-in
        onClick={onJumpIn}
        className="ml-auto shrink-0 rounded-lg px-2 py-1 text-[12px] text-content/55 hover:bg-content/6 hover:text-content"
      >
        Jump in
      </button>
    </div>
  );
}

export function DelegationWaitingLine({
  count,
  rollup,
  stuck = [],
  now = Date.now(),
  failed = [],
  unloaded = [],
  onStopAll,
}: {
  count: number;
  /** "Delegated 3: 2 working, 1 failed", in place of "Waiting on N". */
  rollup?: string;
  /** Its workers that are stuck: a card each, above the line. */
  stuck?: readonly StuckWorker[];
  now?: number;
  /** Chats the last Stop couldn't stop, by title. */
  failed?: readonly string[];
  /** Chats whose workers the last Stop couldn't load (they may still be running), by title. */
  unloaded?: readonly string[];
  onStopAll?: () => Promise<unknown> | void;
}) {
  const [stopping, setStopping] = useState(false);
  if (count <= 0 && !failed.length && !unloaded.length && !stuck.length)
    return null;
  const line = rollup ?? (count > 0 ? `Waiting on ${count}` : undefined);
  return (
    <>
      <StuckList stuck={stuck} now={now} variant="chat" label="Stuck workers" />
      <div
        data-delegation-waiting={count}
        className="flex items-center gap-2 px-1 pb-1.5 font-sans text-[12px] text-content/55"
      >
        {line ? <span data-delegation-rollup-line>{line}</span> : null}
        {failed.length ? (
          <span
            className="min-w-0 truncate text-amber-400"
            title={failed.join(", ")}
          >
            Couldn&apos;t stop{" "}
            {failed.length === 1 ? failed[0] : `${failed.length} chats`}
          </span>
        ) : null}
        {unloaded.length ? (
          <span
            data-delegation-unloaded
            className="min-w-0 truncate text-amber-400"
            title={unloaded.join(", ")}
          >
            Couldn&apos;t load the workers under{" "}
            {unloaded.length === 1 ? unloaded[0] : `${unloaded.length} chats`};
            they may still be running
          </span>
        ) : null}
        {onStopAll && count > 0 ? (
          <button
            type="button"
            data-delegation-stop-all
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void Promise.resolve(onStopAll()).finally(() =>
                setStopping(false),
              );
            }}
            title="Stop everything it delegated"
            className="ml-auto flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 hover:bg-content/6 hover:text-content disabled:opacity-50"
          >
            <Square className="size-3" strokeWidth={2} />
            {stopping ? "Stopping" : "Stop all"}
          </button>
        ) : null}
      </div>
    </>
  );
}
