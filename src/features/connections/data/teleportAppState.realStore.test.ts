// HIGH A, the quit path: the real saved store (sessionStore.ts unmocked; only the Tauri boundary is an in-memory backend)
// and the real persistQuitState. A pre-move copy that App still holds in memory must not write back over the moved row.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../features/sessions/model/session";

const backend = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "session_upsert") {
      const session = args.session as Record<string, unknown>;
      const prev = backend.get(String(session.id));
      if (prev && !session.teleport && Array.isArray(session.blocks) && Array.isArray(prev.blocks)) {
        const notice = (block: unknown) => (block && typeof block === "object" ? String((block as { notice?: unknown }).notice ?? "") : "");
        let away = false;
        for (let i = (prev.blocks as unknown[]).length - 1; i >= 0; i--) {
          const name = notice((prev.blocks as unknown[])[i]);
          if (name === "teleported-back") { away = false; break; }
          if (name === "teleported") { away = true; break; }
        }
        if (away) {
          session.blocks = [...(prev.blocks as unknown[])];
          session.providerSessionId = prev.providerSessionId;
          session.queuedMessages = prev.queuedMessages;
        } else {
          const owned = new Set(["teleport-frozen", "teleport-freeze-asked", "teleport-incoming", "teleport-release-owed", "teleport-aborted", "teleported", "teleported-back"]);
          const body = (session.blocks as unknown[]).filter((block) => !owned.has(notice(block)));
          const notes = (prev.blocks as unknown[]).filter((block) => owned.has(notice(block)));
          session.blocks = [...body, ...notes];
        }
      }
      backend.set(String(session.id), { ...session });
      return { id: session.id };
    }
    if (command === "session_get") return backend.get(String(args.sessionId)) ?? null;
    if (command === "session_list_by_project" || command === "session_list_folderless" || command === "session_list_linked") {
      return [...backend.values()].map((row) => ({ ...row }));
    }
    return null;
  }),
}));

import { forgetMovedRowsForTests, getSession, upsertSession } from "../../../features/sessions/data/sessionStore";
import { persistQuitState } from "../../../app/model/appLifecycle";
import { sessionStoreChatPort } from "./teleportStorePort";
import { localMoveEndpoint } from "../model/teleportLocal";
import { teleportStateOf } from "../model/teleportState";
import { isChatLocked, unlockChat } from "../model/teleportLock";

class TestMouseEvent {
  readonly type: string;
  isTrusted = false;
  constructor(type: string) {
    this.type = type;
  }
}
(globalThis as unknown as { MouseEvent: unknown }).MouseEvent = TestMouseEvent;

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

// The quit-and-reopen proof through the real stores: a move to a host store (a loopback stand-in: the same store the
// host runs, reached through the JSON wire), a quit with App still holding the pre-move copy, then a reopen where the
// in-memory state is gone and only the saved rows remain.
describe("WP-177 quit after a move, then reopen: the row stays moved and the chat is not live on the Mac", () => {
  it("the moved row and the host copy survive; the Mac does not run the chat", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { HostTeleportStore } = await import("../../../../host/teleport/store");
    const { teleportRpc } = await import("../../../../host/teleport/rpc");
    const { sshMoveEndpoint } = await import("../model/teleportSsh");
    const { approvePlan, moveChat, planMove } = await import("../model/teleport");
    const { launchRecovery } = await import("../model/teleportMove");
    const { forgetMovedRowsForTests: forget } = await import("../../../features/sessions/data/sessionStore");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp177-quit-"));
    try {
      const host = new HostTeleportStore({ dir, selfId: "host-a", providers: ["claude"], leaseRoot: path.join(dir, "leases") });
      const wire = async (method: string, params: Record<string, unknown>) =>
        JSON.parse(JSON.stringify((await teleportRpc(host, method, JSON.parse(JSON.stringify(params)), "dev-desktop")) ?? null));

      await upsertSession({ ...preMove(), id: "quit-reopen" } as Session);
      const local = localMoveEndpoint({ machineId: "this-mac", port: sessionStoreChatPort(), labelFor: () => "Studio box" });
      const planned = await planMove((await local.read("quit-reopen"))!.live!, "this-mac", "host-a");
      if (!planned.ok) throw new Error("plan");
      const moved = await moveChat({
        chatId: "quit-reopen",
        from: local,
        to: sshMoveEndpoint("host-a", wire),
        approval: approvePlan(planned.plan, Object.assign(new TestMouseEvent("click"), { isTrusted: true }) as never),
        moveId: "quit-1",
        at: "2026-11-10T09:00:00.000Z",
      });
      expect(moved.status).toBe("moved");

      // Quit: App's list still holds the pre-move copy and persists it.
      await persistQuitState([{ ...preMove(), id: "quit-reopen" } as Session], [], "", "/projects/quit", new Map(), "quit");

      // Reopen: a new process. The in-memory state is gone; the saved rows are what is left.
      forget();
      unlockChat("quit-reopen");
      const reopened = await getSession("quit-reopen");
      expect(teleportStateOf(reopened!)).toMatchObject({ moved: true, host: "Studio box" });
      expect(reopened!.blocks.some((b) => b.role === "user")).toBe(false);
      expect(isChatLocked("quit-reopen")).toBe(true);
      // Launch recovery finds nothing to finish, and does not bring the chat back.
      expect(await launchRecovery(["/projects/quit"], { port: sessionStoreChatPort(), local, remoteFor: () => sshMoveEndpoint("host-a", wire), onRow: () => undefined })).toEqual([]);
      expect(teleportStateOf((await getSession("quit-reopen"))!).moved).toBe(true);
      // The host runs the chat; the Mac does not.
      expect((await host.read("quit-reopen", "dev-desktop"))?.live?.title).toBe("Before the move");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WP-177 M3: an old 'Moved back' notice does not let a stale copy return a chat that moved away again", () => {
  it("a copy whose back notice is older than the move away is refused", async () => {
    const id = "m3-chat";
    await upsertSession({ ...preMove(), id } as Session);
    const mac = localMoveEndpoint({ machineId: "this-mac", port: sessionStoreChatPort(), labelFor: () => "Studio box" });
    expect(await mac.freeze(id, "m3-away", "host-a")).toBe(true);
    await mac.release(id, "m3-away", "host-a");
    const stale = {
      ...preMove(),
      id,
      blocks: [
        ...preMove().blocks,
        { id: "teleported-back-old", role: "system", text: "Moved back to this Mac", notice: "teleported-back", startedAt: 1000 },
      ],
    } as unknown as Session;
    await upsertSession(stale);
    expect(teleportStateOf((await getSession(id))!)).toMatchObject({ moved: true, host: "Studio box" });
  });
});
