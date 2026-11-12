import { describe, expect, it } from "vitest";
import { buildDeterministicHandoff, sessionChildHarnesses } from "./handoff";
import {
  applyMidThreadSwitch,
  buildPortableTranscript,
  LEFT_OUT_POINTER_LIMIT,
  PORTABLE_TRANSCRIPT_LIMIT,
  commitMidThreadSwitch,
  continueThisChatLine,
  harnessCanResumePortable,
  planPortableHandoff,
  recapNewChatLine,
  refuseResumeReason,
  restoreUnsentPortableResume,
  wrapPortableResume,
  type ThreadPort,
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

function portOver(initial: Session): { port: ThreadPort; read: () => Session | undefined } {
  let live = initial;
  return {
    read: () => live,
    port: {
      get: (id) => (live.id === id ? live : undefined),
      compareAndPut: (session, seen) => {
        if (
          live.blocks.length !== seen.blocks ||
          live.harness !== seen.harness ||
          live.model !== seen.model
        ) {
          return false;
        }
        live = session;
        return true;
      },
    },
  };
}

describe("commitMidThreadSwitch", () => {
  const target = {
    harness: "codex" as const,
    model: "codex:gpt-5",
    modelSettings: { effort: "medium" },
  };

  it("keeps the thread id and a marker when the target can resume", () => {
    const session = sessionWith([user("u1", "keep going")], {
      providerSessionId: "claude-1",
    });
    const { port, read } = portOver(session);
    const result = commitMidThreadSwitch(port, session.id, target);
    expect(result.kind).toBe("ok");
    const next = read();
    expect(next?.id).toBe(session.id);
    expect(next?.harness).toBe("codex");
    expect(next?.providerSessionId).toBeUndefined();
    expect(next?.pendingSwitch).toBeUndefined();
    expect(next?.portableResume?.from).toBe("claude");
    expect(next?.portableResume?.fromProviderSessionId).toBe("claude-1");
    expect(next?.portableResume?.transcript).toContain("keep going");
    expect(next?.midThread).toEqual({
      kind: "resume",
      line: "Continue this chat with Codex",
    });
    const marker = next?.blocks.find((block) => block.handoff?.switchTo);
    expect(marker?.handoff?.switchTo?.label).toBe("Switched to Codex");
    expect(marker?.text).toBe("Switched to Codex");
  });

  it("keeps the provider session when only the model changes", () => {
    const session = sessionWith([user("u1", "hello")], {
      providerSessionId: "claude-1",
      model: "claude:opus",
    });
    const { port, read } = portOver(session);
    const result = commitMidThreadSwitch(port, session.id, {
      harness: "claude",
      model: "claude:sonnet",
      modelSettings: {},
    });
    expect(result.kind).toBe("ok");
    const next = read();
    expect(next?.id).toBe(session.id);
    expect(next?.providerSessionId).toBe("claude-1");
    expect(next?.portableResume).toBeUndefined();
    expect(next?.pendingSwitch).toBeUndefined();
    expect(next?.blocks.some((block) => block.handoff?.switchTo)).toBe(true);
    expect(next?.midThread?.kind).toBe("resume");
    expect(next?.midThread?.line.startsWith("Continue this chat with ")).toBe(true);
  });

  it("arms today's recap, and says so, when the target cannot resume", () => {
    const session = sessionWith([user("u1", "fix the header")], {
      providerSessionId: "claude-1",
    });
    const { port, read } = portOver(session);
    const result = commitMidThreadSwitch(port, session.id, {
      harness: "fx",
      model: "fx:default",
      modelSettings: {},
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.outcome.plan.kind).toBe("recap");
    if (result.outcome.plan.kind !== "recap") return;
    expect(result.outcome.plan.recap).toBe(buildDeterministicHandoff(session));
    expect(result.outcome.plan.reason).toContain("cannot resume");
    const next = read();
    expect(next?.id).toBe(session.id);
    expect(next?.portableResume).toBeUndefined();
    expect(next?.pendingSwitch?.from).toBe("claude");
    expect(next?.pendingSwitch?.fromProviderSessionId).toBe("claude-1");
    expect(next?.midThread).toEqual({
      kind: "recap",
      line: "Start a new chat with a recap, because fx cannot resume",
    });
  });

  it("restores the original provider session when the person switches back before sending", () => {
    const session = sessionWith([user("u1", "hello")], {
      providerSessionId: "claude-1",
    });
    const { port, read } = portOver(session);
    commitMidThreadSwitch(port, session.id, target);
    const back = commitMidThreadSwitch(port, session.id, {
      harness: "claude",
      model: session.model,
      modelSettings: session.modelSettings,
    });
    expect(back.kind).toBe("ok");
    const next = read();
    expect(next?.harness).toBe("claude");
    expect(next?.providerSessionId).toBe("claude-1");
    expect(next?.portableResume).toBeUndefined();
    expect(next?.pendingSwitch).toBeUndefined();
    expect(next?.midThread).toBeUndefined();
    expect(next?.blocks.some((block) => block.handoff?.switchTo)).toBe(false);
  });

  it("does not overwrite a thread that changed while the switch was decided", () => {
    const session = sessionWith([user("u1", "hello")]);
    let live = session;
    const port: ThreadPort = {
      get: (id) => (live.id === id ? live : undefined),
      compareAndPut: (_session, seen) => {
        live = {
          ...live,
          blocks: [...live.blocks, user("late", "arrived first")],
        };
        return (
          live.blocks.length === seen.blocks &&
          live.harness === seen.harness &&
          live.model === seen.model
        );
      },
    };
    const result = commitMidThreadSwitch(port, session.id, target);
    expect(result.kind).toBe("conflict");
    expect(live.harness).toBe("claude");
    expect(live.blocks.map((block) => block.id)).toEqual(["u1", "late"]);
  });

  it("reports a missing thread and leaves the port alone", () => {
    const { port, read } = portOver(sessionWith([user("u1", "hello")]));
    const before = read();
    expect(commitMidThreadSwitch(port, "missing", target).kind).toBe("missing");
    expect(read()).toEqual(before);
  });

  it("forgets an empty thread's old harness and does not invent a marker", () => {
    const session = sessionWith([]);
    const outcome = applyMidThreadSwitch(session, target);
    expect(outcome.forget).toBe("claude");
    expect(outcome.session.id).toBe(session.id);
    expect(outcome.session.blocks).toEqual([]);
    expect(outcome.session.midThread).toBeUndefined();
    expect(outcome.session.pendingSwitch).toBeUndefined();
  });
});

describe("restoreUnsentPortableResume", () => {
  const resume = {
    from: "claude" as const,
    fromModel: "claude:opus",
    fromSettings: {},
    transcript: "User:\nhello",
    markerId: "m1",
  };
  const notice = {
    kind: "resume" as const,
    line: "Continue this chat with Codex",
  };

  it("puts the transcript back when the send never reached the provider", () => {
    const cleared = sessionWith([user("u1", "hello")], {
      harness: "codex",
      model: "codex:gpt-5",
    });
    const restored = restoreUnsentPortableResume(cleared, resume, notice, {
      harness: "codex",
      model: "codex:gpt-5",
    });
    expect(restored.portableResume).toEqual(resume);
    expect(restored.midThread).toEqual(notice);
  });

  it("leaves a newer switch and a moved thread alone", () => {
    const newer = sessionWith([user("u1", "hello")], {
      harness: "codex",
      model: "codex:gpt-5",
      portableResume: { ...resume, transcript: "newer" },
    });
    expect(
      restoreUnsentPortableResume(newer, resume, notice, {
        harness: "codex",
        model: "codex:gpt-5",
      }),
    ).toBe(newer);
    const moved = sessionWith([user("u1", "hello")], { harness: "claude" });
    expect(
      restoreUnsentPortableResume(moved, resume, notice, {
        harness: "codex",
        model: "codex:gpt-5",
      }),
    ).toBe(moved);
    expect(restoreUnsentPortableResume(moved, undefined, notice, {
      harness: "claude",
      model: "claude:opus",
    })).toBe(moved);
  });
});

describe("wrapPortableResume", () => {
  it("keeps the new request outside the transcript", () => {
    const text = wrapPortableResume("User:\nfix the header", "claude", "now the footer");
    expect(text).toContain("<thread>");
    expect(text).toContain("fix the header");
    expect(text).toContain("now the footer");
    expect(text.indexOf("now the footer")).toBeLessThan(text.indexOf("<thread>"));
    expect(text).not.toMatch(/[—–]/);
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

describe("portable switch of a busy chat (WP-121 review)", () => {
  it("keeps the old CLI in the child set so Stop, close and detach reach it", () => {
    const base = sessionWith([user("u1", "hi"), assistant("a1", "working")], { busy: true });
    const out = applyMidThreadSwitch(
      base,
      { harness: "codex", model: "codex:gpt-5", modelSettings: {} },
      undefined,
    );
    expect(out.session.harness).toBe("codex");
    expect(out.session.portableResume?.from).toBe("claude");
    expect(sessionChildHarnesses(out.session).sort()).toEqual(["claude", "codex"]);
  });

  it("builds the hand-over at send time, so output streamed after the switch is in it", () => {
    const blocks = [user("u1", "hi"), assistant("a1", "early")];
    const out = applyMidThreadSwitch(
      sessionWith(blocks, { busy: true }),
      { harness: "codex", model: "codex:gpt-5", modelSettings: {} },
      undefined,
    );
    const resume = out.session.portableResume!;
    expect(resume.transcript).not.toContain("late streamed");
    const later = [...blocks, assistant("a2", "late streamed")];
    expect(buildPortableTranscript(later, resume.messageIds)).toContain("late streamed");
  });

  it("caps a long hand-over, keeps the newest messages and says how many were left out", () => {
    const blocks: Block[] = [];
    for (let i = 0; i < 200; i += 1) {
      blocks.push(user(`u${i}`, `question ${i}`), assistant(`a${i}`, `answer ${i} ${"x".repeat(500)}`));
    }
    const text = buildPortableTranscript(blocks);
    expect(text.length).toBeLessThanOrEqual(PORTABLE_TRANSCRIPT_LIMIT + 100);
    expect(text).toContain("answer 199");
    expect(text).not.toContain("answer 0 ");
    expect(text).toMatch(/\[\d+ earlier messages left out to fit\]/);
    const one = buildPortableTranscript([assistant("a", "y".repeat(100_000))]);
    expect(one.length).toBeLessThanOrEqual(PORTABLE_TRANSCRIPT_LIMIT + 50);
  });

  describe("WP-251: the first ask and pointers to what was left out", () => {
    function longChat(turns: number): Block[] {
      const blocks: Block[] = [];
      for (let i = 0; i < turns; i += 1) {
        blocks.push(user(`u${i}`, `question ${i}`), assistant(`a${i}`, `answer ${i} ${"x".repeat(500)}`));
      }
      return blocks;
    }

    it("keeps the first ask first, then the marker, then the newest messages in order", () => {
      const text = buildPortableTranscript(longChat(200), null, PORTABLE_TRANSCRIPT_LIMIT, "chat-1");
      expect(text.length).toBeLessThanOrEqual(PORTABLE_TRANSCRIPT_LIMIT);
      expect(text.startsWith("User:\nquestion 0")).toBe(true);
      const marker = text.indexOf("earlier messages left out to fit");
      expect(marker).toBeGreaterThan(text.indexOf("question 0"));
      expect(text.indexOf("answer 198")).toBeLessThan(text.indexOf("answer 199"));
      expect(text.indexOf("answer 199")).toBeGreaterThan(marker);
      expect(text).not.toContain("answer 0 ");
    });

    it("names the left-out messages by id, capped, and says how to read them", () => {
      const text = buildPortableTranscript(longChat(200), null, PORTABLE_TRANSCRIPT_LIMIT, "chat-1");
      const pointers = text.split("\n").filter((line) => /^- (User|Assistant) [ua]\d+: /.test(line));
      expect(pointers).toHaveLength(LEFT_OUT_POINTER_LIMIT);
      expect(text).toMatch(/\(the \d+ oldest are not listed\)/);
      expect(text).toContain('sessions.read with sessionId: "chat-1"');
      const firstKept = /before: "(u\d+)"/.exec(text)?.[1];
      expect(firstKept).toBeDefined();
      expect(text).toContain(`User:\nquestion ${firstKept!.slice(1)}`);
    });

    it("cuts a huge first ask to a quarter of the budget", () => {
      const blocks = [user("u0", "q".repeat(50_000)), ...longChat(100).slice(1)];
      const text = buildPortableTranscript(blocks, null, PORTABLE_TRANSCRIPT_LIMIT, "chat-1");
      expect(text.length).toBeLessThanOrEqual(PORTABLE_TRANSCRIPT_LIMIT);
      expect(text.indexOf("[truncated]")).toBeLessThan(text.indexOf("left out to fit"));
      expect(text).toContain("answer 99");
    });

    it("leaves a short chat exactly as before, and omits the read line without a chat id", () => {
      const blocks = longChat(3);
      expect(buildPortableTranscript(blocks, null, PORTABLE_TRANSCRIPT_LIMIT, "chat-1")).toBe(buildPortableTranscript(blocks));
      expect(buildPortableTranscript(blocks)).not.toContain("left out");
      expect(buildPortableTranscript(longChat(200))).not.toContain("sessions.read");
    });
  });
});
