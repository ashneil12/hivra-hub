// A Lead's delegated batch in its chat (H4; T3's agentSpawnSummary): one counted line ("Delegated 3: 2 working, 1
// failed"), then each worker's chat as a clickable chip with a Stop while it runs, and a grey Stalled beside one that
// stalled (workerStall.ts; its card above the composer says how). Ash's Stop on a row stops that task
// and everything it delegated in turn (stopTree.ts), and no report follows for it.
import { useState } from "react";
import { CircleAlert, Square } from "../../../shared/ui/icons";
import type { MonoSpawnedSession } from "../../sessions/model/session";
import {
  delegationActions,
  noteStopFailures,
  useDelegationRows,
} from "../model/delegationStore";
import { isOpenDelegation, type Delegation } from "../model/delegations";
import {
  batchRollup,
  cardView,
  delegationOf,
  launchState,
} from "../model/delegationView";
import type { LaunchedSessionView } from "../model/monoSpawnedSessions";
import { LaunchedSessionCard } from "./LaunchedSessionCard";
import { CrewE2eLinks } from "../../firstmate/ui/CrewE2eLinks";
import {
  dequeueWorker,
  heldLine,
  queuedWorker,
  queuedWaitLine,
  taskWait,
  useWorkerPoolVersion,
  type QueuedWorker,
} from "../model/workerPool";

/** Held, or still waiting on a provider: the card says so. A worker-limit wait does not. */
function waitsOnTask(job: QueuedWorker | undefined): boolean {
  const reason = job ? taskWait(job)?.reason : undefined;
  return reason === "held" || reason === "requires";
}

/** The row a launched chat's Stop acts on: its newest one, still running or asking. */
function stoppableRow(
  sessionId: string,
  rows: readonly Delegation[],
): Delegation | undefined {
  const row = delegationOf(sessionId, rows);
  return row && isOpenDelegation(row) ? row : undefined;
}

export function DelegationBatchRow({
  launches,
  views,
  openSessionId,
  onOpen,
}: {
  launches: readonly MonoSpawnedSession[];
  views?: ReadonlyMap<string, LaunchedSessionView>;
  openSessionId?: string;
  onOpen?: (sessionId: string) => void;
}) {
  const rows = useDelegationRows();
  useWorkerPoolVersion();
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  // One that waits for a free worker (H8) has no chat or row yet: its card says it waits.
  // (The app shows a chat it hasn't loaded as done, so its row and the queue decide, not its view.)
  const waiting = launches.map((launch) =>
    !delegationOf(launch.sessionId, rows)
      ? queuedWorker(launch.sessionId)
      : undefined,
  );
  const states = launches.map((launch, index) =>
    waiting[index]
      ? ("waiting" as const)
      : launchState(
          views?.get(launch.sessionId),
          delegationOf(launch.sessionId, rows),
        ),
  );
  const stop = (row: Delegation) => {
    const actions = delegationActions();
    if (!actions) return;
    setStopping((current) => new Set(current).add(row.childSession));
    void actions
      .stopRow(row)
      .then((result) => noteStopFailures(row.ownerSession, result))
      .catch(() =>
        noteStopFailures(row.ownerSession, { stopFailed: [row.childSession] }),
      )
      .finally(() =>
        setStopping((current) => {
          const next = new Set(current);
          next.delete(row.childSession);
          return next;
        }),
      );
  };
  return (
    <div data-delegation-batch className="flex flex-col gap-2">
      {launches.length > 1 ? (
        <div
          data-delegation-rollup
          className="font-sans text-[12px] text-content/55"
        >
          {batchRollup(states)}
        </div>
      ) : null}
      {launches.map((launch, index) => {
        const row = stoppableRow(launch.sessionId, rows);
        const running =
          states[index] === "working" ||
          states[index] === "input" ||
          states[index] === "stuck";
        const busy = stopping.has(launch.sessionId);
        return (
          <div
            key={launch.sessionId}
            className="flex min-w-0 items-center gap-1.5"
          >
            <LaunchedSessionCard
              launch={launch}
              view={
                waiting[index]
                  ? {
                      state: "waiting",
                      title: waiting[index]!.title,
                      // WP-171: held, or waiting on a provider, is another task. A free worker is the project's own limit.
                      forTask: waitsOnTask(waiting[index]),
                      waitingLine: queuedWaitLine(waiting[index]!),
                    }
                  : cardView(
                      views?.get(launch.sessionId),
                      delegationOf(launch.sessionId, rows),
                    )
              }
              stalled={states[index] === "stuck"}
              open={openSessionId === launch.sessionId}
              onOpen={
                onOpen && !waiting[index]
                  ? () => onOpen(launch.sessionId)
                  : undefined
              }
            />
            {waiting[index] ? (
              <button
                type="button"
                data-delegation-unqueue={launch.sessionId}
                onClick={() => void dequeueWorker(launch.sessionId)}
                title="Take it out of the queue: it never starts"
                aria-label={`Don't start ${waiting[index]!.title}`}
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 font-sans text-[12px] text-content/55 hover:bg-content/6 hover:text-content"
              >
                <Square className="size-3" strokeWidth={2} />
                Stop
              </button>
            ) : null}
            {row && views?.get(launch.sessionId)?.retryAt ? (
              <span
                data-delegation-held={launch.sessionId}
                className="min-w-0 truncate font-sans text-[12px] text-content/55"
              >
                {heldLine(
                  views.get(launch.sessionId)!.provider ?? "the provider's",
                  views.get(launch.sessionId)!.retryAt!,
                  Date.now(),
                )}
              </span>
            ) : null}
            {states[index] === "stuck" ? (
              <span
                data-delegation-stuck={launch.sessionId}
                className="flex shrink-0 items-center gap-1 font-sans text-[12px] text-content/55"
              >
                <CircleAlert className="size-3.5" strokeWidth={1.75} />
                Stalled
              </span>
            ) : null}
            {row && running ? (
              <button
                type="button"
                data-delegation-stop={launch.sessionId}
                disabled={busy}
                onClick={() => stop(row)}
                title="Stop this task and everything it delegated"
                aria-label={`Stop ${row.title ?? "this task"}`}
                className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 font-sans text-[12px] text-content/55 hover:bg-content/6 hover:text-content disabled:opacity-50"
              >
                <Square className="size-3" strokeWidth={2} />
                {busy ? "Stopping" : "Stop"}
              </button>
            ) : null}
            {/* WP-42: .e2e proof on this worker's report, until the Crew tab lists it. */}
            <CrewE2eLinks report={delegationOf(launch.sessionId, rows)?.report} />
          </div>
        );
      })}
    </div>
  );
}
