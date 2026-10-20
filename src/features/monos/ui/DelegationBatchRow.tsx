// A Lead's delegated batch in its chat (H4; T3's agentSpawnSummary): one counted line ("Delegated 3: 2 working, 1
// failed"), then each worker's chat as a clickable chip with a Stop while it runs. Ash's Stop on a row stops that task
// and everything it delegated in turn (stopTree.ts), and no report follows for it.
import { useState } from "react";
import { Square } from "../../../shared/ui/icons";
import type { MonoSpawnedSession } from "../../sessions/model/session";
import {
  delegationActions,
  noteStopFailures,
  useDelegationRows,
} from "../model/delegationStore";
import { isOpenDelegation, type Delegation } from "../model/delegations";
import {
  batchRollup,
  delegationOf,
  launchState,
} from "../model/delegationView";
import type { LaunchedSessionView } from "../model/monoSpawnedSessions";
import { LaunchedSessionCard } from "./LaunchedSessionCard";

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
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const states = launches.map((launch) =>
    launchState(
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
      .then((result) => noteStopFailures(row.ownerSession, result.stopFailed))
      .catch(() => noteStopFailures(row.ownerSession, [row.childSession]))
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
          states[index] === "working" || states[index] === "input";
        const busy = stopping.has(launch.sessionId);
        return (
          <div
            key={launch.sessionId}
            className="flex min-w-0 items-center gap-1.5"
          >
            <LaunchedSessionCard
              launch={launch}
              view={views?.get(launch.sessionId)}
              open={openSessionId === launch.sessionId}
              onOpen={onOpen ? () => onOpen(launch.sessionId) : undefined}
            />
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
          </div>
        );
      })}
    </div>
  );
}
