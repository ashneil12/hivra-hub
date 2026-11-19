// WP-177 host side, against the host's own session store (a real SQLite file under a temporary folder): a copy the host
// activates is a real host session the desktop can open (H4), a released copy is archived, a refused move id stays refused
// (M1), and a failed session write leaves nothing live.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MovePayload, TransferChat } from "../../src/features/connections/model/teleport";
import { HostStore } from "../store";
import { HostTeleportStore, type HostChatSessions } from "./store";
import { hostChatSessions, MOVED_PROJECT_NAME } from "./sessions";

const CHAT = "host-chat-1";
const MAC = "this-mac";
const HOST = "env-host";

function payload(moveId: string): MovePayload {
  const transcript = JSON.stringify([
    { id: "u1", role: "user", text: "keep this" },
    { id: "a1", role: "assistant", text: "kept" },
  ]);
  const chat: TransferChat = {
    chatId: CHAT,
    provider: "claude",
    providerSessionId: "",
    model: "test-model-1",
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
      model: "test-model-1",
      effort: "high",
      title: "Moved chat",
      queuedCount: 0,
      transcriptBytes: transcript.length,
      transcriptSha256: "",
      from: MAC,
      to: HOST,
      at: "2026-11-10T09:00:00.000Z",
    },
    chat,
  };
}

describe("WP-177 host copy (H4) and refused move ids (M1)", () => {
  let dir: string;
  let store: HostStore;
  let teleport: HostTeleportStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wp177-host-"));
    store = new HostStore(path.join(dir, "host.db"));
    teleport = new HostTeleportStore({
      dir: path.join(dir, "teleport"),
      selfId: HOST,
      providers: ["claude"],
      leaseRoot: path.join(dir, "leases"),
      sessions: hostChatSessions(store),
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("activating a copy makes a real host session the desktop can open, in the moved project", async () => {
    await teleport.receive(CHAT, "m1", payload("m1"), "dev-1");
    await teleport.activate(CHAT, "m1", "dev-1");
    const session = store.session(CHAT);
    expect(session.session.title).toBe("Moved chat");
    expect(session.session.blocks).toHaveLength(2);
    expect(session.archived).toBe(false);
    expect(store.projects().some((project) => project.name === MOVED_PROJECT_NAME)).toBe(true);
    expect(session.projectId).toBe(store.projects().find((project) => project.name === MOVED_PROJECT_NAME)!.id);
    expect(await teleport.holds(CHAT, "m1", "dev-1")).toBe("live");
  });

  it("releasing the chat back to the Mac archives the host copy, so it is not run twice", async () => {
    await teleport.receive(CHAT, "m1", payload("m1"), "dev-1");
    await teleport.activate(CHAT, "m1", "dev-1");
    await teleport.freeze(CHAT, "m2", "dev-1", MAC);
    await teleport.release(CHAT, "m2", MAC, "dev-1");
    expect(store.session(CHAT).archived).toBe(true);
    expect((await teleport.read(CHAT, "dev-1"))?.owner).toBe(MAC);
  });

  it("a move id the host refused is turned away for good, even when its copy arrives later", async () => {
    await teleport.receive(CHAT, "m1", payload("m1"), "dev-1");
    expect(await teleport.abort(CHAT, "m1", "dev-1")).toBe("aborted");
    await expect(teleport.receive(CHAT, "m1", payload("m1"), "dev-1")).rejects.toThrow(/refused here/);
    await expect(teleport.activate(CHAT, "m1", "dev-1")).rejects.toThrow();
    // A new move with a new id is accepted.
    await expect(teleport.receive(CHAT, "m2", payload("m2"), "dev-1")).resolves.toMatchObject({ ok: true });
  });

  it("abort answers live for a copy the host already opened, and nothing is thawed on that answer", async () => {
    await teleport.receive(CHAT, "m1", payload("m1"), "dev-1");
    await teleport.activate(CHAT, "m1", "dev-1");
    expect(await teleport.abort(CHAT, "m1", "dev-1")).toBe("live");
    expect(await teleport.holds(CHAT, "m1", "dev-1")).toBe("live");
  });

  it("when the host cannot open the session, activation fails and the copy stays incoming, never live", async () => {
    const failing: HostChatSessions = {
      open: () => {
        throw new Error("session store is full");
      },
      close: () => undefined,
    };
    const broken = new HostTeleportStore({
      dir: path.join(dir, "teleport-broken"),
      selfId: HOST,
      providers: ["claude"],
      leaseRoot: path.join(dir, "leases-broken"),
      sessions: failing,
    });
    await broken.receive(CHAT, "m1", payload("m1"), "dev-1");
    await expect(broken.activate(CHAT, "m1", "dev-1")).rejects.toThrow(/session store is full/);
    expect(await broken.holds(CHAT, "m1", "dev-1")).toBe("incoming");
    expect((await broken.read(CHAT, "dev-1"))?.live).toBeNull();
  });
});
