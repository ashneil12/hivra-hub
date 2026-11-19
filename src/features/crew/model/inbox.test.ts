import { describe, expect, it } from "vitest";
import { afterAnswer, failureWords, inboxItems, noticesFrom, preserveAnswer, refuseAnswer, waitingPhrase, type DecisionInput } from "./inbox";
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
    createdAt: 10,
    updatedAt: 10,
    ...patch,
  };
}

function worker(patch: Partial<CrewWorkerInput> & { id: string }): CrewWorkerInput {
  return { project: PROJECT, title: patch.id, createdAt: 5, updatedAt: 5, ...patch };
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

describe("inbox items: done work says how far it was checked (SC-3a)", () => {
  const review = (patch: Partial<CrewWorkerInput>) =>
    inboxItems({
      project: PROJECT,
      decisions: [],
      rows: [worker({ id: "w", status: "done", title: "Add a b export", ...patch })],
    })[0];

  it("adds the note to a done row that wasn't tested, and says nothing on a plain pass", () => {
    expect(review({ statusNotice: "Built, not tested yet" })).toMatchObject({
      kind: "review",
      title: "Ready for review",
      body: "Add a b export · Built, not tested yet",
    });
    expect(review({ statusNotice: "Not tested" })?.body).toBe("Add a b export · Not tested");
    expect(review({ statusNotice: "Accepted without a pass: the diff is right" })?.body).toBe(
      "Add a b export · Accepted without a pass: the diff is right",
    );
    expect(review({})?.body).toBe("Add a b export");
    expect(review({ statusNotice: null })?.body).toBe("Add a b export");
    expect(review({ statusNotice: "  \n " })?.body).toBe("Add a b export");
  });

  it("drops a stack frame or a secret from the note, and still reads with no title", () => {
    expect(review({ statusNotice: "at save (/tmp/a.ts:1)" })?.body).toBe("Add a b export");
    expect(review({ statusNotice: "token sk-live-abc" })?.body).toBe("Add a b export");
    expect(review({ title: "", statusNotice: "Built, not tested yet" })?.body).toBe("Built, not tested yet");
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

  it("puts the oldest question first, a credential between that and a failure, and the longest wait first inside the group", () => {
    const now = 1_000_000_000_000;
    const minute = 60_000;
    // Every row was touched a second ago (a stream update, a refresh). Only createdAt says how long it has waited.
    const touched = now - 1_000;
    const shown = inboxItems({
      project: PROJECT,
      decisions: [
        decision({ decisionKey: "new", question: "Newer question", createdAt: now - 5 * minute, updatedAt: touched, waiting: [] }),
        decision({ decisionKey: "old", question: "Oldest question", createdAt: now - 20 * minute, updatedAt: touched, waiting: [] }),
        decision({ decisionKey: "blank", question: "No clock", createdAt: 0, updatedAt: touched, waiting: [] }),
        decision({ decisionKey: "dashed", question: "Ship — it", createdAt: now - 3 * minute, updatedAt: touched, waiting: [] }),
      ],
      rows: [
        worker({ id: "ask", status: "needs-you", title: "A word please", createdAt: now - 12 * minute, updatedAt: touched, statusNotice: "Pick one", childSession: "chat-ask" }),
        worker({ id: "cred", status: "paused", errorClass: "auth", error: "not signed in", createdAt: now - 90 * minute, updatedAt: touched }),
        worker({ id: "permit", status: "needs-you", title: "Needs a folder", createdAt: now - 30 * minute, updatedAt: touched, statusNotice: "Needs permission to open the Documents folder" }),
        worker({ id: "boom", status: "failed", title: "It failed", createdAt: now - 40 * minute, updatedAt: touched, statusNotice: "The save did not finish." }),
        worker({ id: "ready", status: "done", title: "Ready work", createdAt: now - 8 * minute, updatedAt: touched }),
      ],
    });
    expect(shown.map((item) => item.title)).toEqual([
      "Oldest question",
      "A word please",
      "Newer question",
      "Ship, it",
      "No clock",
      "Needs a sign-in",
      "Needs a permission",
      "It failed",
      "Ready for review",
    ]);
    expect(shown[0]?.kind).toBe("decision");
    expect(shown.find((item) => item.id === "question:ask")).toMatchObject({ body: "Pick one", chatId: "chat-ask", statusWord: "needs you" });
    expect(shown.find((item) => item.title === "Needs a permission")?.body).toBe("Needs permission to open the Documents folder");
    expect(shown.findIndex((item) => item.kind === "failure")).toBeGreaterThan(shown.findIndex((item) => item.title === "Needs a sign-in"));
    expect(shown.findIndex((item) => item.title === "Needs a sign-in")).toBeGreaterThan(shown.findIndex((item) => item.title === "Newer question"));
    const notices = noticesFrom(shown, [
      worker({ id: "ask", status: "needs-you", title: "A word please", updatedAt: now - 12 * minute }),
    ]);
    expect(notices.find((notice) => notice.title === "A word please")?.immediate).toBe(true);
    expect(notices.some((notice) => notice.id.startsWith("needs:ask"))).toBe(false);
    expect(waitingPhrase(now - 12 * minute, now)).toBe("waiting 12 minutes");
    expect(waitingPhrase(now - minute, now)).toBe("waiting 1 minute");
    expect(waitingPhrase(now - 30_000, now)).toBe("waiting under a minute");
    expect(waitingPhrase(now - 3 * 60 * minute, now)).toBe("waiting 3 hours");
    expect(waitingPhrase(now - 3 * 24 * 60 * minute, now)).toBe("waiting 3 days");
    expect(waitingPhrase(0, now)).toBeNull();
    expect(waitingPhrase(Number.NaN, now)).toBeNull();
    expect(waitingPhrase(now + minute, now)).toBeNull();
  });

  describe("how long an item has waited", () => {
    const now = 1_000_000_000_000;
    const minute = 60_000;

    it("counts from createdAt, so an update that lands now does not reset the wait", () => {
      const shown = inboxItems({
        project: PROJECT,
        decisions: [decision({ decisionKey: "asked", waiting: [], createdAt: now - 40 * minute, updatedAt: now - 2_000 })],
        rows: [
          worker({ id: "ask", status: "needs-you", title: "Pick", createdAt: now - 25 * minute, updatedAt: now - 1_000 }),
          worker({ id: "boom", status: "failed", title: "Broke", createdAt: now - 15 * minute, updatedAt: now }),
        ],
      });
      const since = Object.fromEntries(shown.map((item) => [item.id, item.since]));
      expect(since[`decision:${PROJECT}:asked`]).toBe(now - 40 * minute);
      expect(since["question:ask"]).toBe(now - 25 * minute);
      expect(since["failure:boom"]).toBe(now - 15 * minute);
      expect(waitingPhrase(since["question:ask"]!, now)).toBe("waiting 25 minutes");
      // updatedAt still names the newest change, for the digest's notice ids.
      expect(shown.find((item) => item.id === "question:ask")?.updatedAt).toBe(now - 1_000);
    });

    it("counts a blocked row from when it got stuck, not from when the work began", () => {
      const shown = inboxItems({
        project: PROJECT,
        rows: [
          worker({
            id: "stuck",
            status: "needs-you",
            title: "Cannot finish",
            statusNotice: "Cannot finish: the deploy key is missing",
            stallKind: "blocked",
            stalledAt: now - 4 * minute,
            createdAt: now - 3 * 60 * minute,
            updatedAt: now - 1_000,
          }),
          worker({
            id: "asked",
            status: "needs-you",
            title: "A question",
            createdAt: now - 3 * 60 * minute,
            updatedAt: now - 1_000,
          }),
        ],
      });
      const stuck = shown.find((item) => item.id === "question:stuck");
      expect(stuck?.since).toBe(now - 4 * minute);
      expect(waitingPhrase(stuck!.since, now)).toBe("waiting 4 minutes");
      expect(shown.find((item) => item.id === "question:asked")?.since).toBe(now - 3 * 60 * minute);
      // The longer wait is first, so the question that has sat for three hours leads the one stuck for four minutes.
      expect(shown.map((item) => item.id)).toEqual(["question:asked", "question:stuck"]);
    });

    it("counts a failed, finished or failed-sign-in row from when it ended, not from when the work began", () => {
      const shown = inboxItems({
        project: PROJECT,
        rows: [
          // Made three hours ago, ended a minute ago: it has waited a minute, not three hours.
          worker({ id: "boom", status: "failed", title: "Broke", createdAt: now - 3 * 60 * minute, settledAt: now - minute, updatedAt: now }),
          worker({ id: "ready", status: "done", title: "Ready work", createdAt: now - 3 * 60 * minute, settledAt: now - 2 * minute, updatedAt: now }),
          worker({ id: "signin", status: "failed", errorClass: "auth", error: "not signed in", createdAt: now - 3 * 60 * minute, settledAt: now - 5 * minute, updatedAt: now }),
          // Not ended yet: no settledAt, so it counts from when it was made.
          worker({ id: "paused", status: "paused", errorClass: "auth", error: "not signed in", createdAt: now - 90 * minute, settledAt: null, updatedAt: now }),
          worker({ id: "ask", status: "needs-you", title: "Pick", createdAt: now - 3 * 60 * minute, settledAt: null, updatedAt: now }),
        ],
      });
      const since = Object.fromEntries(shown.map((item) => [item.id, item.since]));
      expect(since["failure:boom"]).toBe(now - minute);
      expect(since["review:ready"]).toBe(now - 2 * minute);
      expect(since["credential:signin"]).toBe(now - 5 * minute);
      expect(since["credential:paused"]).toBe(now - 90 * minute);
      expect(since["question:ask"]).toBe(now - 3 * 60 * minute);
      expect(waitingPhrase(since["failure:boom"]!, now)).toBe("waiting 1 minute");
      expect(waitingPhrase(since["review:ready"]!, now)).toBe("waiting 2 minutes");
    });

    it("sorts a worker that failed long ago ahead of one made earlier that only just failed", () => {
      const shown = inboxItems({
        project: PROJECT,
        rows: [
          // Made at 09:00 and failed at 12:00, against made at 11:00 and failed at 11:30.
          worker({ id: "late", status: "failed", title: "Late", createdAt: now - 180 * minute, settledAt: now - minute, updatedAt: now }),
          worker({ id: "early", status: "failed", title: "Early", createdAt: now - 60 * minute, settledAt: now - 30 * minute, updatedAt: now }),
        ],
      });
      expect(shown.map((item) => item.id)).toEqual(["failure:early", "failure:late"]);
    });

    it("falls back to createdAt for an ended row that has no settledAt", () => {
      const shown = inboxItems({
        project: PROJECT,
        rows: [
          worker({ id: "boom", status: "failed", title: "Broke", createdAt: now - 15 * minute, updatedAt: now }),
          worker({ id: "nulled", status: "done", title: "Done", createdAt: now - 20 * minute, settledAt: null, updatedAt: now }),
        ],
      });
      expect(shown.find((item) => item.id === "failure:boom")?.since).toBe(now - 15 * minute);
      expect(shown.find((item) => item.id === "review:nulled")?.since).toBe(now - 20 * minute);
    });

    it("ignores stalledAt unless the row is blocked", () => {
      const shown = inboxItems({
        project: PROJECT,
        rows: [
          worker({ id: "quiet", status: "failed", title: "Quiet", stallKind: "quiet", stalledAt: now - minute, createdAt: now - 50 * minute, updatedAt: now }),
          worker({ id: "nostamp", status: "needs-you", title: "Blocked, no stamp", stallKind: "blocked", stalledAt: null, createdAt: now - 9 * minute, updatedAt: now }),
        ],
      });
      expect(shown.find((item) => item.id === "failure:quiet")?.since).toBe(now - 50 * minute);
      expect(shown.find((item) => item.id === "question:nostamp")?.since).toBe(now - 9 * minute);
    });

    it("says nothing for a row with no start time instead of reading its last update", () => {
      const shown = inboxItems({
        project: PROJECT,
        rows: [{ id: "old", project: PROJECT, status: "needs-you", title: "Old build", updatedAt: now - minute }],
      });
      expect(shown[0]?.since).toBe(0);
      expect(waitingPhrase(shown[0]!.since, now)).toBeNull();
    });
  });

  describe("a permission ask", () => {
    it("is read from the status notice, so a title that says permission does not make it one", () => {
      const shown = inboxItems({
        project: PROJECT,
        rows: [
          worker({ id: "title-only", status: "needs-you", title: "Fix the permission check", statusNotice: "Question for you: which name to ship?" }),
          worker({ id: "denied-title", status: "needs-you", title: "Access denied page", statusNotice: "Question for you: ship it?" }),
          worker({ id: "real", status: "needs-you", title: "Open the folder", statusNotice: "Needs permission to read the Documents folder" }),
          worker({ id: "denied", status: "needs-you", title: "Save", statusNotice: "Access denied" }),
        ],
      });
      expect(shown.find((item) => item.id === "question:title-only")).toMatchObject({ kind: "question", title: "Fix the permission check" });
      expect(shown.find((item) => item.id === "question:denied-title")?.kind).toBe("question");
      expect(shown.find((item) => item.id === "credential:real")).toMatchObject({ kind: "credential", title: "Needs a permission" });
      expect(shown.find((item) => item.id === "credential:denied")).toMatchObject({ kind: "credential", title: "Needs a permission" });
    });
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

// Review round 1 (PR #232), LOW: a sent-back reason quotes the worker's own to-do or command. A working row whose
// reason names a sign-in test is not a sign-in the person has to do.
describe("review r1: sent-back reasons", () => {
  it("r1: a sent-back reason that mentions sign-in is not a credential card", () => {
    const shown = inboxItems({
      project: "/work/proj",
      rows: [
        {
          id: "fixing",
          project: "/work/proj",
          title: "Fix the login page",
          status: "working",
          statusNotice: "Sent back: a check failed this turn (npx vitest run src/features/auth/sign-in.test.ts).",
          updatedAt: 1,
        },
      ],
    });
    expect(shown.filter((item) => item.kind === "credential")).toEqual([]);
  });
});

// Review round 2 (PR #232), MED (r1 MED still open): the r1 fix reads only a working row's notice. A delivery that the
// checks failed twice carries the same sent-back line as its error, and that still becomes a credential card.
describe("review r2: sent-back reasons", () => {
  it("r2: a failed delivery whose error is a sent-back reason naming sign-in is not a credential card", () => {
    const line = "Sent back: a check failed this turn (npx vitest run src/features/auth/sign-in.test.ts).";
    const shown = inboxItems({
      project: "/work/proj",
      rows: [
        {
          id: "fixing",
          project: "/work/proj",
          title: "Fix the login page",
          status: "failed",
          statusNotice: `${line} Still failed after 2 tries.`,
          error: `${line} Still failed after 2 tries.`,
          updatedAt: 1,
        },
      ],
    });
    expect(shown.filter((item) => item.kind === "credential")).toEqual([]);
  });

  it("a real sign-in line stays a credential when a send-back line is also there", () => {
    const shown = inboxItems({
      project: "/work/proj",
      rows: [
        {
          id: "auth",
          project: "/work/proj",
          title: "Connect the account",
          status: "failed",
          statusNotice: "not signed in",
          error: "Sent back: npx vitest run src/features/auth/sign-in.test.ts",
          updatedAt: 1,
        },
      ],
    });
    expect(shown.some((item) => item.kind === "credential")).toBe(true);
  });
});
