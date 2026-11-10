import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, sha256Hex, type MovePayload } from "../../src/features/connections/model/teleport";
import { HostTeleportStore } from "./store";

const SELF = "host-a";
const MAC = "this-mac";
const CHAT = "chat-1";
const transcript = '[{"id":"b1","role":"user","text":"hello"}]';

function payloadFor(over: Partial<MovePayload["chat"]> = {}, to = SELF, moveId = "m1"): MovePayload {
  const chat = {
    chatId: CHAT,
    provider: "claude" as const,
    providerSessionId: "11111111-2222-3333-4444-555555555555",
    model: "test-model-1",
    effort: "high",
    title: "Refactor the parser",
    transcript,
    queued: ["next"],
    ...over,
  };
  return {
    chat,
    manifest: buildManifest(
      { ...chat, turnRunning: false, approvalPending: false },
      { moveId, from: MAC, to, at: "2026-11-10T09:00:00.000Z", transcriptSha256: "" },
    ),
  };
}

describe("WP-177 host teleport store", () => {
  let dir: string;
  let leaseRoot: string;
  let now: number;
  let store: HostTeleportStore;
  const make = () =>
    new HostTeleportStore({ dir, selfId: SELF, providers: ["claude", "codex"], leaseRoot, now: () => now, leaseMs: 60_000 });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wp177-host-"));
    leaseRoot = path.join(dir, "firstmate-leases");
    now = 1_000_000;
    store = make();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stores an incoming copy that does not run, and does not claim ownership until activated", async () => {
    const reply = await store.receive(CHAT, "m1", payloadFor());
    expect(reply).toEqual({ ok: true, transcriptSha256: await sha256Hex(transcript) });
    const before = await store.read(CHAT);
    expect(before?.live ?? null).toBeNull();
    expect(before?.owner).not.toBe(SELF);
    expect(await store.holds(CHAT, "m1")).toBe("incoming");

    await store.activate(CHAT, "m1");
    const rec = await store.read(CHAT);
    expect(rec?.owner).toBe(SELF);
    expect(rec?.live).toMatchObject({ chatId: CHAT, model: "test-model-1", effort: "high", queued: ["next"], transcript });
    expect(await store.holds(CHAT, "m1")).toBe("live");
  });

  it("activate throws when there is no copy for the move", async () => {
    await expect(store.activate(CHAT, "m1")).rejects.toThrow(/No copy/);
    await store.receive(CHAT, "m1", payloadFor());
    await expect(store.activate(CHAT, "other")).rejects.toThrow(/No copy/);
  });

  it("activate is idempotent for the same move", async () => {
    await store.receive(CHAT, "m1", payloadFor());
    await store.activate(CHAT, "m1");
    await expect(store.activate(CHAT, "m1")).resolves.toBeUndefined();
    expect((await store.read(CHAT))?.owner).toBe(SELF);
  });

  it("refuses a move addressed to another machine", async () => {
    await expect(store.receive(CHAT, "m1", payloadFor({}, "some-other-host"))).rejects.toThrow(/another machine/);
  });

  it("refuses a payload that names another chat than the one being received", async () => {
    await expect(store.receive("chat-2", "m1", payloadFor())).rejects.toThrow(/another chat/);
  });

  it("refuses a receive for a chat that is live here, and one that is frozen here", async () => {
    await store.receive(CHAT, "m1", payloadFor());
    await store.activate(CHAT, "m1");
    expect(await store.receive(CHAT, "m2", payloadFor({}, SELF, "m2"))).toEqual({ ok: false, reason: "held" });
    expect(await store.freeze(CHAT, "back")).toBe(true);
    expect(await store.receive(CHAT, "m3", payloadFor({}, SELF, "m3"))).toEqual({ ok: false, reason: "held" });
  });

  it("refuses a second receive while another move holds the chat, and the same move may repeat", async () => {
    expect((await store.receive(CHAT, "m1", payloadFor())).ok).toBe(true);
    expect(await store.receive(CHAT, "m2", payloadFor({}, SELF, "m2"))).toEqual({ ok: false, reason: "held" });
    expect((await store.receive(CHAT, "m1", payloadFor())).ok).toBe(true);
  });

  it("an expired copy gives way to a new move, and the old move can no longer open it", async () => {
    await store.receive(CHAT, "m1", payloadFor());
    now += 61_000;
    expect((await store.receive(CHAT, "m2", payloadFor({}, SELF, "m2"))).ok).toBe(true);
    await expect(store.activate(CHAT, "m1")).rejects.toThrow(/No copy/);
  });

  it("the lease lives under the WP-60 lease root, not beside the chats", async () => {
    await store.receive(CHAT, "m1", payloadFor());
    expect(existsSync(path.join(leaseRoot, `${CHAT}.lock`))).toBe(true);
    expect(existsSync(path.join(dir, "locks"))).toBe(false);
  });

  it("discard removes only the copy that move stored and lets the lease go", async () => {
    await store.receive(CHAT, "m1", payloadFor());
    await store.discard(CHAT, "someone-else");
    expect(await store.holds(CHAT, "m1")).toBe("incoming");
    await store.discard(CHAT, "m1");
    expect(await store.holds(CHAT, "m1")).toBe("none");
    expect((await store.receive(CHAT, "m2", payloadFor({}, SELF, "m2"))).ok).toBe(true);
  });

  it("refuses a provider this host does not run, with the reason", async () => {
    expect(await store.canResume("codex", "test-model-1", "high")).toEqual({ ok: true });
    const none = await store.canResume("claude", "", "high");
    expect(none.ok).toBe(false);
    const other = new HostTeleportStore({ dir: path.join(dir, "other"), selfId: SELF, providers: ["codex"], leaseRoot });
    const refused = await other.canResume("claude", "test-model-1", "high");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/claude/);
  });

  it("as a source, releases the chat only when the move that froze it asks, and records the new owner", async () => {
    await store.receive(CHAT, "m1", payloadFor());
    await store.activate(CHAT, "m1");
    expect(await store.freeze(CHAT, "back")).toBe(true);
    expect(await store.freeze(CHAT, "other")).toBe(false);
    await expect(store.release(CHAT, "other", MAC)).rejects.toThrow();
    expect((await store.read(CHAT))?.live).not.toBeNull();
    await store.release(CHAT, "back", MAC);
    const rec = await store.read(CHAT);
    expect(rec?.live ?? null).toBeNull();
    expect(rec?.owner).toBe(MAC);
  });

  it("writes nothing that looks like a key or token, and only the allow-listed fields", async () => {
    const polluted = payloadFor() as MovePayload & { chat: Record<string, unknown> };
    polluted.chat.apiKey = "sk-ant-api03-SENTINELSECRETVALUE123456";
    await store.receive(CHAT, "m1", polluted);
    await store.activate(CHAT, "m1");
    const files = readdirSync(path.join(dir, "chats"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(path.join(dir, "chats", file), "utf8");
      expect(text).not.toContain("SENTINELSECRETVALUE");
      expect(text).not.toContain("apiKey");
    }
  });
});
