// Moved from monos/model/workerStall.test.ts with the stall judge (Hivra WP-11): a worker can be stuck without asking
// or failing (Ash 20 Oct): quiet mid-turn, looping on one step, or idle without a report.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { judgeStall, type Presence } from "./stall";
import { lookAt } from "./look";

const MIN = 60_000;
let seq = 0;
const tool = (title: string, status = "completed", detail = "ok"): Block => ({
  id: `b${++seq}`,
  role: "tool",
  text: title,
  tool: { kind: "execute", title, status, detail },
});
const said = (text: string): Block => ({ id: `b${++seq}`, role: "assistant", text });
const asked = (): Block => ({ id: `b${++seq}`, role: "user", text: "Fix the save bug", startedAt: 0 });

type Chat = Pick<Session, "busy" | "blocks" | "pendingQuestion" | "queuedMessages" | "queueStatus" | "usageLimit" | "cwd">;
const chat = (blocks: Block[], extra: Partial<Chat> = {}): Chat => ({ busy: true, blocks, cwd: "/repo", ...extra });
const seen = (over: Partial<Presence> = {}): Presence => ({ watchedSince: 0, lastProgressAt: 0, steps: 0, ...over });

describe("judgeStall", () => {
  it("a busy worker that keeps talking is fine; six quiet minutes make it stuck since its last change", () => {
    const look = lookAt(chat([asked(), said("Reading the save code")]));
    expect(judgeStall(look, seen({ lastChangeAt: 10 * MIN, lastProgressAt: 10 * MIN }), 15 * MIN)).toBeNull();
    expect(judgeStall(look, seen({ lastChangeAt: 10 * MIN, lastProgressAt: 10 * MIN }), 16 * MIN)).toEqual({
      kind: "quiet",
      reason: "",
      since: 10 * MIN,
    });
  });

  it("gives a step that is still running longer (20 min), and says which", () => {
    const look = lookAt(chat([asked(), tool("npm test", "in_progress", "")]));
    expect(look.runningTool).toBeTruthy();
    const presence = seen({ lastChangeAt: 0 });
    expect(judgeStall(look, presence, 12 * MIN)).toBeNull();
    const stall = judgeStall(look, presence, 20 * MIN);
    expect(stall?.kind).toBe("quiet");
    expect(stall?.reason).toMatch(/^Still running .*npm test/);
  });

  it("the same finished step with the same output six times in a row is a loop; a different output breaks it", () => {
    const five = [asked(), ...Array.from({ length: 5 }, () => tool("gh pr checks", "completed", "pending"))];
    expect(lookAt(chat(five)).repeat?.count).toBe(5);
    expect(judgeStall(lookAt(chat(five)), seen({ lastChangeAt: 100 }), 200)).toBeNull();
    const six = [...five, tool("gh pr checks", "completed", "pending")];
    const stall = judgeStall(lookAt(chat(six)), seen({ lastChangeAt: 100, repeatSince: 150 }), 200);
    expect(stall).toMatchObject({ kind: "loop", since: 150 });
    expect(stall?.reason).toMatch(/^Repeating the same step: .*gh pr checks.* \(6 times\)$/);
    const varied = [...five, tool("gh pr checks", "completed", "1 failing")];
    expect(lookAt(chat(varied)).repeat).toBeUndefined();
  });

  it("an hour without a new step is left to the hourly progress check (workerProgress.ts), which reads real progress", () => {
    const look = lookAt(chat([asked(), tool("npm test")]));
    const presence = seen({ lastChangeAt: 59 * MIN, lastProgressAt: 0 });
    expect(judgeStall(look, presence, 60 * MIN)).toBeNull();
  });

  it("idle with its row still running means it stopped without reporting; a question, a queued message or a limit holds it", () => {
    const idle = chat([asked(), said("Done, I think")], { busy: false });
    expect(judgeStall(lookAt(idle), seen({ lastChangeAt: 0 }), 5 * MIN)).toBeNull();
    expect(judgeStall(lookAt(idle), seen({ lastChangeAt: 0 }), 6 * MIN)).toEqual({
      kind: "idle",
      reason: "Stopped without reporting back",
      since: 0,
    });
    const queued = { ...idle, queuedMessages: [{ id: "m", text: "go on", attachments: [] }] } as Chat;
    expect(judgeStall(lookAt(queued), seen(), 60 * MIN)).toBeNull();
    expect(judgeStall(lookAt({ ...queued, queueStatus: "paused" }), seen(), 60 * MIN)?.kind).toBe("idle");
    const resumeStopped = chat([asked(), { id: "n", role: "system", text: "Stopped resuming", notice: "resume-stopped" } as Block], {
      busy: false,
    });
    expect(judgeStall(lookAt(resumeStopped), seen(), 6 * MIN)?.reason).toBe("Stopped resuming itself after restarts");
  });

  it("unknown is never stuck: the clock starts when this window first sees the worker", () => {
    const look = lookAt(chat([asked()]));
    expect(judgeStall(look, seen({ watchedSince: 100 * MIN, lastProgressAt: 100 * MIN }), 105 * MIN)).toBeNull();
    expect(judgeStall(look, seen({ watchedSince: 100 * MIN, lastProgressAt: 100 * MIN }), 106 * MIN)?.since).toBe(100 * MIN);
  });
});
