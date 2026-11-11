// PR #214 hard review, round 3 (desktop side): red repros against the real session store and the real host store over
// the JSON wire. The Tauri boundary is the same in-memory backend and guard fake as review214r2.realStore.test.ts.
// Each case asserts the RIGHT outcome.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../features/sessions/model/session";

type Row = Record<string, unknown> & { id: string; blocks: Array<Record<string, unknown>> };

const backend = vi.hoisted(() => new Map<string, Row>());

// The Rust guard, as the boundary fake applies it (session_store.rs teleport_guard): an ordinary save may not drop a
// freeze or change whether the chat is away. Nothing else in the row is protected from an ordinary save.
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
import { approvePlan, moveChat, planMove, type MoveEndpoint } from "../model/teleport";
import { recoverSavedMoves, YOUNG_MOVE_MS } from "../model/teleportMove";
import { teleportStateOf } from "../model/teleportState";
import { unlockChat } from "../model/teleportLock";

class TestMouseEvent {
  readonly type: string;
  isTrusted = false;
  constructor(type: string) {
    this.type = type;
  }
}
(globalThis as unknown as { MouseEvent: unknown }).MouseEvent = TestMouseEvent;
const click = () => Object.assign(new TestMouseEvent("click"), { isTrusted: true }) as never;

const CHAT = "r3-review-chat";
const HOST = "host-a";
const CWD = "/projects/r3-review";

function preMove(extra: Partial<Session> = {}): Session {
  return {
    id: CHAT,
    harness: "claude",
    model: "test-model-1",
    modelSettings: { effort: "high" },
    runtimeMode: "default",
    title: "R3 review chat",
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
  return moveChat({ chatId: CHAT, from, to, approval: approvePlan(planned.plan, click()), moveId, at: "2026-11-11T09:00:00.000Z" });
}

describe("PR 214 review r3: a move back that loses the host after the freeze reply", () => {
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
    dir = mkdtempSync(path.join(tmpdir(), "wp177-r3r-"));
    host = new HostTeleportStore({ dir, selfId: HOST, providers: ["claude"], leaseRoot: path.join(dir, "leases") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a network drop right after the freeze reply (the re-read and the thaw are lost) does not leave the host frozen for good", async () => {
    await upsertSession(preMove());
    const mac = local();
    const healthy = sshMoveEndpoint(HOST, wireAs("dev-1"));
    expect((await move(mac, healthy, "m1")).status).toBe("moved");
    // Move back. The freeze reply arrives (so moveChat clears the freeze-ask note), then the link drops: the re-read under
    // the freeze fails, and so does the thaw undoFreeze sends (its error is swallowed). The Mac has not stored a copy yet,
    // so nothing on this Mac names move m2 any more. A Mac crash at the same point leaves the same rows.
    let frozenOnHost = false;
    const dropsAfterFreeze = sshMoveEndpoint(
      HOST,
      wireAs("dev-1", (m) => {
        if (m === "teleport.freeze") {
          frozenOnHost = true;
          return undefined;
        }
        return frozenOnHost && (m === "teleport.read" || m === "teleport.thaw") ? "before-throw" : undefined;
      }),
    );
    expect((await move(dropsAfterFreeze, mac, "m2")).status).toBe("failed");
    // The network is back. Recovery runs (well after the young window), then Ash moves the chat back again.
    await recoverSavedMoves({ chatIds: [CHAT], port: sessionStoreChatPort(), local: local(), remoteFor: () => healthy, now: youngFree() });
    // Today the host keeps frozenBy = m2 for good: the freeze-ask note was cleared on the freeze reply, no incoming copy was
    // stored, so recovery has no move id to thaw. Every later move back is refused as held elsewhere, and the held host copy
    // refuses turns too.
    const again = await move(healthy, local(), "m3");
    expect(again).not.toMatchObject({ status: "refused", refusal: { reason: "held-elsewhere" } });
    expect(again.status).toBe("moved");
    expect(teleportStateOf((await getSession(CHAT))!).moved).toBe(false);
  });

  it("a quit while a move back's freeze call is in flight keeps the note recovery needs to thaw the host", async () => {
    await upsertSession(preMove());
    const mac = local();
    const healthy = sshMoveEndpoint(HOST, wireAs("dev-1"));
    expect((await move(mac, healthy, "m1")).status).toBe("moved");
    // App's copy of the chat: the marker row, as the release's teleport-row-changed event (or the panel's refreshRow) left it.
    // noteFreezeAsk is a plain save with no event, so App never hears of the note.
    const appCopy = (await getSession(CHAT))!;
    let dead = false;
    const healthyWire = wireAs("dev-1");
    const quitting: HostCall = async (method, params) => {
      if (dead) throw new Error("the app quit here");
      const out = await healthyWire(method, params);
      if (method === "teleport.freeze") {
        // The host froze. While its reply is on the way, Ash quits: the quit saves App's copy of every chat, then the
        // process is gone (nothing after this reaches the host).
        await persistQuitState([appCopy], [], "", CWD, new Map(), "quit");
        dead = true;
        throw new Error("the app quit here");
      }
      return out;
    };
    expect((await move(sshMoveEndpoint(HOST, quitting), mac, "m2")).status).toBe("failed");
    // Restart.
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    await recoverSavedMoves({ chatIds: [CHAT], port: sessionStoreChatPort(), local: local(), remoteFor: () => healthy, now: youngFree() });
    // Today the quit's ordinary save of App's marker copy is accepted (it drops no freeze and does not change where the
    // chat is), so it erases teleport-freeze-asked-m2. Recovery then has nothing to thaw, and the host stays frozen for m2.
    const again = await move(healthy, local(), "m3");
    expect(again).not.toMatchObject({ status: "refused", refusal: { reason: "held-elsewhere" } });
    expect(again.status).toBe("moved");
  });
});
