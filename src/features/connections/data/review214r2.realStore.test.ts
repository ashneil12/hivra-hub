// PR #214 hard review, round 2 (desktop side): red repros against the real session store and the real host store over
// the JSON wire. The Tauri boundary is the same in-memory backend and guard fake as teleportRound3.realStore.test.ts.
// Each case asserts the RIGHT outcome.
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

// The listings as session_store.rs serves them (list_chats_in): a project lists only rows in that folder that hold a user
// message (`has_user_message = 1`), and the folderless list only rows with no folder. Off by default, like the other files.
const listing = vi.hoisted(() => ({ real: false }));

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
      if (listing.real) {
        const rows = [...backend.values()];
        if (command === "session_list_linked") return [];
        if (command === "session_list_folderless") return rows.filter((row) => row.cwd === "").map((row) => ({ ...row }));
        return rows
          .filter((row) => row.cwd === args.cwd && row.blocks.some((block) => block.role === "user"))
          .map((row) => ({ ...row }));
      }
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
import { approvePlan, moveChat, planMove, type MoveEndpoint } from "../model/teleport";
import { launchRecovery, recoverSavedMoves, YOUNG_MOVE_MS } from "../model/teleportMove";
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

describe("PR 214 review r2: custody across a lost reply on a move back", () => {
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
    listing.real = false;
    backend.clear();
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    dir = mkdtempSync(path.join(tmpdir(), "wp177-r2r-"));
    host = new HostTeleportStore({ dir, selfId: HOST, providers: ["claude"], leaseRoot: path.join(dir, "leases") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a move back whose freeze reply is lost (and whose thaw cannot reach the host) can still be moved back later", async () => {
    await upsertSession(preMove());
    const mac = local();
    const healthy = sshMoveEndpoint(HOST, wireAs("dev-1"));
    expect((await move(mac, healthy, "m1")).status).toBe("moved");
    // Move back: the host freezes its copy, but the reply is lost, and the thaw the Mac sends next does not get through
    // (the same network drop). Nothing on the Mac records this move: it is the target, and it never got the copy.
    const flaky = sshMoveEndpoint(
      HOST,
      wireAs("dev-1", (m) => (m === "teleport.freeze" ? "after-throw" : m === "teleport.thaw" ? "before-throw" : undefined)),
    );
    const lost = await move(flaky, mac, "m2");
    expect(lost.status).toBe("failed");
    // The network is back. Launch recovery runs (well after the young window), then Ash asks to move the chat back again.
    await recoverSavedMoves({ chatIds: [CHAT], port: sessionStoreChatPort(), local: local(), remoteFor: () => healthy, now: youngFree() });
    // The chat must come back: it is not lost on the host. Today the host keeps frozenBy = m2 for good (no one knows the
    // move id to thaw it, and no recovery asks), so every later move back is refused as held elsewhere, and the held host
    // copy refuses turns too: the chat is stuck on both machines.
    const again = await move(healthy, mac, "m3");
    expect(again).not.toMatchObject({ status: "refused", refusal: { reason: "held-elsewhere" } });
    expect(again.status).toBe("moved");
    expect(teleportStateOf((await getSession(CHAT))!).moved).toBe(false);
  });

  it("the round-3 C case as first written: App's stale pre-move copy at quit does not erase a freeze left by an unknown result", async () => {
    // teleportRound3 C now quits with the stored row; the repro (a26da5018) quit with App's pre-move copy. Kept as written.
    await upsertSession(preMove());
    const remote = sshMoveEndpoint(
      HOST,
      wireAs("dev-1", (m) => (m === "teleport.activate" ? "after-throw" : m === "teleport.holds" ? "before-throw" : undefined)),
    );
    expect((await move(local(), remote, "m1")).status).toBe("unknown");
    await persistQuitState([preMove()], [], "", CWD, new Map(), "quit");
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    const reopened = (await getSession(CHAT))!;
    expect(reopened.blocks.some((b) => b.notice === "teleport-frozen")).toBe(true);
    expect(isChatLocked(CHAT)).toBe(true);
    const healthy = sshMoveEndpoint(HOST, wireAs("dev-1"));
    const lines = await recoverSavedMoves({ chatIds: [CHAT], port: sessionStoreChatPort(), local: local(), remoteFor: () => healthy, now: youngFree() });
    expect(lines).toEqual([{ chatId: CHAT, moveId: "m1", status: "moved" }]);
    expect(teleportStateOf((await getSession(CHAT))!).moved).toBe(true);
  });

  it("launch recovery finds a move back that died after this Mac stored the copy (the real project listing)", async () => {
    listing.real = true;
    await upsertSession(preMove());
    const mac = local();
    const healthy = sshMoveEndpoint(HOST, wireAs("dev-1"));
    expect((await move(mac, healthy, "m1")).status).toBe("moved");
    // Move back: the host froze its copy and this Mac stored it as incoming, then the app quit before it opened it.
    // (activate, and everything after it, never runs: the process is gone.)
    const dying: MoveEndpoint = {
      ...mac,
      activate: async () => {
        throw new Error("the app quit here");
      },
      holds: async () => {
        throw new Error("the app quit here");
      },
      abort: async () => {
        throw new Error("the app quit here");
      },
    };
    expect((await move(healthy, dying, "m2")).status).toBe("unknown");
    const stored = (await getSession(CHAT))!;
    expect(stored.blocks.some((b) => b.notice === "teleport-incoming")).toBe(true);
    // Restart: launch recovery over the chat's project folder. The row is the moved marker plus the incoming copy, with no
    // user message, so session_list_by_project (has_user_message = 1) never lists it. Recovery must still find it.
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    const lines = await launchRecovery([CWD], { port: sessionStoreChatPort(), local: local(), remoteFor: () => healthy, now: youngFree() });
    expect(lines.map((line) => line.moveId)).toContain("m2");
    // And the chat can be moved back afterwards.
    expect((await move(healthy, local(), "m3")).status).toBe("moved");
  });

  it("a moved chat's marker row stays in its project's list after a restart (the real project listing)", async () => {
    listing.real = true;
    await upsertSession(preMove());
    expect((await move(local(), sshMoveEndpoint(HOST, wireAs("dev-1")), "m1")).status).toBe("moved");
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    // The sidebar and launch recovery list a project's chats through the same command. A moved chat must still be listed,
    // or this Mac has no row to open, no marker to show and no "Move back" to press.
    const { listSessionsByProject } = await import("../../../features/sessions/data/sessionStore");
    expect((await listSessionsByProject(CWD)).map((summary) => summary.id)).toContain(CHAT);
  });
});
