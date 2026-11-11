// WP-177 LOW: a copy that comes from another machine is checked before this Mac stores or opens it. A malformed copy is
// refused whole, so nothing reaches the chat row.
import { describe, expect, it } from "vitest";
import { copyBlocks, localMoveEndpoint } from "./teleportLocal";
import type { Session } from "../../sessions/model/session";

describe("WP-177 host-supplied copies are validated (LOW)", () => {
  it("accepts a list of messages with string ids and roles", () => {
    expect(copyBlocks(JSON.stringify([{ id: "u1", role: "user", text: "hi" }]))).toHaveLength(1);
  });

  it("refuses a transcript that is not a list, a message without an id, and text that is not JSON", () => {
    expect(() => copyBlocks(JSON.stringify({ id: "u1", role: "user" }))).toThrow(/not a list/);
    expect(() => copyBlocks(JSON.stringify([{ role: "user", text: "no id" }]))).toThrow(/not in the saved form/);
    expect(() => copyBlocks("not json")).toThrow(/not readable/);
  });

  it("a receive with a malformed transcript throws and stores nothing", async () => {
    const rows = new Map<string, Session>();
    const moved = {
      id: "chat-validate",
      harness: "claude",
      model: "m",
      modelSettings: { effort: "high" },
      runtimeMode: "default",
      title: "T",
      cwd: "/tmp",
      busy: false,
      blocks: [{ id: "teleported@host-a@2026-11-10T09:00:00.000Z", role: "system", text: "Moved to Studio box", notice: "teleported", startedAt: Date.parse("2026-11-10T09:00:00.000Z") }],
      queuedMessages: [],
    } as unknown as Session;
    rows.set(moved.id, moved);
    const endpoint = localMoveEndpoint({
      machineId: "this-mac",
      port: { get: async (id) => rows.get(id) ?? null, put: async (s) => void rows.set(s.id, s) },
    });
    const payload = {
      manifest: { format: "hivra-teleport-v1", moveId: "m-bad", chatId: moved.id, from: "host-a", to: "this-mac" },
      chat: { chatId: moved.id, provider: "claude", providerSessionId: "", model: "m", effort: "high", title: "T", transcript: "{\"nope\":true}", queued: [] },
    } as never;
    await expect(endpoint.receive(moved.id, "m-bad", payload)).rejects.toThrow(/not a list/);
    expect(rows.get(moved.id)!.blocks.some((b) => b.notice === "teleport-incoming")).toBe(false);
  });
});
