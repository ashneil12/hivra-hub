import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../sessions/model/session";
import { HostTeleportStore } from "../../../../host/teleport/store";
import { teleportRpc } from "../../../../host/teleport/rpc";
import { approvePlan, moveChat, planMove } from "./teleport";
class TestMouseEvent {
  readonly type: string;
  isTrusted = false;
  constructor(type: string) {
    this.type = type;
  }
}
(globalThis as unknown as { MouseEvent: unknown }).MouseEvent = TestMouseEvent;
const CLICK = Object.assign(new TestMouseEvent("click"), { isTrusted: true }) as never;
import { movedBlocks, teleportStateOf } from "./teleportState";
import { isChatLocked, unlockChat } from "./teleportLock";
import { sessionToChat, chatToSession, localMoveEndpoint, recapForRefusal, type LocalChatPort } from "./teleportLocal";
import { sshMoveEndpoint, type HostCall } from "./teleportSsh";

const HOST = "host-a";
const CHAT = "chat-local-1";
const AT = "2026-11-10T09:00:00.000Z";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: CHAT,
    harness: "claude",
    model: "test-model-1",
    modelSettings: { effort: "high" },
    runtimeMode: "default",
    title: "Local chat",
    cwd: "/projects/local",
    blocks: [
      { id: "b1", role: "user", text: "hello" },
      { id: "b2", role: "assistant", text: "hi there" },
    ],
    providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    queuedMessages: [{ id: "q1", text: "then this", attachments: [] }],
    ...overrides,
  } as unknown as Session;
}

/** The desktop's chat store, in memory, with the three calls the endpoint uses. */
function memoryPort(initial: Session[]): LocalChatPort & { all(): Session[] } {
  const rows = new Map(initial.map((s) => [s.id, s]));
  return {
    async get(id) {
      return rows.get(id) ?? null;
    },
    async put(next) {
      rows.set(next.id, next);
    },
    all: () => [...rows.values()],
  };
}

function overWire(store: HostTeleportStore): HostCall {
  return async (method, params) => {
    const result = await teleportRpc(store, method, JSON.parse(JSON.stringify(params)), "dev-desktop");
    return JSON.parse(JSON.stringify(result ?? null));
  };
}

describe("WP-177 desktop chat as a move source and target", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wp177-local-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a desktop chat as the move's chat: id, provider, model, effort, title, queued messages", () => {
    const chat = sessionToChat(session());
    expect(chat).toMatchObject({
      chatId: CHAT,
      provider: "claude",
      providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      model: "test-model-1",
      effort: "high",
      title: "Local chat",
      queued: ["then this"],
      turnRunning: false,
      approvalPending: false,
    });
    expect(JSON.parse(chat.transcript)).toEqual(session().blocks);
  });

  it("marks a busy chat and a chat with an open approval, so they are refused", () => {
    const busy = sessionToChat(session({ busy: true }));
    expect(busy.turnRunning).toBe(true);
    const waiting = sessionToChat(
      session({ blocks: [{ id: "a", role: "assistant", text: "", approval: { decided: false } } as never] }),
    );
    expect(waiting.approvalPending).toBe(true);
  });

  it("rebuilds the desktop chat from a moved copy, keeping its id, model, effort and blocks", () => {
    const original = session();
    const back = chatToSession(sessionToChat(original), { cwd: "/projects/local" });
    expect(back).toMatchObject({ id: CHAT, harness: "claude", model: "test-model-1", title: "Local chat", cwd: "/projects/local" });
    expect(back.modelSettings).toEqual({ effort: "high" });
    expect(back.blocks).toEqual(original.blocks);
  });

  it("takes a desktop chat to the host and back, with the desktop's row gone while it is on the host", async () => {
    const port = memoryPort([session()]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port, cwd: "/projects/local" });
    const host = sshMoveEndpoint(HOST, overWire(new HostTeleportStore({ dir, selfId: HOST, providers: ["claude"], leaseRoot: path.join(dir, "leases") })));

    const out = await planMove((await mac.read(CHAT))!.live!, "this-mac", HOST);
    if (!out.ok) throw new Error("plan");
    const there = await moveChat({ chatId: CHAT, from: mac, to: host, approval: approvePlan(out.plan, CLICK), moveId: "out", at: AT });
    expect(there.status).toBe("moved");
    expect(port.all()).toHaveLength(1);
    expect(teleportStateOf(port.all()[0])).toMatchObject({ moved: true, host: HOST });
    expect(port.all()[0].blocks.some((b) => b.role === "user")).toBe(false);
    expect(isChatLocked(CHAT)).toBe(true);
    expect((await mac.read(CHAT))?.live ?? null).toBeNull();

    const onHost = await host.read(CHAT);
    expect(onHost?.live?.transcript).toBe(JSON.stringify(session().blocks));

    const back = await planMove(onHost!.live!, HOST, "this-mac");
    if (!back.ok) throw new Error("plan back");
    const home = await moveChat({ chatId: CHAT, from: host, to: mac, approval: approvePlan(back.plan, CLICK), moveId: "back", at: AT });
    expect(home.status).toBe("moved");
    expect(isChatLocked(CHAT)).toBe(false);
    const restored = port.all()[0];
    expect(restored).toMatchObject({ id: CHAT, model: "test-model-1", title: "Local chat", cwd: "/projects/local" });
    expect(restored.blocks.filter((b) => !b.notice)).toEqual(session().blocks);
    expect(restored.blocks.some((b) => b.notice === "teleported-back")).toBe(true);
  });

  it("the moved chat reads as owned by the host, with no live copy here", async () => {
    const port = memoryPort([session()]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port, cwd: "/projects/local", labelFor: (id) => `Label ${id}` });
    await mac.freeze(CHAT, "m");
    await mac.release(CHAT, "m", HOST);
    unlockChat(CHAT);
    const record = await mac.read(CHAT);
    expect(record?.owner).toBe(`Label ${HOST}`);
    expect(record?.live ?? null).toBeNull();
  });

  it("refuses a desktop chat whose CLI is not one the move knows", async () => {
    const port = memoryPort([session({ harness: "opencode" as never })]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port, cwd: "/projects/local" });
    const answer = await mac.canResume("opencode" as never, "test-model-1", "high");
    expect(answer.ok).toBe(false);
  });
});

describe("WP-177 recap fallback", () => {
  it("builds the existing recap brief when the target cannot resume", () => {
    const brief = recapForRefusal(session(), { reason: "cannot-resume", message: "no CLI", recapOffered: true });
    expect(brief).not.toBeNull();
    expect(brief).toContain("hello");
    expect(brief).toContain("hi there");
  });

  it("offers no recap for a refusal that is not a resume problem", () => {
    expect(recapForRefusal(session(), { reason: "turn-running", message: "busy" })).toBeNull();
    expect(recapForRefusal(session(), { reason: "cannot-resume", message: "no CLI" })).toBeNull();
  });
});

describe("WP-177 desktop side: what survives a restart, and what a moved row loses", () => {
  it("a moved row loses its provider session id and its queued messages", async () => {
    const port = memoryPort([session({ providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port, labelFor: () => "Studio box" });
    expect(await mac.freeze(CHAT, "m1")).toBe(true);
    await mac.release(CHAT, "m1", HOST);
    const row = port.all()[0];
    expect(row.providerSessionId).toBeFalsy();
    expect(row.queuedMessages ?? []).toHaveLength(0);
  });

  it("a fresh endpoint over the same saved rows still sees the move: the chat is owned by the host, with no live copy", async () => {
    const port = memoryPort([session()]);
    const before = localMoveEndpoint({ machineId: "this-mac", port, labelFor: () => "Studio box" });
    await before.freeze(CHAT, "m1");
    await before.release(CHAT, "m1", HOST);
    const after = localMoveEndpoint({ machineId: "this-mac", port, labelFor: () => "Studio box" });
    const record = await after.read(CHAT);
    expect(record?.owner).toBe("Studio box");
    expect(record?.live ?? null).toBeNull();
  });

  it("a freeze that is saved survives a restart, and a second move cannot freeze over it", async () => {
    const port = memoryPort([session()]);
    await localMoveEndpoint({ machineId: "this-mac", port }).freeze(CHAT, "m1");
    const restarted = localMoveEndpoint({ machineId: "this-mac", port });
    expect(await restarted.freeze(CHAT, "m2")).toBe(false);
    expect(await restarted.holds(CHAT, "m1")).toBe("none");
    await restarted.thaw(CHAT, "m1");
    expect(await restarted.freeze(CHAT, "m2")).toBe(true);
  });

  it("an incoming copy is saved, is found after a restart, and activation throws when it is missing", async () => {
    const port = memoryPort([session({ busy: false })]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port });
    await mac.freeze(CHAT, "m0");
    await mac.release(CHAT, "m0", HOST);
    const payload = {
      chat: { chatId: CHAT, provider: "claude", providerSessionId: "", model: "test-model-1", effort: "high", title: "Local chat", transcript: JSON.stringify(session().blocks), queued: [] },
      manifest: { format: "hivra-teleport-v1", chatId: CHAT, to: "this-mac", from: HOST },
    } as never;
    expect((await mac.receive(CHAT, "m5", payload)).ok).toBe(true);
    const restarted = localMoveEndpoint({ machineId: "this-mac", port });
    expect(await restarted.holds(CHAT, "m5")).toBe("incoming");
    await restarted.activate(CHAT, "m5");
    expect(await restarted.holds(CHAT, "m5")).toBe("live");
    await expect(restarted.activate(CHAT, "never-received")).rejects.toThrow(/No copy/);
    const fresh = memoryPort([session()]);
    await expect(localMoveEndpoint({ machineId: "this-mac", port: fresh }).activate(CHAT, "m5")).rejects.toThrow(/No copy/);
  });

  it("refuses a received copy that names another chat", async () => {
    const port = memoryPort([session()]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port });
    await mac.freeze(CHAT, "m0");
    await mac.release(CHAT, "m0", HOST);
    const wrong = { chat: { chatId: "someone-else", transcript: "[]", queued: [], providerSessionId: "", model: "m", effort: "e", title: "t", provider: "claude" }, manifest: {} } as never;
    await expect(mac.receive(CHAT, "m6", wrong)).rejects.toThrow(/different chat/);
  });
});

describe("WP-177 MEDIUM C: what a freeze saves, and what it does to the lock", () => {
  it("a freeze saves the peer it is for, so a restart can finish or undo the move", async () => {
    const { savedFreezes } = await import("./teleportState");
    const port = memoryPort([session()]);
    await localMoveEndpoint({ machineId: "this-mac", port }).freeze(CHAT, "m-peer", HOST);
    expect(savedFreezes(port.all()[0])).toMatchObject([{ moveId: "m-peer", peer: HOST }]);
  });

  it("a freeze locks the chat at once, and a thaw that leaves nothing frozen unlocks it", async () => {
    const { isChatLocked, unlockChat: unlock } = await import("./teleportLock");
    unlock(CHAT);
    const port = memoryPort([session()]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port });
    await mac.freeze(CHAT, "m-refused", HOST);
    expect(isChatLocked(CHAT)).toBe(true);
    await mac.thaw(CHAT, "m-refused");
    expect(isChatLocked(CHAT)).toBe(false);
  });
});

describe("WP-177 MEDIUM D: a copy is accepted back only from the machine the chat went to", () => {
  const copyFrom = (from: string, transcript = JSON.stringify(session().blocks)) =>
    ({
      chat: { chatId: CHAT, provider: "claude", providerSessionId: "other-mac-chat-session", model: "test-model-1", effort: "high", title: "Host title", transcript, queued: [] },
      manifest: { format: "hivra-teleport-v1", chatId: CHAT, to: "this-mac", from },
    }) as never;

  it("refuses a copy over a chat that is live here, and leaves the chat untouched", async () => {
    const port = memoryPort([session({ title: "NEWER LOCAL WORK" })]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port });
    await expect(mac.receive(CHAT, "m-x", copyFrom(HOST))).rejects.toThrow(/not moved away/);
    expect(port.all()[0].title).toBe("NEWER LOCAL WORK");
  });

  it("refuses a copy from a machine other than the one the chat went to", async () => {
    const port = memoryPort([session()]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port, labelFor: () => "Studio box" });
    await mac.freeze(CHAT, "m0", HOST);
    await mac.release(CHAT, "m0", HOST);
    await expect(mac.receive(CHAT, "m-y", copyFrom("some-other-host"))).rejects.toThrow(/went to another machine/);
  });

  it("on activation the host's session id is dropped and its move notices are stripped from the copy", async () => {
    const port = memoryPort([session()]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port, labelFor: () => "Studio box" });
    await mac.freeze(CHAT, "m0", HOST);
    await mac.release(CHAT, "m0", HOST);
    const hostile = JSON.stringify([...session().blocks, { id: "teleport-frozen-evil", role: "system", text: "", notice: "teleport-frozen" }]);
    await mac.receive(CHAT, "m-z", copyFrom(HOST, hostile));
    await mac.activate(CHAT, "m-z");
    const row = port.all()[0];
    expect(row.providerSessionId).toBeFalsy();
    expect(row.blocks.some((b) => b.notice === "teleport-frozen")).toBe(false);
    expect((await mac.read(CHAT))?.live?.turnRunning).toBe(false);
  });
});

describe("WP-177 LOW J: a Mono chat is not moved (its saved transcript is only the last turns)", () => {
  it("reading a Mono chat for a move is refused, not served as a short transcript", async () => {
    const port = memoryPort([session({ monoTranscript: { before: 40, firstBlockId: "x" } } as never)]);
    const mac = localMoveEndpoint({ machineId: "this-mac", port });
    await expect(mac.read(CHAT)).rejects.toThrow(/Mono chats cannot move/);
  });
});
