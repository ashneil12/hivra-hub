import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The real host lease (WP-60): the reconnect race is proved against the same code the host runs.
import { acquireSessionLease, type SessionLease } from "../../../../host/firstmate/lease";
import {
  assertManifestClean,
  buildManifest,
  freezeRefusal,
  moveChat,
  completeMove,
  planMove,
  sha256Hex,
  type ChatSnapshot,
  type LeasePort,
  type MoveEndpoint,
  type MovePayload,
  type ChatRecord,
} from "./teleport";

const THIS_MAC = "this-mac";
const HOST = "host-a";
const CHAT = "chat-1";
const AT = "2026-11-10T09:00:00.000Z";

function chat(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    chatId: CHAT,
    provider: "claude",
    providerSessionId: "11111111-2222-3333-4444-555555555555",
    model: "test-model-1",
    effort: "high",
    title: "Refactor the parser",
    transcript: '{"type":"user","text":"hello"}\n{"type":"assistant","text":"hi"}\n',
    queued: ["ship it after the tests"],
    turnRunning: false,
    approvalPending: false,
    ...overrides,
  };
}

/** Exclusive in-memory lease, the test stand-in for the host lease when the race is not the point. */
function memoryLeases(): LeasePort {
  const held = new Map<string, string>();
  return {
    acquire(chatId, holder) {
      if (held.has(chatId)) return false;
      held.set(chatId, holder);
      return true;
    },
    release(chatId, holder) {
      if (held.get(chatId) === holder) held.delete(chatId);
    },
  };
}

/** The host's lease through the real WP-60 session lease file. A second acquire in the process is refused. */
function hostLeases(root: string): LeasePort {
  const leases = new Map<string, SessionLease>();
  return {
    acquire(chatId) {
      const lease = acquireSessionLease(chatId, root);
      if (!lease) return false;
      leases.set(chatId, lease);
      return true;
    },
    release(chatId) {
      leases.get(chatId)?.release();
      leases.delete(chatId);
    },
  };
}

/**
 * An in-memory machine. It keeps what a real endpoint keeps: one live copy, an incoming copy that does not run,
 * a freeze that stops turns, and the owner. Failure switches let a test break one step.
 */
class StubMachine implements MoveEndpoint {
  readonly records = new Map<string, { owner: string; live: ChatSnapshot | null }>();
  readonly payloads: MovePayload[] = [];
  private frozen = new Map<string, string>();
  private incoming = new Map<string, { moveId: string; payload: MovePayload }>();
  canResumeReply: { ok: true } | { ok: false; reason: string } = { ok: true };
  fail: Partial<Record<"receive" | "release" | "activate", string>> = {};
  onReceive: (() => void) | null = null;

  constructor(
    readonly id: string,
    private readonly leases: LeasePort = memoryLeases(),
  ) {}

  seed(snapshot: ChatSnapshot): void {
    this.records.set(snapshot.chatId, { owner: this.id, live: snapshot });
  }

  /** A turn may start only when the chat is live here and not frozen by a move. */
  startTurn(chatId: string): boolean {
    const rec = this.records.get(chatId);
    if (!rec?.live || this.frozen.has(chatId)) return false;
    rec.live = { ...rec.live, turnRunning: true };
    return true;
  }

  async read(chatId: string): Promise<ChatRecord | null> {
    const rec = this.records.get(chatId);
    if (!rec) return null;
    return { owner: rec.owner, live: rec.live ? { ...rec.live, queued: [...rec.live.queued] } : null };
  }

  async freeze(chatId: string, moveId: string): Promise<boolean> {
    if (this.frozen.has(chatId)) return false;
    this.frozen.set(chatId, moveId);
    return true;
  }

  async thaw(chatId: string, moveId: string): Promise<void> {
    if (this.frozen.get(chatId) === moveId) this.frozen.delete(chatId);
  }

  async canResume(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.canResumeReply;
  }

  async receive(chatId: string, moveId: string, payload: MovePayload) {
    this.onReceive?.();
    if (this.fail.receive) throw new Error(this.fail.receive);
    if (!this.leases.acquire(chatId, moveId)) return { ok: false as const, reason: "held" as const };
    this.payloads.push(payload);
    const sha = await sha256Hex(payload.chat.transcript);
    this.incoming.set(chatId, { moveId, payload });
    this.records.set(chatId, { owner: payload.manifest.from, live: null });
    return { ok: true as const, transcriptSha256: sha };
  }

  async discard(chatId: string, moveId: string): Promise<void> {
    const inc = this.incoming.get(chatId);
    if (inc?.moveId !== moveId) return;
    this.incoming.delete(chatId);
    this.leases.release(chatId, moveId);
    this.records.set(chatId, { owner: this.records.get(chatId)?.owner ?? "", live: null });
  }

  async activate(chatId: string, moveId: string): Promise<void> {
    if (this.fail.activate) throw new Error(this.fail.activate);
    const inc = this.incoming.get(chatId);
    if (inc?.moveId !== moveId) return; // idempotent: already live, or nothing to do
    this.incoming.delete(chatId);
    const p = inc.payload.chat;
    this.records.set(chatId, {
      owner: this.id,
      live: { ...p, queued: [...p.queued], turnRunning: false, approvalPending: false },
    });
    this.leases.release(chatId, moveId);
  }

  async release(chatId: string, moveId: string, to: string): Promise<void> {
    if (this.fail.release) throw new Error(this.fail.release);
    if (this.frozen.get(chatId) !== moveId) throw new Error("not frozen by this move");
    this.records.set(chatId, { owner: to, live: null });
    this.frozen.delete(chatId);
  }

  isFrozen(chatId: string): boolean {
    return this.frozen.has(chatId);
  }
}

describe("WP-177 freeze rules", () => {
  it("refuses while a turn is running, with the reason and the offer to move after it", () => {
    const refusal = freezeRefusal(chat({ turnRunning: true }));
    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toBe("turn-running");
    expect(refusal?.offer).toBe("finish-then-move");
    expect(refusal?.message).not.toMatch(/[–—]/);
  });

  it("refuses while a tool approval is pending", () => {
    expect(freezeRefusal(chat({ approvalPending: true }))?.reason).toBe("approval-pending");
  });

  it("lets a settled chat move, queued messages included", () => {
    expect(freezeRefusal(chat())).toBeNull();
  });

  it("does not move a running chat: the plan is refused and the source is untouched", async () => {
    const mac = new StubMachine(THIS_MAC);
    mac.seed(chat({ turnRunning: true }));
    const planned = await planMove(chat({ turnRunning: true }), THIS_MAC, HOST);
    expect(planned.ok).toBe(false);
    const rec = await mac.read(CHAT);
    expect(rec?.live?.turnRunning).toBe(true);
    expect(mac.isFrozen(CHAT)).toBe(false);
  });

  it("moves once the turn settles", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat({ turnRunning: true }));
    expect((await planMove(chat({ turnRunning: true }), THIS_MAC, HOST)).ok).toBe(false);
    mac.seed(chat({ turnRunning: false }));
    const planned = await planMove(chat(), THIS_MAC, HOST);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: planned.plan.planId }, moveId: "m1", at: AT });
    expect(result.status).toBe("moved");
  });
});

describe("WP-177 person approval", () => {
  it("never freezes or sends without an approved plan", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: null, moveId: "m1", at: AT });
    expect(result.status).toBe("refused");
    expect(mac.isFrozen(CHAT)).toBe(false);
    expect(host.payloads).toHaveLength(0);
    expect((await mac.read(CHAT))?.live).not.toBeNull();
  });

  it("refuses when the transcript changed after the person approved the plan", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const planned = await planMove(chat(), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan should be possible");
    mac.seed(chat({ transcript: chat().transcript + '{"type":"user","text":"one more"}\n' }));
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: planned.plan.planId }, moveId: "m1", at: AT });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.refusal.reason).toBe("approval-stale");
    expect(mac.isFrozen(CHAT)).toBe(false);
    expect(host.payloads).toHaveLength(0);
  });
});

describe("WP-177 custody handover", () => {
  it("moves Mac to host and back, keeping id, model, effort, transcript and queued messages", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    const start = chat();
    mac.seed(start);
    const sha = await sha256Hex(start.transcript);

    const out = await planMove(start, THIS_MAC, HOST);
    if (!out.ok) throw new Error("plan should be possible");
    const there = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: out.plan.planId }, moveId: "m-out", at: AT });
    expect(there.status).toBe("moved");

    const onHost = (await host.read(CHAT))?.live;
    expect(onHost).toMatchObject({ chatId: CHAT, providerSessionId: start.providerSessionId, model: start.model, effort: start.effort, queued: start.queued });
    expect(await sha256Hex(onHost!.transcript)).toBe(sha);
    expect((await mac.read(CHAT))?.live).toBeNull();
    expect((await mac.read(CHAT))?.owner).toBe(HOST);

    const back = await planMove(onHost!, HOST, THIS_MAC);
    if (!back.ok) throw new Error("plan back should be possible");
    const again = await moveChat({ chatId: CHAT, from: host, to: mac, approval: { planId: back.plan.planId }, moveId: "m-back", at: AT });
    expect(again.status).toBe("moved");

    const home = (await mac.read(CHAT))?.live;
    expect(home).toMatchObject({ chatId: CHAT, model: start.model, effort: start.effort, title: start.title });
    expect(await sha256Hex(home!.transcript)).toBe(sha);
    expect((await host.read(CHAT))?.live).toBeNull();
    expect((await host.read(CHAT))?.owner).toBe(THIS_MAC);
  });

  it("keeps the chat on the Mac and unfrozen when the target fails to receive", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    host.fail.receive = "disk full";
    const planned = await planMove(chat(), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: planned.plan.planId }, moveId: "m1", at: AT });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.stage).toBe("receive");
      expect(result.chatStayedOn).toBe(THIS_MAC);
    }
    expect((await mac.read(CHAT))?.live).not.toBeNull();
    expect(mac.isFrozen(CHAT)).toBe(false);
    expect((await host.read(CHAT))?.live ?? null).toBeNull();
  });

  it("refuses to move when the target's copy does not match the transcript", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const realReceive = host.receive.bind(host);
    host.receive = async (chatId, moveId, payload) => {
      const ok = await realReceive(chatId, moveId, payload);
      return ok.ok ? { ok: true, transcriptSha256: "0".repeat(64) } : ok;
    };
    const planned = await planMove(chat(), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: planned.plan.planId }, moveId: "m1", at: AT });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.stage).toBe("verify");
    expect((await mac.read(CHAT))?.live).not.toBeNull();
    expect((await host.read(CHAT))?.live).toBeNull();
  });

  it("keeps the chat on the Mac when the source cannot let go, and drops the target's copy", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    mac.fail.release = "permission denied";
    const planned = await planMove(chat(), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: planned.plan.planId }, moveId: "m1", at: AT });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.stage).toBe("release");
    expect((await mac.read(CHAT))?.live).not.toBeNull();
    expect(mac.isFrozen(CHAT)).toBe(false);
    expect((await host.read(CHAT))?.live).toBeNull();
  });

  it("never runs on both sides: a turn cannot start on the Mac while the host is receiving", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    let startedDuringReceive: boolean | null = null;
    host.onReceive = () => {
      startedDuringReceive = mac.startTurn(CHAT);
    };
    const planned = await planMove(chat(), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: planned.plan.planId }, moveId: "m1", at: AT });
    expect(result.status).toBe("moved");
    expect(startedDuringReceive).toBe(false);
  });

  it("reports a partial move, not a silent success, when the host cannot open the chat after the handover", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    host.fail.activate = "host restarting";
    const planned = await planMove(chat(), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: planned.plan.planId }, moveId: "m1", at: AT });
    expect(result.status).toBe("partial");
    expect((await host.read(CHAT))?.live).toBeNull();
    expect((await mac.read(CHAT))?.live).toBeNull();

    host.fail.activate = undefined;
    const done = await completeMove({ chatId: CHAT, to: host, moveId: "m1" });
    expect(done.status).toBe("moved");
    expect((await host.read(CHAT))?.live).not.toBeNull();
    expect((await host.read(CHAT))?.owner).toBe(HOST);
  });
});

describe("WP-177 model, effort and resume", () => {
  it("refuses a target whose CLI cannot resume the transcript, and offers the recap path", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    host.canResumeReply = { ok: false, reason: "this CLI version cannot read the transcript" };
    mac.seed(chat());
    const planned = await planMove(chat(), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: planned.plan.planId }, moveId: "m1", at: AT });
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.refusal.reason).toBe("cannot-resume");
      expect(result.refusal.recapOffered).toBe(true);
      expect(result.refusal.message).toContain("this CLI version cannot read the transcript");
    }
    expect(mac.isFrozen(CHAT)).toBe(false);
    expect((await mac.read(CHAT))?.live?.model).toBe("test-model-1");
  });
});

describe("WP-177 reconnect race", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "wp177-lease-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("starts the chat on the host once when the desktop and the host both ask to move it", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST, hostLeases(root));
    mac.seed(chat());
    const planned = await planMove(chat(), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const approval = { planId: planned.plan.planId };
    const [a, b] = await Promise.all([
      moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "desktop", at: AT }),
      moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "host", at: AT }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["moved", "refused"]);
    const loser = a.status === "moved" ? b : a;
    expect(loser.status).toBe("refused");
    expect(host.payloads).toHaveLength(1);
    expect((await host.read(CHAT))?.live).not.toBeNull();
    expect((await mac.read(CHAT))?.live).toBeNull();
  });

  it("the host lease refuses a second receive for the same chat until the first one lets go", async () => {
    const leases = hostLeases(root);
    expect(leases.acquire(CHAT, "first")).toBe(true);
    expect(leases.acquire(CHAT, "second")).toBe(false);
    leases.release(CHAT, "first");
    expect(leases.acquire(CHAT, "second")).toBe(true);
    leases.release(CHAT, "second");
  });
});

describe("WP-177 no credentials in a move", () => {
  const SENTINEL_KEY = "sk-ant-api03-SENTINELSECRETVALUE123456";
  const SENTINEL_TOKEN = "oauth-refresh-SENTINEL-987654";

  it("builds the manifest from an allow list, so an extra secret field never reaches it", () => {
    const polluted = { ...chat(), apiKey: SENTINEL_KEY, oauthToken: SENTINEL_TOKEN } as ChatSnapshot;
    const manifest = buildManifest(polluted, { moveId: "m1", from: THIS_MAC, to: HOST, at: AT, transcriptSha256: "a".repeat(64) });
    const text = JSON.stringify(manifest);
    expect(text).not.toContain(SENTINEL_KEY);
    expect(text).not.toContain(SENTINEL_TOKEN);
    expect(Object.keys(manifest).sort()).toEqual(
      ["at", "chatId", "effort", "format", "from", "model", "moveId", "provider", "providerSessionId", "queuedCount", "title", "to", "transcriptBytes", "transcriptSha256"].sort(),
    );
  });

  it("the payload a host receives carries no key or token from the Mac", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed({ ...chat(), apiKey: SENTINEL_KEY, oauthToken: SENTINEL_TOKEN } as ChatSnapshot);
    const planned = await planMove(chat(), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval: { planId: planned.plan.planId }, moveId: "m1", at: AT });
    expect(result.status).toBe("moved");
    const sent = JSON.stringify(host.payloads);
    expect(sent).not.toContain(SENTINEL_KEY);
    expect(sent).not.toContain(SENTINEL_TOKEN);
  });

  it("refuses a manifest with a key-like field name or a token-shaped value", () => {
    const manifest = buildManifest(chat(), { moveId: "m1", from: THIS_MAC, to: HOST, at: AT, transcriptSha256: "a".repeat(64) });
    expect(() => assertManifestClean(manifest)).not.toThrow();
    expect(() => assertManifestClean({ ...manifest, title: SENTINEL_KEY })).toThrow(/secret/i);
    expect(() => assertManifestClean({ ...manifest, title: "Bearer abcdefghijklmnop" })).toThrow(/secret/i);
    expect(() => assertManifestClean({ ...manifest, title: "-----BEGIN PRIVATE KEY-----" })).toThrow(/secret/i);
    expect(() => assertManifestClean({ ...manifest, title: "see .credentials.json" })).toThrow(/secret/i);
    expect(() => assertManifestClean({ ...manifest, extra: "x" } as typeof manifest & { extra: string })).toThrow(/field/i);
  });
});
