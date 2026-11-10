// The app's move path against the real saved store (sessionStore.ts unmocked; only the Tauri boundary is an in-memory
// backend) and the real host store reached through the JSON wire. Nothing in the chain is mocked.
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
      backend.set(String(session.id), { ...session });
      return { id: session.id };
    }
    if (command === "session_get") return backend.get(String(args.sessionId)) ?? null;
    if (command === "session_list_by_project" || command === "session_list_folderless" || command === "session_list_linked") {
      return [...backend.values()].map((row) => ({ ...row }));
    }
    if (command === "session_delete") {
      backend.delete(String(args.sessionId));
      return null;
    }
    return null;
  }),
}));

import { forgetMovedRowsForTests, getSession, upsertSession } from "../../../features/sessions/data/sessionStore";
import { sessionStoreChatPort } from "../data/teleportStorePort";
import { localMoveEndpoint } from "./teleportLocal";
import { sshMoveEndpoint, type HostCall } from "./teleportSsh";
import { HostTeleportStore } from "../../../../host/teleport/store";
import { teleportRpc } from "../../../../host/teleport/rpc";
import { approveAndMove, planFromSession, recoverSavedMoves } from "./teleportMove";
import { teleportStateOf } from "./teleportState";
import { isChatLocked, unlockChat } from "./teleportLock";

const CHAT = "app-chat-1";
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

describe("WP-177 the app's move path, against the real stores", () => {
  let dir: string;
  let host: HostTeleportStore;
  let call: HostCall;
  beforeEach(() => {
    backend.clear();
    forgetMovedRowsForTests();
    unlockChat(CHAT);
    dir = mkdtempSync(path.join(tmpdir(), "wp177-app-"));
    host = new HostTeleportStore({ dir, selfId: HOST, providers: ["claude"], leaseRoot: path.join(dir, "leases") });
    call = async (method, params) =>
      JSON.parse(JSON.stringify((await teleportRpc(host, method, JSON.parse(JSON.stringify(params)), "dev-desktop")) ?? null));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("approve in the app moves the chat, and the saved row shows the move after a reload", async () => {
    await upsertSession(savedChat());
    const session = (await getSession(CHAT))!;
    const local = localMoveEndpoint({ machineId: MAC, port: sessionStoreChatPort(), labelFor: () => "Studio box" });
    const remote = sshMoveEndpoint(HOST, call);
    const planned = await planFromSession(session, MAC, HOST);
    if (!planned.ok) throw new Error(planned.refusal.reason);
    const { result } = await approveAndMove({ session, plan: planned.plan, gesture: click(), from: local, to: remote, moveId: "app-1", at: "2026-11-10T09:00:00.000Z" });
    expect(result.status).toBe("moved");

    const reloaded = (await getSession(CHAT))!;
    expect(teleportStateOf(reloaded)).toMatchObject({ moved: true, host: "Studio box" });
    expect(isChatLocked(CHAT)).toBe(true);
    expect((await host.read(CHAT, "dev-desktop"))?.live?.transcript).toContain("shipped");
  });

  it("a plain object is not an approval: nothing moves and the saved row is unchanged", async () => {
    await upsertSession(savedChat());
    const session = (await getSession(CHAT))!;
    const local = localMoveEndpoint({ machineId: MAC, port: sessionStoreChatPort() });
    const planned = await planFromSession(session, MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    await expect(
      approveAndMove({ session, plan: planned.plan, gesture: { isTrusted: true, type: "click" }, from: local, to: sshMoveEndpoint(HOST, call), moveId: "x", at: "t" }),
    ).rejects.toThrow(/person's click/);
    expect(teleportStateOf((await getSession(CHAT))!).moved).toBe(false);
    expect((await host.read(CHAT, "dev-desktop")) ?? null).toBeNull();
  });

  it("a chat that is busy in the app is refused in the plan, from the app's own state", async () => {
    await upsertSession(savedChat());
    const session = { ...(await getSession(CHAT))!, busy: true } as Session;
    const planned = await planFromSession(session, MAC, HOST);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.reason).toBe("turn-running");
  });

  it("startup recovery finishes a move that stopped after the host activated, and thaws a plain freeze", async () => {
    await upsertSession(savedChat());
    const local = localMoveEndpoint({ machineId: MAC, port: sessionStoreChatPort(), labelFor: () => "Studio box" });
    // A move that stopped after the host activated and before the Mac released: the Mac still holds the transcript.
    const session = (await getSession(CHAT))!;
    const planned = await planFromSession(session, MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const { approvePlan, moveChat } = await import("./teleport");
    const stopsBeforeRelease = { ...local, release: async () => { throw new Error("process stopped"); } };
    const first = await moveChat({ chatId: CHAT, from: stopsBeforeRelease, to: sshMoveEndpoint(HOST, call), approval: approvePlan(planned.plan, click()), moveId: "crash-1", at: "t" });
    expect(first.status).toBe("partial");

    const recovered = await recoverSavedMoves({ chatIds: [CHAT], port: sessionStoreChatPort(), local, remoteFor: () => sshMoveEndpoint(HOST, call) });
    expect(recovered).toEqual([expect.objectContaining({ chatId: CHAT, status: "moved" })]);
    expect(teleportStateOf((await getSession(CHAT))!)).toMatchObject({ moved: true });
    expect((await host.read(CHAT, "dev-desktop"))?.live).not.toBeNull();
  });
});

describe("WP-177 startup recovery, called at launch", () => {
  beforeEach(() => {
    backend.clear();
    forgetMovedRowsForTests();
    unlockChat(CHAT);
  });

  it("launch recovery skips chats with no saved move, and reports each recovered row back to the app", async () => {
    const { launchRecovery } = await import("./teleportMove");
    await upsertSession(savedChat());
    const dir2 = mkdtempSync(path.join(tmpdir(), "wp177-launch-"));
    const host2 = new HostTeleportStore({ dir: dir2, selfId: HOST, providers: ["claude"], leaseRoot: path.join(dir2, "leases") });
    const call: HostCall = async (method, params) =>
      JSON.parse(JSON.stringify((await teleportRpc(host2, method, JSON.parse(JSON.stringify(params)), "dev-desktop")) ?? null));
    const local = localMoveEndpoint({ machineId: MAC, port: sessionStoreChatPort(), labelFor: () => "Studio box" });
    const rows: Session[] = [];
    expect(await launchRecovery(["/projects/app"], { port: sessionStoreChatPort(), local, remoteFor: () => sshMoveEndpoint(HOST, call), onRow: (r) => rows.push(r) })).toEqual([]);
    expect(rows).toEqual([]);

    // A move that stopped before the Mac released: the launch finishes it and tells the app.
    const session = (await getSession(CHAT))!;
    const planned = await planFromSession(session, MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const { approvePlan, moveChat } = await import("./teleport");
    const stopped = { ...local, release: async () => { throw new Error("process stopped"); } };
    await moveChat({ chatId: CHAT, from: stopped, to: sshMoveEndpoint(HOST, call), approval: approvePlan(planned.plan, click()), moveId: "launch-1", at: "t" });
    const lines = await launchRecovery(["/projects/app"], { port: sessionStoreChatPort(), local, remoteFor: () => sshMoveEndpoint(HOST, call), onRow: (r) => rows.push(r) });
    expect(lines).toEqual([expect.objectContaining({ chatId: CHAT, status: "moved" })]);
    expect(rows).toHaveLength(1);
    expect(teleportStateOf(rows[0])).toMatchObject({ moved: true });
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe("WP-177 startup recovery finds every move in the store", () => {
  beforeEach(() => {
    backend.clear();
    forgetMovedRowsForTests();
    unlockChat(CHAT);
  });

  it("the scan returns a frozen chat that no tab shows, and an incoming copy, and not an ordinary chat", async () => {
    const { findMovedChatIds } = await import("./teleportMove");
    await upsertSession({ ...savedChat(), id: "plain-1" } as Session);
    await upsertSession({ ...savedChat(), id: "frozen-1" } as Session);
    const local = localMoveEndpoint({ machineId: MAC, port: sessionStoreChatPort(), labelFor: () => "Studio box" });
    expect(await local.freeze("frozen-1", "m-frozen", HOST)).toBe(true);

    await upsertSession({ ...savedChat(), id: "incoming-1" } as Session);
    expect(await localMoveEndpoint({ machineId: MAC, port: sessionStoreChatPort() }).freeze("incoming-1", "m-out", HOST)).toBe(true);
    await localMoveEndpoint({ machineId: MAC, port: sessionStoreChatPort(), labelFor: () => "Studio box" }).release("incoming-1", "m-out", HOST);
    await localMoveEndpoint({ machineId: MAC, port: sessionStoreChatPort() }).receive("incoming-1", "m-in", {
      chat: { chatId: "incoming-1", provider: "claude", providerSessionId: "", model: "m", effort: "high", title: "t", transcript: "[]", queued: [] },
      manifest: { format: "hivra-teleport-v1", chatId: "incoming-1", to: MAC, from: HOST },
    } as never);

    const ids = await findMovedChatIds(["/projects/app"]);
    expect(ids.sort()).toEqual(["frozen-1", "incoming-1"]);
  });
});
