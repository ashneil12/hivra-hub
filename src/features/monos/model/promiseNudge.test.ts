import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { appNoteText } from "../../sessions/model/appNote";
import { KEEP_PROMISE_PREFIX, promiseNudge } from "./promiseNudge";

function chat(blocks: Block[], extra: Partial<Session> = {}): Session {
  return { id: "lead-1", blocks, busy: false, ...extra } as unknown as Session;
}
const ash = (id: string, text: string): Block => ({ id, role: "user", text }) as Block;
const says = (id: string, text: string): Block => ({ id, role: "assistant", text }) as Block;
const tool = (id: string): Block => ({ id, role: "assistant", text: "", tool: { name: "Bash" } }) as unknown as Block;

describe("promiseNudge", () => {
  it("asks a finished chat to do the step its last words promised", () => {
    const nudge = promiseNudge(chat([ash("a1", "Pull the open issues"), tool("t1"), says("r1", "I have 11 of 20. I'll fetch the rest now.")]), new Set());
    expect(nudge?.id).toBe("keep-promise-r1");
    expect(nudge?.waitForIdle).toBe(true);
    expect(nudge?.text.startsWith(KEEP_PROMISE_PREFIX)).toBe(true);
    expect(nudge?.text).toContain(`"I'll fetch the rest now."`);
    expect(appNoteText(nudge!.text)).toBe("The app asked the chat to do the step it said it would do");
  });

  it("leaves a finished answer, a question, a busy chat and a turn ending on a tool alone", () => {
    expect(promiseNudge(chat([ash("a1", "x"), says("r1", "Here is the list. Let me know if you want more.")]), new Set())).toBeUndefined();
    expect(promiseNudge(chat([ash("a1", "x"), says("r1", "Shall I fetch the rest now?")]), new Set())).toBeUndefined();
    expect(promiseNudge(chat([ash("a1", "x"), says("r1", "I'll fetch the rest now.")], { busy: true }), new Set())).toBeUndefined();
    expect(promiseNudge(chat([ash("a1", "x"), says("r1", "I'll fetch the rest now."), tool("t1")]), new Set())).toBeUndefined();
    expect(promiseNudge(chat([ash("a1", "x"), says("r1", "I'll send it once you confirm.")]), new Set())).toBeUndefined();
  });

  it("nudges each reply once, and stops after two in a row until Ash writes again", () => {
    expect(promiseNudge(chat([ash("a1", "x"), says("r1", "I'll fetch the rest now.")]), new Set(["r1"]))).toBeUndefined();
    const n = (id: string) => ash(id, `${KEEP_PROMISE_PREFIX} From the app: ...`);
    const twice = [ash("a1", "x"), says("r1", "I'll fetch the rest now."), n("n1"), says("r2", "Let me pull them now."), n("n2"), says("r3", "Fetching the rest now.")];
    expect(promiseNudge(chat(twice), new Set())).toBeUndefined();
    const once = twice.slice(0, 4);
    expect(promiseNudge(chat(once), new Set())?.id).toBe("keep-promise-r2");
    const fresh = [...twice, ash("a2", "go on"), says("r4", "I'll fetch the rest now.")];
    expect(promiseNudge(chat(fresh), new Set())?.id).toBe("keep-promise-r4");
  });

  it("skips notes the app put after the reply", () => {
    const note = { id: "s1", role: "system", text: "note" } as Block;
    expect(promiseNudge(chat([ash("a1", "x"), says("r1", "I'll fetch the rest now."), note]), new Set())?.id).toBe("keep-promise-r1");
  });
});
