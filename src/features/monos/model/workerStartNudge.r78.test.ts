import { describe, expect, it } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import { START_WORKERS_PREFIX, workerStartNudge } from "./workerStartNudge";

// r78 (s13 runs 1-3): the Lead listed the asks, said the jobs start next, and ended its turn with no delegate_task.
const ash: Block = { id: "u1", role: "user", text: "big dump, sorry. 1 the +1 button 2 the title ... 40 tell me what you think i forgot", startedAt: 1_000 };
const list = "Forty items, in your order. Jobs start next.\n1. Bigger +1 on mobile.\n2. Title says Team board.\n3. Streak badge.";
const reply = (text = list): Block => ({ id: "a1", role: "assistant", text });
const delegate = (status = "completed"): Block => ({ id: "t1", role: "tool", text: "", tool: { kind: "mcp__monocode__delegate_task", title: "mcp__monocode__delegate_task", status } });
const chat = (blocks: Block[], extra: Partial<Session> = {}): Session => ({ ...newSession("claude", "/p"), id: "lead", blocks, ...extra });

describe("a Lead that listed the asks and started no worker is asked to start them", () => {
  it("asks once, as an app message that waits for the chat to be idle", () => {
    const nudge = workerStartNudge(chat([ash, reply()]), [], new Set());
    expect(nudge?.id).toBe("start-workers-u1");
    expect(nudge?.waitForIdle).toBe(true);
    expect(nudge?.text.startsWith(START_WORKERS_PREFIX)).toBe(true);
    expect(nudge?.text).toContain("delegate_task");
    expect(workerStartNudge(chat([ash, reply()]), [], new Set(["u1"]))).toBeUndefined();
  });

  it("leaves it alone while it works, or once a worker started (by its tool call or a task it owns)", () => {
    expect(workerStartNudge(chat([ash, reply()], { busy: true }), [], new Set())).toBeUndefined();
    expect(workerStartNudge(chat([ash, reply(), delegate()]), [], new Set())).toBeUndefined();
    expect(workerStartNudge(chat([ash, reply()]), [{ ownerSession: "lead", createdAt: 2_000 }], new Set())).toBeUndefined();
  });

  it("still asks when the only delegate_task failed, or the task it owns is from before Ash's message", () => {
    expect(workerStartNudge(chat([ash, reply(), delegate("failed")]), [], new Set())).toBeDefined();
    expect(workerStartNudge(chat([ash, reply()]), [{ ownerSession: "lead", createdAt: 500 }], new Set())).toBeDefined();
  });

  it("not for a short answer, a list that starts nothing, or its own nudge's turn", () => {
    expect(workerStartNudge(chat([ash, reply("Yes, the reset is Monday.")]), [], new Set())).toBeUndefined();
    expect(workerStartNudge(chat([ash, reply("Options:\n1. Monday\n2. Sunday\n3. Rolling")]), [], new Set())).toBeUndefined();
    const ours: Block = { ...ash, id: "u2", text: `${START_WORKERS_PREFIX} From the app: ...` };
    expect(workerStartNudge(chat([ash, reply(), ours, reply()]), [], new Set())).toBeUndefined();
  });
});
