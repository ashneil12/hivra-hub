// Reviewer scratch test (round 3). Real sessionStore (only the Tauri boundary is an in-memory backend), real
// persistQuitState, real host store over the JSON wire. Each case asserts the BROKEN outcome, so a pass = bug reproduced.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../features/sessions/model/session";

const backend = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "session_upsert") {
      const session = args.session as Record<string, unknown>;
      backend.set(String(session.id), JSON.parse(JSON.stringify(session)));
      return { id: session.id };
    }
    if (command === "session_get") {
      const row = backend.get(String(args.sessionId));
      return row ? JSON.parse(JSON.stringify(row)) : null;
    }
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
import { sshMoveEndpoint, type HostCall } from "../model/teleportSsh";
import { HostTeleportStore } from "../../../../host/teleport/store";
import { teleportRpc } from "../../../../host/teleport/rpc";
import { approvePlan, moveChat, planMove, recoverMove, type MoveEndpoint } from "../model/teleport";
import { launchRecovery } from "../model/teleportMove";
import { teleportStateOf } from "../model/teleportState";
import { assertChatAcceptsTurns, isChatLocked, syncTeleportLock, unlockChat } from "../model/teleportLock";

class TestMouseEvent {
  readonly type: string;
  isTrusted = false;
  constructor(type: string) {
    this.type = type;
  }
}
(globalThis as unknown as { MouseEvent: unknown }).MouseEvent = TestMouseEvent;
const click = () => Object.assign(new TestMouseEvent("click"), { isTrusted: true }) as never;

const CHAT = "r3-chat";
const HOST = "host-a";
const CWD = "/projects/r3";

function preMove(extra: Partial<Session> = {}): Session {
  return {
    id: CHAT,
    harness: "claude",
    model: "test-model-1",
    modelSettings: { effort: "high" },
    runtimeMode: "default",
    title: "R3 chat",
    cwd: CWD,
    busy: false,
    blocks: [
      { id: "u1", role: "user", text: "keep this" },
      { id: "a1", role: "assistant", text: "kept" },
    ],
    providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    queuedMessages: [],
    ...extra,
  } as unknown as Session;
}

async function move(from: MoveEndpoint, to: MoveEndpoint, moveId: string) {
  const record = await from.read(CHAT);
  const planned = await planMove(record!.live!, from.id, to.id);
  if (!planned.ok) throw new Error(`plan refused: ${planned.refusal.reason}`);
  return moveChat({ chatId: CHAT, from, to, approval: approvePlan(planned.plan, click()), moveId, at: "2026-11-10T09:00:00.000Z" });
}

describe("R3 review", () => {
  let dir: string;
  let host: HostTeleportStore;
  const wireAs =
    (device: string, hook?: (method: string) => "before-throw" | "after-throw" | undefined): HostCall =>
    async (method, params) => {
      const mode = hook?.(method);
      if (mode === "before-throw") throw new Error("The host request did not complete. Retry to confirm its result.");
      const out = JSON.parse(JSON.stringify((await teleportRpc(host, method, JSON.parse(JSON.stringify(params)), device)) ?? null));
      if (mode === "after-throw") throw new Error("The host request did not complete. Retry to confirm its result.");
      return out;
    };
  const local = () => localMoveEndpoint({ machineId: "this-mac", port: sessionStoreChatPort(), labelFor: () => "Studio box" });

  beforeEach(() => {
    backend.clear();
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    dir = mkdtempSync(path.join(tmpdir(), "wp177-r3-"));
    host = new HostTeleportStore({ dir, selfId: HOST, providers: ["claude"], leaseRoot: path.join(dir, "leases") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("A: a chat moved back once, then moved again, is resurrected by App's stale pre-move copy at quit", async () => {
    await upsertSession(preMove());
    const mac = local();
    const remote = sshMoveEndpoint(HOST, wireAs("dev-1"));
    expect((await move(mac, remote, "m1")).status).toBe("moved");
    expect((await move(remote, mac, "m2")).status).toBe("moved");
    // Back on the Mac: App holds the returned row and the chat runs another turn here.
    const back = (await getSession(CHAT))!;
    expect(teleportStateOf(back).moved).toBe(false);
    const appCopy = {
      ...back,
      providerSessionId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
      blocks: [...back.blocks, { id: "u2", role: "user", text: "more work" }, { id: "a2", role: "assistant", text: "done" }],
    } as Session;
    await upsertSession(appCopy);
    // Move away again.
    expect((await move(mac, remote, "m3")).status).toBe("moved");
    expect(teleportStateOf((await getSession(CHAT))!).moved).toBe(true);
    // Quit: App still holds appCopy (it carries the old teleported-back-m2 notice).
    await persistQuitState([appCopy], [], "", CWD, new Map(), "quit");
    // Reopen.
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    const reopened = (await getSession(CHAT))!;
    expect(teleportStateOf(reopened).moved).toBe(false); // BUG: live on the Mac again
    expect(reopened.providerSessionId).toBe("bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(isChatLocked(CHAT)).toBe(false);
    expect((await host.read(CHAT, "dev-1"))?.live).not.toBeNull(); // and live on the host
  });

  it("B: second window (its own module state never saw the moved row) writes its pre-move copy at quit", async () => {
    await upsertSession(preMove());
    expect((await move(local(), sshMoveEndpoint(HOST, wireAs("dev-1")), "m1")).status).toBe("moved");
    // Window B: separate JS context. Its movedSessionIds and lock Set are its own; it read the chat before the move.
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    await persistQuitState([preMove()], [], "", CWD, new Map(), "quit");
    const row = (await getSession(CHAT))!;
    expect(teleportStateOf(row).moved).toBe(false); // BUG
    expect(row.providerSessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect((await host.read(CHAT, "dev-1"))?.live).not.toBeNull();
  });

  it("C: lost activate reply (unknown) keeps the freeze in the store, but App's stale copy erases it at quit", async () => {
    await upsertSession(preMove());
    const remote = sshMoveEndpoint(
      HOST,
      wireAs("dev-1", (m) => (m === "teleport.activate" ? "after-throw" : m === "teleport.holds" ? "before-throw" : undefined)),
    );
    const result = await move(local(), remote, "m1");
    expect(result.status).toBe("unknown");
    expect((await getSession(CHAT))!.blocks.some((b) => b.notice === "teleport-frozen")).toBe(true);
    // The panel calls onRow only for "moved", so App still holds the pre-move copy. Quit (or window close) writes it.
    await persistQuitState([preMove()], [], "", CWD, new Map(), "quit");
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    const reopened = (await getSession(CHAT))!;
    expect(reopened.blocks.some((b) => b.notice === "teleport-frozen")).toBe(false); // freeze gone
    expect(teleportStateOf(reopened).moved).toBe(false);
    expect(isChatLocked(CHAT)).toBe(false);
    const healthy = sshMoveEndpoint(HOST, wireAs("dev-1"));
    expect(await launchRecovery([CWD], { port: sessionStoreChatPort(), local: local(), remoteFor: () => healthy })).toEqual([]);
    expect((await host.holds(CHAT, "m1", "dev-1"))).toBe("live"); // host live
  });

  it("D: the pane's render-time sync with App's (stale) session unlocks a chat the move froze", async () => {
    await upsertSession(preMove());
    const mac = local();
    expect(await mac.freeze(CHAT, "m1", HOST)).toBe(true);
    expect(isChatLocked(CHAT)).toBe(true);
    syncTeleportLock(preMove()); // what LocalSessionPane does on every render with App's session prop
    expect(isChatLocked(CHAT)).toBe(false); // BUG
    expect(() => assertChatAcceptsTurns(CHAT)).not.toThrow();
  });

  it("E: the host's live copy is invisible to a re-paired device, so recovery thaws the Mac while the host holds it", async () => {
    await upsertSession(preMove());
    // Crash after the host activated, before the Mac released: emulate by failing the release step.
    const remoteOld = sshMoveEndpoint(HOST, wireAs("dev-old"));
    const mac = local();
    const failingRelease: MoveEndpoint = { ...mac, release: async () => { throw new Error("crash"); } };
    expect((await move(failingRelease, remoteOld, "m1")).status).toBe("partial");
    // Ash re-pairs the host (new token, same machine id). Launch recovery runs with the new device.
    const remoteNew = sshMoveEndpoint(HOST, wireAs("dev-new"));
    const res = await recoverMove({ chatId: CHAT, moveId: "m1", from: mac, to: remoteNew });
    expect(res.status).toBe("recovered"); // thawed on the Mac
    const row = (await getSession(CHAT))!;
    expect(row.blocks.some((b) => b.notice === "teleport-frozen")).toBe(false);
    expect(teleportStateOf(row).moved).toBe(false);
    expect(await host.holds(CHAT, "m1", "dev-old")).toBe("live"); // still live on the host
  });

  it("G: a window opened mid-move runs launch recovery, thaws the live move's freeze, and the move ends partial on both", async () => {
    await upsertSession(preMove());
    const plain = sshMoveEndpoint(HOST, wireAs("dev-1"));
    let recovered: unknown = null;
    const remote: MoveEndpoint = {
      ...plain,
      receive: async (chatId, moveId, payload) => {
        // Window B opens now (Cmd-N or a reload): its App runs launchRecovery over the saved store.
        recovered = await launchRecovery([CWD], { port: sessionStoreChatPort(), local: local(), remoteFor: () => plain });
        return plain.receive(chatId, moveId, payload);
      },
    };
    const result = await move(local(), remote, "m1");
    expect(recovered).toEqual([{ chatId: CHAT, moveId: "m1", status: "recovered" }]);
    expect(result.status).toBe("partial");
    const row = (await getSession(CHAT))!;
    expect(teleportStateOf(row).moved).toBe(false);
    expect(row.blocks.some((b) => b.notice === "teleport-frozen")).toBe(false);
    expect(row.providerSessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"); // live on the Mac
    expect(await host.holds(CHAT, "m1", "dev-1")).toBe("live"); // and on the host
  });

  it("F: the real ids: the desktop's machine id is not the host's environment id, so every receive is refused", async () => {
    const realHost = new HostTeleportStore({ dir, selfId: "env-7f0c", providers: ["claude"], leaseRoot: path.join(dir, "leases2") });
    await upsertSession(preMove());
    const wire: HostCall = async (method, params) =>
      JSON.parse(JSON.stringify((await teleportRpc(realHost, method, JSON.parse(JSON.stringify(params)), "dev-1")) ?? null));
    const result = await move(local(), sshMoveEndpoint("machine-uuid-1", wire), "m1");
    expect(result).toMatchObject({ status: "failed", stage: "receive", message: "This move is addressed to another machine" });
  });
});
