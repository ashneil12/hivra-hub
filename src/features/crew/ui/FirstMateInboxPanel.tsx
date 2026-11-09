// Hivra WP-15: first-mate items in the Inbox, and the quiet digest.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { DELEGATIONS_CHANGED, type Delegation } from "../../monos/model/delegations";
import { DECISIONS_CHANGED, tauriFirstMate, type Decision } from "../../firstmate/model/steering";
import { readDigestStore, showDigest, writeDigestStore, type DigestPlan } from "../model/digest";
import { afterAnswer, inboxItems, noticesFrom, preserveAnswer, refuseAnswer, type FirstMateItem } from "../model/inbox";
import { takeHomeDecision } from "../../home/model/pending";
import { loadCrewDelegations } from "../model/load";
import type { CrewDeliveryInput, CrewWorkerInput } from "../model/rows";
import { settleLoad } from "../model/rows";
import { invoke } from "@tauri-apps/api/core";
import { DigestBanner } from "./DigestBanner";
import { FirstMateInbox } from "./FirstMateInbox";

type Load<T> = { ok: true; value: T } | { ok: false };

function asDelivery(value: unknown): CrewDeliveryInput | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return {
    delegationId: typeof row.delegationId === "string" ? row.delegationId : null,
    state: typeof row.state === "string" ? row.state : null,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
  };
}

export function FirstMateInboxPanel({
  cwd,
  onOpenSession,
}: {
  cwd?: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const project = cwd ?? "";
  const [rows, setRows] = useState<CrewWorkerInput[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [deliveries, setDeliveries] = useState<CrewDeliveryInput[]>([]);
  const [stale, setStale] = useState(false);
  const [shown, setShown] = useState<DigestPlan | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const generation = useRef(0);
  const mounted = useRef(true);
  const held = useRef({ rows, decisions, deliveries });
  held.current = { rows, decisions, deliveries };
  // An answer that has not been confirmed. Its waiters stay working while the decision is still open.
  const pendingAnswer = useRef<{ key: string; rows: CrewWorkerInput[] } | null>(null);
  // While an answer is in flight, a load must not paint over it. A skipped load is run after.
  const answerFlight = useRef(0);
  const skippedLoad = useRef(0);

  const load = useCallback(async (): Promise<"applied" | "stale" | "busy" | "gone"> => {
    const ticket = ++generation.current;
    const [listed, asked, delivered]: [Load<Delegation[]>, Load<Decision[]>, Load<unknown>] = await Promise.all([
      loadCrewDelegations(),
      tauriFirstMate.decisions().then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
      invoke("delivery_list", { project }).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    ]);
    if (!mounted.current) return "gone";
    if (ticket !== generation.current) return "stale";
    if (answerFlight.current !== 0) {
      skippedLoad.current += 1;
      return "busy";
    }
    const nextRows = settleLoad(held.current.rows, listed.ok ? { ok: true, value: listed.value } : { ok: false });
    const nextDecisions = settleLoad(held.current.decisions, asked.ok && Array.isArray(asked.value) ? { ok: true, value: asked.value } : { ok: false });
    const pending = pendingAnswer.current;
    const decisionsKnown = asked.ok && Array.isArray(asked.value);
    const decisionOpen =
      !!pending &&
      (!decisionsKnown ||
        nextDecisions.value.some(
          (decision) => decision.decisionKey === pending.key && decision.state !== "answered",
        ));
    if (pending && decisionsKnown && !decisionOpen) pendingAnswer.current = null;
    const keptRows = pending
      ? preserveAnswer(pending.rows, nextRows.value, decisionOpen)
      : nextRows.value;
    // The decision stays as the server sent it. A timeout must not paint it answered.
    const keptDecisions = nextDecisions.value;
    const nextDeliveries = settleLoad(
      held.current.deliveries,
      delivered.ok && Array.isArray(delivered.value)
        ? { ok: true, value: delivered.value.map(asDelivery).filter((row) => row != null) }
        : { ok: false },
    );
    held.current = { rows: keptRows, decisions: keptDecisions, deliveries: nextDeliveries.value };
    setRows(keptRows);
    setDecisions(keptDecisions);
    setDeliveries(nextDeliveries.value);
    setStale(nextRows.stale || nextDecisions.stale || nextDeliveries.stale);
    return "applied";
  }, [project]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => {
      setClock(Date.now());
      void load();
    }, 60_000);
    let unlistens: Array<() => void> = [];
    let dead = false;
    void Promise.all([
      listen(DELEGATIONS_CHANGED, () => {
        if (!dead) void load();
      }),
      listen(DECISIONS_CHANGED, () => {
        if (!dead) void load();
      }),
    ])
      .then((offs) => {
        if (dead) for (const off of offs) off();
        else unlistens = offs;
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      mounted.current = false;
      window.clearInterval(timer);
      for (const off of unlistens) off();
    };
  }, [load]);

  const items = inboxItems({ project, decisions, rows, deliveries });
  useEffect(() => {
    const key = takeHomeDecision(items.filter((item) => item.kind === "decision").map((item) => ({ key: item.key, project: item.project })));
    if (key) setSelectedKey(key);
  }, [items]);
  const notices = noticesFrom(items, rows);
  const noticeKey = notices.map((notice) => `${notice.id}:${notice.immediate}`).join("|");
  const noticesRef = useRef(notices);
  noticesRef.current = notices;

  useEffect(() => {
    let dead = false;
    void showDigest(
      { read: readDigestStore, write: writeDigestStore },
      noticesRef.current,
      Date.now(),
      {
        show: (plan) => {
          if (dead) return;
          setShown((current) => {
            if (noticesRef.current.length === 0) return { ...plan, immediate: [], digest: null };
            if (!plan.digest && current && current.state.version === plan.state.version) {
              return { ...current, immediate: plan.immediate };
            }
            return plan;
          });
        },
        cancelled: () => dead,
      },
    );
    return () => {
      dead = true;
    };
  }, [noticeKey, clock]);

  async function onAnswer(item: FirstMateItem, answerText: string, tries = 0) {
    if (!item.key || !mounted.current) return;
    const snapshot = { rows: held.current.rows, decisions: held.current.decisions };
    const decision = snapshot.decisions.find((entry) => entry.decisionKey === item.key);
    if (tries > 0 && (!decision || decision.state === "answered")) return;
    const optimistic = afterAnswer(snapshot.rows, decision, answerText);
    if (!optimistic.applied) return;
    // The card stays open until the server confirms. The waiters can show as working.
    pendingAnswer.current = { key: item.key, rows: optimistic.rows };
    held.current = { ...held.current, rows: optimistic.rows };
    setRows(optimistic.rows);
    answerFlight.current += 1;
    let applied = false;
    let threw = false;
    try {
      const outcome = await tauriFirstMate.answer(item.project, item.key, answerText);
      applied = outcome.applied;
    } catch {
      // A timeout is not a final no. The decision stays open and is tried again.
      threw = true;
    }
    answerFlight.current = Math.max(0, answerFlight.current - 1);
    if (!mounted.current) return;
    if (threw) {
      if (tries < 2) {
        window.setTimeout(() => {
          if (!mounted.current) return;
          void onAnswer(item, answerText, tries + 1);
        }, 0);
        return;
      }
      pendingAnswer.current = null;
      if (answerFlight.current === 0 && skippedLoad.current > 0) {
        skippedLoad.current = 0;
        void load();
      }
      return;
    }
    if (!applied) {
      pendingAnswer.current = null;
      const skipped = skippedLoad.current;
      skippedLoad.current = 0;
      let end: "applied" | "stale" | "busy" | "gone" = "gone";
      try {
        end = await load();
      } catch {
        end = "gone";
      }
      if (!mounted.current || end === "gone" || end === "stale") return;
      // A reload that landed, one that was skipped for a flight, or a flight still going: keep that, not the click.
      const newer = end === "applied" || end === "busy" || skipped > 0;
      const back = refuseAnswer(snapshot, { rows: held.current.rows, decisions: held.current.decisions }, newer);
      held.current = { ...held.current, rows: back.rows, decisions: back.decisions };
      setRows(back.rows);
      setDecisions(back.decisions);
      if (end === "busy" && answerFlight.current === 0) void load();
      return;
    }
    pendingAnswer.current = null;
    try {
      await load();
    } catch {
      // The next load paints what the server has.
    }
  }

  return (
    <>
      <DigestBanner immediate={shown?.immediate ?? []} digest={shown?.digest ?? null} />
      <FirstMateInbox
        items={items}
        stale={stale}
        selectedKey={selectedKey}
        onAnswer={(item, answer) => void onAnswer(item, answer)}
        onOpenChat={onOpenSession}
        now={clock}
        onOpenWorker={(id) => {
          const chat = rows.find((row) => row.id === id)?.childSession;
          if (chat) onOpenSession?.(chat);
        }}
      />
    </>
  );
}
