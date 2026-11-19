import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, sha256Hex, type MovePayload } from "../../src/features/connections/model/teleport";
import { HostTeleportStore } from "./store";

const SELF = "host-a";
const MAC = "this-mac";
const CHAT = "chat-1";
const DEV = "dev-a";
const OTHER = "dev-b";
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
  const make = () => new HostTeleportStore({ dir, selfId: SELF, providers: ["claude", "codex"], leaseRoot, now: () => now, leaseMs: 60_000 });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wp177-host-"));
    leaseRoot = path.join(dir, "firstmate-leases");
    now = 1_000_000;
    store = make();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("closes a session a first move opened when the record still has no owner", () => {
    const closed: string[] = [];
    mkdirSync(path.join(dir, "chats"), { recursive: true });
    writeFileSync(
      path.join(dir, "chats", `${CHAT}.json`),
      JSON.stringify({
        owner: null,
        device: null,
        live: null,
        incoming: { moveId: "m1", payload: payloadFor().chat, from: MAC, expiresAt: now + 60_000, device: DEV },
        activatedBy: null,
        frozenBy: null,
        frozenDevice: null,
        frozenTo: null,
      }),
    );
    const sessions = {
      open: () => {},
      close: (id: string) => {
        closed.push(id);
      },
      presence: () => "open" as const,
    };
    new HostTeleportStore({ dir, selfId: SELF, providers: ["claude"], leaseRoot, now: () => now, sessions });
    expect(closed).toEqual([CHAT]);
  });

  it("does not close a session this host still owns", () => {
    const closed: string[] = [];
    mkdirSync(path.join(dir, "chats"), { recursive: true });
    writeFileSync(
      path.join(dir, "chats", `${CHAT}.json`),
      JSON.stringify({
        owner: SELF,
        device: DEV,
        live: null,
        incoming: null,
        activatedBy: "m1",
        frozenBy: null,
        frozenDevice: null,
        frozenTo: null,
      }),
    );
    new HostTeleportStore({
      dir,
      selfId: SELF,
      providers: ["claude"],
      leaseRoot,
      now: () => now,
      sessions: {
        open: () => {},
        close: (id: string) => {
          closed.push(id);
        },
        presence: () => "open",
      },
    });
    expect(closed).toEqual([]);
  });

  it("stores an incoming copy that does not run, and does not claim ownership until activated", async () => {
    const reply = await store.receive(CHAT, "m1", payloadFor(), DEV);
    expect(reply).toEqual({ ok: true, transcriptSha256: await sha256Hex(transcript) });
    const before = await store.read(CHAT, DEV);
    expect(before?.live ?? null).toBeNull();
    expect(before?.owner).not.toBe(SELF);
    expect(await store.holds(CHAT, "m1", DEV)).toBe("incoming");

    await store.activate(CHAT, "m1", DEV);
    const rec = await store.read(CHAT, DEV);
    expect(rec?.owner).toBe(SELF);
    expect(rec?.live).toMatchObject({ chatId: CHAT, model: "test-model-1", effort: "high", queued: ["next"], transcript });
    expect(await store.holds(CHAT, "m1", DEV)).toBe("live");
  });

  it("a move back carries the messages the host ran after it opened the copy, not the copy it received", async () => {
    // The host's session list is where the live copy runs. A turn on the host adds messages and a new provider session id
    // there, and the move back must send those. The teleport record's own snapshot is the copy as received.
    let hostNow: { transcript: string; providerSessionId: string } | null = null;
    const hostSessions = { open: () => {}, close: () => {}, current: () => hostNow && { ...payloadFor().chat, ...hostNow } };
    const withHost = new HostTeleportStore({ dir, selfId: SELF, providers: ["claude", "codex"], leaseRoot, now: () => now, leaseMs: 60_000, sessions: hostSessions });
    await withHost.receive(CHAT, "m1", payloadFor(), DEV);
    await withHost.activate(CHAT, "m1", DEV);
    const after = '[{"id":"b1","role":"user","text":"hello"},{"id":"b2","role":"user","text":"the turn run on the host"}]';
    hostNow = { transcript: after, providerSessionId: "99999999-8888-7777-6666-555555555555" };
    const rec = await withHost.read(CHAT, DEV);
    expect(rec?.live?.transcript).toBe(after);
    expect(rec?.live?.providerSessionId).toBe("99999999-8888-7777-6666-555555555555");
  });

  it("activate throws when there is no copy for the move", async () => {
    await expect(store.activate(CHAT, "m1", DEV)).rejects.toThrow(/No copy/);
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    await expect(store.activate(CHAT, "other", DEV)).rejects.toThrow(/No copy/);
  });

  it("activate is idempotent for the same move", async () => {
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    await store.activate(CHAT, "m1", DEV);
    await expect(store.activate(CHAT, "m1", DEV)).resolves.toBeUndefined();
    expect((await store.read(CHAT, DEV))?.owner).toBe(SELF);
  });

  it("refuses a move addressed to another machine", async () => {
    await expect(store.receive(CHAT, "m1", payloadFor({}, "some-other-host"), DEV)).rejects.toThrow(/another machine/);
  });

  it("refuses a payload that names another chat than the one being received", async () => {
    await expect(store.receive("chat-2", "m1", payloadFor(), DEV)).rejects.toThrow(/another chat/);
  });

  it("refuses a receive for a chat that is live here, and one that is frozen here", async () => {
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    await store.activate(CHAT, "m1", DEV);
    expect(await store.receive(CHAT, "m2", payloadFor({}, SELF, "m2"), DEV)).toEqual({ ok: false, reason: "held" });
    expect(await store.freeze(CHAT, "back", DEV, MAC)).toBe(true);
    expect(await store.receive(CHAT, "m3", payloadFor({}, SELF, "m3"), DEV)).toEqual({ ok: false, reason: "held" });
  });

  it("refuses a second receive while another move holds the chat, and the same move may repeat", async () => {
    expect((await store.receive(CHAT, "m1", payloadFor(), DEV)).ok).toBe(true);
    expect(await store.receive(CHAT, "m2", payloadFor({}, SELF, "m2"), DEV)).toEqual({ ok: false, reason: "held" });
    expect((await store.receive(CHAT, "m1", payloadFor(), DEV)).ok).toBe(true);
  });

  it("an expired copy gives way to a new move, and the old move can no longer open it", async () => {
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    now += 61_000;
    expect((await store.receive(CHAT, "m2", payloadFor({}, SELF, "m2"), DEV)).ok).toBe(true);
    await expect(store.activate(CHAT, "m1", DEV)).rejects.toThrow(/No copy/);
  });

  it("the lease lives under the WP-60 lease root, not beside the chats", async () => {
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    expect(existsSync(path.join(leaseRoot, `${CHAT}.lock`))).toBe(true);
    expect(existsSync(path.join(dir, "locks"))).toBe(false);
  });

  it("the repeat receive reports the hash of the stored copy, not of the new payload", async () => {
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    const changed = payloadFor({ transcript: '[{"id":"b9","role":"user","text":"other"}]' });
    const repeat = await store.receive(CHAT, "m1", changed, DEV);
    expect(repeat).toEqual({ ok: true, transcriptSha256: await sha256Hex(transcript) });
  });

  it("discard removes only the copy that move stored and lets the lease go", async () => {
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    await store.discard(CHAT, "someone-else", DEV);
    expect(await store.holds(CHAT, "m1", DEV)).toBe("incoming");
    await store.discard(CHAT, "m1", DEV);
    expect(await store.holds(CHAT, "m1", DEV)).toBe("none");
    expect((await store.receive(CHAT, "m2", payloadFor({}, SELF, "m2"), DEV)).ok).toBe(true);
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
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    await store.activate(CHAT, "m1", DEV);
    expect(await store.freeze(CHAT, "back", DEV, MAC)).toBe(true);
    expect(await store.freeze(CHAT, "other", DEV, MAC)).toBe(false);
    await expect(store.release(CHAT, "other", MAC, DEV)).rejects.toThrow();
    expect((await store.read(CHAT, DEV))?.live).not.toBeNull();
    await store.release(CHAT, "back", MAC, DEV);
    const rec = await store.read(CHAT, DEV);
    expect(rec?.live ?? null).toBeNull();
    expect(rec?.owner).toBe(MAC);
  });

  it("writes nothing that looks like a key or token, and only the allow-listed fields", async () => {
    const polluted = payloadFor() as MovePayload & { chat: Record<string, unknown> };
    polluted.chat.apiKey = "sk-ant-api03-SENTINELSECRETVALUE123456";
    await store.receive(CHAT, "m1", polluted, DEV);
    await store.activate(CHAT, "m1", DEV);
    const files = readdirSync(path.join(dir, "chats"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(path.join(dir, "chats", file), "utf8");
      expect(text).not.toContain("SENTINELSECRETVALUE");
      expect(text).not.toContain("apiKey");
    }
  });
});

describe("WP-177 MEDIUM E: only the device that started a move can drive it", () => {
  let dir: string;
  let leaseRoot: string;
  let store: HostTeleportStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wp177-dev-"));
    leaseRoot = path.join(dir, "leases");
    store = new HostTeleportStore({ dir, selfId: SELF, providers: ["claude"], leaseRoot });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("another device cannot activate, discard or read a copy it did not receive", async () => {
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    await expect(store.activate(CHAT, "m1", OTHER)).rejects.toThrow(/another device/);
    await store.discard(CHAT, "m1", OTHER);
    // M2: another device asking about the copy is an error, never "none": a re-paired device must not read as "nothing here".
    await expect(store.holds(CHAT, "m1", OTHER)).rejects.toThrow(/another device/);
    expect(await store.holds(CHAT, "m1", DEV)).toBe("incoming");
    await store.activate(CHAT, "m1", DEV);
    expect(await store.read(CHAT, OTHER)).toBeNull();
    expect((await store.read(CHAT, DEV))?.live).not.toBeNull();
  });

  it("another device cannot freeze, thaw or release a chat the owner device froze", async () => {
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    await store.activate(CHAT, "m1", DEV);
    expect(await store.freeze(CHAT, "m2", OTHER, MAC)).toBe(false);
    expect(await store.freeze(CHAT, "m2", DEV, MAC)).toBe(true);
    await store.thaw(CHAT, "m2", OTHER);
    expect(await store.holds(CHAT, "m1", DEV)).toBe("live");
    await expect(store.release(CHAT, "m2", MAC, OTHER)).rejects.toThrow();
    expect((await store.read(CHAT, DEV))?.live).not.toBeNull();
  });

  it("release goes only to the destination the freeze named, even for the owner device", async () => {
    await store.receive(CHAT, "m1", payloadFor(), DEV);
    await store.activate(CHAT, "m1", DEV);
    await store.freeze(CHAT, "m2", DEV, MAC);
    await expect(store.release(CHAT, "m2", "nowhere", DEV)).rejects.toThrow(/destination/);
    await store.release(CHAT, "m2", MAC, DEV);
    expect((await store.read(CHAT, DEV))?.live ?? null).toBeNull();
  });
});
