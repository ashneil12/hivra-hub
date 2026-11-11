import { describe, expect, it } from "vitest";
import { newTab } from "../../workspace/model/layout";
import {
  claimAutoContinue,
  CONTINUE_PROMPT,
  CUT_NOTE_MAX_ENTRIES,
  CUT_NOTE_MAX_LABEL,
  INTERRUPT_MESSAGE,
  MAX_AUTO_RESUMES,
  RELOAD_INTERRUPT_MESSAGE,
  cutBeforeAnyOutput,
  RESUME_STOPPED_MESSAGE,
  UPDATE_INTERRUPT_MESSAGE,
  canAutoContinue,
  cutWorkLabel,
  cutWorkNote,
  inFlightSnapshotKey,
  markResumeStopped,
  resumeBlocked,
  resumePrompt,
  resumeStopped,
  withInFlightState,
  interruptingShip,
  shipResumePrompt,
  hasInFlightSessions,
  inFlightRefs,
  isInFlightSession,
  isRunningWork,
  isTurnRunning,
  markTurnInterrupted,
  quitWhileBusyMessage,
  shouldWriteInFlightSnapshot,
  workspaceFromResumed,
} from "./inFlight";
import { newSession, type CutWork, type Session } from "./session";
import { appendUser, stopStreaming } from "../../../integrations/harness/core/apply";

function chat(
  cwd: string,
  patch: Partial<Session> = {},
): Session {
  const session = newSession("cursor", cwd);
  session.blocks = [{ id: "u1", role: "user", text: "hello" }];
  return { ...session, ...patch, blocks: patch.blocks ?? session.blocks };
}

describe("isInFlightSession", () => {
  it("is true for a busy turn, a live approval, or a parked question", () => {
    expect(isInFlightSession(chat("/tmp/a"))).toBe(false);
    expect(isInFlightSession(chat("/tmp/a", { busy: true }))).toBe(true);
    expect(
      isInFlightSession(
        chat("/tmp/a", {
          blocks: [
            { id: "u1", role: "user", text: "hello" },
            {
              id: "a1",
              role: "approval",
              text: "run rm",
              approval: { requestId: 1 },
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      isInFlightSession(
        chat("/tmp/a", {
          pendingQuestion: {
            requestId: 4,
            questions: [
              {
                id: "q1",
                prompt: "Which file?",
                multiSelect: false,
                allowCustom: true,
                options: [{ id: "a.ts", label: "a.ts" }],
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("inFlightRefs", () => {
  it("walks open tabs first, then parked busy sessions", () => {
    const parked = chat("/tmp/parked", { busy: true });
    const openBusy = chat("/tmp/open", { busy: true });
    const idle = chat("/tmp/idle");
    const blank = newSession("cursor", "/tmp/blank");
    blank.busy = true;

    const tabs = [newTab(idle.id), newTab(openBusy.id)];
    expect(
      inFlightRefs([parked, openBusy, idle, blank], tabs),
    ).toEqual([
      { sessionId: openBusy.id, cwd: "/tmp/open" },
      { sessionId: parked.id, cwd: "/tmp/parked" },
    ]);
  });

  it("skips chats that were never persisted", () => {
    const blank = newSession("cursor", "/tmp/a");
    blank.busy = true;
    expect(inFlightRefs([blank], [newTab(blank.id)])).toEqual([]);
    expect(hasInFlightSessions([blank])).toBe(true);
  });

  it("does not resume a session whose worktree was removed", () => {
    const removed = chat("/tmp/a", {
      busy: true,
      worktreeCwd: "/tmp/a-worktrees/feature",
      worktreeRemoved: true,
    });
    expect(isInFlightSession(removed)).toBe(false);
    expect(inFlightRefs([removed], [newTab(removed.id)])).toEqual([]);
  });
});

describe("markTurnInterrupted", () => {
  it("seals the stream, cancels open tools, and appends a system note", () => {
    const interrupted = markTurnInterrupted(
      chat("/tmp/a", {
        busy: true,
        blocks: [
          { id: "u1", role: "user", text: "hello", startedAt: 1_000 },
          { id: "a1", role: "assistant", text: "Working", streaming: true },
          {
            id: "t1",
            role: "tool",
            text: "edit",
            streaming: true,
            tool: { status: "running", title: "edit" },
          },
          {
            id: "p1",
            role: "approval",
            text: "allow?",
            approval: { requestId: 7 },
          },
        ],
      }),
    );

    expect(interrupted.busy).toBe(false);
    expect(interrupted.blocks).toEqual([
      expect.objectContaining({
        id: "u1",
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        id: "a1",
        streaming: false,
        text: "Working",
      }),
      expect.objectContaining({
        id: "t1",
        streaming: false,
        tool: expect.objectContaining({ status: "cancelled" }),
      }),
      expect.objectContaining({
        role: "system",
        text: INTERRUPT_MESSAGE,
      }),
    ]);
  });

  it("does not append the interrupt note twice for the same turn", () => {
    const once = markTurnInterrupted(chat("/tmp/a", { busy: true }));
    const twice = markTurnInterrupted(once);
    expect(
      twice.blocks.filter((block) => block.text === INTERRUPT_MESSAGE),
    ).toHaveLength(1);
  });

  it("appends a new note when a later turn is quit after Continue", () => {
    const first = markTurnInterrupted(
      chat("/tmp/a", { busy: true, providerSessionId: "p1" }),
    );
    const continued: Session = {
      ...first,
      blocks: [
        ...first.blocks,
        { id: "c1", role: "user", text: CONTINUE_PROMPT },
        { id: "a2", role: "assistant", text: "resumed" },
        { id: "u2", role: "user", text: "edit the readme" },
        {
          id: "t2",
          role: "tool",
          text: "read",
          tool: { status: "completed", title: "read" },
        },
      ],
      busy: true,
    };
    const second = markTurnInterrupted(continued);
    expect(
      second.blocks.filter((block) => block.text === INTERRUPT_MESSAGE),
    ).toHaveLength(2);
    expect(second.blocks[second.blocks.length - 1]?.text).toBe(INTERRUPT_MESSAGE);
    expect(canAutoContinue(second)).toBe(true);
  });

  it("leaves finished tools alone", () => {
    const interrupted = markTurnInterrupted(
      chat("/tmp/a", {
        busy: true,
        blocks: [
          { id: "u1", role: "user", text: "hello" },
          {
            id: "t1",
            role: "tool",
            text: "read",
            tool: { status: "completed", title: "read" },
          },
        ],
      }),
    );
    expect(interrupted.blocks[1]?.tool?.status).toBe("completed");
  });
});

describe("quitWhileBusyMessage", () => {
  it("mentions resume on reopen", () => {
    expect(quitWhileBusyMessage(1)).toContain("1 chat is still running");
    expect(quitWhileBusyMessage(3)).toContain("3 chats are still running");
  });
});

describe("workspaceFromResumed", () => {
  it("opens one tab per restored chat", () => {
    const first = chat("/tmp/a");
    const second = chat("/tmp/b");
    const workspace = workspaceFromResumed([first, second]);
    expect(workspace?.projectCwd).toBe("/tmp/a");
    expect(workspace?.sessions.map((session) => session.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(workspace?.tabs).toHaveLength(2);
    expect(workspace?.tabs[0]?.focusedId).toBe(first.id);
    expect(workspace?.activeTabId).toBe(workspace?.tabs[0]?.id);
  });

  it("returns null when there is nothing to restore", () => {
    expect(workspaceFromResumed([])).toBeNull();
  });
});

describe("canAutoContinue", () => {
  it("needs a provider thread and an interrupt note as the last block", () => {
    const interrupted = markTurnInterrupted(
      chat("/tmp/a", { busy: true, providerSessionId: "p1" }),
    );
    expect(canAutoContinue(interrupted)).toBe(true);
    expect(canAutoContinue(chat("/tmp/a", { providerSessionId: "p1" }))).toBe(
      false,
    );
    // No provider thread and the turn already had output: nothing to continue.
    expect(
      canAutoContinue(
        markTurnInterrupted(
          chat("/tmp/a", {
            busy: true,
            blocks: [
              { id: "u1", role: "user", text: "hello" },
              { id: "a1", role: "assistant", text: "Hi" },
            ],
          }),
        ),
      ),
    ).toBe(false);
    expect(
      canAutoContinue({
        ...interrupted,
        blocks: [
          ...interrupted.blocks,
          { id: "c1", role: "user", text: "Continue from where you left off." },
        ],
      }),
    ).toBe(false);
    expect(canAutoContinue({ ...interrupted, busy: true })).toBe(false);
    expect(canAutoContinue({ ...interrupted, worktreeRemoved: true })).toBe(
      false,
    );
  });
});

describe("shouldWriteInFlightSnapshot", () => {
  it("does not wipe a disk snapshot on the first idle paint", () => {
    expect(shouldWriteInFlightSnapshot("", [], null, false)).toBe(false);
  });

  it("writes when a chat becomes in-flight", () => {
    expect(
      shouldWriteInFlightSnapshot("a", [{ sessionId: "a", cwd: "/tmp" }], null, false),
    ).toBe(true);
  });

  it("clears after this process has seen an in-flight chat", () => {
    expect(shouldWriteInFlightSnapshot("", [], "a", true)).toBe(true);
  });

  it("skips unchanged keys", () => {
    expect(
      shouldWriteInFlightSnapshot("a", [{ sessionId: "a", cwd: "/tmp" }], "a", true),
    ).toBe(false);
  });
});

describe("a turn cut by a quit for update (a ship)", () => {
  const ship = "20261019-210405-bbbbbbb";
  const note = {
    id: ship,
    phase: "committed",
    reason: null,
    from: { sha: "a".repeat(40), branch: "hub/next" },
    to: { sha: "b".repeat(40), branch: "hub/1b-ship" },
    requestedBy: { sessionId: "lead" },
    receiptPath: "/data/ship/x/receipt.json",
    log: "/data/ship/x/runner.log",
  };

  it("is marked with the ship and still continues once", () => {
    const cut = markTurnInterrupted(
      chat("/tmp/a", { busy: true, providerSessionId: "p1" }),
      ship,
    );
    const last = cut.blocks[cut.blocks.length - 1];
    expect(last).toMatchObject({ role: "system", text: UPDATE_INTERRUPT_MESSAGE, notice: "interrupt", shipUpdate: ship });
    expect(canAutoContinue(cut)).toBe(true);
    expect(interruptingShip(cut)).toBe(ship);
    // Marking again for the same turn adds nothing.
    expect(markTurnInterrupted(cut, ship).blocks).toHaveLength(cut.blocks.length);
    // A plain quit carries no ship.
    const quit = markTurnInterrupted(chat("/tmp/a", { busy: true, providerSessionId: "p1" }));
    expect(quit.blocks[quit.blocks.length - 1].text).toBe(INTERRUPT_MESSAGE);
    expect(interruptingShip(quit)).toBeNull();
    // Once the user (or the resume) has spoken, it's no longer the cut that matters.
    const resumed = { ...cut, blocks: [...cut.blocks, { id: "u2", role: "user" as const, text: "go on" }] };
    expect(interruptingShip(resumed)).toBeNull();
    expect(canAutoContinue(resumed)).toBe(false);
  });

  it("gives the session that shipped its receipt, and any other just what runs now", () => {
    const own = shipResumePrompt("lead", note);
    expect(own).toContain(`Your ship ${ship} finished.`);
    expect(own).toContain("now runs hub/1b-ship @ bbbbbbb (was hub/next @ aaaaaaa)");
    expect(own).toContain("receipt /data/ship/x/receipt.json");
    expect(own).toContain("log /data/ship/x/runner.log");
    expect(own).toMatch(/continue from where you left off\.$/);

    const other = shipResumePrompt("someone-else", note);
    expect(other).not.toContain("Your ship");
    expect(other).not.toContain("receipt.json");
    expect(other).toContain("restarted for an update");
    expect(other.endsWith(CONTINUE_PROMPT)).toBe(true);

    const rolled = shipResumePrompt("lead", {
      ...note,
      phase: "rolled-back",
      reason: "The new build didn't commit within 120 s.",
    });
    expect(rolled).toContain("rolled back (The new build didn't commit within 120 s.)");
    expect(rolled).toContain("runs hub/next @ aaaaaaa again");

    expect(shipResumePrompt("lead", null)).toBe(
      `MonoCode Hub restarted for an update. ${CONTINUE_PROMPT}`,
    );
  });
});

describe("restart-safe resume (Phase 1b WP5)", () => {
  const subagent: CutWork = {
    kind: "subagent",
    label: "Audit src/math.ts",
    id: "a44c0ed810da9e4f3",
  };
  const shell: CutWork = { kind: "shell", label: "npm run dev", id: "bt3kw2qpn" };

  it("saves a busy turn's background work and resume count in its in-flight row", () => {
    const busy = chat("/tmp/a", {
      busy: true,
      cutWork: [subagent, shell],
      autoResumes: 2,
    });
    const idle = chat("/tmp/b", { cutWork: [subagent] });
    expect(inFlightRefs([busy, idle], [])).toEqual([
      {
        sessionId: busy.id,
        cwd: "/tmp/a",
        background: [subagent, shell],
        resumes: 2,
      },
    ]);
    // Nothing extra on a plain turn, so older rows read the same.
    const plain = chat("/tmp/c", { busy: true });
    expect(inFlightRefs([plain], [])).toEqual([{ sessionId: plain.id, cwd: "/tmp/c" }]);
  });

  it("rewrites the snapshot when the background work or the count changes", () => {
    const base = { sessionId: "s1", cwd: "/tmp/a" };
    const keys = [
      inFlightSnapshotKey([base]),
      inFlightSnapshotKey([{ ...base, resumes: 1 }]),
      inFlightSnapshotKey([{ ...base, resumes: 1, background: [subagent] }]),
      inFlightSnapshotKey([{ ...base, resumes: 1, background: [subagent, shell] }]),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(inFlightSnapshotKey([base])).toBe(inFlightSnapshotKey([{ ...base }]));
  });

  it("brings a restored chat's work and count back from its row", () => {
    const restored = withInFlightState(chat("/tmp/a"), {
      sessionId: "x",
      cwd: "/tmp/a",
      background: [subagent],
      resumes: 1,
    });
    expect(restored.cutWork).toEqual([subagent]);
    expect(restored.autoResumes).toBe(1);
    const untouched = chat("/tmp/a");
    expect(withInFlightState(untouched, undefined)).toBe(untouched);
  });

  it("writes a bounded what-was-cut note with each piece of work's id", () => {
    expect(cutWorkNote([])).toBeNull();
    const note = cutWorkNote([subagent, shell, subagent])!;
    expect(note.split("\n")).toEqual([
      expect.stringContaining("background work was cut before it finished"),
      "- subagent: Audit src/math.ts (id a44c0ed810da9e4f3)",
      "- shell: npm run dev (id bt3kw2qpn)",
    ]);

    const many: CutWork[] = Array.from({ length: 14 }, (_, i) => ({
      kind: "subagent",
      label: `Task ${i} ${"x".repeat(400)}`,
      id: `agent-${i}`,
    }));
    const lines = cutWorkNote(many)!.split("\n");
    expect(lines).toHaveLength(1 + CUT_NOTE_MAX_ENTRIES + 1);
    expect(lines.at(-1)).toBe("- and 4 more");
    for (const line of lines.slice(1, -1)) {
      const label = line.replace(/^- subagent: /, "");
      expect(label.length).toBeLessThanOrEqual(CUT_NOTE_MAX_LABEL);
      // The id survives the clipping.
      expect(label).toMatch(/… \(id agent-\d+\)$/);
    }
    // An id too long for any label still yields a bounded entry.
    expect(
      cutWorkLabel({ kind: "task", label: "x", id: "y".repeat(500) }).length,
    ).toBeLessThanOrEqual(CUT_NOTE_MAX_LABEL);
    // Whitespace in a label collapses to one line.
    expect(cutWorkLabel({ kind: "shell", label: "a\n\n  b", id: "1" })).toBe("a b (id 1)");
  });

  it("puts the note before the continue, or before a ship's receipt", () => {
    const cut = chat("/tmp/a", { cutWork: [subagent] });
    const plain = resumePrompt(cut);
    expect(plain.startsWith("Note: MonoCode Hub restarted")).toBe(true);
    expect(plain.endsWith(`\n\n${CONTINUE_PROMPT}`)).toBe(true);
    expect(resumePrompt(chat("/tmp/a"))).toBe(CONTINUE_PROMPT);

    const shipped = resumePrompt(
      { ...cut, id: "lead" },
      {
        note: {
          id: "s1",
          phase: "committed",
          from: { sha: "a".repeat(40), branch: "hub/next" },
          to: { sha: "b".repeat(40), branch: "hub/1b-resume" },
          requestedBy: { sessionId: "lead" },
        },
      },
    );
    expect(shipped).toContain("(id a44c0ed810da9e4f3)");
    expect(shipped).toContain("Your ship s1 finished.");
    expect(shipped.indexOf("Note:")).toBeLessThan(shipped.indexOf("Your ship"));
    expect(resumePrompt(chat("/tmp/a"), { note: null })).toBe(
      `MonoCode Hub restarted for an update. ${CONTINUE_PROMPT}`,
    );
  });

  it(`stops after ${MAX_AUTO_RESUMES} automatic resumes and waits for Ash`, () => {
    expect(MAX_AUTO_RESUMES).toBe(3);
    // Each crash under a resumed turn leaves a row one higher; the cap is checked before resuming again.
    let session = markTurnInterrupted(
      chat("/tmp/a", { busy: true, providerSessionId: "p1", cutWork: [subagent] }),
    );
    const resumed: number[] = [];
    for (let boot = 0; boot < 6; boot++) {
      if (!canAutoContinue(session)) break;
      if (resumeBlocked(session)) {
        session = markResumeStopped(session);
        break;
      }
      const next = (session.autoResumes ?? 0) + 1;
      resumed.push(next);
      // The resumed turn starts, then the app dies under it again.
      session = markTurnInterrupted({
        ...session,
        autoResumes: next,
        busy: true,
        blocks: [...session.blocks, { id: `r${next}`, role: "user", text: CONTINUE_PROMPT }],
      });
    }
    expect(resumed).toEqual([1, 2, 3]);
    expect(resumeStopped(session)).toBe(true);
    const last = session.blocks.at(-1)!;
    expect(last).toMatchObject({ role: "system", notice: "resume-stopped" });
    expect(last.text.startsWith(RESUME_STOPPED_MESSAGE)).toBe(true);
    // It says what was still running, with the id.
    expect(last.text).toContain("(id a44c0ed810da9e4f3)");
    // Nothing continues it now, and marking it again adds nothing.
    expect(canAutoContinue(session)).toBe(false);
    expect(markResumeStopped(session).blocks).toHaveLength(session.blocks.length);
    expect(session.autoResumes).toBeUndefined();
    // A turn Ash sends himself starts over: below the cap again.
    expect(resumeBlocked({ autoResumes: undefined })).toBe(false);
    expect(resumeBlocked({ autoResumes: 2 })).toBe(false);
    expect(resumeBlocked({ autoResumes: 3 })).toBe(true);
  });

  it("never resumes over a question still on screen", () => {
    const cut = markTurnInterrupted(chat("/tmp/a", { busy: true, providerSessionId: "p1" }));
    expect(canAutoContinue(cut)).toBe(true);
    expect(
      canAutoContinue({
        ...cut,
        pendingQuestion: { requestId: 1, questions: [] },
      }),
    ).toBe(false);
  });
});

describe("claimAutoContinue", () => {
  it("lets one restart resume a chat once, and the next restart's resume again", () => {
    const claimed = new Set<string>();
    expect(claimAutoContinue(claimed, { id: "app-cos-r1" })).toBe(true);
    // The effect runs again (another chat's resumability changed) before this Continue was accepted.
    expect(claimAutoContinue(claimed, { id: "app-cos-r1" })).toBe(false);
    expect(claimAutoContinue(claimed, { id: "app-cos-r2" })).toBe(true);
    // Cut by the next restart: its resume count went up, so it may resume again.
    expect(claimAutoContinue(claimed, { id: "app-cos-r1", autoResumes: 1 })).toBe(true);
    expect(claimAutoContinue(claimed, { id: "app-cos-r1", autoResumes: 1 })).toBe(false);
  });
});

describe("a reload cuts a turn (the realtest baseline: cut 1 s after Ash's message, never resumed)", () => {
  const sent = (patch: Partial<Session> = {}) =>
    chat("/p/tally", {
      busy: true,
      blocks: [
        { id: "a0", role: "assistant", text: "Earlier reply." },
        { id: "u1", role: "user", text: "have a worker add sharing to tallies now. go" },
      ],
      ...patch,
    });

  it("reproduces the baseline: a chat with no provider thread yet was never resumed", () => {
    // Before: canAutoContinue needed a provider thread, so a turn cut before Claude bound one waited for good.
    const cut = markTurnInterrupted(sent(), undefined, "reload");
    expect(cut.providerSessionId).toBeUndefined();
    expect(canAutoContinue(cut)).toBe(true);
  });

  it("says it was a reload, not a quit", () => {
    const cut = markTurnInterrupted(sent({ providerSessionId: "p1" }), undefined, "reload");
    expect(cut.blocks.at(-1)).toMatchObject({ role: "system", notice: "interrupt", text: RELOAD_INTERRUPT_MESSAGE });
    expect(canAutoContinue(cut)).toBe(true);
  });

  it("a message that never reached the agent is sent again, whole, with a note; one it had begun on continues", () => {
    const early = markTurnInterrupted(sent({ providerSessionId: "p1" }), undefined, "reload");
    expect(cutBeforeAnyOutput(early)).toBe(true);
    expect(resumePrompt(early)).toBe(
      "MonoCode Hub restarted before this message reached you, so it is sent again:\n\nhave a worker add sharing to tallies now. go",
    );
    const midTurn = markTurnInterrupted(
      sent({
        providerSessionId: "p1",
        blocks: [...sent().blocks, { id: "a1", role: "assistant", text: "Let me look at the code first." }],
      }),
      undefined,
      "reload",
    );
    expect(cutBeforeAnyOutput(midTurn)).toBe(false);
    expect(resumePrompt(midTurn)).toBe(CONTINUE_PROMPT);
    // Without a provider thread only a message it never got can come back.
    expect(canAutoContinue({ ...midTurn, providerSessionId: undefined })).toBe(false);
  });

  it("a message still waiting in the queue is not the cut turn; an app's hidden turn keeps the old rule", () => {
    const queuedBubble = sent({
      providerSessionId: "p1",
      blocks: [...sent().blocks, { id: "a1", role: "assistant", text: "On it." }, { id: "q1", role: "user", text: "and this" }],
      queuedMessages: [{ id: "q1", text: "and this", attachments: [], blockId: "q1" }],
    });
    expect(cutBeforeAnyOutput(markTurnInterrupted(queuedBubble))).toBe(false);
    const hidden = sent({
      providerSessionId: "p1",
      blocks: [{ id: "r1", role: "user", text: "[MonoCode report] ...", internal: true }],
    });
    expect(cutBeforeAnyOutput(markTurnInterrupted(hidden))).toBe(false);
    expect(resumePrompt(markTurnInterrupted(hidden))).toBe(CONTINUE_PROMPT);
  });
});

describe("a chat the app holds busy for a background compact (WP-115)", () => {
  const held = (patch: Partial<Session> = {}) => chat("/tmp/a", { busy: true, idleCompacting: true, ...patch });

  it("is not a running turn, so it is not in flight, not running work and not saved as cut", () => {
    const session = held();
    expect(isTurnRunning(session)).toBe(false);
    expect(isInFlightSession(session)).toBe(false);
    expect(isRunningWork(session)).toBe(false);
    expect(hasInFlightSessions([session])).toBe(false);
    expect(inFlightRefs([session], [newTab(session.id)])).toEqual([]);
  });

  it("leaves a real turn beside it counted", () => {
    const compacting = held();
    const working = chat("/tmp/b", { busy: true });
    const refs = inFlightRefs([compacting, working], [newTab(compacting.id), newTab(working.id)]);
    expect(refs.map((ref) => ref.sessionId)).toEqual([working.id]);
  });

  it("is a real turn again the moment a message starts one or the chat is stopped", () => {
    const started = appendUser(held(), "go on");
    expect(started.idleCompacting).toBeUndefined();
    expect(isInFlightSession(started)).toBe(true);
    const stopped = stopStreaming(held());
    expect(stopped.busy).toBe(false);
    expect(stopped.idleCompacting).toBeUndefined();
  });

  it("still counts an approval waiting on the person", () => {
    const session = held({
      blocks: [
        { id: "u1", role: "user", text: "hello" },
        { id: "a1", role: "approval", text: "run rm", approval: { requestId: 1 } },
      ],
    });
    expect(isInFlightSession(session)).toBe(true);
  });
});
