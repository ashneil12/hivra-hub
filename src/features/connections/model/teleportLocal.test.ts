import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../sessions/model/session";
import { HostTeleportStore } from "../../../../host/teleport/store";
import { teleportRpc } from "../../../../host/teleport/rpc";
import { moveChat, planMove } from "./teleport";
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
    async remove(id) {
      rows.delete(id);
    },
    all: () => [...rows.values()],
  };
}

function overWire(store: HostTeleportStore): HostCall {
  return async (method, params) => {
    const result = await teleportRpc(store, method, JSON.parse(JSON.stringify(params)));
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
    const host = sshMoveEndpoint(HOST, overWire(new HostTeleportStore({ dir, selfId: HOST, providers: ["claude"] })));

    const out = await planMove((await mac.read(CHAT))!.live!, "this-mac", HOST);
    if (!out.ok) throw new Error("plan");
    const there = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: out.plan.planId }, moveId: "out", at: AT });
    expect(there.status).toBe("moved");
    expect(port.all()).toHaveLength(0);

    const onHost = await host.read(CHAT);
    expect(onHost?.live?.transcript).toBe(JSON.stringify(session().blocks));

    const back = await planMove(onHost!.live!, HOST, "this-mac");
    if (!back.ok) throw new Error("plan back");
    const home = await moveChat({ chatId: CHAT, from: host, to: mac, approval: { planId: back.plan.planId }, moveId: "back", at: AT });
    expect(home.status).toBe("moved");
    const restored = port.all()[0];
    expect(restored).toMatchObject({ id: CHAT, model: "test-model-1", title: "Local chat", cwd: "/projects/local" });
    expect(restored.blocks).toEqual(session().blocks);
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
