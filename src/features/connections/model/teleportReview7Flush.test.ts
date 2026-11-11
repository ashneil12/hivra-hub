// PR #214 hard review, round 7: red repro for the stale-save merge (6868137f8) and the store guard (4863e761e). Each case
// states the RIGHT outcome: the person's reply is never dropped.
//
// 1. A window whose copy has no move state yet writes its pending save raw (upsertSession reads the stored row only for a
//    chat that already carries move state). After a freeze that save drops the freeze, the store refuses it, and the
//    refused flush keeps it pending. acceptStoredTeleportRow then reads the row and applyTeleportRow takes it whole for an
//    idle chat, so the reply leaves the window too, and App's observer replaces the kept pending save with that row.
// 2. upsertSession reads the stored row outside the per-chat write queue. A step that lands between that read and the
//    write makes the merged save stale; the store refuses it, and the same row read then drops the reply.
// 3. A move step is a read-modify-write too: the port reads the row, then writes it with the step's change. An ordinary
//    save that lands in between is overwritten. teleport_guard checks only the move notes of a step, so the store takes
//    a step that drops a saved reply.
//
// The Tauri boundary is an in-memory backend whose ordinary save applies teleport_guard's `write: None` branch as it is on
// 6868137f8: refuse a dropped or added freeze, a changed away state, a dropped move note, or an added move note other
// than a freeze ask. A step is stored as sent. The window mirrors App.tsx on 6868137f8: its observer queues every changed
// idle chat for the 650 ms save, and its flush keeps a refused save pending.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Session } from "../../../features/sessions/model/session";

const backend = vi.hoisted(() => new Map<string, Record<string, unknown>>());
/** Runs once, inside the next session_get, before the row is read. Lets a step land between a save's read and write. */
const beforeNextGet = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));
const NOTES = ["teleport-freeze-asked", "teleport-incoming", "teleport-release-owed", "teleport-aborted"];
type Raw = { id?: unknown; notice?: unknown };
function ids(blocks: unknown, notice: string): string[] {
  return (Array.isArray(blocks) ? (blocks as Raw[]) : []).filter((b) => b?.notice === notice).map((b) => String(b.id));
}
function away(blocks: unknown): string | null {
  const list = Array.isArray(blocks) ? (blocks as Raw[]) : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.notice === "teleported-back") return null;
    if (list[i]?.notice === "teleported") return String(list[i]?.id);
  }
  return null;
}
/** teleport_guard with `write: None`, as session_store.rs has it on 6868137f8. */
function ordinaryRefusal(previous: unknown, next: unknown): string | null {
  const storedFrozen = ids(previous, "teleport-frozen");
  const nextFrozen = ids(next, "teleport-frozen");
  if (storedFrozen.some((id) => !nextFrozen.includes(id))) return "teleport-refused: this save would drop a chat move's freeze";
  if (nextFrozen.some((id) => !storedFrozen.includes(id))) return "teleport-refused: this save would add a chat move's freeze";
  if (away(previous) !== away(next)) return "teleport-refused: this save would change whether the chat is on another machine";
  for (const notice of NOTES) {
    const kept = ids(next, notice);
    if (ids(previous, notice).some((id) => !kept.includes(id))) return "teleport-refused: this save would drop a chat move's note";
  }
  for (const notice of NOTES) {
    if (notice === "teleport-freeze-asked") continue;
    const stored = ids(previous, notice);
    if (ids(next, notice).some((id) => !stored.includes(id))) return "teleport-refused: this save would add a chat move's note";
  }
  return null;
}
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "session_upsert") {
      const session = args.session as Record<string, unknown>;
      const id = String(session.id);
      const previous = backend.get(id);
      if (previous && !session.teleport) {
        const refusal = ordinaryRefusal(previous.blocks, session.blocks);
        if (refusal) throw new Error(refusal);
      }
      const { teleport: _step, ...row } = session;
      backend.set(id, { ...row });
      return { id };
    }
    if (command === "session_get" || command === "session_get_for_move") {
      const hook = command === "session_get" ? beforeNextGet.hook : null;
      if (hook) {
        beforeNextGet.hook = null;
        const row = backend.get(String(args.sessionId));
        const snapshot = row ? JSON.parse(JSON.stringify(row)) : null;
        await hook();
        return snapshot;
      }
      const row = backend.get(String(args.sessionId));
      return row ? JSON.parse(JSON.stringify(row)) : null;
    }
    return null;
  }),
}));

import { forgetMovedRowsForTests, getSession, upsertSession } from "../../../features/sessions/data/sessionStore";
import { registerSessionPersistFlush } from "../../../features/sessions/model/sessionPersistFlush";
import { acceptStoredTeleportRow } from "../../../app/model/teleportSessionState";
import { sessionStoreChatPort } from "../data/teleportStorePort";
import { localMoveEndpoint, type LocalChatPort } from "./teleportLocal";
import { settleTeleportLock, unlockChat } from "./teleportLock";
import type { Block } from "../../../features/sessions/model/session";

const CHAT = "r7-flush-chat";
const HOST = "host-a";
const MAC = "this-mac";

function savedChat(): Session {
  return {
    id: CHAT,
    harness: "claude",
    model: "test-model-1",
    modelSettings: { effort: "high" },
    runtimeMode: "default",
    title: "App chat",
    cwd: "/projects/app",
    busy: false,
    blocks: [
      { id: "u1", role: "user", text: "ship it" },
      { id: "a1", role: "assistant", text: "shipped" },
    ],
    providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    queuedMessages: [],
  } as unknown as Session;
}

const REPLY = { id: "a2", role: "assistant", text: "the reply that finished just now" } as unknown as Block;

/** The window as App.tsx runs it on 6868137f8: session list, observer, the 650 ms pending save, the flush, the row event. */
function appWindow() {
  let sessions: Session[] = [];
  const ref = { current: sessions } as RefObject<Session[]>;
  const pending = new Map<string, Session>();
  const setSessions = ((update: SetStateAction<Session[]>) => {
    const before = sessions;
    sessions = typeof update === "function" ? (update as (s: Session[]) => Session[])(sessions) : update;
    (ref as { current: Session[] }).current = sessions;
    // App's observer: a changed idle chat is queued for its debounced save.
    for (const session of sessions) {
      if (before.find((s) => s.id === session.id) === session) continue;
      if (!session.busy) pending.set(session.id, session);
    }
  }) as Dispatch<SetStateAction<Session[]>>;
  // App's flush on 6868137f8: a refused save stays pending unless a newer one replaced it.
  const unregister = registerSessionPersistFlush(async (id) => {
    const session = pending.get(id);
    if (!session) return;
    const summary = await upsertSession(session).catch(() => null);
    const pendingNow = pending.get(id);
    if (pendingNow && pendingNow !== session) return;
    if (!summary) {
      if (!pendingNow) pending.set(id, session);
      return;
    }
    pending.delete(id);
  });
  /** The 650 ms timer: every pending save, written once. */
  const timer = async () => {
    const dirty = [...pending.values()];
    pending.clear();
    for (const session of dirty) await upsertSession(session).catch(() => null);
  };
  const hear = (id: string) => acceptStoredTeleportRow(ref, setSessions, id, getSession, settleTeleportLock);
  const has = (blockId: string) => (ref.current.find((s) => s.id === CHAT)?.blocks ?? []).some((b) => b.id === blockId);
  return { ref, setSessions, pending, hear, timer, has, unregister };
}

/** The store port, firing the row event after each stored step as session_upsert does. */
function portWithRowEvents(hear: (id: string) => Promise<void>, afterGet?: () => Promise<void>): LocalChatPort {
  const base = sessionStoreChatPort();
  return {
    ...base,
    get: async (id) => {
      const session = await base.get(id);
      if (afterGet) await afterGet();
      return session;
    },
    step: async (session, step) => {
      const result = await base.step!(session, step);
      if (result.ok) await hear(session.id);
      return result;
    },
  };
}

async function storedHas(blockId: string): Promise<boolean> {
  return ((await getSession(CHAT))?.blocks ?? []).some((b) => b.id === blockId);
}

describe("PR 214 review r7: a move step must not drop the person's reply", () => {
  let win: ReturnType<typeof appWindow>;
  beforeEach(() => {
    backend.clear();
    beforeNextGet.hook = null;
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    win = appWindow();
  });
  afterEach(() => win.unregister());

  it("a reply waiting on the save timer when another window freezes the chat is kept", async () => {
    await upsertSession(savedChat());
    win.setSessions([(await getSession(CHAT))!]);
    win.pending.clear();
    // A turn ended in this window; its reply waits on the 650 ms save. Another window freezes the chat for a move.
    win.setSessions((list) => list.map((s) => ({ ...s, blocks: [...s.blocks, REPLY] })));
    const mover = localMoveEndpoint({ machineId: MAC, port: portWithRowEvents(win.hear), labelFor: () => "Studio box" });
    expect(await mover.freeze(CHAT, "r7-freeze", HOST)).toBe(true);
    // The move fails at once and thaws. Then the window's timer fires.
    await mover.thaw(CHAT, "r7-freeze");
    await win.timer();
    const kept = win.has("a2") || (await storedHas("a2"));
    expect(kept, "the reply is in the window or the store").toBe(true);
  });

  it("a merged save that a thaw overtakes between its read and its write does not drop the reply", async () => {
    await upsertSession(savedChat());
    const mover = localMoveEndpoint({ machineId: MAC, port: portWithRowEvents(win.hear), labelFor: () => "Studio box" });
    expect(await mover.freeze(CHAT, "r7-race", HOST)).toBe(true);
    // The window heard the freeze. A reply arrives in it while the move is under way (another window started the move).
    win.setSessions([(await getSession(CHAT))!]);
    win.pending.clear();
    win.setSessions((list) => list.map((s) => ({ ...s, blocks: [...s.blocks, REPLY] })));
    // The save reads the frozen row; the move's thaw is stored before the save writes.
    beforeNextGet.hook = () => mover.thaw(CHAT, "r7-race");
    await win.timer();
    await win.timer();
    const kept = win.has("a2") || (await storedHas("a2"));
    expect(kept, "the reply is in the window or the store").toBe(true);
  });

  it("a settle step that read the row before a reply was saved does not overwrite that reply", async () => {
    // The chat came back here; its release on the host is still owed. The person is chatting in it again.
    const owed = {
      id: "teleport-release-owed-r7-back",
      role: "system",
      text: JSON.stringify({ peer: HOST, name: "Studio box", at: 1 }),
      notice: "teleport-release-owed",
    } as unknown as Block;
    const back = { id: "teleported-back-r7-back", role: "system", text: "Moved back to this Mac", notice: "teleported-back" } as unknown as Block;
    const base = savedChat();
    backend.set(CHAT, { ...base, blocks: [...base.blocks, back, owed] } as unknown as Record<string, unknown>);
    win.setSessions([(await getSession(CHAT))!]);
    win.pending.clear();
    win.setSessions((list) => list.map((s) => ({ ...s, blocks: [...s.blocks, REPLY] })));
    // Recovery settles the owed release. Its read of the row comes just before the window's save of the reply.
    const settler = localMoveEndpoint({
      machineId: MAC,
      port: portWithRowEvents(win.hear, () => win.timer()),
      labelFor: () => "Studio box",
    });
    await settler.settleRelease!(CHAT, "r7-back");
    expect(await storedHas("teleport-release-owed-r7-back"), "the owed note is settled").toBe(false);
    const kept = win.has("a2") || (await storedHas("a2"));
    expect(kept, "the reply is in the window or the store").toBe(true);
    expect(await storedHas("a2"), "the stored row keeps the saved reply").toBe(true);
  });
});
