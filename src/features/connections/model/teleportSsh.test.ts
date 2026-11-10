import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostTeleportStore } from "../../../../host/teleport/store";
import { teleportRpc } from "../../../../host/teleport/rpc";
import {
  approvePlan,
  moveChat,
  planMove,
  sha256Hex,
  type ChatRecord,
  type ChatSnapshot,
  type MoveEndpoint,
  type MovePayload,
} from "./teleport";
const CLICK = { isTrusted: true, type: "click" };
import { sshMoveEndpoint, type HostCall } from "./teleportSsh";

const MAC = "this-mac";
const HOST = "host-a";
const CHAT = "chat-7";
const AT = "2026-11-10T09:00:00.000Z";
const transcript = '{"type":"user","text":"keep going"}\n{"type":"assistant","text":"ok"}\n';

const chat: ChatSnapshot = {
  chatId: CHAT,
  provider: "claude",
  providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  model: "test-model-1",
  effort: "high",
  title: "Over the wire",
  transcript,
  queued: ["then this"],
  turnRunning: false,
  approvalPending: false,
};

/** The Mac side, in memory. The host side is the real host store, reached only through the RPC. */
function memoryMac(): MoveEndpoint & { seed(snapshot: ChatSnapshot): void; live(): ChatSnapshot | null } {
  let record: ChatRecord | null = null;
  let frozen: string | null = null;
  let incoming: { moveId: string; payload: MovePayload } | null = null;
  return {
    id: MAC,
    seed(snapshot) {
      record = { owner: MAC, live: snapshot };
    },
    live: () => record?.live ?? null,
    async read() {
      return record ? { owner: record.owner, live: record.live ? { ...record.live } : null } : null;
    },
    async freeze(_chatId, moveId) {
      if (frozen) return false;
      frozen = moveId;
      return true;
    },
    async thaw(_chatId, moveId) {
      if (frozen === moveId) frozen = null;
    },
    async canResume() {
      return { ok: true };
    },
    async receive(_chatId, moveId, payload) {
      incoming = { moveId, payload };
      return { ok: true, transcriptSha256: await sha256Hex(payload.chat.transcript) };
    },
    async discard(_chatId, moveId) {
      if (incoming?.moveId === moveId) incoming = null;
    },
    async activate(_chatId, moveId) {
      if (incoming?.moveId === moveId) {
        record = { owner: MAC, live: { ...incoming.payload.chat, turnRunning: false, approvalPending: false } };
        incoming = null;
      }
    },
    async release(_chatId, moveId, to) {
      if (frozen !== moveId) throw new Error("not frozen by this move");
      record = { owner: to, live: null };
      frozen = null;
    },
  };
}

/** Each call goes through JSON, as the desktop's invoke does, so nothing survives that the wire would drop. */
function overWire(store: HostTeleportStore): HostCall {
  return async (method, params) => {
    const sent = JSON.parse(JSON.stringify(params));
    const result = await teleportRpc(store, method, sent);
    return JSON.parse(JSON.stringify(result ?? null));
  };
}

describe("WP-177 SSH transport for a chat move", () => {
  let dir: string;
  let store: HostTeleportStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wp177-ssh-"));
    store = new HostTeleportStore({ dir, selfId: HOST, providers: ["claude"], leaseRoot: path.join(dir, "leases") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("moves a chat from this Mac to the host over the host connection and back", async () => {
    const mac = memoryMac();
    mac.seed(chat);
    const host = sshMoveEndpoint(HOST, overWire(store));

    const planned = await planMove(chat, MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const there = await moveChat({ chatId: CHAT, from: mac, to: host, approval: approvePlan(planned.plan, CLICK), moveId: "out", at: AT });
    expect(there.status).toBe("moved");
    expect(mac.live()).toBeNull();

    const onHost = await host.read(CHAT);
    expect(onHost?.owner).toBe(HOST);
    expect(onHost?.live).toMatchObject({ chatId: CHAT, model: "test-model-1", effort: "high", queued: ["then this"], transcript });

    const back = await planMove(onHost!.live!, HOST, MAC);
    if (!back.ok) throw new Error("plan back");
    const home = await moveChat({ chatId: CHAT, from: host, to: mac, approval: approvePlan(back.plan, CLICK), moveId: "back", at: AT });
    expect(home.status).toBe("moved");
    expect(mac.live()).toMatchObject({ chatId: CHAT, transcript, effort: "high" });
    expect((await host.read(CHAT))?.live ?? null).toBeNull();
  });

  it("reports a host that is out of reach as a failed step, and the chat stays on this Mac", async () => {
    const mac = memoryMac();
    mac.seed(chat);
    const down: HostCall = async () => {
      throw new Error("Machine is no longer connected");
    };
    const host = sshMoveEndpoint(HOST, down);
    const planned = await planMove(chat, MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: approvePlan(planned.plan, CLICK), moveId: "x", at: AT });
    expect(result.status).toBe("failed");
    expect(mac.live()).toMatchObject({ chatId: CHAT });
  });

  it("sends only the teleport methods and never a credential field", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const recorder: HostCall = async (method, params) => {
      seen.push({ method, params });
      return overWire(store)(method, params as Record<string, unknown>);
    };
    const host = sshMoveEndpoint(HOST, recorder);
    await host.read(CHAT);
    await host.canResume("claude", "test-model-1", "high");
    expect(seen.every((call) => call.method.startsWith("teleport."))).toBe(true);
    expect(JSON.stringify(seen)).not.toMatch(/token|apiKey|secret|password/i);
  });
});
