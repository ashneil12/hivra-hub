import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterAnswer, inboxItems, noticesFrom, type DecisionInput } from "../../src/features/crew/model/inbox";
import { EMPTY_DIGEST, planDigest, type DigestPlan, type DigestState } from "../../src/features/crew/model/digest";
import { crewRows, type CrewWorkerInput } from "../../src/features/crew/model/rows";
import { CrewTab } from "../../src/features/crew/ui/CrewTab";
import { DigestBanner } from "../../src/features/crew/ui/DigestBanner";
import { FirstMateInbox } from "../../src/features/crew/ui/FirstMateInbox";
import "../../src/styles/index.css";

const PROJECT = "/work/proj";
const START = 1_700_000_000_000;
const HOUR = 60 * 60_000;

const SESSIONS = [
  { id: "chat-working", harness: "claude", model: "opus", branch: "fix-save", additions: 12, deletions: 3 },
];

const DELIVERIES = [
  { delegationId: "done", mode: "pr", state: "ready", url: "https://github.com/acme/app/pull/12", number: 12, branch: "fix-save", updatedAt: 1 },
];

const CHECKS = [{ url: "https://github.com/acme/app/pull/12", number: 12, pending: 1, failed: [], passed: false, checks: 1 }];

function initialRows(): CrewWorkerInput[] {
  return [
    { id: "working", project: PROJECT, title: "Fix the save bug", status: "working", createdAt: START - 12 * 60_000, updatedAt: START, childSession: "chat-working", ownerSession: "lead" },
    { id: "needs", project: PROJECT, title: "Which name to ship", status: "needs-you", createdAt: START - 8 * 60_000, updatedAt: START, childSession: "chat-needs", ownerSession: "lead" },
    { id: "done", project: PROJECT, title: "Ready to land", status: "done", createdAt: START - 60 * 60_000, settledAt: START, updatedAt: START, childSession: "chat-done" },
    {
      id: "failed",
      project: PROJECT,
      title: "Save bug",
      status: "failed",
      createdAt: START - 20 * 60_000,
      updatedAt: START,
      childSession: "chat-failed",
      statusNotice: "The save did not finish.",
      error: "at save (/tmp/a.ts:1)\nsk-live-secret",
    },
    {
      id: "paused",
      project: PROJECT,
      title: "Waiting on the limit",
      status: "paused",
      errorClass: "usage_limit",
      statusNotice: "Waiting for a usage limit",
      createdAt: START - 30 * 60_000,
      updatedAt: START,
      childSession: "chat-paused",
    },
  ];
}

const OPEN_DECISION: DecisionInput = {
  project: PROJECT,
  decisionKey: "ship",
  question: "Ship it now?",
  options: ["Ship it", "Wait"],
  recommended: "Ship it",
  askedBy: "lead-chat",
  waiting: ["needs"],
  state: "open",
  updatedAt: START,
};

function Fixture() {
  const [rows, setRows] = useState(initialRows);
  const [decision, setDecision] = useState(OPEN_DECISION);
  const [quiet, setQuiet] = useState(false);
  const [now, setNow] = useState(START);
  const [digest, setDigest] = useState<DigestState>(EMPTY_DIGEST);
  const [shown, setShown] = useState<DigestPlan | null>(null);

  const decisions = !quiet && decision.state === "open" ? [decision] : [];
  const source = quiet ? [] : rows;
  const items = inboxItems({ project: PROJECT, decisions, rows: source, deliveries: DELIVERIES });
  const notices = noticesFrom(items, source);
  const noticeKey = notices.map((notice) => notice.id).join("|");
  const crew = crewRows({
    project: PROJECT,
    rows,
    sessions: SESSIONS,
    deliveries: DELIVERIES,
    checks: CHECKS,
    now: START + 12 * 60_000,
  });

  useEffect(() => {
    if (quiet) return;
    const plan = planDigest(digest, notices, now);
    setShown((current) => {
      if (current && current.state.version === plan.state.version) return { ...current, immediate: plan.immediate };
      return plan;
    });
    if (plan.state.version !== digest.version) setDigest(plan.state);
    // The hour and the notices decide this. `digest` is what the plan reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeKey, now, quiet]);

  function answer(option: string) {
    const next = afterAnswer(rows, decision, option);
    if (!next.applied) return;
    setRows(next.rows);
    setDecision({ ...decision, state: "answered", answer: option });
  }

  function hour() {
    setNow((digest.lastDigestAt ?? now) + HOUR);
  }

  function quietHour() {
    const plan = planDigest(digest, [], (digest.lastDigestAt ?? now) + HOUR);
    setQuiet(true);
    setShown(plan);
  }

  return (
    <div data-window={digest.lastDigestAt ?? ""}>
      <div role="tablist" aria-label="Project">
        <button type="button" role="tab" aria-selected={false}>Explorer</button>
        <button type="button" role="tab" aria-selected={false}>Changes</button>
        <button type="button" role="tab" aria-selected={false}>History</button>
        <button type="button" role="tab" aria-selected>Crew</button>
      </div>
      <div role="tabpanel" aria-label="Crew">
        <CrewTab rows={crew} />
      </div>
      <DigestBanner immediate={shown?.immediate ?? []} digest={shown?.digest ?? null} />
      <FirstMateInbox items={items} onAnswer={(_item, option) => answer(option)} />
      <button type="button" onClick={hour}>An hour passes</button>
      <button type="button" onClick={quietHour}>A quiet hour</button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
