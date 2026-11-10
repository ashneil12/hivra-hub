// HIGH A: the real session store (sessionStore.ts runs unmocked). Only the Tauri boundary is replaced, by an in-memory
// backend that keeps what session_upsert is given and returns it from session_get, the way the Rust store does.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../features/sessions/model/session";

const backend = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "session_upsert") {
      const session = args.session as Record<string, unknown>;
      backend.set(String(session.id), { ...session });
      return { id: session.id };
    }
    if (command === "session_get") return backend.get(String(args.sessionId)) ?? null;
    if (command === "session_delete") {
      backend.delete(String(args.sessionId));
      return null;
    }
    return null;
  }),
}));

import { getSession, upsertSession } from "../../../features/sessions/data/sessionStore";
import { sessionStoreChatPort } from "./teleportStorePort";
import { localMoveEndpoint } from "../model/teleportLocal";
import { isChatLocked, unlockChat } from "../model/teleportLock";
import { teleportStateOf } from "../model/teleportState";

const CHAT = "real-chat-1";
const HOST = "host-a";

function savedChat(): Session {
  return {
    id: CHAT,
    harness: "codex",
    model: "test-model-1",
    modelSettings: { effort: "high" },
    runtimeMode: "default",
    title: "Real store chat",
    cwd: "/projects/real",
    blocks: [
      { id: "u1", role: "user", text: "please refactor" },
      { id: "a1", role: "assistant", text: "done" },
    ],
    providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    queuedMessages: [{ id: "q1", text: "then this", attachments: [] }],
  } as unknown as Session;
}

describe("WP-177 HIGH A: a move through the real session store", () => {
  beforeEach(() => {
    backend.clear();
    unlockChat(CHAT);
  });

  it("a released row is saved: the marker survives a reload, and the transcript and session id do not", async () => {
    await upsertSession(savedChat());
    const mac = localMoveEndpoint({ machineId: "this-mac", port: sessionStoreChatPort(), labelFor: () => "Studio box" });
    expect(await mac.freeze(CHAT, "m1")).toBe(true);
    await mac.release(CHAT, "m1", HOST);

    const reloaded = await getSession(CHAT);
    expect(reloaded).not.toBeNull();
    expect(teleportStateOf(reloaded!)).toMatchObject({ moved: true, host: "Studio box" });
    expect(reloaded!.blocks.some((b) => b.role === "user")).toBe(false);
    expect(reloaded!.providerSessionId).toBeFalsy();
    expect(reloaded!.queuedMessages ?? []).toHaveLength(0);
  });

  it("after a reload the moved chat is locked, so a send is refused", async () => {
    await upsertSession(savedChat());
    const mac = localMoveEndpoint({ machineId: "this-mac", port: sessionStoreChatPort(), labelFor: () => "Studio box" });
    await mac.freeze(CHAT, "m1");
    await mac.release(CHAT, "m1", HOST);
    unlockChat(CHAT);
    await getSession(CHAT);
    expect(isChatLocked(CHAT)).toBe(true);
  });

  it("a chat frozen by a move that never finished is locked on reload, too", async () => {
    await upsertSession(savedChat());
    const mac = localMoveEndpoint({ machineId: "this-mac", port: sessionStoreChatPort() });
    await mac.freeze(CHAT, "m-unfinished");
    unlockChat(CHAT);
    await getSession(CHAT);
    expect(isChatLocked(CHAT)).toBe(true);
  });
});

describe("WP-177 HIGH A: busy comes from the app's live state, not from the saved row", () => {
  beforeEach(() => {
    backend.clear();
    unlockChat(CHAT);
  });

  it("a chat with a turn in flight in the app reads as running, so the move refuses it", async () => {
    await upsertSession(savedChat());
    const port = sessionStoreChatPort({ isBusy: (id) => id === CHAT });
    const mac = localMoveEndpoint({ machineId: "this-mac", port });
    const record = await mac.read(CHAT);
    expect(record?.live?.turnRunning).toBe(true);
    const { planMove } = await import("../model/teleport");
    const planned = await planMove(record!.live!, "this-mac", HOST);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.reason).toBe("turn-running");
  });

  it("with nothing in flight, the same chat is not running", async () => {
    await upsertSession(savedChat());
    const mac = localMoveEndpoint({ machineId: "this-mac", port: sessionStoreChatPort({ isBusy: () => false }) });
    expect((await mac.read(CHAT))?.live?.turnRunning).toBe(false);
  });
});
