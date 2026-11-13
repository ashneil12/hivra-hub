import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const summary = { id: "chat", cwd: "/tmp/project", title: "", updatedAt: 1, createdAt: 1 };

function chat() {
  return {
    id: "chat",
    cwd: "/tmp/project",
    harness: "claude" as const,
    model: "",
    modelSettings: {},
    runtimeMode: "supervised" as const,
    title: "",
    blocks: [{ id: "user", role: "user" as const, text: "hello" }],
    queuedMessages: [] as { id: string; text: string; attachments: never[] }[],
  };
}

async function loadStore() {
  vi.resetModules();
  return import("./sessionStore");
}

const upserts = () =>
  mocks.invoke.mock.calls.filter(([command]) => command === "session_upsert").map(([, args]) => args);

afterEach(() => mocks.invoke.mockReset());

// T3 Code #29521: a queue edit on a long chat used to send the whole transcript again and have the store rewrite it.
it("sends the transcript once and only the header while the blocks are unchanged", async () => {
  const { upsertSession } = await loadStore();
  mocks.invoke.mockResolvedValue(summary);
  const session = chat();
  await upsertSession(session as never);
  const queued = { ...session, blocks: [...session.blocks], queuedMessages: [{ id: "q", text: "next", attachments: [] }] };
  await upsertSession(queued as never);
  const reply = { ...queued, blocks: [...queued.blocks, { id: "a", role: "assistant" as const, text: "hi" }] };
  await upsertSession(reply as never);

  const [first, second, third] = upserts();
  expect(first.session.blocks).toHaveLength(1);
  expect(first.blocksUnchanged).toBeUndefined();
  expect(second.session.blocks).toEqual([]);
  expect(second.blocksUnchanged).toBe(true);
  expect(second.session.queuedMessages).toHaveLength(1);
  expect(third.session.blocks).toHaveLength(2);
  expect(third.blocksUnchanged).toBeUndefined();
});

it("sends the blocks after all when the store has no row to keep them from", async () => {
  const { upsertSession } = await loadStore();
  mocks.invoke.mockResolvedValueOnce(summary);
  const session = chat();
  await upsertSession(session as never);
  mocks.invoke.mockRejectedValueOnce(new Error("blocks-missing: the chat isn't stored yet, send its blocks"));
  mocks.invoke.mockResolvedValueOnce(summary);
  await upsertSession({ ...session, title: "Renamed" } as never);

  const [, kept, resent] = upserts();
  expect(kept.blocksUnchanged).toBe(true);
  expect(resent.session.blocks).toHaveLength(1);
  expect(resent.blocksUnchanged).toBeUndefined();
});

it("sends the blocks again after a failed save", async () => {
  const { upsertSession } = await loadStore();
  mocks.invoke.mockResolvedValueOnce(summary);
  const session = chat();
  await upsertSession(session as never);
  mocks.invoke.mockRejectedValueOnce(new Error("Session store is locked"));
  await expect(upsertSession({ ...session, title: "A" } as never)).rejects.toThrow("locked");
  mocks.invoke.mockResolvedValueOnce(summary);
  await upsertSession({ ...session, title: "B" } as never);
  expect(upserts()[2].session.blocks).toHaveLength(1);
});
