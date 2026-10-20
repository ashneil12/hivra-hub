import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "./sessionStore";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const { getSession, readSession, repairSession, applySessionRepair } =
  await import("./sessionStore");

/** A saved Codex session holding the one row this PR repairs. */
function codexRecord(): SessionRecord {
  return {
    id: "s1",
    harness: "codex",
    model: "gpt-5",
    cwd: "/repo",
    providerSessionId: "01a0e6f4-13e3-7692-9250-4befceed807b",
    blocks: [
      { id: "b0", role: "user", text: "list the agents" },
      {
        id: "b1",
        role: "tool",
        text: "Shell",
        tool: {
          callId: "exec-1",
          title: "Shell",
          kind: "execute",
          status: "completed",
          preview: {
            kind: "shell",
            title: "rg --files -g AGENTS.md -g '!node_modules'",
          },
        },
      },
    ],
  } as unknown as SessionRecord;
}

describe("restoring a session whose repair cannot be persisted", () => {
  beforeEach(() => invoke.mockReset());

  it("restores sidebar visibility when a hidden session is opened by id", async () => {
    const record = codexRecord();
    record.sidebarHidden = true;
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? record : null),
    );
    const session = await getSession(record.id);
    expect(session?.sidebarHidden).toBe(true);
    expect(session?.blocks[0].text).toBe("list the agents");
    const repaired = invoke.mock.calls.find(
      ([cmd]) => cmd === "session_upsert",
    );
    expect(repaired?.[1].session.sidebarHidden).toBe(true);
  });

  it("restores the turn's launched session links", async () => {
    const record = codexRecord();
    const launch = {
      sessionId: "app-review",
      cwd: "/repo",
      title: "Review",
      harness: "codex" as const,
      model: "gpt-6",
    };
    record.blocks[0].monoSpawnedSessions = [launch];
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? record : null),
    );
    expect((await getSession("s1"))?.blocks[0].monoSpawnedSessions).toEqual([
      launch,
    ]);
  });

  it("still returns the repaired session when the write fails", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "session_get") return Promise.resolve(codexRecord());
      if (cmd === "session_upsert")
        return Promise.reject(new Error("db locked"));
      return Promise.resolve(null);
    });

    // A failed persistence must not cost the reader the session: the repair
    // stays in memory and the next load retries the write.
    const session = await getSession("s1");
    expect(session).not.toBeNull();
    expect(session?.blocks[1].text).toBe("Find files");
  });

  it("persists the repair when the write succeeds", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "session_get") return Promise.resolve(codexRecord());
      return Promise.resolve(null);
    });

    const session = await getSession("s1");
    expect(session?.blocks[1].text).toBe("Find files");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "session_upsert")).toBe(
      true,
    );
  });
});

describe("progressive session restoration", () => {
  beforeEach(() => invoke.mockReset());

  it("returns saved text without reading provider logs or writing repairs", async () => {
    const record = { ...codexRecord(), harness: "claude" } as SessionRecord;
    invoke.mockResolvedValue(record);
    const session = await readSession("s1");
    expect(session?.blocks[1].text).toBe("Shell");
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["session_get"]);
  });

  it("does not mutate or persist a conversation while repairing it for a visible caller", async () => {
    invoke.mockResolvedValueOnce(codexRecord());
    const source = (await readSession("s1"))!;
    const repaired = await repairSession(source, { persist: false });
    expect(source.blocks[1].text).toBe("Shell");
    expect(repaired.blocks[1].text).toBe("Find files");
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["session_get"]);
    const renamed = { ...source, title: "Renamed while loading" };
    expect(applySessionRepair(renamed, source, repaired)).toMatchObject({
      title: "Renamed while loading",
      blocks: repaired.blocks,
    });
  });

  it("discards late repairs after streaming, editing, or a provider change", async () => {
    invoke.mockResolvedValueOnce(codexRecord());
    const source = (await readSession("s1"))!;
    const repaired = await repairSession(source, { persist: false });
    for (const current of [
      {
        ...source,
        blocks: [
          ...source.blocks,
          { id: "new", role: "assistant" as const, text: "Live output" },
        ],
      },
      { ...source, blocks: source.blocks.slice(0, 1) },
      { ...source, providerSessionId: "new-provider-session" },
      { ...source, harness: "claude" as const },
    ])
      expect(applySessionRepair(current, source, repaired)).toBe(current);
  });
});

describe("what a restart hands back: a chat's waiting briefs and its open /goal", () => {
  beforeEach(() => invoke.mockReset());

  const brief = (id: string) => ({
    id,
    text: `[MonoCode brief from Chief of Staff]\n\n${id}`,
    attachments: [],
    appRequestId: id,
    waitForIdle: true,
  });
  /** A worker cut mid-turn: its saved row, as session_get returns it. */
  function workerRecord(patch: Partial<SessionRecord> = {}): SessionRecord {
    return {
      id: "w1",
      harness: "claude",
      model: "claude:sonnet-5",
      cwd: "/repo",
      runtimeMode: "full-access",
      title: "Worker",
      modelSettings: {},
      providerSessionId: "conv-1",
      blocks: [{ id: "u1", role: "user", text: "[MonoCode brief from Chief of Staff]\n\nFix it." }],
      createdAt: 1,
      updatedAt: 2,
      ...patch,
    } as SessionRecord;
  }
  const load = async (record: SessionRecord) => {
    invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "session_get" ? record : null));
    return (await readSession(record.id))!;
  };

  it("briefs other chats queued keep going after a restart; Ash's own queued messages wait for him", async () => {
    const briefs = await load(workerRecord({ queuedMessages: [brief("app-cos-1"), brief("app-cos-2")], queueStatus: "active" }));
    expect(briefs.queuedMessages?.map((message) => message.id)).toEqual(["app-cos-1", "app-cos-2"]);
    expect(briefs.queueStatus).toBe("active");
    const mixed = await load(
      workerRecord({ queuedMessages: [brief("app-cos-1"), { id: "ash-1", text: "and then this", attachments: [] }], queueStatus: "active" }),
    );
    expect(mixed.queueStatus).toBe("paused");
  });

  it("a queue Ash paused or stopped, or an archived chat's, stays paused; a brief that already went in is dropped", async () => {
    expect((await load(workerRecord({ queuedMessages: [brief("app-cos-1")], queueStatus: "paused" }))).queueStatus).toBe("paused");
    expect((await load(workerRecord({ queuedMessages: [brief("app-cos-1")], queueStatus: "active", archived: true }))).queueStatus).toBe(
      "paused",
    );
    const sent = await load(
      workerRecord({
        queuedMessages: [brief("app-cos-1"), brief("app-cos-2")],
        queueStatus: "active",
        blocks: [{ id: "u1", role: "user", text: "first", appRequestId: "app-cos-1" }],
      }),
    );
    expect(sent.queuedMessages?.map((message) => message.id)).toEqual(["app-cos-2"]);
    const allSent = await load(
      workerRecord({ queuedMessages: [brief("app-cos-1")], blocks: [{ id: "u1", role: "user", text: "first", appRequestId: "app-cos-1" }] }),
    );
    expect(allSent.queuedMessages).toBeUndefined();
    expect(allSent.queueStatus).toBeUndefined();
  });

  it("an open /goal comes back with its chat; a met or cleared one never does", async () => {
    const goal = { objective: "the save test passes", checks: 3, status: "active", setAt: 5, lastCheck: "still red", providerSessionId: "conv-1" };
    expect((await load(workerRecord({ goal }))).goal).toEqual(goal);
    expect((await load(workerRecord({ goal: { ...goal, status: "paused" } }))).goal?.status).toBe("paused");
    for (const status of ["met", "cleared", "stopped"])
      expect((await load(workerRecord({ goal: { ...goal, status } }))).goal).toBeUndefined();
    expect((await load(workerRecord({ goal: { status: "active", checks: 1 } }))).goal).toBeUndefined();
  });

  it("saves a chat's goal only while it is open, so a finished one is cleared from the row", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "session_get" ? workerRecord() : cmd === "session_upsert" ? { id: "w1" } : null),
    );
    const session = (await readSession("w1"))!;
    const { upsertSession } = await import("./sessionStore");
    const goal = { objective: "the save test passes", checks: 1, status: "active" as const, setAt: 5, providerSessionId: "conv-1" };
    await upsertSession({ ...session, goal });
    await upsertSession({ ...session, goal: { ...goal, checks: 2, status: "met" } });
    const saved = invoke.mock.calls.filter(([cmd]) => cmd === "session_upsert").map(([, args]) => args.session.goal);
    expect(saved).toEqual([goal, undefined]);
  });
});
