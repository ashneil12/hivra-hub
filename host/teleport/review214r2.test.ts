// PR #214 hard review, round 2: red repros for the host side of a chat move. Each case states the RIGHT outcome.
// A crash is played by a session-port step that throws at the point the process would die: everything the host stored
// before that point stays on disk, nothing after it happens. "Restart" builds a new engine and teleport store over the
// same folders, as the host does when it comes back.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MovePayload, TransferChat } from "../../src/features/connections/model/teleport";
import type { HostProvider } from "../providers";
import { HostEngine } from "../engine";
import { HostStore } from "../store";
import { HostTeleportStore, type HostChatSessions } from "./store";
import { hostChatSessions, MOVED_PROJECT_NAME } from "./sessions";

const CHAT = "review2-chat-1";
const MAC = "this-mac";
const HOST = "env-host";
const DEVICE = "dev-1";

function payload(moveId: string, extra: Array<Record<string, unknown>> = []): MovePayload {
  const transcript = JSON.stringify([
    { id: "u1", role: "user", text: "Remember the codeword teal." },
    { id: "a1", role: "assistant", text: "Noted." },
    ...extra,
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

function provider(): HostProvider {
  return {
    send: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    bind: vi.fn(),
    approve: vi.fn(),
    answer: vi.fn(),
  };
}

/** One host process: its session store, engine and teleport store. `wrap` lets a test break one session-port step. */
function hostProcess(dir: string, wrap: (real: HostChatSessions) => HostChatSessions = (real) => real) {
  const store = new HostStore(path.join(dir, "host.db"));
  if (!store.projects().some((p) => p.name === MOVED_PROJECT_NAME)) store.addProject(dir, MOVED_PROJECT_NAME);
  const p = provider();
  const engine = new HostEngine(store, { codex: p, claude: p });
  const teleport = new HostTeleportStore({
    dir: path.join(dir, "teleport"),
    selfId: HOST,
    providers: ["claude"],
    leaseRoot: path.join(dir, "leases"),
    sessions: wrap(hostChatSessions(store)),
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await engine.close();
    store.close();
  };
  cleanups.push(close);
  return { store, engine, teleport, close };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "review214r2-host-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sendTo = (engine: HostEngine, id: string) => () =>
  engine.command({ type: "send", commandId: `send-${id}`, sessionId: CHAT, text: "one more thing" });

describe("PR 214 review r2: custody on the host across a crash", () => {
  it("a host copy left open by a dead release does not swallow the Mac's later turns on the next move out", async () => {
    const dir = tempDir();
    let crash = false;
    const first = hostProcess(dir, (real) => ({
      ...real,
      hold: (chatId, held) => {
        if (crash) throw new Error("host process died here");
        real.hold?.(chatId, held);
      },
    }));
    expect((await first.teleport.receive(CHAT, "m1", payload("m1"), DEVICE)).ok).toBe(true);
    await first.teleport.activate(CHAT, "m1", DEVICE);
    expect(await first.teleport.freeze(CHAT, "m2", DEVICE, MAC)).toBe(true);
    crash = true;
    await expect(first.teleport.release(CHAT, "m2", MAC, DEVICE)).rejects.toThrow(/died/);
    await first.close();

    // The chat is back on the Mac and runs a turn there ("u2"), then moves out again (m3).
    const second = hostProcess(dir);
    const later = payload("m3", [
      { id: "u2", role: "user", text: "Mac-only turn after the move back" },
      { id: "a2", role: "assistant", text: "done on the Mac" },
    ]);
    expect((await second.teleport.receive(CHAT, "m3", later, DEVICE)).ok).toBe(true);
    await second.teleport.activate(CHAT, "m3", DEVICE);
    // The host copy is the live one now (the Mac releases its transcript next). It must carry the Mac's turn and take turns.
    // Today open() sees a non-archived session and keeps the stale one (still held by the m2 freeze), so the live copy
    // and every later move back lose u2, and the host refuses every turn on the chat.
    const live = await second.teleport.read(CHAT, DEVICE);
    expect(live?.live?.transcript).toContain("Mac-only turn after the move back");
    expect(second.store.session(CHAT).session.blocks.some((b) => b.id === "u2")).toBe(true);
    expect(sendTo(second.engine, "after-m3")).not.toThrow();
  });

  it("an activation that dies after the session opened leaves no runnable host copy once the move is aborted", async () => {
    const dir = tempDir();
    // The session is opened (saved to the host's session store), then the process dies before the teleport record says
    // "live". The record still says "incoming".
    const first = hostProcess(dir, (real) => ({
      ...real,
      open: (chat, moveId) => {
        real.open(chat, moveId);
        throw new Error("host process died here");
      },
    }));
    expect((await first.teleport.receive(CHAT, "m1", payload("m1"), DEVICE)).ok).toBe(true);
    await expect(first.teleport.activate(CHAT, "m1", DEVICE)).rejects.toThrow(/died/);
    await first.close();

    // The Mac's recovery asks the host: holds says "incoming", abort says "aborted", so the Mac thaws and runs the chat.
    const second = hostProcess(dir);
    expect(await second.teleport.holds(CHAT, "m1", DEVICE)).toBe("incoming");
    expect(await second.teleport.abort(CHAT, "m1", DEVICE)).toBe("aborted");
    // The chat is live on the Mac now. The host must not hold a second runnable copy of it.
    // Today the session row opened in run 1 stays unarchived and unheld, and takes the turn.
    expect(sendTo(second.engine, "after-abort")).toThrow();
  });
});

