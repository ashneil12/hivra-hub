import { describe, expect, it, vi } from "vitest";
import { submitWithSettlement } from "../../../app/model/managedSubmission";
import {
  canDispatchQueuedHead,
  canSteerQueuedHead,
} from "../../sessions/model/messageQueue";
import { newSession, type Session } from "../../sessions/model/session";
import {
  dismissQueuedMonoSessionCompletion,
  enqueueMonoSessionCompletion,
  monoSessionCompletionResult,
  MonoSessionCompletionBatches,
  REPORT_WINDOW_MS,
} from "./monoSessionCompletion";

const origin = { monoId: "mono", turn: 1 };
function result(
  id: string,
  status: "completed" | "failed" | "cancelled" = "completed",
) {
  return monoSessionCompletionResult({
    requestId: id,
    sessionId: id,
    project: "/code/project",
    prompt: `Review ${id}`,
    outcome: {
      status,
      text: `Result ${id}`,
      ...(status === "failed" ? { error: "Launch failed" } : {}),
    },
  });
}

describe("Mono completion batches", () => {
  // SC-19: a moved row's report that a batch still holds is the batch's to queue, not the move's.
  it("holds a request's report from its launch until the batch has reported it, and no longer", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    expect(batches.holds("a")).toBe(false);
    const a = batches.watch(origin, "a");
    const b = batches.watch(origin, "b");
    // Running, and finished but waiting for its turn to end: both are still the batch's to report.
    expect(batches.holds("a")).toBe(true);
    a(result("a"));
    expect(batches.holds("a")).toBe(true);
    batches.closeInactive(() => false);
    expect(ready).not.toHaveBeenCalled();
    expect(batches.holds("a")).toBe(true);
    b(result("b"));
    // The report went out: the batch holds nothing of it any more.
    expect(ready).toHaveBeenCalledOnce();
    expect(batches.holds("a")).toBe(false);
    expect(batches.holds("b")).toBe(false);
    expect(batches.holds("c")).toBe(false);
  });

  it("holds nothing for a launch that was discarded", () => {
    const batches = new MonoSessionCompletionBatches(vi.fn());
    const a = batches.watch(origin, "a", "a", { awaitAcceptance: true });
    expect(batches.holds("a")).toBe(true);
    a.discard();
    expect(batches.holds("a")).toBe(false);
  });

  it("waits for the launching turn, and children that finish together go as one report, even when a fast child finishes before the others launch", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const a = batches.watch(origin, "a");
    a(result("a"));
    batches.closeInactive(() => true);
    expect(ready).not.toHaveBeenCalled();
    const b = batches.watch(origin, "b");
    const c = batches.watch(origin, "c");
    c(result("c"));
    batches.closeInactive(() => false);
    expect(ready).not.toHaveBeenCalled();
    b(result("b"));
    expect(ready).toHaveBeenCalledOnce();
    const [monoId, message] = ready.mock.calls[0];
    expect(monoId).toBe("mono");
    expect(message.monoSessionCompletion).toMatchObject({
      sessionCount: 3,
      status: "completed",
    });
    const payload = JSON.parse(message.text.split("\n\n")[1]);
    expect(
      payload.sessions.map((entry: { sessionId: string }) => entry.sessionId),
    ).toEqual(["a", "b", "c"]);
    expect(message.text).toContain("one consolidated update");
    for (const id of ["a", "b", "c"])
      expect(message.text).toContain(`Result ${id}`);
    a(result("a"));
    b(result("b"));
    batches.closeInactive(() => false);
    expect(ready).toHaveBeenCalledOnce();
  });

  it("counts failures and cancellations as finished, reported with the others that finish within the window", async () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const failed = batches.watch(origin, "failed");
    const cancelled = batches.watch(origin, "cancelled");
    const succeeded = batches.watch(origin, "success");
    batches.closeInactive(() => false);
    await submitWithSettlement({
      submit: () => false,
      onSettled: (outcome) =>
        failed(
          monoSessionCompletionResult({
            requestId: "failed",
            sessionId: "failed",
            project: "/code/project",
            prompt: "Review",
            outcome,
          }),
        ),
      rejectionMessage: "Launch failed",
    });
    cancelled(result("cancelled", "cancelled"));
    expect(ready).not.toHaveBeenCalled();
    succeeded(result("success"));
    const message = ready.mock.calls[0][1];
    expect(message.monoSessionCompletion.status).toBe("failed");
    expect(message.text).toContain("Launch failed");
    expect(message.text).toContain('"status":"cancelled"');
    expect(message.text).toContain('"status":"completed"');
  });

  it("keeps later requests and other Monos independent of a slow earlier batch", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const slow = batches.watch(origin, "slow");
    batches.watch(origin, "also-slow");
    const later = batches.watch({ ...origin, turn: 2 }, "later");
    const other = batches.watch({ monoId: "another", turn: 1 }, "other");
    batches.closeInactive(() => false);
    later(result("later"));
    other(result("other"));
    expect(ready.mock.calls.map(([monoId]) => monoId)).toEqual([
      "mono",
      "another",
    ]);
    slow(result("slow"));
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("queues one consolidated report behind chat and never steers a busy Mono", () => {
    let mono: Session = {
      ...newSession("codex", "/code/project"),
      busy: true,
      turnReady: true,
      queuedMessages: [
        { id: "chat", text: "Another question", attachments: [] },
      ],
    };
    const batches = new MonoSessionCompletionBatches((_, message) => {
      mono = enqueueMonoSessionCompletion(mono, message);
    });
    const a = batches.watch(origin, "a");
    const b = batches.watch(origin, "b");
    batches.closeInactive(() => false);
    b(result("b"));
    expect(mono.queuedMessages).toHaveLength(1);
    a(result("a"));
    expect(mono.queuedMessages).toHaveLength(2);
    const notification = {
      ...mono,
      queuedMessages: mono.queuedMessages!.slice(1),
    };
    expect(canDispatchQueuedHead(notification)).toBe(false);
    expect(canSteerQueuedHead(notification)).toBe(false);
    expect(canDispatchQueuedHead({ ...notification, busy: false })).toBe(true);
  });

  it("keeps single-session reports compatible", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const done = batches.watch(origin, "request");
    const snapshot = result("worker");
    done(snapshot);
    expect(ready).not.toHaveBeenCalled();
    batches.closeInactive(() => false);
    expect(ready.mock.calls[0][3]).toEqual(["request"]);
    expect(ready.mock.calls[0][1].text.startsWith("[MonoCode report] ")).toBe(
      true,
    );
    expect(ready.mock.calls[0][1]).toMatchObject({
      id: "mono-completion-request-g1",
      monoSessionCompletion: {
        sessionId: "worker",
        title: "Agent session",
        status: "completed",
      },
    });
    expect(ready.mock.calls[0][1].monoSessionCompletion).not.toHaveProperty(
      "sessionCount",
    );
  });

  it("gives a resumed generation's report its own receipt", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    batches.watch(origin, "request", "worker", { generation: 3 })(
      result("worker"),
    );
    batches.closeInactive(() => false);
    expect(ready.mock.calls[0][1].id).toBe("mono-completion-request-g3");
  });

  it("waits for a retry of a rejected launch and ignores its old settlement callback", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const rejected = batches.watch(origin, "request");
    rejected(result("worker", "failed"));
    const retry = batches.watch(origin, "request");
    batches.closeInactive(() => false);
    rejected(result("worker", "failed"));
    expect(ready).not.toHaveBeenCalled();
    retry(result("worker"));
    expect(ready).toHaveBeenCalledOnce();
    expect(ready.mock.calls[0][1].monoSessionCompletion.status).toBe(
      "completed",
    );
  });

  it("dismisses the calling Mono's pending cancellation without losing other session results", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const stopped = batches.watch(origin, "stop-request", "stopped-session");
    const other = batches.watch(origin, "other-request", "other-session");
    batches.closeInactive(() => false);
    batches.dismissSession(origin.monoId, "stopped-session");
    stopped(result("stopped-session", "cancelled"));
    expect(ready).not.toHaveBeenCalled();
    other(result("other-session"));
    expect(ready).toHaveBeenCalledOnce();
    expect(ready.mock.calls[0][1].monoSessionCompletion).toEqual({
      sessionId: "other-session",
      title: "Agent session",
      status: "completed",
    });
    expect(ready.mock.calls[0][1].text).not.toContain("stopped-session");
  });

  it("keeps other Monos and future monitored turns on the same session independent", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const cancelled = batches.watch(origin, "request", "worker");
    const other = batches.watch(
      { monoId: "another", turn: 1 },
      "other",
      "worker",
    );
    batches.closeInactive(() => false);
    batches.dismissSession(origin.monoId, "worker");
    cancelled(result("worker", "cancelled"));
    other(result("worker", "cancelled"));
    expect(ready.mock.calls.map(([monoId]) => monoId)).toEqual(["another"]);

    const followUp = batches.watch(
      { ...origin, turn: 2 },
      "follow-up",
      "worker",
    );
    batches.closeInactive(() => false);
    cancelled(result("worker", "cancelled"));
    expect(ready).toHaveBeenCalledOnce();
    followUp(result("worker"));
    expect(ready.mock.calls.map(([monoId]) => monoId)).toEqual([
      "another",
      "mono",
    ]);
    expect(ready.mock.calls[1][1].monoSessionCompletion.status).toBe(
      "completed",
    );
  });

  it("does not repeat a rejected launch after the successfully launched session is archived", async () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const rejected = batches.watch(
      origin,
      "rejected-request",
      "failed-session",
    );
    const accepted = await submitWithSettlement({
      submit: () => false,
      onSettled: (outcome) =>
        rejected(
          monoSessionCompletionResult({
            requestId: "rejected-request",
            sessionId: "failed-session",
            project: "/code/project",
            prompt: "Review",
            outcome,
          }),
        ),
      rejectionMessage: "Session was not open",
    });
    expect(accepted).toBe(false);
    rejected.discard();
    const launched = batches.watch(origin, "launched-request", "worker");
    batches.closeInactive(() => false);
    batches.dismissSession(origin.monoId, "worker");
    launched(result("worker", "cancelled"));
    expect(ready).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not deliver a rejected submission when the Mono becomes idle before acceptance (throws: %s)",
    async (throws) => {
      const ready = vi.fn();
      const batches = new MonoSessionCompletionBatches(ready);
      const rejected = batches.watch(origin, "request", "worker", {
        awaitAcceptance: true,
      });
      let finish!: (accepted: boolean) => void;
      let fail!: (error: Error) => void;
      const acceptance = new Promise<boolean>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const submission = submitWithSettlement({
        submit: () => acceptance,
        onSettled: (outcome) =>
          rejected(
            monoSessionCompletionResult({
              requestId: "request",
              sessionId: "worker",
              project: "/code/project",
              prompt: "Review",
              outcome,
            }),
          ),
        rejectionMessage: "Could not start",
      });
      batches.closeInactive(() => false);
      if (throws) fail(new Error("Session was not open"));
      else finish(false);
      expect(await submission).toBe(false);
      // No delivery may start in the gap before the caller handles rejection.
      expect(ready).not.toHaveBeenCalled();
      rejected.discard();
      rejected.accept();
      rejected(result("worker", "failed"));
      batches.closeInactive(() => false);
      expect(ready).not.toHaveBeenCalled();
    },
  );

  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps an early %s event from an accepted submission and releases it after acceptance",
    (status) => {
      const ready = vi.fn();
      const batches = new MonoSessionCompletionBatches(ready);
      const watched = batches.watch(origin, "request", "worker", {
        awaitAcceptance: true,
      });
      batches.closeInactive(() => false);
      watched(result("worker", status));
      expect(ready).not.toHaveBeenCalled();
      watched.accept();
      expect(ready).toHaveBeenCalledOnce();
      expect(ready.mock.calls[0][1].monoSessionCompletion.status).toBe(status);
      watched.accept();
      expect(ready).toHaveBeenCalledOnce();
    },
  );

  it("releases an accepted sibling when an undecided submission is rejected", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const rejected = batches.watch(origin, "rejected-request", "rejected", {
      awaitAcceptance: true,
    });
    batches.watch(origin, "accepted-request", "accepted")(result("accepted"));
    batches.closeInactive(() => false);
    rejected(result("rejected", "failed"));
    expect(ready).not.toHaveBeenCalled();
    rejected.discard();
    expect(ready).toHaveBeenCalledOnce();
    expect(ready.mock.calls[0][1].monoSessionCompletion.sessionId).toBe(
      "accepted",
    );
    expect(ready.mock.calls[0][1].text).not.toContain('"sessionId":"rejected"');
  });

  it("lets a discarded request retry while ignoring the old callback and discard", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    const rejected = batches.watch(origin, "request", "worker");
    rejected.discard();
    const retry = batches.watch(origin, "request", "worker");
    rejected(result("worker", "failed"));
    rejected.discard();
    batches.closeInactive(() => false);
    expect(ready).not.toHaveBeenCalled();
    retry(result("worker"));
    expect(ready).toHaveBeenCalledOnce();
    expect(ready.mock.calls[0][1].monoSessionCompletion.status).toBe(
      "completed",
    );
  });

  it.each([false, true])(
    "updates a report dismissed during asynchronous delivery (retain another session: %s)",
    async (retainOther) => {
      let resume!: () => void;
      const waiting = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const delivered = vi.fn();
      const batches = new MonoSessionCompletionBatches(
        async (_, _message, current) => {
          await waiting;
          const message = current();
          if (message) delivered(message);
        },
      );
      batches.watch(origin, "request", "worker")(result("worker", "cancelled"));
      if (retainOther) batches.watch(origin, "other", "other")(result("other"));
      batches.closeInactive(() => false);
      batches.dismissSession(origin.monoId, "worker");
      resume();
      await waiting;
      if (retainOther) {
        expect(delivered).toHaveBeenCalledOnce();
        expect(delivered.mock.calls[0][0].monoSessionCompletion).toEqual({
          sessionId: "other",
          title: "Agent session",
          status: "completed",
        });
        expect(delivered.mock.calls[0][0].text).not.toContain(
          '"sessionId":"worker"',
        );
      } else {
        expect(delivered).not.toHaveBeenCalled();
      }
    },
  );

  it("bounds a large group's reports while retaining every session's identity and outcome", () => {
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready);
    for (let index = 0; index < 40; index++) {
      const id = `worker-${index}`;
      batches.watch(
        origin,
        id,
      )({
        ...result(id),
        result: "x".repeat(12_000),
        originalPrompt: "y".repeat(12_000),
      });
    }
    batches.closeInactive(() => false);
    const message = ready.mock.calls[0][1];
    const payload = JSON.parse(message.text.split("\n\n")[1]);
    expect(payload.sessions).toHaveLength(40);
    expect(
      payload.sessions.every(
        (entry: { truncated: boolean }) => entry.truncated,
      ),
    ).toBe(true);
    expect(message.text.length).toBeLessThan(60_000);
  });
});

/** A clock and timers the batches run on, moved by hand. */
function manualClock() {
  let at = 0;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  return {
    now: () => at,
    schedule: (run: () => void, ms: number) => {
      const timer = { at: at + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    advance(ms: number) {
      at += ms;
      for (const timer of timers.filter((entry) => entry.live && entry.at <= at)) {
        timer.live = false;
        timer.run();
      }
    },
    pending: () => timers.filter((entry) => entry.live).length,
  };
}

describe("reports as each worker finishes (Ash, 20 Oct)", () => {
  const titled = (batches: MonoSessionCompletionBatches, id: string, title: string, turn = origin) =>
    batches.watch(turn, id, id, { title });

  it("one slow worker never holds back the others: each result reaches the Mono within the window, with N of M back", () => {
    const clock = manualClock();
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready, clock);
    const api = titled(batches, "api", "API");
    const ui = titled(batches, "ui", "UI");
    const docs = titled(batches, "docs", "Docs");
    batches.closeInactive(() => false);
    api(result("api"));
    clock.advance(REPORT_WINDOW_MS - 1);
    expect(ready).not.toHaveBeenCalled();
    clock.advance(1);
    expect(ready).toHaveBeenCalledOnce();
    const [monoId, first, current, requestIds] = ready.mock.calls[0];
    expect(monoId).toBe("mono");
    expect(requestIds).toEqual(["api"]);
    expect(first.id).toBe("mono-completion-api-g1");
    expect(first.text).toContain("1 of 3 back, still running: UI, Docs");
    expect(first.text).toContain("without waiting for the rest");
    expect(current()?.id).toBe(first.id);

    // The other two finish 10 s apart: the last one completes the turn, so both go at once.
    clock.advance(30_000);
    ui(result("ui"));
    expect(ready).toHaveBeenCalledOnce();
    clock.advance(10_000);
    docs(result("docs"));
    expect(ready).toHaveBeenCalledTimes(2);
    const second = ready.mock.calls[1][1];
    expect(ready.mock.calls[1][3]).toEqual(["ui", "docs"]);
    expect(second.monoSessionCompletion).toMatchObject({ sessionCount: 2 });
    expect(second.text).toContain("all 3 of 3 back");
    expect(JSON.parse(second.text.split("\n\n")[1]).progress).toEqual({ back: 3, total: 3, running: [] });
    expect(clock.pending()).toBe(0);
    // Nothing goes twice.
    api(result("api"));
    batches.closeInactive(() => false);
    clock.advance(REPORT_WINDOW_MS * 2);
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("results that come in within the window go together; one that waited out the launching turn goes when it ends", () => {
    const clock = manualClock();
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready, clock);
    const a = titled(batches, "a", "API");
    const b = titled(batches, "b", "UI");
    titled(batches, "c", "Docs");
    // Still inside the launching turn: nothing goes, however long.
    a(result("a"));
    clock.advance(REPORT_WINDOW_MS * 3);
    batches.closeInactive(() => true);
    expect(ready).not.toHaveBeenCalled();
    // The turn ends: the result that waited past the window goes at once.
    batches.closeInactive(() => false);
    expect(ready).toHaveBeenCalledOnce();
    expect(ready.mock.calls[0][1].text).toContain("1 of 3 back, still running: UI, Docs");
    b(result("b"));
    clock.advance(REPORT_WINDOW_MS);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(ready.mock.calls[1][1].text).toContain("2 of 3 back, still running: Docs");
  });

  it("tells the Mono what still runs from its other turns", () => {
    const clock = manualClock();
    const ready = vi.fn();
    const batches = new MonoSessionCompletionBatches(ready, clock);
    titled(batches, "slow", "Migration", { monoId: "mono", turn: 1 });
    const quick = titled(batches, "quick", "Typo fix", { monoId: "mono", turn: 2 });
    titled(batches, "theirs", "Not mine", { monoId: "another", turn: 1 });
    batches.closeInactive(() => false);
    quick(result("quick"));
    expect(ready).toHaveBeenCalledOnce();
    const text = ready.mock.calls[0][1].text;
    expect(text).toContain("a session you are monitoring has now stopped");
    expect(text).toContain("Also still running from your other turns: Migration.");
    expect(text).not.toContain("Not mine");
  });

  it("a queued report keeps its progress when one of its sessions is dismissed", () => {
    const clock = manualClock();
    let mono = { ...newSession("claude", "/code/project"), busy: true, turnReady: true };
    const batches = new MonoSessionCompletionBatches((_, message) => {
      mono = enqueueMonoSessionCompletion(mono, message);
    }, clock);
    const a = titled(batches, "a", "API");
    const b = titled(batches, "b", "UI");
    titled(batches, "c", "Docs");
    batches.closeInactive(() => false);
    a(result("a"));
    b(result("b"));
    clock.advance(REPORT_WINDOW_MS);
    expect(mono.queuedMessages).toHaveLength(1);
    const trimmed = dismissQueuedMonoSessionCompletion(mono, "a");
    const message = trimmed.queuedMessages![0];
    expect(message.text).toContain("2 of 3 back, still running: Docs");
    expect(JSON.parse(message.text.split("\n\n")[1]).sessionId).toBe("b");
  });
});
