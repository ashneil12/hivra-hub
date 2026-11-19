// Hivra WP-15: the Crew tab. A refresh that fails keeps the last list.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DELEGATIONS_CHANGED, type Delegation } from "../../monos/model/delegations";
import { tauriFirstMate } from "../../firstmate/model/steering";
import { tauriPrWatches, type PrWatch } from "../../pr-watch/model/prWatches";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { clearCrewFocus, crewFocus, holdCrewOpen, subscribeCrewFocus } from "../model/focus";
import { loadCrewDelegations } from "../model/load";
import { CREW_STOP_REASON, crewCancel, stopRequestId } from "../model/cancel";
import { crewDelegate, retrySameBrief } from "../model/retry";
import { steerRequestId } from "../model/steerId";
import {
  crewRows,
  httpsUrl,
  settleLoad,
  type CrewChecksInput,
  type CrewDeliveryInput,
  type CrewRow,
  type CrewWorkerInput,
} from "../model/rows";
import { GateCards } from "../../delivery-gate/ui/GateCards";
import { ShipCheckCard } from "../../hub/ui/ShipCheckCard"; // SC-3b
import { TestDebtLine } from "../../hub/ui/TestDebtLine"; // PT-5
import { FreshEyesPanel } from "../../fresh-eyes/ui/FreshEyesPanel";
import { LeadTickPanel } from "../../leadTick/ui/LeadTickPanel";
import { phaseDocLinks } from "../../phases/model/pr";
import { taskForCrew, workFor } from "../../phases/model/store";
import { crewTree } from "../model/crewTree";
import { CrewTab } from "./CrewTab";
import { useCrewSessions } from "./useCrewSessions";
import { TaskPane } from "../../tasks/ui/TaskPane";

// steering.rs `TEXT_MAX`. Counted in Unicode scalar values, the same as `chars().count()`.
const STEER_TEXT_MAX = 8_000;

function steerTextLength(text: string): number {
  return Array.from(text).length;
}

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
    const [listed, delivered, watches]: [Load<Delegation[]>, Load<unknown>, Load<PrWatch[]>] = await Promise.all([
      loadCrewDelegations(),
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

  useEffect(() => holdCrewOpen(), [focus.version]);

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

  // WP-119: the tree is built from the crew and the chats already open.
  const extraIds = useMemo(() => {
    const ids = new Set<string>();
    for (const worker of workers) {
      if (typeof worker.ownerSession === "string" && worker.ownerSession.trim()) ids.add(worker.ownerSession.trim());
      if (typeof worker.childSession === "string" && worker.childSession.trim()) ids.add(worker.childSession.trim());
    }
    return [...ids].sort();
  }, [workers]);
  const liveSessions = useCrewSessions(project, extraIds);
  // Built again only when something it draws changes, not on every render of the panel.
  const tree = useMemo(() => crewTree({ project, workers, sessions: liveSessions, now }), [project, workers, liveSessions, now]);

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
    if (!rows.some((item) => item.id === row.id)) return;
    if (steerTextLength(body) > STEER_TEXT_MAX) {
      const tooLong = `A message can be ${STEER_TEXT_MAX} characters at most.`;
      setNote(tooLong);
      throw new Error(tooLong);
    }
    try {
      await tauriFirstMate.record({
        ownerSession: row.ownerSession,
        childSession: row.sessionId,
        delegationId: row.id,
        requestId: steerRequestId(row.id),
        text: body,
      });
      setNote("Sent.");
    } catch (error) {
      setNote("Couldn't send that. Try again.");
      throw error instanceof Error ? error : new Error("Couldn't send that.");
    }
  }

  async function onRetry(row: CrewRow) {
    if (!rows.some((item) => item.id === row.id)) return;
    const worker = workers.find((item) => item.id === row.id);
    if (!worker?.ownerSession) return;
    try {
      await retrySameBrief(worker, (requestId, input) =>
        crewDelegate(worker.ownerSession as string, requestId, input),
      );
      setNote(null);
      void load();
    } catch {
      setNote("Couldn't retry that. Try again.");
    }
  }

  async function onStop(row: CrewRow) {
    // The list is already this project. A row that is not on it is not stopped.
    if (!rows.some((item) => item.id === row.id)) return;
    if (!row.ownerSession) return;
    try {
      // WP-15: the owner's tasks.cancel, which stops a busy child, unqueues a waiter, and cancels what it delegated.
      await crewCancel(row.ownerSession, stopRequestId(row.id), {
        taskId: row.id,
        reason: CREW_STOP_REASON,
      });
      setNote(null);
      void load();
    } catch {
      setNote("Couldn't stop that. Try again.");
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
      // WP-84: link this task's phase documents. A straight build, or a crew with no task, adds none.
      const named = workers.find((item) => item.id === row.id)?.taskId;
      const taskId = taskForCrew(row.id, named);
      const phaseDocs = taskId ? phaseDocLinks(workFor(taskId)?.docs ?? []) : [];
      await invoke("delivery_deliver", {
        input: { project, checkout: row.checkout, delegationId: row.id, title: row.title, phaseDocs },
      });
      setNote(null);
      void load();
    } catch {
      setNote("Couldn't do that just now. Trying again.");
    }
  }

  return (
    <>
      {/* WP-81: the check on the crew's task, and one question when it needs a person. */}
      <GateCards project={project} />
      {/* SC-3b: the ship check, for a project that tests at ship (or has a result). The one primary button on this tab. */}
      <ShipCheckCard project={project} />
      {/* PT-5: tests waiting to be sorted at ship, one quiet line. */}
      <TestDebtLine project={project} />
      {/* WP-144: one line before the crew starts, off until this project turns it on. */}
      <FreshEyesPanel project={project} />
      {/* WP-160: the Lead's timed pass over the programme, off until this project turns it on. */}
      <LeadTickPanel project={project} />
      <CrewTab
        rows={rows}
        briefTitle={focus.briefId ? "This brief" : null}
        stale={stale}
        note={note}
        onShowAll={clearCrewFocus}
        onOpen={(row) => {
          if (row.sessionId) onOpenSession(row.sessionId);
        }}
        onMessage={(row, text) => onMessage(row, text)}
        onStop={(row) => void onStop(row)}
        onRetry={(row) => void onRetry(row)}
        onDeliver={(row) => void onDeliver(row)}
        tree={tree}
        onOpenChat={onOpenSession}
      />
      {/* WP-70: the tasks of this project, under the crew. */}
      <TaskPane project={project} />
    </>
  );
}
