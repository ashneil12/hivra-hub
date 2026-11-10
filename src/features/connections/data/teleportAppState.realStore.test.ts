// HIGH A, the quit path: the real saved store (sessionStore.ts unmocked; only the Tauri boundary is an in-memory backend)
// and the real persistQuitState. A pre-move copy that App still holds in memory must not write back over the moved row.
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
    return null;
  }),
}));

import { forgetMovedRowsForTests, getSession, upsertSession } from "../../../features/sessions/data/sessionStore";
import { persistQuitState } from "../../../app/model/appLifecycle";
import { sessionStoreChatPort } from "./teleportStorePort";
import { localMoveEndpoint } from "../model/teleportLocal";
import { teleportStateOf } from "../model/teleportState";
import { unlockChat } from "../model/teleportLock";

const CHAT = "quit-chat-1";

function preMove(): Session {
  return {
    id: CHAT,
    harness: "claude",
    model: "test-model-1",
    modelSettings: { effort: "high" },
    runtimeMode: "default",
    title: "Before the move",
    cwd: "/projects/quit",
    busy: false,
    blocks: [
      { id: "u1", role: "user", text: "keep this" },
      { id: "a1", role: "assistant", text: "kept" },
    ],
    providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    queuedMessages: [{ id: "q1", text: "queued before the move", attachments: [] }],
  } as unknown as Session;
}

async function moveAway(): Promise<void> {
  await upsertSession(preMove());
  const mac = localMoveEndpoint({ machineId: "this-mac", port: sessionStoreChatPort(), labelFor: () => "Studio box" });
  expect(await mac.freeze(CHAT, "m-quit", "host-a")).toBe(true);
  await mac.release(CHAT, "m-quit", "host-a");
}

describe("WP-177 HIGH A: a quit after a move keeps the moved row", () => {
  beforeEach(() => {
    backend.clear();
    forgetMovedRowsForTests();
    unlockChat(CHAT);
  });

  it("the store refuses a pre-move copy over a moved row", async () => {
    await moveAway();
    await upsertSession(preMove());
    const stored = await getSession(CHAT);
    expect(teleportStateOf(stored!)).toMatchObject({ moved: true, host: "Studio box" });
    expect(stored!.blocks.some((b) => b.role === "user")).toBe(false);
  });

  it("a quit through persistQuitState, with App still holding the pre-move copy, keeps the moved row", async () => {
    await moveAway();
    await persistQuitState([preMove()], [], "", "/projects/quit", new Map(), "quit");
    const stored = await getSession(CHAT);
    expect(teleportStateOf(stored!)).toMatchObject({ moved: true });
    expect(stored!.blocks.some((b) => b.role === "user")).toBe(false);
    expect(stored!.providerSessionId).toBeFalsy();
  });

  it("after a restart, a pre-move copy still cannot overwrite the moved row (the guard is not only in memory)", async () => {
    await moveAway();
    // A new process: the moved state is only in the saved row. Reading the row is what a restart does first.
    await getSession(CHAT);
    unlockChat(CHAT);
    await upsertSession(preMove());
    expect(teleportStateOf((await getSession(CHAT))!)).toMatchObject({ moved: true });
  });
});
