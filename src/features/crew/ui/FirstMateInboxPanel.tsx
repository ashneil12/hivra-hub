// Hivra WP-15: first-mate items in the Inbox, and the quiet digest.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { DELEGATIONS_CHANGED, type Delegation } from "../../monos/model/delegations";
import { DECISIONS_CHANGED, tauriFirstMate, type Decision } from "../../firstmate/model/steering";
import { readDigestStore, showDigest, writeDigestStore, type DigestPlan } from "../model/digest";
import { afterAnswer, inboxItems, noticesFrom, preserveAnswer, refuseAnswer, type FirstMateItem } from "../model/inbox";
import { isSecretDecisionKey } from "../../hub/model/decisionKey";
import { takeHomeDecision } from "../../home/model/pending";
import { loadCrewDelegations } from "../model/load";
import type { CrewDeliveryInput, CrewWorkerInput } from "../model/rows";
import { settleLoad } from "../model/rows";
import { invoke } from "@tauri-apps/api/core";
import { DigestBanner } from "./DigestBanner";
import { FirstMateInbox } from "./FirstMateInbox";
import { StandingAnswersPanel } from "./StandingAnswersPanel";

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

/**
 * G10: what the panel hands the Inbox's one Needs you list. Each decision is drawn there as a row, and the row's answer
 * buttons run this panel's own versioned answer (`answer`), so the version check and the refusals stay in one place.
 */
export type FirstMateFold = {
  project: string;
  /** This project's open decisions, as the panel would have drawn them. Each carries the version it was drawn from. */
  decisions: readonly FirstMateItem[];
  /** The decision Home asked the Inbox to show, if any. */
  selectedKey: string | null;
  answer: (item: FirstMateItem, answer: string) => void;
  openChat: (sessionId: string) => void;
  openWorker: (workerId: string) => void;
};

/** A digest line about a decision. A folded decision is a Needs you row already, so its line is not repeated. */
function decisionLine(id: string): boolean {
  return id.startsWith("decision:");
}

export function FirstMateInboxPanel({
  cwd,
  onOpenSession,
  onFold,
}: {
  cwd?: string;
  onOpenSession?: (sessionId: string) => void;
  /** G10: given, the decisions go to the Needs you list through this, and the panel keeps the rest. */
  onFold?: (fold: FirstMateFold | null) => void;
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

  async function onAnswer(item: FirstMateItem, answerText: string, tries = 0, seenVersion?: number) {
    if (!item.key || !mounted.current) return;
    const snapshot = { rows: held.current.rows, decisions: held.current.decisions };
    const decision = snapshot.decisions.find((entry) => entry.decisionKey === item.key);
    if (tries > 0 && (!decision || decision.state === "answered")) return;
    // The version of the card that was painted. `held` is updated by a reload before React paints the new card, so a
    // tap in that gap must not send the newer version (fix round 6). A retry keeps the version from the first tap.
    const version = tries === 0 ? item.version : seenVersion;
    const optimistic = afterAnswer(snapshot.rows, decision, answerText);
    if (!optimistic.applied) return;
    // The card stays open until the server confirms. The waiters can show as working.
    pendingAnswer.current = { key: item.key, rows: optimistic.rows };
    held.current = { ...held.current, rows: optimistic.rows };
    setRows(optimistic.rows);
    answerFlight.current += 1;
    let applied = false;
    try {
      // The version of the card on screen: a secret card is answered only for the words the person read (fix round 4, N6).
      // A secret card accepts only `person`. Every other card in this Inbox is the person's tap, recorded as user.
      const by = isSecretDecisionKey(item.key) ? "person" : "user";
      const outcome = await tauriFirstMate.answer(item.project, item.key, answerText, by, version);
      applied = outcome.applied;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      answerFlight.current = Math.max(0, answerFlight.current - 1);
      if (!mounted.current) return;
      // The card changed after the tap. Do not send the answer again. The person reads the new card and taps again.
      if (/changed after you read it/i.test(message)) {
        pendingAnswer.current = null;
        void load();
        return;
      }
      // A timeout is not a final no. Try again with the version from the first tap, not whatever the card says now.
      if (/timed out|timeout/i.test(message) && tries < 2) {
        window.setTimeout(() => {
          if (!mounted.current) return;
          void onAnswer(item, answerText, tries + 1, version);
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
    answerFlight.current = Math.max(0, answerFlight.current - 1);
    if (!mounted.current) return;
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

  // G10: the folded decisions and the answer the Needs you rows run. The callbacks read the latest props through refs,
  // so the fold changes only when the decisions or the selection do.
  const answerRef = useRef(onAnswer);
  answerRef.current = onAnswer;
  const openRef = useRef(onOpenSession);
  openRef.current = onOpenSession;
  const answer = useCallback((item: FirstMateItem, text: string) => void answerRef.current(item, text), []);
  const openChat = useCallback((sessionId: string) => openRef.current?.(sessionId), []);
  const openWorker = useCallback((id: string) => {
    const chat = held.current.rows.find((row) => row.id === id)?.childSession;
    if (chat) openRef.current?.(chat);
  }, []);
  const folded = useMemo(
    () => (onFold ? inboxItems({ project, decisions, rows, deliveries }).filter((item) => item.kind === "decision") : []),
    [onFold, project, decisions, rows, deliveries],
  );
  useEffect(() => {
    onFold?.({ project, decisions: folded, selectedKey, answer, openChat, openWorker });
  }, [onFold, project, folded, selectedKey, answer, openChat, openWorker]);
  useEffect(() => () => onFold?.(null), [onFold]);
  const cards = onFold ? items.filter((item) => item.kind !== "decision") : items;
  const immediate = shown?.immediate ?? [];

  return (
    <>
      <DigestBanner
        immediate={onFold ? immediate.filter((line) => !decisionLine(line.id)) : immediate}
        digest={shown?.digest ?? null}
        onOpen={(id) => {
          // A line about a card below shows that card; a line about work that needs you opens that work's chat.
          const item = items.find((entry) => id.startsWith(`${entry.id}:`));
          if (item?.key) return setSelectedKey(item.key);
          const row = rows.find((entry) => id.startsWith(`needs:${entry.id}:`));
          const chat = row?.childSession ?? row?.ownerSession ?? item?.chatId;
          if (chat) onOpenSession?.(chat);
        }}
      />
      <FirstMateInbox
        items={cards}
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
      {/* WP-156: standing answers, hidden until the setting is on. */}
      <StandingAnswersPanel project={project} />
    </>
  );
}
