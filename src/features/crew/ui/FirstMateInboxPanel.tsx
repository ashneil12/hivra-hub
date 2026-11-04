// Hivra WP-15: first-mate items in the Inbox, and the quiet digest.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { DELEGATIONS_CHANGED, tauriDelegations, type Delegation } from "../../monos/model/delegations";
import { DECISIONS_CHANGED, tauriFirstMate, type Decision } from "../../firstmate/model/steering";
import { publish, readDigestStore, writeDigestStore, type DigestPlan } from "../model/digest";
import { afterAnswer, inboxItems, noticesFrom, type FirstMateItem } from "../model/inbox";
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

  const load = useCallback(async () => {
    const ticket = ++generation.current;
    const recent = tauriDelegations.recent
      ? tauriDelegations.recent(0).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const }))
      : Promise.resolve({ ok: false as const });
    const [listed, asked, delivered]: [Load<Delegation[]>, Load<Decision[]>, Load<unknown>] = await Promise.all([
      recent,
      tauriFirstMate.decisions().then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
      invoke("delivery_list", { project }).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    ]);
    if (!mounted.current || ticket !== generation.current) return;
    const nextRows = settleLoad(held.current.rows, listed.ok ? { ok: true, value: listed.value } : { ok: false });
    const nextDecisions = settleLoad(held.current.decisions, asked.ok && Array.isArray(asked.value) ? { ok: true, value: asked.value } : { ok: false });
    const nextDeliveries = settleLoad(
      held.current.deliveries,
      delivered.ok && Array.isArray(delivered.value)
        ? { ok: true, value: delivered.value.map(asDelivery).filter((row) => row != null) }
        : { ok: false },
    );
    setRows(nextRows.value);
    setDecisions(nextDecisions.value);
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
    const plan = publish({ read: readDigestStore, write: writeDigestStore }, noticesRef.current, Date.now());
    if (!plan) return;
    setShown((current) => (current?.state.version === plan.state.version ? current : plan));
  }, [noticeKey, clock]);

  async function onAnswer(item: FirstMateItem, answer: string) {
    if (!item.key) return;
    const previousRows = rows;
    const previousDecisions = decisions;
    const optimistic = afterAnswer(rows, decisions.find((decision) => decision.decisionKey === item.key), answer);
    if (!optimistic.applied) return;
    const answered = decisions.map((decision) =>
      decision.decisionKey === item.key ? { ...decision, state: "answered" as const, answer } : decision,
    );
    held.current = { ...held.current, rows: optimistic.rows, decisions: answered };
    setRows(optimistic.rows);
    setDecisions(answered);
    try {
      const outcome = await tauriFirstMate.answer(item.project, item.key, answer);
      if (!outcome.applied) {
        held.current = { ...held.current, rows: previousRows, decisions: previousDecisions };
        setRows(previousRows);
        setDecisions(previousDecisions);
      }
    } catch {
      // A timeout is not a final no. The answer stays on screen and the next load checks.
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
