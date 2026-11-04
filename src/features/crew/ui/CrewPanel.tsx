// Hivra WP-15: the Crew tab. A refresh that fails keeps the last list.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DELEGATIONS_CHANGED, tauriDelegations, type Delegation } from "../../monos/model/delegations";
import { tauriFirstMate } from "../../firstmate/model/steering";
import { tauriPrWatches, type PrWatch } from "../../pr-watch/model/prWatches";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { clearCrewFocus, crewFocus, subscribeCrewFocus } from "../model/focus";
import {
  crewRows,
  httpsUrl,
  settleLoad,
  type CrewChecksInput,
  type CrewDeliveryInput,
  type CrewRow,
  type CrewWorkerInput,
} from "../model/rows";
import { CrewTab } from "./CrewTab";

type Load<T> = { ok: true; value: T } | { ok: false };

function asDelivery(value: unknown): CrewDeliveryInput | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return {
    delegationId: typeof row.delegationId === "string" ? row.delegationId : null,
    mode: typeof row.mode === "string" ? row.mode : null,
    state: typeof row.state === "string" ? row.state : null,
    url: typeof row.url === "string" ? row.url : null,
    number: typeof row.number === "number" ? row.number : null,
    branch: typeof row.branch === "string" ? row.branch : null,
    checkout: typeof row.checkout === "string" ? row.checkout : null,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
  };
}

function asChecks(watch: PrWatch): CrewChecksInput {
  const status = watch.status;
  return {
    number: watch.number,
    url: watch.url,
    repo: watch.repo,
    passed: status?.passed === true,
    pending: status?.pending,
    failed: Array.isArray(status?.failed) ? status.failed : [],
    checks: status?.checks,
  };
}

let messages = 0;

export function CrewPanel({
  project,
  sessions,
  onOpenSession,
}: {
  project: string;
  sessions: readonly SessionSummary[];
  onOpenSession: (sessionId: string) => void;
}) {
  const focus = useSyncExternalStore(subscribeCrewFocus, crewFocus, crewFocus);
  const [workers, setWorkers] = useState<CrewWorkerInput[]>([]);
  const [deliveries, setDeliveries] = useState<CrewDeliveryInput[]>([]);
  const [checks, setChecks] = useState<CrewChecksInput[]>([]);
  const [stale, setStale] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);
  const mounted = useRef(true);
  const held = useRef({ workers, deliveries, checks });
  held.current = { workers, deliveries, checks };

  const load = useCallback(async () => {
    const ticket = ++generation.current;
    const recent = tauriDelegations.recent
      ? tauriDelegations.recent(0).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const }))
      : Promise.resolve({ ok: false as const });
    const [listed, delivered, watches]: [Load<Delegation[]>, Load<unknown>, Load<PrWatch[]>] = await Promise.all([
      recent,
      invoke("delivery_list", { project }).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
      tauriPrWatches.list().then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    ]);
    if (!mounted.current || ticket !== generation.current) return;
    const nextWorkers = settleLoad(held.current.workers, listed.ok ? { ok: true, value: listed.value } : { ok: false });
    const nextDeliveries = settleLoad(
      held.current.deliveries,
      delivered.ok && Array.isArray(delivered.value)
        ? { ok: true, value: delivered.value.map(asDelivery).filter((row) => row != null) }
        : { ok: false },
    );
    const nextChecks = settleLoad(
      held.current.checks,
      watches.ok && Array.isArray(watches.value)
        ? { ok: true, value: watches.value.map(asChecks) }
        : { ok: false },
    );
    setWorkers(nextWorkers.value);
    setDeliveries(nextDeliveries.value);
    setChecks(nextChecks.value);
    setStale(nextWorkers.stale || nextDeliveries.stale || nextChecks.stale);
    setNow(Date.now());
  }, [project]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timers = [window.setInterval(() => void load(), 60_000)];
    let unlisten: (() => void) | undefined;
    let dead = false;
    void listen(DELEGATIONS_CHANGED, () => {
      if (!dead) void load();
    })
      .then((off) => {
        if (dead) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      mounted.current = false;
      for (const timer of timers) window.clearInterval(timer);
      unlisten?.();
    };
  }, [load]);

  const rows = crewRows({
    project,
    rows: workers,
    sessions,
    deliveries,
    checks,
    now,
    briefId: focus.briefId,
  });

  async function onMessage(row: CrewRow, text: string) {
    const body = text.trim();
    if (!body || !row.sessionId || !row.ownerSession) return;
    if (body.length > 2000) {
      setNote("That message is too long.");
      return;
    }
    messages += 1;
    try {
      await tauriFirstMate.record({
        ownerSession: row.ownerSession,
        childSession: row.sessionId,
        delegationId: row.id,
        requestId: `crew-${row.id}-${messages}`,
        text: body,
      });
      setNote("Sent.");
    } catch {
      setNote("Couldn't send that. Trying again.");
    }
  }

  async function onStop(row: CrewRow) {
    try {
      await tauriDelegations.cancel([row.id], "Stopped from the crew tab");
      setNote(null);
    } catch {
      setNote("Couldn't stop that. Trying again.");
    }
  }

  async function onRetry(row: CrewRow) {
    if (!row.ownerSession || !tauriDelegations.noteRedo) {
      setNote("Couldn't retry that. Trying again.");
      return;
    }
    messages += 1;
    try {
      await tauriDelegations.noteRedo(row.ownerSession, row.id, `crew-retry-${messages}`);
      setNote("Retry noted.");
    } catch {
      setNote("Couldn't retry that. Trying again.");
    }
  }

  async function onDeliver(row: CrewRow) {
    const url = httpsUrl(row.prUrl);
    if (url) {
      try {
        await openUrl(url);
      } catch {
        setNote("Couldn't open that. Trying again.");
      }
      return;
    }
    if (!row.checkout) return;
    try {
      await invoke("delivery_deliver", {
        input: { project, checkout: row.checkout, delegationId: row.id, title: row.title },
      });
      setNote(null);
      void load();
    } catch {
      setNote("Couldn't do that just now. Trying again.");
    }
  }

  return (
    <CrewTab
      rows={rows}
      briefTitle={focus.briefId ? "This brief" : null}
      stale={stale}
      note={note}
      onShowAll={clearCrewFocus}
      onOpen={(row) => {
        if (row.sessionId) onOpenSession(row.sessionId);
      }}
      onMessage={(row, text) => void onMessage(row, text)}
      onStop={(row) => void onStop(row)}
      onRetry={(row) => void onRetry(row)}
      onDeliver={(row) => void onDeliver(row)}
    />
  );
}
