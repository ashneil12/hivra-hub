// WP-177 round 3, against the real session store and the real host store over the JSON wire. Only the Tauri boundary is
// an in-memory backend, and it applies the same guard rules the Rust session_upsert applies (session_store.rs,
// teleport_guard): an ordinary save may not drop a freeze or change whether the chat is away, and a move step may make
// only its own change. Each case asserts the RIGHT outcome for a reviewer's failure.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../features/sessions/model/session";

type Row = Record<string, unknown> & { id: string; blocks: Array<Record<string, unknown>> };

const backend = vi.hoisted(() => new Map<string, Row>());

// The Rust guard, as the boundary fake applies it.
const fakeGuard = vi.hoisted(() => {
  const idsWith = (blocks: Array<Record<string, unknown>>, notice: string) =>
    blocks.filter((b) => b.notice === notice).map((b) => String(b.id));
  const away = (blocks: Array<Record<string, unknown>>): string | null => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].notice === "teleported-back") return null;
      if (blocks[i].notice === "teleported") return String(blocks[i].id);
    }
    return null;
  };
  return (prev: Array<Record<string, unknown>> | undefined, next: Array<Record<string, unknown>>, teleport?: { op: string; moveId: string }) => {
    if (!prev) return;
    const storedFrozen = idsWith(prev, "teleport-frozen");
    const nextFrozen = idsWith(next, "teleport-frozen");
    if (!teleport) {
      if (storedFrozen.some((id) => !nextFrozen.includes(id))) throw new Error("teleport-refused: a save would drop a freeze");
      if (away(prev) !== away(next)) throw new Error("teleport-refused: a save would change whether the chat is away");
      return;
    }
    if (teleport.op === "freeze" && (storedFrozen.length > 0 || away(prev) !== null)) {
      throw new Error("teleport-conflict: another move or a resume already holds this chat");
    }
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "session_upsert") {
      const session = args.session as Row & { teleport?: { op: string; moveId: string } };
      const prev = backend.get(session.id);
      fakeGuard(prev?.blocks, session.blocks, session.teleport);
      const { teleport: _teleport, ...stored } = session;
      backend.set(String(session.id), JSON.parse(JSON.stringify(stored)));
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
import { approvePlan, completeMove, moveChat, planMove, recoverMove, type MoveEndpoint } from "../model/teleport";
import { launchRecovery, recoverSavedMoves, YOUNG_MOVE_MS } from "../model/teleportMove";
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

describe("WP-177 round 3 review", () => {
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
  const youngFree = () => Date.now() + YOUNG_MOVE_MS + 1;

  beforeEach(() => {
    backend.clear();
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    dir = mkdtempSync(path.join(tmpdir(), "wp177-r3-"));
    host = new HostTeleportStore({ dir, selfId: HOST, providers: ["claude"], leaseRoot: path.join(dir, "leases") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("A: a chat moved back, then moved away again, is not resurrected by App's stale pre-move copy at quit", async () => {
    await upsertSession(preMove());
    const mac = local();
    const remote = sshMoveEndpoint(HOST, wireAs("dev-1"));
    expect((await move(mac, remote, "m1")).status).toBe("moved");
    expect((await move(remote, mac, "m2")).status).toBe("moved");
    const back = (await getSession(CHAT))!;
    expect(teleportStateOf(back).moved).toBe(false);
    const appCopy = {
      ...back,
      providerSessionId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
      blocks: [...back.blocks, { id: "u2", role: "user", text: "more work" }, { id: "a2", role: "assistant", text: "done" }],
    } as Session;
    await upsertSession(appCopy);
    expect((await move(mac, remote, "m3")).status).toBe("moved");
    expect(teleportStateOf((await getSession(CHAT))!).moved).toBe(true);
    // Quit: App still holds appCopy. The stored row refuses it.
    await persistQuitState([appCopy], [], "", CWD, new Map(), "quit");
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    const reopened = (await getSession(CHAT))!;
    expect(teleportStateOf(reopened).moved).toBe(true);
    expect(reopened.blocks.some((b) => b.notice === "teleport-frozen")).toBe(false);
    expect(isChatLocked(CHAT)).toBe(true);
    expect((await host.read(CHAT, "dev-1"))?.live).not.toBeNull();
  });

  it("B: a second window's pre-move copy cannot write over the moved chat at quit", async () => {
    await upsertSession(preMove());
    expect((await move(local(), sshMoveEndpoint(HOST, wireAs("dev-1")), "m1")).status).toBe("moved");
    // Window B: separate JS context. Its movedSessionIds and lock Set are its own; it read the chat before the move.
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    await persistQuitState([preMove()], [], "", CWD, new Map(), "quit");
    const row = (await getSession(CHAT))!;
    expect(teleportStateOf(row).moved).toBe(true);
    expect(row.providerSessionId).toBeFalsy();
    expect((await host.read(CHAT, "dev-1"))?.live).not.toBeNull();
  });

  it("C: a lost activate reply leaves the chat frozen and locked, and recovery finishes the move once the host answers", async () => {
    await upsertSession(preMove());
    const remote = sshMoveEndpoint(
      HOST,
      wireAs("dev-1", (m) => (m === "teleport.activate" ? "after-throw" : m === "teleport.holds" ? "before-throw" : undefined)),
    );
    const result = await move(local(), remote, "m1");
    expect(result.status).toBe("unknown");
    // The App takes the stored row (the panel refreshes it on every result), so the freeze stays in the row it holds.
    await persistQuitState([(await getSession(CHAT))!], [], "", CWD, new Map(), "quit");
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    const frozen = await getSession(CHAT);
    expect(frozen!.blocks.some((b) => b.notice === "teleport-frozen")).toBe(true);
    expect(isChatLocked(CHAT)).toBe(true);
    // A young freeze is not touched by a launch pass.
    const healthy = sshMoveEndpoint(HOST, wireAs("dev-1"));
    const young = await launchRecovery([CWD], { port: sessionStoreChatPort(), local: local(), remoteFor: () => healthy });
    expect(young).toEqual([{ chatId: CHAT, moveId: "m1", status: "skipped" }]);
    // Once it is old enough, recovery asks the host, which holds the live copy, and the Mac releases.
    const lines = await recoverSavedMoves({
      chatIds: [CHAT],
      port: sessionStoreChatPort(),
      local: local(),
      remoteFor: () => healthy,
      now: youngFree(),
    });
    expect(lines).toEqual([{ chatId: CHAT, moveId: "m1", status: "moved" }]);
    expect(teleportStateOf((await getSession(CHAT))!).moved).toBe(true);
    expect(await host.holds(CHAT, "m1", "dev-1")).toBe("live");
  });

  it("D: the pane's render-time sync with App's (stale) session never unlocks a chat the move froze", async () => {
    await upsertSession(preMove());
    const mac = local();
    expect(await mac.freeze(CHAT, "m1", HOST)).toBe(true);
    expect(isChatLocked(CHAT)).toBe(true);
    syncTeleportLock(preMove());
    expect(isChatLocked(CHAT)).toBe(true);
    expect(() => assertChatAcceptsTurns(CHAT)).toThrow(/Nothing was sent/);
  });

  it("E: a re-paired device is refused by the host, so recovery leaves the chat frozen rather than thawing it", async () => {
    await upsertSession(preMove());
    const mac = local();
    // Crash after the host activated, before the Mac released: emulate by failing the release step.
    const remoteOld = sshMoveEndpoint(HOST, wireAs("dev-old"));
    const failingRelease: MoveEndpoint = { ...mac, release: async () => { throw new Error("crash"); } };
    expect((await move(failingRelease, remoteOld, "m1")).status).toBe("partial");
    // Ash re-pairs the host (new token, same machine id). Recovery runs with the new device: the host refuses it.
    const remoteNew = sshMoveEndpoint(HOST, wireAs("dev-new"));
    const res = await recoverMove({ chatId: CHAT, moveId: "m1", from: mac, to: remoteNew });
    expect(res.status).toBe("unknown");
    const row = (await getSession(CHAT))!;
    expect(row.blocks.some((b) => b.notice === "teleport-frozen")).toBe(true);
    expect(await host.holds(CHAT, "m1", "dev-old")).toBe("live");
    // The original device finishes the move.
    const done = await completeMove({ chatId: CHAT, moveId: "m1", from: mac, to: remoteOld });
    expect(done.status).toBe("moved");
  });

  it("G: a window opened mid-move leaves the live move's young freeze alone, and the move ends moved on both sides", async () => {
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
    expect(recovered).toEqual([{ chatId: CHAT, moveId: "m1", status: "skipped" }]);
    expect(result.status).toBe("moved");
    const row = (await getSession(CHAT))!;
    expect(teleportStateOf(row).moved).toBe(true);
    expect(row.blocks.some((b) => b.notice === "teleport-frozen")).toBe(false);
    expect(await host.holds(CHAT, "m1", "dev-1")).toBe("live");
  });

  it("F: the real ids: the desktop addresses the host by environment id, so a move is received", async () => {
    const realHost = new HostTeleportStore({ dir, selfId: "env-7f0c", providers: ["claude"], leaseRoot: path.join(dir, "leases2") });
    await upsertSession(preMove());
    const wire: HostCall = async (method, params) =>
      JSON.parse(JSON.stringify((await teleportRpc(realHost, method, JSON.parse(JSON.stringify(params)), "dev-1")) ?? null));
    const result = await move(local(), sshMoveEndpoint("machine-uuid-1", wire, "env-7f0c"), "m1");
    expect(result.status).toBe("moved");
    expect(await realHost.holds(CHAT, "m1", "dev-1")).toBe("live");
  });
});
