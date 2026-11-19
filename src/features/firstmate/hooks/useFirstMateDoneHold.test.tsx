// @vitest-environment happy-dom
// SC-3b: the turn-end wiring of the hold on "ready to ship" (hooks/useFirstMateDoneHold.ts). The decision itself is
// model/doneHold.ts; this keeps the seam honest: it fires on the edge where a first mate's turn ends, once per version
// per chat, sends the message before the note, and an app that can't answer holds nothing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import type { HoldDeps } from "../model/doneHold";
import { holdOnTurnEnd, useFirstMateDoneHold } from "./useFirstMateDoneHold";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEXT = "89abcdef0123456789abcdef0123456789abcdef";

function chat(over: Partial<Session> = {}, said = "The sort is fixed. It's ready to ship."): Session {
  const blocks: Block[] = [
    { id: "u1", role: "user", text: "Please finish the sort fix." },
    { id: "a1", role: "assistant", text: said },
  ];
  return { ...newSession("claude", "/work/app", "claude:opus-5-5"), id: "chat-1", firstMate: true, blocks, ...over };
}

function deps(over: Partial<HoldDeps> = {}): HoldDeps {
  return {
    mode: vi.fn(async () => "at-ship" as const),
    head: vi.fn(async () => HEAD),
    passed: vi.fn(async () => false),
    ...over,
  };
}

function send() {
  const order: string[] = [];
  return {
    order,
    ask: vi.fn(async (_id: string, _message: unknown) => {
      order.push("ask");
    }),
    note: vi.fn((_id: string, _block: unknown) => {
      order.push("note");
    }),
  };
}

describe("holdOnTurnEnd", () => {
  it("sends the app message, then the grey note, and says it held", async () => {
    const out = send();
    const memo = new Set<string>();
    const sessions = [chat()];
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps(), memo)).toBe(true);
    expect(out.order).toEqual(["ask", "note"]);
    expect(out.ask).toHaveBeenCalledWith("chat-1", expect.objectContaining({ waitForIdle: true }));
    expect(out.note).toHaveBeenCalledWith("chat-1", expect.objectContaining({ text: "Held: no ship check for this version yet." }));
  });

  // SC-7: a first mate that says "done" with a task still open is held at the same edge, in any testing mode.
  it("holds a plain done while a task is open, message first and note after, once per set of open work", async () => {
    const out = send();
    const memo = new Set<string>();
    const sessions = [chat({}, "All done. The sort is fixed.")];
    const open = {
      tasks: [{ id: "t1", title: "Fix the save bug", status: "working" as const }],
      unanswered: [],
    };
    const api = deps({ mode: vi.fn(async () => "off" as const), work: vi.fn(async () => open) });
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, api, memo)).toBe(true);
    expect(out.order).toEqual(["ask", "note"]);
    expect(out.ask).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        text: expect.stringContaining("Not done yet: 1 task is still open (Fix the save bug: working). Finish or close it, then report."),
      }),
    );
    expect(out.note).toHaveBeenCalledWith("chat-1", expect.objectContaining({ text: "Held: tasks still open." }));
    // The same set of open work is not held again; a changed set is.
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, api, memo)).toBe(false);
    const changed = deps({
      work: vi.fn(async () => ({ tasks: [{ id: "t1", title: "Fix the save bug", status: "failed" as const }], unanswered: [] })),
    });
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, changed, memo)).toBe(true);
  });

  it("gives the hold back when the message could not be queued, so the next turn that ends tries again", async () => {
    const memo = new Set<string>();
    const sessions = [chat({}, "All done.")];
    const api = deps({ work: vi.fn(async () => ({ tasks: [{ id: "t1", title: "A", status: "working" as const }], unanswered: [] })) });
    const failing = {
      ask: vi.fn(async () => {
        throw new Error("This chat does not take app messages.");
      }),
      note: vi.fn(),
    };
    expect(await holdOnTurnEnd("chat-1", () => sessions, failing, api, memo)).toBe(false);
    expect(failing.note).not.toHaveBeenCalled();
    expect(memo.size).toBe(0);
    expect(await holdOnTurnEnd("chat-1", () => sessions, send(), api, memo)).toBe(true);
  });

  it("holds once per version per chat, and again for a new version", async () => {
    const out = send();
    const memo = new Set<string>();
    const sessions = [chat()];
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps(), memo)).toBe(true);
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps(), memo)).toBe(false);
    expect(out.ask).toHaveBeenCalledTimes(1);
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps({ head: vi.fn(async () => NEXT) }), memo)).toBe(true);
    expect(out.ask).toHaveBeenCalledTimes(2);
  });

  it("holds nothing when the project isn't tested at ship, or a ship check passed", async () => {
    const out = send();
    const sessions = [chat()];
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps({ mode: vi.fn(async () => "light" as const) }), new Set())).toBe(false);
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps({ passed: vi.fn(async () => true) }), new Set())).toBe(false);
    expect(out.ask).not.toHaveBeenCalled();
    expect(out.note).not.toHaveBeenCalled();
  });

  it("holds nothing, and throws nothing, when the app can't answer", async () => {
    const out = send();
    const sessions = [chat()];
    for (const broken of [
      deps({ mode: vi.fn(async () => Promise.reject("gone")) }),
      deps({ head: vi.fn(async () => Promise.reject(new Error("no git"))) }),
      deps({ passed: vi.fn(async () => Promise.reject("gone")) }),
    ]) {
      await expect(holdOnTurnEnd("chat-1", () => sessions, out, broken, new Set())).resolves.toBe(false);
    }
    expect(out.ask).not.toHaveBeenCalled();
  });

  it("gives the memo back when the message could not be queued, so the next turn end tries again", async () => {
    const out = send();
    out.ask.mockRejectedValueOnce(new Error("the chat is gone"));
    const memo = new Set<string>();
    const sessions = [chat()];
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps(), memo)).toBe(false);
    expect(out.note).not.toHaveBeenCalled();
    expect(memo.size).toBe(0);
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps(), memo)).toBe(true);
    expect(out.note).toHaveBeenCalledTimes(1);
  });

  it("adds no note and gives the memo back when the app refuses the message at once, then tries again at the next turn end", async () => {
    // App.tsx's ask throws for a chat that isn't an orchestrator chat, before it queues anything.
    const out = send();
    out.ask.mockImplementationOnce(() => {
      throw new Error("This chat does not take app messages.");
    });
    const memo = new Set<string>();
    const sessions = [chat()];
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps(), memo)).toBe(false);
    expect(out.note).not.toHaveBeenCalled();
    expect(memo.size).toBe(0);
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, deps(), memo)).toBe(true);
    expect(out.ask).toHaveBeenCalledTimes(2);
    expect(out.note).toHaveBeenCalledTimes(1);
    expect(memo.size).toBe(1);
  });

  it("does nothing for a chat that is gone, mid-turn again, or has moved past the claim", async () => {
    const out = send();
    expect(await holdOnTurnEnd("nope", () => [chat()], out, deps(), new Set())).toBe(false);
    expect(await holdOnTurnEnd("chat-1", () => [chat({ busy: true })], out, deps(), new Set())).toBe(false);
    // It went busy again while the app was answering.
    let sessions = [chat()];
    const slow = deps({
      passed: vi.fn(async () => {
        sessions = [chat({ busy: true })];
        return false;
      }),
    });
    expect(await holdOnTurnEnd("chat-1", () => sessions, out, slow, new Set())).toBe(false);
    expect(out.ask).not.toHaveBeenCalled();
  });
});

describe("the hook", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function Harness(props: { sessions: Session[]; api: ReturnType<typeof send>; deps: HoldDeps }) {
    useFirstMateDoneHold({ sessions: props.sessions, ask: props.api.ask, note: props.api.note, deps: props.deps });
    return null;
  }

  async function show(sessions: Session[], api: ReturnType<typeof send>, d: HoldDeps) {
    await act(async () => {
      root.render(createElement(Harness, { sessions, api, deps: d }));
    });
    // The hold decides after a few awaits.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("fires when a first mate's turn ends on a ship claim, and only once for that version", async () => {
    const api = send();
    const d = deps();
    await show([chat({ busy: true })], api, d);
    expect(api.ask).not.toHaveBeenCalled();
    await show([chat({ busy: false })], api, d);
    expect(api.ask).toHaveBeenCalledTimes(1);
    expect(api.note).toHaveBeenCalledTimes(1);
    // The next turn, on the same version, claims it again: no second message.
    await show([chat({ busy: true })], api, d);
    await show([chat({ busy: false }, "Still ready to ship.")], api, d);
    expect(api.ask).toHaveBeenCalledTimes(1);
  });

  it("fires again once the project has a new version", async () => {
    const api = send();
    let head = HEAD;
    const d = deps({ head: vi.fn(async () => head) });
    await show([chat({ busy: true })], api, d);
    await show([chat({ busy: false })], api, d);
    expect(api.ask).toHaveBeenCalledTimes(1);
    head = NEXT;
    await show([chat({ busy: true })], api, d);
    await show([chat({ busy: false }, "Fixed the rest. Ready to ship.")], api, d);
    expect(api.ask).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a chat that was already idle, a chat that isn't a first mate, or a turn with no claim", async () => {
    const api = send();
    const d = deps();
    await show([chat({ busy: false })], api, d);
    await show([chat({ busy: true, id: "plain", firstMate: false })], api, d);
    await show([chat({ busy: false, id: "plain", firstMate: false })], api, d);
    await show([chat({ busy: true, id: "calm" }, "I fixed the sort.")], api, d);
    await show([chat({ busy: false, id: "calm" }, "I fixed the sort.")], api, d);
    expect(api.ask).not.toHaveBeenCalled();
    expect(d.mode).not.toHaveBeenCalled();
  });

  it("holds nothing in a project that isn't tested at ship, and survives an app that can't answer", async () => {
    const light = send();
    const d1 = deps({ mode: vi.fn(async () => "full" as const) });
    await show([chat({ busy: true })], light, d1);
    await show([chat({ busy: false })], light, d1);
    expect(light.ask).not.toHaveBeenCalled();
    const broken = send();
    const d2 = deps({ head: vi.fn(async () => Promise.reject("gone")) });
    await show([chat({ busy: true, id: "chat-2" })], broken, d2);
    await show([chat({ busy: false, id: "chat-2" })], broken, d2);
    expect(broken.ask).not.toHaveBeenCalled();
  });
});
