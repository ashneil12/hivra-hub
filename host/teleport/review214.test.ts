// PR #214 hard review, round 1: red repros for the host side of a chat move. Each case states the RIGHT outcome.
// The host's teleport store froze or released a chat, but the host's own engine (the one every paired device and the
// desktop's remote session view send through) never asks it, so the freeze and the release do not stop host turns.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendTurnInput } from "../../src/integrations/harness/core/types";
import type { MovePayload, TransferChat } from "../../src/features/connections/model/teleport";
import type { HostProvider } from "../providers";
import { HostEngine } from "../engine";
import { HostStore } from "../store";
import { HostTeleportStore } from "./store";
import { hostChatSessions, MOVED_PROJECT_NAME } from "./sessions";

const CHAT = "review-chat-1";
const MAC = "this-mac";
const HOST = "env-host";
const DEVICE = "dev-1";

function payload(moveId: string): MovePayload {
  const transcript = JSON.stringify([
    { id: "u1", role: "user", text: "Remember the codeword teal." },
    { id: "a1", role: "assistant", text: "Noted." },
  ]);
  const chat: TransferChat = {
    chatId: CHAT,
    provider: "claude",
    providerSessionId: "",
    model: "claude:test",
    effort: "high",
    title: "Moved chat",
    transcript,
    queued: [],
  };
  return {
    manifest: {
      format: "hivra-teleport-v1",
      moveId,
      chatId: CHAT,
      provider: "claude",
      providerSessionId: "",
      model: "claude:test",
      effort: "high",
      title: "Moved chat",
      queuedCount: 0,
      transcriptBytes: transcript.length,
      transcriptSha256: "",
      from: MAC,
      to: HOST,
      at: "2026-11-11T09:00:00.000Z",
    },
    chat,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "review214-host-"));
  const store = new HostStore(path.join(dir, "host.db"));
  store.addProject(dir, MOVED_PROJECT_NAME);
  const turns: Array<{ input: SendTurnInput; finish: () => void }> = [];
  const provider: HostProvider = {
    send: vi.fn((input) => new Promise<void>((resolve) => turns.push({ input, finish: resolve }))),
    cancel: vi.fn(async () => turns.at(-1)?.finish()),
    stop: vi.fn(async () => turns.at(-1)?.finish()),
    bind: vi.fn(),
    approve: vi.fn(),
    answer: vi.fn(),
  };
  const engine = new HostEngine(store, { codex: provider, claude: provider });
  const teleport = new HostTeleportStore({
    dir: path.join(dir, "teleport"),
    selfId: HOST,
    providers: ["claude"],
    leaseRoot: path.join(dir, "leases"),
    sessions: hostChatSessions(store),
  });
  cleanups.push(async () => {
    await engine.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, engine, teleport, provider, turns };
}

async function moveIn(teleport: HostTeleportStore, moveId: string) {
  expect((await teleport.receive(CHAT, moveId, payload(moveId), DEVICE)).ok).toBe(true);
  await teleport.activate(CHAT, moveId, DEVICE);
}

describe("PR 214 review: the host keeps one live copy", () => {
  it("a host copy frozen for a move back takes no new turn (a turn after the Mac's read is lost)", async () => {
    const { engine, teleport } = setup();
    await moveIn(teleport, "m1");
    // The Mac starts the move back: the host copy is frozen for it.
    expect(await teleport.freeze(CHAT, "m2", DEVICE, MAC)).toBe(true);
    // A phone, another window's remote view, or a queued message sends to the host copy now.
    expect(() => engine.command({ type: "send", commandId: "late-1", sessionId: CHAT, text: "one more thing" })).toThrow();
  });

  it("a host copy released back to the Mac takes no new turn (two live copies otherwise)", async () => {
    const { engine, teleport } = setup();
    await moveIn(teleport, "m1");
    expect(await teleport.freeze(CHAT, "m2", DEVICE, MAC)).toBe(true);
    await teleport.release(CHAT, "m2", MAC, DEVICE);
    expect(() => engine.command({ type: "send", commandId: "after-1", sessionId: CHAT, text: "still here?" })).toThrow();
  });

  it("a move back read while a host turn runs reports the turn as running, so the move refuses it", async () => {
    const { engine, teleport, turns } = setup();
    await moveIn(teleport, "m1");
    engine.command({ type: "send", commandId: "t1", sessionId: CHAT, text: "long job" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const record = await teleport.read(CHAT, DEVICE);
    // Today the host always answers turnRunning: false, so the Mac moves the chat and the reply lands in an archived copy.
    expect(record?.live?.turnRunning).toBe(true);
    turns[0].finish();
  });

  it("a release stops the host's provider for the chat, so a later move out does not reuse its warm conversation", async () => {
    const { engine, teleport, turns, provider } = setup();
    await moveIn(teleport, "m1");
    engine.command({ type: "send", commandId: "t1", sessionId: CHAT, text: "hello" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0].input.onEvent({ type: "session.providerBound", providerSessionId: "prov-host-1" });
    turns[0].finish();
    await vi.waitFor(() => expect(teleport.read(CHAT, DEVICE).then((r) => r?.live?.providerSessionId)).resolves.toBe("prov-host-1"));
    vi.mocked(provider.stop).mockClear();
    expect(await teleport.freeze(CHAT, "m2", DEVICE, MAC)).toBe(true);
    await teleport.release(CHAT, "m2", MAC, DEVICE);
    expect(provider.stop).toHaveBeenCalledWith(CHAT);
  });
});
