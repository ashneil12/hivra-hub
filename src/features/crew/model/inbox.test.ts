import { describe, expect, it } from "vitest";
import { afterAnswer, failureWords, inboxItems, noticesFrom, preserveAnswer, refuseAnswer, type DecisionInput } from "./inbox";
import type { CrewWorkerInput } from "./rows";

const PROJECT = "/work/proj";

function decision(patch: Partial<DecisionInput> = {}): DecisionInput {
  return {
    project: PROJECT,
    decisionKey: "ship",
    question: "Ship it now?",
    options: ["Ship it", "Wait"],
    recommended: "Ship it",
    askedBy: "lead-chat",
    waiting: ["w-needs"],
    state: "open",
    updatedAt: 10,
    ...patch,
  };
}

function worker(patch: Partial<CrewWorkerInput> & { id: string }): CrewWorkerInput {
  return { project: PROJECT, title: patch.id, updatedAt: 5, ...patch };
}

describe("failure words", () => {
  it("drops a stack frame and a secret, and still says it failed when nothing plain is left", () => {
    expect(failureWords("The save did not finish.", "at save (/tmp/a.ts:1)\nsk-live-secret")).toBe(
      "The save did not finish.",
    );
    expect(failureWords("at save (/tmp/a.ts:1)", "api key sk-live")).toBe("This work failed.");
    expect(failureWords("", "")).toBe("This work failed.");
    expect(failureWords(null, "token abc")).toBe("This work failed.");
  });
});

describe("inbox items", () => {
  const rows: CrewWorkerInput[] = [
    worker({ id: "w-needs", status: "needs-you", title: "The question", childSession: "chat-1" }),
    worker({ id: "w-done", status: "done", title: "Save bug", childSession: "chat-2" }),
    worker({
      id: "w-fail",
      status: "failed",
      title: "Save bug",
      childSession: "chat-3",
      statusNotice: "The save did not finish.",
      error: "at save (/tmp/a.ts:1)\nsk-live-secret",
    }),
    worker({
      id: "w-auth",
      status: "failed",
      errorClass: "auth",
      error: "not signed in",
      title: "Docs",
    }),
    worker({
      id: "w-limit",
      status: "paused",
      errorClass: "usage_limit",
      statusNotice: "Waiting for a usage limit",
    }),
    worker({ id: "w-down", status: "failed", errorClass: "overloaded", error: "overloaded" }),
    worker({ id: "w-landed", status: "done", title: "Already in" }),
    worker({ id: "other", project: "/elsewhere", status: "failed", title: "Not here" }),
  ];

  const items = () =>
    inboxItems({
      project: `${PROJECT}/`,
      decisions: [decision(), decision({ project: "/elsewhere", decisionKey: "away" })],
      rows,
      deliveries: [{ delegationId: "w-landed", state: "merged", updatedAt: 1 }],
    });

  it("lists a decision, a review, a failure and a credential need, and not another project's row", () => {
    const shown = items();
    expect(shown.map((item) => item.kind)).toEqual([
      "decision",
      "credential",
      "credential",
      "failure",
      "failure",
      "review",
    ]);
    expect(shown.find((item) => item.kind === "decision")).toMatchObject({
      title: "Ship it now?",
      options: ["Ship it", "Wait"],
      recommended: "Ship it",
      chatId: "lead-chat",
      workerIds: ["w-needs"],
      statusWord: "needs you",
    });
    const failure = shown.find((item) => item.id === "failure:w-fail");
    expect(failure?.body).toBe("The save did not finish.");
    expect(failure?.body).not.toMatch(/sk-|at save/);
    expect(failure?.statusWord).toBe("failed");
    expect(shown.find((item) => item.id === "credential:w-auth")?.title).toBe("Needs a sign-in");
    expect(shown.find((item) => item.id === "credential:w-limit")?.title).toBe("Waiting for a usage limit");
    expect(shown.find((item) => item.id === "credential:w-limit")?.statusWord).toBe("paused");
    expect(shown.find((item) => item.id === "failure:w-down")?.body).toBe("overloaded");
    expect(shown.some((item) => item.id.includes("other") || item.id.includes("w-landed") || item.id.includes("w-needs"))).toBe(
      false,
    );
    expect(shown.some((item) => item.key === "away")).toBe(false);
  });

  it("ignores a recommended option that is not one of the choices, and duplicate or empty choices", () => {
    const shown = inboxItems({
      project: PROJECT,
      decisions: [
        decision({
          options: ["Ship it", "", "Ship it", 1, "Wait"],
          recommended: "Something else",
        }),
      ],
    });
    expect(shown[0]?.options).toEqual(["Ship it", "Wait"]);
    expect(shown[0]?.recommended).toBeNull();
  });

  it("keeps the newer decision when the same key arrives twice, and skips one already answered", () => {
    const shown = inboxItems({
      project: PROJECT,
      decisions: [
        decision({ question: "Old", updatedAt: 1 }),
        decision({ question: "New", updatedAt: 2 }),
        decision({ decisionKey: "done", state: "answered", question: "Answered" }),
      ],
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe("New");
  });

  it("says the CLI is missing from the words, and a timeout is not a credential", () => {
    const shown = inboxItems({
      project: PROJECT,
      rows: [
        worker({ id: "cli", status: "failed", error: "claude isn't installed" }),
        worker({ id: "slow", status: "failed", error: "Timed out" }),
      ],
    });
    expect(shown.find((item) => item.id === "credential:cli")?.title).toBe("The CLI is missing");
    expect(shown.find((item) => item.id === "failure:slow")?.kind).toBe("failure");
  });

  it("tells needs you at once, and leaves a failure for the digest", () => {
    const shown = items();
    const notices = noticesFrom(shown, rows);
    expect(notices.find((notice) => notice.title === "Ship it now?")?.immediate).toBe(true);
    expect(notices.find((notice) => notice.title === "Waiting for a usage limit")?.immediate).toBe(false);
    expect(notices.find((notice) => notice.title === "Needs a sign-in")?.immediate).toBe(true);
    expect(notices.find((notice) => notice.id.startsWith("failure:"))?.immediate).toBe(false);
    expect(notices.find((notice) => notice.id.startsWith("review:"))?.immediate).toBe(false);
    expect(notices.some((notice) => notice.id.startsWith("needs:w-needs"))).toBe(false);
    const blocked = noticesFrom([], [worker({ id: "blocked", status: "needs-you", title: "Blocked" })]);
    expect(blocked).toEqual([
      { id: "needs:blocked:5", immediate: true, title: "Blocked", at: 5 },
    ]);
  });

  it("shows nothing for an empty project", () => {
    expect(inboxItems({ project: "", decisions: [decision()], rows })).toEqual([]);
    expect(inboxItems({ project: "~", decisions: [decision()], rows })).toEqual([]);
  });
});

describe("a timed-out answer", () => {
  it("keeps the working row when a later load still shows the decision open", () => {
    const held = [
      { id: "w1", status: "working" },
      { id: "w2", status: "working" },
    ];
    const loaded = [
      { id: "w1", status: "needs-you" },
      { id: "other", status: "done" },
    ];
    expect(preserveAnswer(held, loaded, true)).toEqual([
      { id: "w1", status: "working" },
      { id: "other", status: "done" },
      { id: "w2", status: "working" },
    ]);
    expect(preserveAnswer(held, loaded, false)).toEqual(loaded);
  });

  it("does not put the click back over a newer load when the answer was refused", () => {
    const snapshot = [{ id: "w1", status: "needs-you" }];
    const newer = [{ id: "w1", status: "done" }];
    expect(refuseAnswer(snapshot, newer, true)).toBe(newer);
    expect(refuseAnswer(snapshot, newer, false)).toBe(snapshot);
  });
});

describe("answering a decision", () => {
  const open = decision({ waiting: ["w1", "w2"] });
  const rows = [
    { id: "w1", status: "needs-you", questionOwner: "person" },
    { id: "w2", status: "needs-you" },
    { id: "w3", status: "needs-you" },
    { id: "w4", status: "failed" },
  ];

  it("releases only the waiters, from needs you to working", () => {
    const next = afterAnswer([...rows, { id: "w1", status: "needs-you" }], open, "Ship it");
    expect(next.applied).toBe(true);
    expect(next.rows.find((row) => row.id === "w1")?.status).toBe("working");
    expect(next.rows.find((row) => row.id === "w2")).toMatchObject({
      status: "working",
      questionOwner: null,
      statusNotice: "Asked its first mate",
    });
    expect(next.rows.find((row) => row.id === "w3")?.status).toBe("needs-you");
    expect(next.rows.filter((row) => row.id === "w1")).toHaveLength(2);
  });

  it("does nothing for an empty answer, a second answer, a missing decision, or one that is too long", () => {
    expect(afterAnswer(rows, open, "   ").applied).toBe(false);
    expect(afterAnswer(rows, open, "x".repeat(2001)).applied).toBe(false);
    expect(afterAnswer(rows, undefined, "Ship it").applied).toBe(false);
    expect(afterAnswer(rows, { ...open, state: "answered" }, "Wait").applied).toBe(false);
    expect(afterAnswer(rows, { ...open, decisionKey: "  " }, "Wait").applied).toBe(false);
    const first = afterAnswer(rows, open, "Ship it");
    const second = afterAnswer(first.rows, { ...open, state: "answered" }, "Wait");
    expect(second.applied).toBe(false);
    expect(second.rows).toEqual(first.rows);
  });

  it("does not turn a failed waiter into working", () => {
    const next = afterAnswer(
      [{ id: "w4", status: "failed" }],
      decision({ waiting: ["w4"] }),
      "Ship it",
    );
    expect(next.applied).toBe(true);
    expect(next.rows[0]?.status).toBe("failed");
  });
});
