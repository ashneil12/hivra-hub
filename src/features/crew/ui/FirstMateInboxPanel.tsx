// Hivra WP-15: first-mate items in the Inbox, and the quiet digest.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { DELEGATIONS_CHANGED, type Delegation } from "../../monos/model/delegations";
import { DECISIONS_CHANGED, tauriFirstMate, type Decision } from "../../firstmate/model/steering";
import { publish, readDigestStore, writeDigestStore, type DigestPlan } from "../model/digest";
import { afterAnswer, inboxItems, noticesFrom, preserveAnswer, refuseAnswer, type FirstMateItem } from "../model/inbox";
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
  const [clock, setClock] = useState(() => Date.now());
  const generation = useRef(0);
  const mounted = useRef(true);
  const held = useRef({ rows, decisions, deliveries });
  held.current = { rows, decisions, deliveries };
  // An answer whose send timed out. A later load must not paint that decision open again.
  const unanswered = useRef<{ key: string; answer: string; rows: CrewWorkerInput[] } | null>(null);
  // While an answer is in flight, a load must not paint over it.
  const holdPaint = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++generation.current;
    const [listed, asked, delivered]: [Load<Delegation[]>, Load<Decision[]>, Load<unknown>] = await Promise.all([
      loadCrewDelegations(),
      tauriFirstMate.decisions().then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
      invoke("delivery_list", { project }).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    ]);
    if (!mounted.current || ticket !== generation.current || holdPaint.current !== 0) return;
    const nextRows = settleLoad(held.current.rows, listed.ok ? { ok: true, value: listed.value } : { ok: false });
    const nextDecisions = settleLoad(held.current.decisions, asked.ok && Array.isArray(asked.value) ? { ok: true, value: asked.value } : { ok: false });
    const pending = unanswered.current;
    const decisionsKnown = asked.ok && Array.isArray(asked.value);
    const decisionOpen =
      !!pending &&
      (!decisionsKnown ||
        nextDecisions.value.some(
          (decision) => decision.decisionKey === pending.key && decision.state !== "answered",
        ));
    if (pending && decisionsKnown && !decisionOpen) unanswered.current = null;
    const keptRows = pending
      ? preserveAnswer(pending.rows, nextRows.value, decisionOpen)
      : nextRows.value;
    const keptDecisions = pending && decisionOpen
      ? nextDecisions.value.map((decision) =>
          decision.decisionKey === pending.key
            ? { ...decision, state: "answered" as const, answer: pending.answer }
            : decision,
        )
      : nextDecisions.value;
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
  const notices = noticesFrom(items, rows);
  const noticeKey = notices.map((notice) => `${notice.id}:${notice.immediate}`).join("|");
  const noticesRef = useRef(notices);
  noticesRef.current = notices;

  useEffect(() => {
    let dead = false;
    void publish({ read: readDigestStore, write: writeDigestStore }, noticesRef.current, Date.now()).then((plan) => {
      if (dead || !plan) return;
      setShown((current) => {
        if (noticesRef.current.length === 0) return { ...plan, immediate: [], digest: null };
        if (!plan.digest && current && current.state.version === plan.state.version) {
          return { ...current, immediate: plan.immediate };
        }
        return plan;
      });
    });
    return () => {
      dead = true;
    };
  }, [noticeKey, clock]);

  async function onAnswer(item: FirstMateItem, answerText: string) {
    if (!item.key) return;
    const snapshot = { rows, decisions };
    const optimistic = afterAnswer(rows, decisions.find((decision) => decision.decisionKey === item.key), answerText);
    if (!optimistic.applied) return;
    const answered = decisions.map((decision) =>
      decision.decisionKey === item.key ? { ...decision, state: "answered" as const, answer: answerText } : decision,
    );
    holdPaint.current = ++generation.current;
    held.current = { ...held.current, rows: optimistic.rows, decisions: answered };
    setRows(optimistic.rows);
    setDecisions(answered);
    let refused = false;
    try {
      const outcome = await tauriFirstMate.answer(item.project, item.key, answerText);
      if (!outcome.applied) refused = true;
    } catch {
      // A timeout is not a final no. The answer stays until a load shows it landed.
      unanswered.current = { key: item.key, answer: answerText, rows: optimistic.rows };
    }
    holdPaint.current = 0;
    if (!mounted.current) return;
    if (refused) {
      unanswered.current = null;
      const back = refuseAnswer(snapshot, { rows: held.current.rows, decisions: held.current.decisions }, false);
      held.current = { ...held.current, rows: back.rows, decisions: back.decisions };
      setRows(back.rows);
      setDecisions(back.decisions);
      return;
    }
    try {
      await load();
    } catch {
      // The optimistic rows stay.
    }
  }

  return (
    <>
      <DigestBanner immediate={shown?.immediate ?? []} digest={shown?.digest ?? null} />
      <FirstMateInbox
        items={items}
        stale={stale}
        onAnswer={(item, answer) => void onAnswer(item, answer)}
        onOpenChat={onOpenSession}
        onOpenWorker={(id) => {
          const chat = rows.find((row) => row.id === id)?.childSession;
          if (chat) onOpenSession?.(chat);
        }}
      />
    </>
  );
}
