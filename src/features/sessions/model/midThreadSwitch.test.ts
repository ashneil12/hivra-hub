import { describe, expect, it } from "vitest";
import { buildDeterministicHandoff } from "./handoff";
import {
  continueThisChatLine,
  harnessCanResumePortable,
  planPortableHandoff,
  recapNewChatLine,
  refuseResumeReason,
} from "./midThreadSwitch";
import { newSession, type Block, type Session } from "./session";

function sessionWith(blocks: Block[], extra?: Partial<Session>): Session {
  return {
    ...newSession("claude", "/tmp/project"),
    blocks,
    ...extra,
  };
}

const user = (id: string, text: string): Block => ({ id, role: "user", text });
const assistant = (id: string, text: string): Block => ({
  id,
  role: "assistant",
  text,
});

describe("planPortableHandoff", () => {
  it("keeps selected messages in thread order, once, and skips everything else", () => {
    const long = "full answer ".repeat(80);
    const session = sessionWith([
      user("u1", "first"),
      assistant("a1", long),
      {
        id: "tool",
        role: "tool",
        text: "Edited src/app.ts",
        tool: { title: "Edited src/app.ts", kind: "edit" },
      },
      { id: "reason", role: "reasoning", text: "hidden chain" },
      user("u2", "second"),
      user("u1", "duplicate id, ignored"),
      assistant("a2", "  "),
    ]);
    const plan = planPortableHandoff(
      session,
      { harness: "codex", model: "codex:gpt-5" },
      ["missing", "a1", "u2", "u1", "u1", "tool", "reason", "a2"],
      () => true,
    );
    expect(plan.kind).toBe("resume");
    if (plan.kind !== "resume") return;
    expect(plan.threadId).toBe(session.id);
    expect(plan.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
    expect(plan.messages[0]?.text).toBe("first");
    expect(plan.transcript).toContain("first");
    expect(plan.transcript).toContain("second");
    expect(plan.transcript).not.toContain("Edited src/app.ts");
    expect(plan.transcript).not.toContain("hidden chain");
    expect(plan.transcript).not.toContain("duplicate id");
    expect(plan.transcript).toContain(long.trim());
  });

  it("defaults to the whole thread of user and assistant messages", () => {
    const session = sessionWith([
      user("u1", "hello"),
      assistant("a1", "hi"),
    ]);
    const plan = planPortableHandoff(
      session,
      { harness: "codex", model: "codex:gpt-5" },
      undefined,
      () => true,
    );
    expect(plan.kind).toBe("resume");
    if (plan.kind !== "resume") return;
    expect(plan.messages.map((message) => message.text)).toEqual(["hello", "hi"]);
  });

  it("treats an empty id list as a selection of nothing, not the whole thread", () => {
    const session = sessionWith([user("u1", "hello")]);
    const plan = planPortableHandoff(
      session,
      { harness: "codex", model: "codex:gpt-5" },
      [],
      () => true,
    );
    expect(plan.kind).toBe("resume");
    if (plan.kind !== "resume") return;
    expect(plan.messages).toEqual([]);
    expect(plan.transcript).toBe("");
  });

  it("returns an empty transcript for an empty thread that can resume", () => {
    const session = sessionWith([]);
    const plan = planPortableHandoff(
      session,
      { harness: "codex", model: "codex:gpt-5" },
      undefined,
      () => true,
    );
    expect(plan.kind).toBe("resume");
    if (plan.kind !== "resume") return;
    expect(plan.threadId).toBe(session.id);
    expect(plan.messages).toEqual([]);
    expect(plan.transcript).toBe("");
  });

  it("falls back to today's recap, with a reason, when the target refuses", () => {
    const session = sessionWith([
      user("u1", "fix the header"),
      assistant("a1", "Looking at it."),
    ]);
    const plan = planPortableHandoff(
      session,
      { harness: "fx", model: "fx:default" },
      ["u1"],
      () => false,
    );
    expect(plan.kind).toBe("recap");
    if (plan.kind !== "recap") return;
    expect(plan.recap).toBe(buildDeterministicHandoff(session));
    expect(plan.reason).toBe(refuseResumeReason("fx"));
    expect(plan.reason).toContain("cannot resume");
    expect(plan.reason).not.toMatch(/[—–]/);
    expect(plan.recap).toContain("fix the header");
  });

  it("still returns the recap and a reason for an empty thread that cannot resume", () => {
    const session = sessionWith([]);
    const plan = planPortableHandoff(
      session,
      { harness: "devin", model: "devin:default" },
      undefined,
      () => false,
    );
    expect(plan.kind).toBe("recap");
    if (plan.kind !== "recap") return;
    expect(plan.recap).toBe(buildDeterministicHandoff(session));
    expect(plan.reason.length).toBeGreaterThan(0);
  });
});

describe("harnessCanResumePortable", () => {
  it("accepts a local coding harness and refuses one whose session cannot be seeded", () => {
    expect(harnessCanResumePortable("claude")).toBe(true);
    expect(harnessCanResumePortable("codex")).toBe(true);
    expect(harnessCanResumePortable("fx")).toBe(false);
    expect(harnessCanResumePortable("devin")).toBe(false);
  });
});

describe("switch copy", () => {
  it("names a continue and a recap without a silent switch", () => {
    expect(
      continueThisChatLine({ harness: "codex", model: "codex:gpt-5" }, "claude"),
    ).toBe("Continue this chat with Codex");
    expect(recapNewChatLine("fx")).toBe(
      "Start a new chat with a recap, because fx cannot resume",
    );
    expect(continueThisChatLine({ harness: "codex", model: "x" }, "claude")).not.toMatch(
      /[—–]/,
    );
    expect(recapNewChatLine("devin")).not.toMatch(/[—–]/);
  });
});
