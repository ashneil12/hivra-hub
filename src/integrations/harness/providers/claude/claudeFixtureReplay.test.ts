import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";
import { applyHarnessEvent } from "../../core/apply";
import { newSession } from "../../../../features/sessions/model/session";
import { lineageForThread } from "../../../../features/sessions/model/subagentLineage";
import {
  parseTranscript,
  type Transcript,
} from "../../../../../scripts/claude-fixtures.mjs";

/**
 * T3 Code's 18 recorded Claude transcripts, replayed through the live adapter (Phase 1b WP5). The data comes from
 * github.com/pingdotgg/t3code at 2532e640 (apps/server/src/orchestration-v2/testkit/fixtures/claude_* /
 * claude_transcript.ndjson), MIT, notice in fixtures/t3code/LICENSE. Each prompt is sent as a turn, every frame
 * Claude printed for it is fed back through the child-process seam, interrupts and restarts happen where they were
 * recorded, and the test checks what the chat would be told: turns settle, errors only where Claude failed, a
 * restart resumes the same conversation, and the background work a resume note needs is reported with its ids.
 */

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code?: number | null) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (_id: string, _path: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (code?: number | null) => void,
  ) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const {
  cancelClaudeTurn,
  sendClaudeTurn,
  steerClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");

const FIXTURES = new URL("./fixtures/t3code/", import.meta.url);
const NAMES = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".ndjson"))
  .map((name) => name.replace(/\.ndjson$/, ""))
  .sort();

function load(name: string): Transcript {
  return parseTranscript(readFileSync(new URL(`${name}.ndjson`, FIXTURES), "utf8"));
}

const parse = () => sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const initializes = () =>
  parse().filter(
    (m) => (m.request as Record<string, unknown> | undefined)?.subtype === "initialize",
  ).length;
const userPrompts = () => parse().filter((m) => m.type === "user");

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const tick = () => new Promise((r) => setTimeout(r, 0));

type TurnReplay = {
  prompt: string;
  processIndex: number;
  outcome: "completed" | "failed" | "open";
  error?: string;
  /** Sent while the turn before it was still open, so it went in as a steer, the way the app sends it. */
  steered: boolean;
  events: HarnessEvent[];
};

type Replay = { turns: TurnReplay[]; spawns: string[][]; sessionIds: string[] };

type Pending = {
  outcome: TurnReplay["outcome"];
  error?: string;
  events: HarnessEvent[];
  done: Promise<void>;
};

/** What a turn's own promise said right after one frame went in (for the turn-boundary regressions). */
type FrameSeen = { prompt: string; label: string; frame: Record<string, unknown>; outcome: TurnReplay["outcome"] };

/** Play one transcript through the adapter and report what each turn told the chat. */
async function replay(
  transcript: Transcript,
  observe?: (seen: FrameSeen) => void,
): Promise<Replay> {
  const rows: { row: Omit<TurnReplay, "outcome" | "error">; pending: Pending }[] = [];
  const settle = async (pending: Pending | undefined, ticks = 50) => {
    for (let i = 0; i < ticks && pending?.outcome === "open"; i++) await tick();
  };
  let open: Pending | undefined;
  for (const [processIndex, process] of transcript.processes.entries()) {
    open = undefined;
    for (const [turnIndex, recorded] of process.turns.entries()) {
      const initsBefore = initializes();
      const promptsBefore = userPrompts().length;
      // A prompt typed while the last turn still runs (it waits on background work) steers it.
      const steered = open?.outcome === "open";
      if (steered) {
        await steerClaudeTurn({
          sessionId: "replay",
          cwd: "/repo",
          model: "claude:claude-sonnet-5",
          text: recorded.prompt,
          attachments: [],
        });
      } else {
        const pending: Pending = {
          outcome: "open",
          events: [],
          done: Promise.resolve(),
        };
        pending.done = sendClaudeTurn({
          sessionId: "replay",
          cwd: "/repo",
          model: "claude:claude-sonnet-5",
          modelSettings: {},
          runtimeMode: "full-access",
          text: recorded.prompt,
          attachments: [],
          onEvent: (event) => pending.events.push(event),
        }).then(
          () => {
            pending.outcome = "completed";
          },
          (reason: Error) => {
            pending.outcome = "failed";
            pending.error = reason.message;
          },
        );
        open = pending;
        if (turnIndex === 0) {
          await waitFor(() => initializes() > initsBefore, `${processIndex}: initialize`);
          onLine!(
            JSON.stringify({
              type: "control_response",
              response: { subtype: "success", request_id: "monocode_2" },
            }),
          );
        }
      }
      await waitFor(
        () => userPrompts().length > promptsBefore,
        `${processIndex}/${turnIndex}: prompt`,
      );
      rows.push({
        row: { prompt: recorded.prompt, processIndex, steered, events: open!.events },
        pending: open!,
      });
      for (const [index, { frame }] of recorded.frames.entries()) {
        if (recorded.interruptAt === index) await cancelClaudeTurn("replay");
        onLine!(JSON.stringify(frame));
        await tick();
        await tick();
        observe?.({ prompt: recorded.prompt, label: String(frame.type), frame, outcome: open!.outcome });
      }
      if (recorded.interruptAt === recorded.frames.length)
        await cancelClaudeTurn("replay");
      // Let it settle on its own before the next prompt or the recorded exit.
      await settle(open, 20);
    }
    if (process.exit) onExit!(0);
    await settle(open);
  }
  const turns = rows.map(({ row, pending }) => ({
    ...row,
    outcome: pending.outcome,
    ...(pending.error ? { error: pending.error } : {}),
  }));
  // Claude's own conversation id, from the frames that carry it (init and the turn's own messages).
  const sessionIds = [
    ...new Set(
      transcript.processes.flatMap((process) =>
        process.turns.flatMap((turn) =>
          turn.frames
            .filter(({ frame }) => frame.type === "system" && frame.subtype === "init")
            .map(({ frame }) => frame.session_id)
            .filter((id): id is string => typeof id === "string"),
        ),
      ),
    ),
  ];
  return { turns, spawns: [...spawned], sessionIds };
}

const errorsOf = (events: HarnessEvent[]) =>
  events.filter(
    (e): e is Extract<HarnessEvent, { type: "session.error" }> => e.type === "session.error",
  );
const workOf = (events: HarnessEvent[]) =>
  events.filter(
    (e): e is Extract<HarnessEvent, { type: "background.work" }> =>
      e.type === "background.work",
  );

/**
 * Task ids Claude started (task_started or a background list) for this turn's prompt. All of them, including what the
 * prompt starts after a background wake Claude ran first: that wake's result (origin "task-notification") no longer
 * ends the MonoCode turn (claude_background_wake_before_queued_prompt*, the regression below).
 */
function startedTaskIds(transcript: Transcript, processIndex: number, prompt: string): string[] {
  const turn = transcript.processes[processIndex].turns.find((t) => t.prompt === prompt)!;
  const ids = new Set<string>();
  for (const { frame } of turn.frames) {
    if (frame.type !== "system") continue;
    if (frame.subtype === "task_started" && typeof frame.task_id === "string" && frame.ambient !== true)
      ids.add(frame.task_id);
    if (frame.subtype === "background_tasks_changed" && Array.isArray(frame.tasks))
      for (const task of frame.tasks as Record<string, unknown>[])
        if (typeof task.task_id === "string" && task.ambient !== true) ids.add(task.task_id);
  }
  return [...ids];
}

beforeEach(async () => {
  await stopClaudeSession("replay");
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
  onExit = undefined;
  __claudeTestReset();
});

describe("T3 Code's recorded Claude transcripts through the live adapter", () => {
  it("has all 18 recordings, with their MIT notice beside them", () => {
    expect(NAMES).toHaveLength(18);
    expect(NAMES.every((name) => name.startsWith("claude_"))).toBe(true);
    const notice = readFileSync(new URL("LICENSE", FIXTURES), "utf8");
    expect(notice).toContain("MIT License");
    expect(notice).toContain("Copyright (c) 2026 T3 Tools Inc.");
  });

  it.each(NAMES)("%s", async (name) => {
    const transcript = load(name);
    const { turns, spawns, sessionIds } = await replay(transcript);
    const recordedTurns = transcript.processes.flatMap((p) => p.turns);
    expect(turns).toHaveLength(recordedTurns.length);

    // Every prompt reached Claude, in order, as typed.
    expect(
      userPrompts().map((m) =>
        ((m.message as { content: { text?: string }[] }).content ?? [])
          .map((part) => part.text ?? "")
          .join(""),
      ),
    ).toEqual(recordedTurns.map((turn) => turn.prompt));

    // One Claude process per recorded process, and a restart resumes the same conversation.
    expect(spawns).toHaveLength(transcript.processes.length);
    for (const [index, process] of transcript.processes.entries()) {
      if (index === 0) continue;
      const resume = process.options.resume;
      if (typeof resume === "string") {
        const args = spawns[index];
        expect(args[args.indexOf("--resume") + 1]).toBe(resume);
      }
    }

    for (const turn of turns) {
      const recorded = transcript.processes[turn.processIndex].turns.find(
        (t) => t.prompt === turn.prompt,
      )!;
      const failedResult = recorded.frames.some(
        ({ frame }) => frame.type === "result" && frame.is_error === true,
      );
      const interrupted = recorded.interruptAt !== undefined;
      // A turn ends: completed, or failed only where Claude failed it or the recorded process exited under it.
      expect(turn.outcome, `${name}: "${turn.prompt.slice(0, 40)}"`).not.toBe("open");
      if (!failedResult && !interrupted && turn.outcome === "failed")
        expect(turn.error).toBe("Claude Code exited");
      if (failedResult) expect(errorsOf(turn.events).length).toBeGreaterThan(0);
      else if (turn.outcome === "completed") expect(errorsOf(turn.events)).toEqual([]);

      // The resume note's raw material: every background task Claude started shows up with its id while it runs,
      // and nothing is left over once the turn ends.
      const work = workOf(turn.events);
      const reported = new Set(work.flatMap((event) => event.work.map((entry) => entry.id)));
      for (const id of startedTaskIds(transcript, turn.processIndex, turn.prompt))
        expect(reported, `${name}: task ${id}`).toContain(id);
      if (turn.outcome === "completed" && work.length)
        expect(work.at(-1)!.work).toEqual([]);
      for (const entry of work.flatMap((event) => event.work)) {
        expect(["subagent", "shell", "monitor", "task"]).toContain(entry.kind);
        expect(entry.id).toBeTruthy();
      }
    }

    // Claude's own conversation id is what the chat binds.
    const bound = turns.flatMap((turn) =>
      turn.events.flatMap((e) =>
        e.type === "session.providerBound" ? [e.providerSessionId] : [],
      ),
    );
    for (const id of sessionIds) expect(bound).toContain(id);
  });

  // The WP5 bench logged this gap; busy briefs depend on it being closed: a brief queued behind a Lead's work is
  // sent as a new turn, and Claude may first run a wake for a task that finished meanwhile. That wake's result must
  // not end the brief's turn (its report would be the wake's words, and the brief's own work would run unseen).
  const resultsOf = (seen: FrameSeen[], prompt: string) =>
    seen
      .filter((f) => f.prompt === prompt && f.frame.type === "result")
      .map((f) => ({
        by: (f.frame.origin as { kind?: string } | null)?.kind ?? "prompt",
        result: f.frame.result,
        outcome: f.outcome,
      }));

  it("claude_background_wake_before_queued_prompt_no_echo: a wake Claude runs before a queued prompt doesn't end that prompt's turn", async () => {
    const seen: FrameSeen[] = [];
    const { turns } = await replay(load("claude_background_wake_before_queued_prompt_no_echo"), (f) => seen.push(f));
    const prompt = turns.find((t) => t.prompt.startsWith("Use the SendMessage tool"))!;
    // Still open after the wake's result; the prompt's own result ends it.
    expect(resultsOf(seen, prompt.prompt)).toEqual([
      { by: "task-notification", result: "Agent B has been confirmed killed.", outcome: "open" },
      { by: "prompt", result: "RESUMED", outcome: "completed" },
    ]);
    // The task the prompt started (SendMessage resumed Agent A) is this turn's own.
    expect(workOf(prompt.events).flatMap((e) => e.work.map((w) => w.id))).toContain("a3d786c6840cc6c7e");
    // The last prompt only got a wake before the recording ended: its turn waits for its own answer and ends when
    // Claude exits, never on the wake.
    const last = turns.at(-1)!;
    expect(resultsOf(seen, last.prompt)).toEqual([
      { by: "task-notification", result: "A_RESUME_REPORTED", outcome: "open" },
    ]);
    expect(last.outcome).toBe("failed");
    expect(last.error).toBe("Claude Code exited");
  });

  it("claude_background_wake_before_queued_prompt: the wake doesn't end the turn, and the prompt's work keeps it open", async () => {
    const seen: FrameSeen[] = [];
    const { turns } = await replay(load("claude_background_wake_before_queued_prompt"), (f) => seen.push(f));
    const prompt = turns.find((t) => t.prompt.startsWith("Use the SendMessage tool"))!;
    // The wake's result leaves it open; after its own result Agent A (resumed by this prompt) still runs, so it stays
    // open until that finishes, with the next prompt steered in.
    expect(resultsOf(seen, prompt.prompt)).toEqual([
      expect.objectContaining({ by: "task-notification", outcome: "open" }),
      { by: "prompt", result: "RESUMED", outcome: "open" },
    ]);
    const last = turns.at(-1)!;
    expect(last.steered).toBe(true);
    expect(resultsOf(seen, last.prompt)).toEqual([{ by: "prompt", result: "ALL_DONE", outcome: "completed" }]);
    expect(workOf(prompt.events).flatMap((e) => e.work.map((w) => w.id))).toContain("adf8739e67a7332fd");
  });

  it("a subagent restarted after a restart is reported by the id Claude resumes it with", async () => {
    const transcript = load("claude_subagent_resume_after_restart");
    const { turns } = await replay(transcript);
    const first = workOf(turns[0].events).flatMap((e) => e.work);
    expect(first).toContainEqual({
      kind: "subagent",
      label: "Audit src/math.ts",
      id: "a44c0ed810da9e4f3",
    });
    expect(turns.map((t) => t.outcome)).toEqual(["completed", "completed"]);
  });

  it("a backgrounded shell is reported as a shell, and an interrupt clears it", async () => {
    const transcript = load("claude_background_task_interrupt");
    const { turns } = await replay(transcript);
    const work = workOf(turns[0].events);
    expect(work.flatMap((e) => e.work)).toContainEqual({
      kind: "shell",
      label: "Background sleep task",
      id: "bt3kw2qpn",
    });
    expect(work.at(-1)!.work).toEqual([]);
  });

  it("the 401 recorded as a success with is_error fails its turn as auth, and the next one completes", async () => {
    const { turns } = await replay(load("claude_result_is_error"));
    expect(turns.map((t) => t.outcome)).toEqual(["completed", "completed"]);
    expect(errorsOf(turns[0].events)).toEqual([
      expect.objectContaining({ errorClass: "auth", retryable: false }),
    ]);
    expect(errorsOf(turns[1].events)).toEqual([]);
  });

  // WP-122: the list on the parent thread is read off the rows the adapter builds from these frames.
  const lineageOf = async (name: string) => {
    const { turns } = await replay(load(name));
    const session = turns
      .flatMap((turn) => turn.events)
      .reduce(applyHarnessEvent, newSession("claude", "/repo"));
    const lineage = lineageForThread("claude", session.blocks);
    if (!lineage?.reported) throw new Error(`${name}: no subagents reported`);
    return lineage.children;
  };

  it("claude_nested_subagent_model: the parent thread lists the subagent with its model and report", async () => {
    const children = await lineageOf("claude_nested_subagent_model");
    expect(children[0]).toMatchObject({
      id: "toolu_015wdGtqfaZX3yxLAXJKHzxY",
      name: "Test nested agent response",
      model: "claude-haiku-4-5-20251001",
      status: "done",
    });
    expect(children[0]!.result).toContain("NESTED_LEAF_OK");
  });

  it("claude_background_subagent_after_root: a background subagent is listed once it has finished", async () => {
    const children = await lineageOf("claude_background_subagent_after_root");
    expect(children.find((child) => child.id === "toolu_01AS7YtghJ9Knkp7QuuGTo7j")).toMatchObject({
      name: "Background subagent test",
      model: "claude-sonnet-4-6",
      status: "done",
    });
  });

  it("claude_subagent_resume_after_restart: the subagent Claude resumed after a restart keeps its name", async () => {
    const children = await lineageOf("claude_subagent_resume_after_restart");
    expect(children.find((child) => child.id === "toolu_015Qai4vD7RwbU7ctXxoebJ6")).toMatchObject({
      name: "Audit src/math.ts",
      model: "claude-sonnet-5",
      status: "done",
    });
  });

  it("claude_idle_resume: a thread that started no subagent has no list", async () => {
    const { turns } = await replay(load("claude_idle_resume"));
    const session = turns
      .flatMap((turn) => turn.events)
      .reduce(applyHarnessEvent, newSession("claude", "/repo"));
    expect(lineageForThread("claude", session.blocks)).toBeNull();
  });
});
