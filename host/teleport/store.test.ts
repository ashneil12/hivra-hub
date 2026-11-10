import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, sha256Hex, type MovePayload } from "../../src/features/connections/model/teleport";
import { HostTeleportStore } from "./store";

const SELF = "host-a";
const MAC = "this-mac";
const CHAT = "chat-1";

function payloadFor(transcript: string, overrides: Partial<MovePayload["chat"]> = {}): MovePayload {
  const chat = {
    chatId: CHAT,
    provider: "claude" as const,
    providerSessionId: "11111111-2222-3333-4444-555555555555",
    model: "test-model-1",
    effort: "high",
    title: "Refactor the parser",
    transcript,
    queued: ["next"],
    ...overrides,
  };
  return {
    chat,
    manifest: buildManifest(
      { ...chat, turnRunning: false, approvalPending: false },
      { moveId: "m1", from: MAC, to: SELF, at: "2026-11-10T09:00:00.000Z", transcriptSha256: "" },
    ),
  };
}

describe("WP-177 host teleport store", () => {
  let dir: string;
  let store: HostTeleportStore;
  const transcript = '{"type":"user","text":"hello"}\n';

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wp177-host-"));
    store = new HostTeleportStore({ dir, selfId: SELF, providers: ["claude", "codex"] });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores an incoming copy that does not run, then opens it as the live copy owned by this host", async () => {
    const payload = payloadFor(transcript);
    const reply = await store.receive(CHAT, "m1", payload);
    expect(reply).toEqual({ ok: true, transcriptSha256: await sha256Hex(transcript) });
    expect((await store.read(CHAT))?.live ?? null).toBeNull();
    expect((await store.read(CHAT))?.owner).toBe(MAC);

    await store.activate(CHAT, "m1");
    const rec = await store.read(CHAT);
    expect(rec?.owner).toBe(SELF);
    expect(rec?.live).toMatchObject({ chatId: CHAT, model: "test-model-1", effort: "high", queued: ["next"], transcript });
  });

  it("activate is idempotent for the same move", async () => {
    await store.receive(CHAT, "m1", payloadFor(transcript));
    await store.activate(CHAT, "m1");
    await expect(store.activate(CHAT, "m1")).resolves.toBeUndefined();
    expect((await store.read(CHAT))?.owner).toBe(SELF);
  });

  it("refuses a second receive while the first move holds the chat", async () => {
    expect((await store.receive(CHAT, "m1", payloadFor(transcript))).ok).toBe(true);
    expect(await store.receive(CHAT, "m2", payloadFor(transcript))).toEqual({ ok: false, reason: "held" });
  });

  it("discard removes only the copy that move stored and lets the lease go", async () => {
    await store.receive(CHAT, "m1", payloadFor(transcript));
    await store.discard(CHAT, "someone-else");
    expect((await store.read(CHAT))?.owner).toBe(MAC);
    await store.discard(CHAT, "m1");
    expect((await store.read(CHAT))?.owner).toBe(MAC);
    expect((await store.receive(CHAT, "m2", payloadFor(transcript))).ok).toBe(true);
  });

  it("refuses a provider this host does not run, with the reason", async () => {
    const answer = await store.canResume("codex", "test-model-1", "high");
    expect(answer).toEqual({ ok: true });
    const none = await store.canResume("claude", "", "high");
    expect(none.ok).toBe(false);
    const other = new HostTeleportStore({ dir: path.join(dir, "other"), selfId: SELF, providers: ["codex"] });
    const refused = await other.canResume("claude", "test-model-1", "high");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/claude/);
  });

  it("as a source, releases the chat only when the move that froze it asks, and records the new owner", async () => {
    await store.receive(CHAT, "m1", payloadFor(transcript));
    await store.activate(CHAT, "m1");
    expect(await store.freeze(CHAT, "back")).toBe(true);
    expect(await store.freeze(CHAT, "other")).toBe(false);
    await store.release(CHAT, "other", MAC).catch(() => undefined);
    expect((await store.read(CHAT))?.live).not.toBeNull();
    await store.release(CHAT, "back", MAC);
    const rec = await store.read(CHAT);
    expect(rec?.live ?? null).toBeNull();
    expect(rec?.owner).toBe(MAC);
  });

  it("writes nothing that looks like a key or token, and only the allow-listed fields", async () => {
    const polluted = payloadFor(transcript) as MovePayload & { chat: Record<string, unknown> };
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
    expect(statSync(path.join(dir, "chats", files[0])).isFile()).toBe(true);
  });
});
