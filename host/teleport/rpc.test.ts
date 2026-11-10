import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, sha256Hex } from "../../src/features/connections/model/teleport";
import { HostTeleportStore } from "./store";
import { isTeleportMethod, teleportRpc } from "./rpc";

const MAC = "this-mac";
const transcript = '{"type":"user","text":"hi"}\n';

describe("WP-177 host teleport RPC", () => {
  let dir: string;
  let store: HostTeleportStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wp177-rpc-"));
    store = new HostTeleportStore({ dir, selfId: "host-a", providers: ["claude"], leaseRoot: path.join(dir, "leases") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("only the teleport methods are routed here", () => {
    expect(isTeleportMethod("teleport.receive")).toBe(true);
    expect(isTeleportMethod("sessions.list")).toBe(false);
    expect(isTeleportMethod("teleport.anything")).toBe(false);
  });

  it("refuses a missing or malformed chat id before it reaches the store", async () => {
    await expect(teleportRpc(store, "teleport.read", {})).rejects.toThrow(/chat/i);
    await expect(teleportRpc(store, "teleport.read", { chatId: "../etc" })).rejects.toThrow(/chat/i);
  });

  it("runs a receive then an activate through the RPC, and reads the owner back", async () => {
    const chat = { chatId: "chat-9", provider: "claude", providerSessionId: "s", model: "m", effort: "high", title: "t", transcript, queued: [] };
    const manifest = buildManifest({ ...chat, turnRunning: false, approvalPending: false }, { moveId: "m1", from: MAC, to: "host-a", at: "2026-11-10T09:00:00.000Z", transcriptSha256: "" });
    const received = (await teleportRpc(store, "teleport.receive", { chatId: "chat-9", moveId: "m1", payload: { chat, manifest } })) as { ok: boolean; transcriptSha256: string };
    expect(received).toEqual({ ok: true, transcriptSha256: await sha256Hex(transcript) });
    await teleportRpc(store, "teleport.activate", { chatId: "chat-9", moveId: "m1" });
    const read = (await teleportRpc(store, "teleport.read", { chatId: "chat-9" })) as { owner: string; live: { transcript: string } };
    expect(read.owner).toBe("host-a");
    expect(read.live.transcript).toBe(transcript);
  });

  it("refuses a receive whose payload is not a move payload", async () => {
    await expect(teleportRpc(store, "teleport.receive", { chatId: "chat-9", moveId: "m1", payload: { nope: true } })).rejects.toThrow(/payload/i);
  });
});
