// PR #214 hard review, round 6: the flush before a row read writes the window's copy whole as an ordinary save. After a
// step that removed a note (a thaw), that copy still has the note, and the store takes an ordinary save that adds a freeze
// back (session_store.rs teleport_guard refuses only a drop). A move that failed at once then leaves the chat frozen and
// locked here, while the other machine refused it: no runnable copy until a later launch recovers it.
//
// The Tauri boundary is an in-memory backend. An ordinary save keeps the stored move notes and writes the rest. A step
// is stored as sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Session } from "../../../features/sessions/model/session";

const backend = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const NOTES = ["teleport-freeze-asked", "teleport-incoming", "teleport-release-owed", "teleport-aborted"];
type Raw = { id?: unknown; notice?: unknown };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "session_upsert") {
      const session = args.session as Record<string, unknown>;
      const id = String(session.id);
      const previous = backend.get(id);
      if (previous && !session.teleport) {
        const owned = (block: Raw) =>
          block?.notice === "teleport-frozen" ||
          NOTES.includes(String(block?.notice ?? "")) ||
          block?.notice === "teleported" ||
          block?.notice === "teleported-back";
        const incoming = Array.isArray(session.blocks) ? (session.blocks as Raw[]) : [];
        const stored = Array.isArray(previous.blocks) ? (previous.blocks as Raw[]) : [];
        let away = false;
        for (let i = stored.length - 1; i >= 0; i--) {
          const notice = stored[i]?.notice;
          if (notice === "teleported-back") { away = false; break; }
          if (notice === "teleported") { away = true; break; }
        }
        if (away) {
          session.blocks = [...stored];
          session.providerSessionId = previous.providerSessionId;
          session.queuedMessages = previous.queuedMessages;
        } else {
          session.blocks = [...incoming.filter((block) => !owned(block)), ...stored.filter((block) => owned(block))];
        }
      }
      const { teleport: _step, ...row } = session;
      backend.set(id, { ...row });
      return { id };
    }
    if (command === "session_get" || command === "session_get_for_move") {
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
import { approveAndMove, planFromSession } from "./teleportMove";
import { isChatLocked, settleTeleportLock, unlockChat } from "./teleportLock";
import type { MoveEndpoint } from "./teleport";

const CHAT = "r6-flush-chat";
const HOST = "host-a";
const MAC = "this-mac";

class TestMouseEvent {
  readonly type: string;
  isTrusted = false;
  constructor(type: string) {
    this.type = type;
  }
}
(globalThis as unknown as { MouseEvent: unknown }).MouseEvent = TestMouseEvent;
const click = () => Object.assign(new TestMouseEvent("click"), { isTrusted: true });

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

/**
 * The window as App.tsx runs it: the session list, the 650 ms pending save that App's flusher writes whole with an
 * ordinary upsertSession, and the `teleport-row-changed` listener, which the store fires after every move step.
 */
function appWindow() {
  let sessions: Session[] = [];
  const ref = { current: sessions } as RefObject<Session[]>;
  const setSessions = ((update: SetStateAction<Session[]>) => {
    sessions = typeof update === "function" ? (update as (s: Session[]) => Session[])(sessions) : update;
    (ref as { current: Session[] }).current = sessions;
  }) as Dispatch<SetStateAction<Session[]>>;
  const pending = new Map<string, Session>();
  const unregister = registerSessionPersistFlush(async (id) => {
    const session = pending.get(id);
    if (!session) return;
    pending.delete(id);
    await upsertSession(session).catch(() => null);
  });
  /** The row listener, then App's observer: a changed idle chat is queued for its debounced save. */
  const hear = async (id: string) => {
    const before = ref.current.find((s) => s.id === id);
    await acceptStoredTeleportRow(ref, setSessions, id, getSession, settleTeleportLock);
    const after = ref.current.find((s) => s.id === id);
    if (after && after !== before) pending.set(id, after);
  };
  return { ref, setSessions, pending, hear, unregister };
}

/** The store port, firing the row event after each stored step as session_upsert does. */
function portWithRowEvents(hear: (id: string) => Promise<void>): LocalChatPort {
  const base = sessionStoreChatPort();
  return {
    ...base,
    step: async (session, step) => {
      const result = await base.step!(session, step);
      if (result.ok) await hear(session.id);
      return result;
    },
  };
}

/** A host that refuses the copy and answers the abort, as a host that already holds another move would. */
function refusingHost(): MoveEndpoint {
  return {
    id: HOST,
    read: async () => null,
    freeze: async () => false,
    thaw: async () => undefined,
    canResume: async () => ({ ok: true }),
    receive: async () => {
      throw new Error("the host refused the copy");
    },
    discard: async () => undefined,
    abort: async () => "aborted",
    activate: async () => undefined,
    release: async () => undefined,
    holds: async () => "none",
    noteFreezeAsk: async () => undefined,
    clearFreezeAsk: async () => undefined,
  } as MoveEndpoint;
}

describe("PR 214 review r6: the flush before a row read must not undo a thaw", () => {
  let win: ReturnType<typeof appWindow>;
  beforeEach(() => {
    backend.clear();
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    win = appWindow();
  });
  afterEach(() => win.unregister());

  it("a move the host refuses at once leaves the chat live here, not frozen and locked", async () => {
    await upsertSession(savedChat());
    const session = (await getSession(CHAT))!;
    win.setSessions([session]);
    const local = localMoveEndpoint({ machineId: MAC, port: portWithRowEvents(win.hear), labelFor: () => "Studio box" });
    const planned = await planFromSession(session, MAC, HOST);
    if (!planned.ok) throw new Error(planned.refusal.reason);
    const { result } = await approveAndMove({
      session,
      plan: planned.plan,
      gesture: click(),
      from: local,
      to: refusingHost(),
      moveId: "r6-quick",
      at: "2026-11-11T09:00:00.000Z",
    });
    // The move reports that the chat stayed here.
    expect(result.status).toBe("failed");
    const stored = await getSession(CHAT);
    const frozen = (stored?.blocks ?? []).filter((block) => block.notice === "teleport-frozen").map((block) => block.id);
    expect(frozen, "the stored row after the thaw").toEqual([]);
    expect(isChatLocked(CHAT), "sends from this chat are refused").toBe(false);
  });

  it("the same, step by step: the thaw's row event writes the window's frozen copy back", async () => {
    await upsertSession(savedChat());
    win.setSessions([(await getSession(CHAT))!]);
    const local = localMoveEndpoint({ machineId: MAC, port: portWithRowEvents(win.hear), labelFor: () => "Studio box" });
    expect(await local.freeze(CHAT, "r6-step", HOST)).toBe(true);
    // The window took the frozen row; its debounced save of that copy is pending (under 650 ms).
    expect(win.pending.has(CHAT)).toBe(true);
    await local.thaw(CHAT, "r6-step");
    const stored = await getSession(CHAT);
    expect((stored?.blocks ?? []).some((block) => block.notice === "teleport-frozen"), "stored row is frozen again").toBe(false);
    expect(isChatLocked(CHAT)).toBe(false);
  });
});
