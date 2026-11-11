// Hivra WP-171: the fan-out host App.tsx lends the worker queue and its pump, built once per window. A provider's row
// this window lacks (after a restart) is read from the store before the queue decides, and a provider held for its
// fresh-eyes review (WP-144) reads as not started yet, so what needs it waits.
import { useMemo, useRef } from "react";
import { heldForReview } from "../../fresh-eyes/model/gate";
import { tauriDelegations, type Delegation } from "../../monos/model/delegations";
import { fanoutHost, type FanoutHost } from "../host/fanoutHost";
import { tauriFanoutCheckpoints } from "../host/fanoutCheckpointStore";

export type FanoutWindow = {
  /** Every row this window has: the open ones and the recent ones, any version. */
  rows(): readonly Delegation[];
  /** The project folder a worker chat works for (where its finished work landed). */
  folder(session: string): string | undefined;
};

/** The app's own fan-out host: the store for a row this window lacks, and the fresh-eyes record for a held brief. */
export function appFanoutHost(view: FanoutWindow, store: Pick<typeof tauriDelegations, "owned"> = tauriDelegations): FanoutHost {
  return fanoutHost({
    rows: view.rows,
    fetch: async (owner, session) => (await store.owned({ ownerSession: owner, requestIds: [session] }))[0],
    folder: view.folder,
    reviewing: (session) => heldForReview(session),
    // WP-172: a provider started again is found through its plan's record.
    checkpoints: () => tauriFanoutCheckpoints,
  });
}

/** One host for the window's life; it always reads the window's latest rows and chats. */
export function useFanoutHost(view: FanoutWindow): FanoutHost {
  const latest = useRef(view);
  latest.current = view;
  return useMemo(
    () => appFanoutHost({ rows: () => latest.current.rows(), folder: (session) => latest.current.folder(session) }),
    [],
  );
}
