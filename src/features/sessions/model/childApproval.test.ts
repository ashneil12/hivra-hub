import { describe, expect, it } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { newSession } from "./session";
import { forwardChildAnswer, type SessionPort } from "./childApproval";

function port(id: string, write: SessionPort["write"]): SessionPort {
  return { id, write };
}

describe("forwardChildAnswer", () => {
  it("sends allow only to the child port", async () => {
    const child: { requestId: string; decision: string }[] = [];
    const parent: { requestId: string; decision: string }[] = [];
    const ports = new Map<string, SessionPort>([
      ["child-1", port("child-1", (answer) => child.push(answer))],
      ["parent", port("parent", (answer) => parent.push(answer))],
    ]);

    expect(
      await forwardChildAnswer({ requestId: "req-9", sessionPort: "child-1" }, "allow", ports),
    ).toBe("sent");

    expect(child).toEqual([{ requestId: "req-9", decision: "allow" }]);
    expect(parent).toEqual([]);
  });

  it("sends deny only to the child port", async () => {
    const child: { requestId: string; decision: string }[] = [];
    const parent: { requestId: string; decision: string }[] = [];
    const ports = new Map<string, SessionPort>([
      ["child-1", port("child-1", (answer) => child.push(answer))],
      ["parent", port("parent", (answer) => parent.push(answer))],
    ]);

    expect(
      await forwardChildAnswer({ requestId: "req-9", sessionPort: "child-1" }, "deny", ports),
    ).toBe("sent");

    expect(child).toEqual([{ requestId: "req-9", decision: "deny" }]);
    expect(parent).toEqual([]);
  });

  it("delivers two answers in order and does not collapse them", async () => {
    const child: string[] = [];
    const ports = new Map<string, SessionPort>([
      ["child-1", port("child-1", (answer) => child.push(answer.decision))],
    ]);

    expect(await forwardChildAnswer({ requestId: "a", sessionPort: "child-1" }, "allow", ports)).toBe("sent");
    expect(await forwardChildAnswer({ requestId: "b", sessionPort: "child-1" }, "deny", ports)).toBe("sent");

    expect(child).toEqual(["allow", "deny"]);
  });

  it("does not write anyone when the child port is missing", async () => {
    const parent: unknown[] = [];
    const ports = new Map<string, SessionPort>([
      ["parent", port("parent", (answer) => parent.push(answer))],
    ]);

    expect(
      await forwardChildAnswer({ requestId: "req-9", sessionPort: "child-1" }, "deny", ports),
    ).toBe("unreachable");
    expect(parent).toEqual([]);
  });

  it("does not write a port whose id does not match its key", async () => {
    const wrote: unknown[] = [];
    const ports = new Map<string, SessionPort>([
      ["child-1", port("other", (answer) => wrote.push(answer))],
    ]);

    expect(
      await forwardChildAnswer({ requestId: "req-9", sessionPort: "child-1" }, "allow", ports),
    ).toBe("unreachable");
    expect(wrote).toEqual([]);
  });

  it("does not write anyone for an empty request or port", async () => {
    const wrote: unknown[] = [];
    const ports = new Map<string, SessionPort>([
      ["child-1", port("child-1", (answer) => wrote.push(answer))],
      ["parent", port("parent", (answer) => wrote.push(answer))],
    ]);

    expect(await forwardChildAnswer({ requestId: "  ", sessionPort: "child-1" }, "allow", ports)).toBe(
      "unreachable",
    );
    expect(await forwardChildAnswer({ requestId: "req-9", sessionPort: " \n " }, "deny", ports)).toBe(
      "unreachable",
    );
    expect(await forwardChildAnswer({ requestId: "", sessionPort: "" }, "deny", ports)).toBe("unreachable");
    expect(wrote).toEqual([]);
  });

  it("trims the request and the port before it writes", async () => {
    const wrote: unknown[] = [];
    const ports = new Map<string, SessionPort>([
      ["child 1", port("child 1", (answer) => wrote.push(answer))],
    ]);

    expect(
      await forwardChildAnswer({ requestId: "  req-9\r", sessionPort: " child 1 " }, "allow", ports),
    ).toBe("sent");
    expect(wrote).toEqual([{ requestId: "req-9", decision: "allow" }]);
  });

  it("is unreachable when the write throws, and does not write the parent", async () => {
    const parent: unknown[] = [];
    let attempts = 0;
    const ports = new Map<string, SessionPort>([
      [
        "child-1",
        port("child-1", () => {
          attempts += 1;
          throw new Error("child stdin closed");
        }),
      ],
      ["parent", port("parent", (answer) => parent.push(answer))],
    ]);

    expect(
      await forwardChildAnswer({ requestId: "req-9", sessionPort: "child-1" }, "deny", ports),
    ).toBe("unreachable");
    expect(attempts).toBe(1);
    expect(parent).toEqual([]);
  });

  it("rejects when the write was accepted and the transport then failed, and does not write the parent", async () => {
    const parent: unknown[] = [];
    const ports = new Map<string, SessionPort>([
      ["child-1", port("child-1", async () => Promise.reject(new Error("Broken pipe")))],
      ["parent", port("parent", (answer) => parent.push(answer))],
    ]);

    await expect(
      forwardChildAnswer({ requestId: "req-9", sessionPort: "child-1" }, "allow", ports),
    ).rejects.toThrow("Broken pipe");
    expect(parent).toEqual([]);
  });

  it("waits for an asynchronous write before it says sent", async () => {
    const order: string[] = [];
    const ports = new Map<string, SessionPort>([
      [
        "child-1",
        port("child-1", async () => {
          await Promise.resolve();
          order.push("written");
        }),
      ],
    ]);

    await forwardChildAnswer({ requestId: "req-9", sessionPort: "child-1" }, "allow", ports);
    order.push("sent");
    expect(order).toEqual(["written", "sent"]);
  });

  it("does not treat a removed port as a parent deny", async () => {
    const child: string[] = [];
    const parent: string[] = [];
    const ports = new Map<string, SessionPort>([
      ["child-1", port("child-1", (answer) => child.push(answer.decision))],
      ["parent", port("parent", (answer) => parent.push(answer.decision))],
    ]);

    expect(await forwardChildAnswer({ requestId: "req-9", sessionPort: "child-1" }, "allow", ports)).toBe(
      "sent",
    );
    ports.delete("child-1");
    expect(await forwardChildAnswer({ requestId: "req-9", sessionPort: "child-1" }, "deny", ports)).toBe(
      "unreachable",
    );

    expect(child).toEqual(["allow"]);
    expect(parent).toEqual([]);
  });

  it("does not send a decision that is not allow or deny", async () => {
    const wrote: unknown[] = [];
    const ports = new Map<string, SessionPort>([
      ["child-1", port("child-1", (answer) => wrote.push(answer))],
    ]);

    expect(
      await forwardChildAnswer(
        { requestId: "req-9", sessionPort: "child-1" },
        "cancelled" as "allow",
        ports,
      ),
    ).toBe("unreachable");
    expect(wrote).toEqual([]);
  });
});

describe("approval on the parent", () => {
  it("keeps the child context on the approval, including after it is answered", () => {
    let session = applyHarnessEvent(newSession("claude", "/work"), {
      type: "tool.started",
      callId: "toolu_1",
      title: "Read config",
      kind: "read",
      status: "pending",
    });
    session = applyHarnessEvent(session, {
      type: "approval.requested",
      requestId: 3,
      callId: "toolu_1",
      title: "Read config",
      kind: "read",
      child: {
        name: "Explore the auth module",
        sessionPort: "sub_1",
        detail: "Read config",
      },
    });
    session = applyHarnessEvent(session, {
      type: "approval.resolved",
      requestId: 3,
      decision: "allow",
    });

    expect(session.blocks.find((block) => block.tool?.callId === "toolu_1")?.approval).toEqual({
      at: expect.any(Number),
      requestId: 3,
      decided: "allow",
      child: {
        name: "Explore the auth module",
        sessionPort: "sub_1",
        detail: "Read config",
      },
    });
  });

  it("drops a child that has no name or no port", () => {
    let session = applyHarnessEvent(newSession("claude", "/work"), {
      type: "tool.started",
      callId: "toolu_1",
      title: "Read config",
      kind: "read",
      status: "pending",
    });
    session = applyHarnessEvent(session, {
      type: "approval.requested",
      requestId: 4,
      callId: "toolu_1",
      title: "Read config",
      kind: "read",
      child: { name: "  ", sessionPort: "sub_1" },
    });

    expect(session.blocks.find((block) => block.tool?.callId === "toolu_1")?.approval).toEqual({
      at: expect.any(Number),
      requestId: 4,
    });
  });

  it("keeps a unicode name and rejects a port that is only a line break", () => {
    let session = applyHarnessEvent(newSession("codex", "/work"), {
      type: "tool.started",
      callId: "call_1",
      title: "Run tests",
      kind: "execute",
      status: "pending",
    });
    session = applyHarnessEvent(session, {
      type: "approval.requested",
      requestId: 5,
      callId: "call_1",
      title: "Run tests",
      kind: "execute",
      child: { name: "  Vérifier l'auth  ", sessionPort: "\n", detail: "line one\r\nline two" },
    });

    expect(session.blocks.find((block) => block.tool?.callId === "call_1")?.approval).toEqual({
      at: expect.any(Number),
      requestId: 5,
    });

    session = applyHarnessEvent(session, {
      type: "approval.requested",
      requestId: 6,
      callId: "call_1",
      title: "Run tests",
      kind: "execute",
      child: {
        name: "  Vérifier l'auth  ",
        sessionPort: " thread/1 ",
        detail: "line one\r\nline two",
      },
    });

    expect(session.blocks.find((block) => block.tool?.callId === "call_1")?.approval).toEqual({
      at: expect.any(Number),
      requestId: 6,
      child: {
        name: "Vérifier l'auth",
        sessionPort: "thread/1",
        detail: "line one line two",
      },
    });
  });
});
