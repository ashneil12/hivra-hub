import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The real host lease (WP-60): the reconnect race is proved against the same code the host runs.
import { acquireSessionLease, type SessionLease } from "../../../../host/firstmate/lease";
import {
  approvePlan,
  assertManifestClean,
  buildManifest,
  freezeRefusal,
  moveChat,
  planMove,
  recoverMove,
  completeMove,
  sha256Hex,
  type ChatRecord,
  type ChatSnapshot,
  type Holds,
  type LeasePort,
  type MoveEndpoint,
  type MovePayload,
  type MovePlan,
} from "./teleport";

const THIS_MAC = "this-mac";
const HOST = "host-a";
const CHAT = "chat-1";
const AT = "2026-11-10T09:00:00.000Z";
// Node has no MouseEvent: a stand-in class, so the trusted-click check runs as it does in the browser.
class TestMouseEvent {
  readonly type: string;
  isTrusted = false;
  constructor(type: string) {
    this.type = type;
  }
}
(globalThis as unknown as { MouseEvent: unknown }).MouseEvent = TestMouseEvent;
const CLICK = Object.assign(new TestMouseEvent("click"), { isTrusted: true }) as never;

function chat(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    chatId: CHAT,
    provider: "claude",
    providerSessionId: "11111111-2222-3333-4444-555555555555",
    model: "test-model-1",
    effort: "high",
    title: "Refactor the parser",
    transcript: '[{"id":"b1","role":"user","text":"hello"},{"id":"b2","role":"assistant","text":"hi"}]',
    queued: ["ship it after the tests"],
    turnRunning: false,
    approvalPending: false,
    ...overrides,
  };
}

async function approve(from: string, to: string, snapshot: ChatSnapshot = chat()) {
  const planned = await planMove(snapshot, from, to);
  if (!planned.ok) throw new Error(`plan refused: ${planned.refusal.reason}`);
  return { plan: planned.plan, approval: approvePlan(planned.plan, CLICK) };
}

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
 * An in-memory machine with the same rules as the real endpoints: a copy is incoming until activated, activation
 * throws when there is no copy, the owner changes only on activation (for the target) and release (for the source),
 * and a freeze stops turns. Failure switches break one step.
 */
class StubMachine implements MoveEndpoint {
  readonly records = new Map<string, { owner: string; live: ChatSnapshot | null }>();
  readonly payloads: MovePayload[] = [];
  private frozen = new Map<string, string>();
  private incoming = new Map<string, { moveId: string; payload: MovePayload }>();
  private activatedBy = new Map<string, string>();
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
    if (payload.chat.chatId !== chatId) throw new Error("The move names a different chat");
    if (!this.leases.acquire(chatId, moveId)) return { ok: false as const, reason: "held" as const };
    this.payloads.push(payload);
    const sha = await sha256Hex(payload.chat.transcript);
    this.incoming.set(chatId, { moveId, payload });
    return { ok: true as const, transcriptSha256: sha };
  }

  async discard(chatId: string, moveId: string): Promise<void> {
    if (this.incoming.get(chatId)?.moveId !== moveId) return;
    this.incoming.delete(chatId);
    this.leases.release(chatId, moveId);
  }

  async activate(chatId: string, moveId: string): Promise<void> {
    if (this.fail.activate) throw new Error(this.fail.activate);
    if (this.activatedBy.get(chatId) === moveId) return;
    const inc = this.incoming.get(chatId);
    if (inc?.moveId !== moveId) throw new Error("No copy of this chat is stored here to activate");
    this.incoming.delete(chatId);
    const p = inc.payload.chat;
    this.records.set(chatId, {
      owner: this.id,
      live: { ...p, queued: [...p.queued], turnRunning: false, approvalPending: false },
    });
    this.activatedBy.set(chatId, moveId);
    this.leases.release(chatId, moveId);
  }

  async release(chatId: string, moveId: string, to: string): Promise<void> {
    if (this.fail.release) throw new Error(this.fail.release);
    if (this.frozen.get(chatId) !== moveId) throw new Error("not frozen by this move");
    this.records.set(chatId, { owner: to, live: null });
    this.frozen.delete(chatId);
    this.activatedBy.delete(chatId);
  }

  async holds(chatId: string, moveId: string): Promise<Holds> {
    if (this.activatedBy.get(chatId) === moveId) return "live";
    if (this.incoming.get(chatId)?.moveId === moveId) return "incoming";
    return "none";
  }

  isFrozen(chatId: string): boolean {
    return this.frozen.has(chatId);
  }
}

describe("WP-177 freeze rules", () => {
  it("refuses while a turn is running, with the reason and the offer to move after it", () => {
    const refusal = freezeRefusal(chat({ turnRunning: true }));
    expect(refusal?.reason).toBe("turn-running");
    expect(refusal?.offer).toBe("finish-then-move");
    expect(refusal?.message).not.toMatch(/[\u2013\u2014]/);
  });

  it("refuses while a tool approval is pending", () => {
    expect(freezeRefusal(chat({ approvalPending: true }))?.reason).toBe("approval-pending");
  });

  it("does not move a running chat: the plan is refused and the source is untouched", async () => {
    const mac = new StubMachine(THIS_MAC);
    mac.seed(chat({ turnRunning: true }));
    expect((await planMove(chat({ turnRunning: true }), THIS_MAC, HOST)).ok).toBe(false);
    expect(mac.isFrozen(CHAT)).toBe(false);
  });

  it("moves once the turn settles", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const { approval } = await approve(THIS_MAC, HOST);
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT });
    expect(result.status).toBe("moved");
  });
});

describe("WP-177 person approval", () => {
  it("never freezes or sends without an approval the person's click created", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const { plan } = await approve(THIS_MAC, HOST);
    const literal = { planId: plan.planId } as never; // a plan id alone is not an approval
    for (const approval of [null, undefined, literal]) {
      const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT });
      expect(result.status).toBe("refused");
      if (result.status === "refused") expect(result.refusal.reason).toBe("approval-missing");
    }
    expect(mac.isFrozen(CHAT)).toBe(false);
    expect(host.payloads).toHaveLength(0);
  });

  it("only a trusted click creates an approval", async () => {
    const { plan } = await approve(THIS_MAC, HOST);
    expect(() => approvePlan(plan, { isTrusted: false, type: "click" })).toThrow(/person's click/);
    expect(() => approvePlan(plan, { isTrusted: true, type: "keydown" })).toThrow(/person's click/);
    expect(approvePlan(plan, CLICK).planId).toBe(plan.planId);
  });

  it("refuses when the transcript changed after the person approved the plan", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const { approval } = await approve(THIS_MAC, HOST);
    mac.seed(chat({ transcript: '[{"id":"b9","role":"user","text":"one more"}]' }));
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.refusal.reason).toBe("approval-stale");
    expect(mac.isFrozen(CHAT)).toBe(false);
    expect(host.payloads).toHaveLength(0);
  });

  it("the plan shows the queued messages that will travel", async () => {
    const planned = await planMove(chat({ queued: ["ship it after the tests"] }), THIS_MAC, HOST);
    if (!planned.ok) throw new Error("plan");
    expect(planned.plan.queued).toEqual(["ship it after the tests"]);
  });
});

describe("WP-177 custody handover", () => {
  it("moves Mac to host and back, keeping id, model, effort, transcript and queued messages", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    const start = chat();
    mac.seed(start);
    const sha = await sha256Hex(start.transcript);

    const out = await approve(THIS_MAC, HOST);
    expect((await moveChat({ chatId: CHAT, from: mac, to: host, approval: out.approval, moveId: "m-out", at: AT })).status).toBe("moved");

    const onHost = (await host.read(CHAT))?.live;
    expect(onHost).toMatchObject({ chatId: CHAT, providerSessionId: start.providerSessionId, model: start.model, effort: start.effort, queued: start.queued });
    expect(await sha256Hex(onHost!.transcript)).toBe(sha);
    expect((await mac.read(CHAT))?.live).toBeNull();
    expect((await mac.read(CHAT))?.owner).toBe(HOST);

    const back = await approve(HOST, THIS_MAC, onHost!);
    expect((await moveChat({ chatId: CHAT, from: host, to: mac, approval: back.approval, moveId: "m-back", at: AT })).status).toBe("moved");
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
    const { approval } = await approve(THIS_MAC, HOST);
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT });
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
    const { approval } = await approve(THIS_MAC, HOST);
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.stage).toBe("verify");
    expect((await mac.read(CHAT))?.live).not.toBeNull();
    expect((await host.read(CHAT))?.live ?? null).toBeNull();
  });

  it("the source keeps its transcript when the target cannot activate, and the copy is discarded", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    host.fail.activate = "host restarting";
    const { approval } = await approve(THIS_MAC, HOST);
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.stage).toBe("activate");
    expect((await mac.read(CHAT))?.live).not.toBeNull();
    expect(mac.isFrozen(CHAT)).toBe(false);
    expect((await host.read(CHAT))?.live ?? null).toBeNull();
  });

  it("a source that cannot let go leaves the target with the chat and the source frozen: partial, then completed", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    mac.fail.release = "permission denied";
    const { approval } = await approve(THIS_MAC, HOST);
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT });
    expect(result.status).toBe("partial");
    expect((await host.read(CHAT))?.live).not.toBeNull();
    expect(mac.isFrozen(CHAT)).toBe(true);

    mac.fail.release = undefined;
    const done = await completeMove({ chatId: CHAT, from: mac, to: host, moveId: "m1" });
    expect(done.status).toBe("moved");
    expect((await mac.read(CHAT))?.live ?? null).toBeNull();
    expect((await host.read(CHAT))?.owner).toBe(HOST);
  });

  it("never runs on both sides: a turn cannot start on the Mac while the host is receiving", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    let startedDuringReceive: boolean | null = null;
    host.onReceive = () => {
      startedDuringReceive = mac.startTurn(CHAT);
    };
    const { approval } = await approve(THIS_MAC, HOST);
    expect((await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT })).status).toBe("moved");
    expect(startedDuringReceive).toBe(false);
  });
});

describe("WP-177 crash at each step, then recovery", () => {
  type Step = "receive" | "activate" | "release" | "freeze";
  const steps: Array<[Step, "before" | "after"]> = [
    ["freeze", "after"],
    ["receive", "before"],
    ["receive", "after"],
    ["activate", "before"],
    ["activate", "after"],
    ["release", "before"],
    ["release", "after"],
  ];

  /** Wraps one endpoint so the named step crashes: before it runs, or after it has stored its change. */
  function crashing(machine: StubMachine, step: Step, when: "before" | "after"): MoveEndpoint {
    const wrapped = Object.create(machine) as StubMachine;
    const original = (machine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[step].bind(machine);
    (wrapped as unknown as Record<string, unknown>)[step] = async (...args: unknown[]) => {
      if (when === "before") throw new Error(`crash before ${step}`);
      const result = await original(...args);
      throw new Error(`crash after ${step}`);
    };
    return wrapped;
  }

  it.each(steps)("%s %s: the chat ends on exactly one machine with its copy, after recovery", async (step, when) => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const { approval } = await approve(THIS_MAC, HOST);
    const sourceSide = step === "freeze" || step === "release" ? crashing(mac, step, when) : mac;
    const targetSide = step === "receive" || step === "activate" ? crashing(host, step, when) : host;

    const first = await moveChat({ chatId: CHAT, from: sourceSide, to: targetSide, approval, moveId: "m-crash", at: AT });
    // Whatever the first attempt reported, recovery brings the chat to one machine.
    const after = await recoverMove({ chatId: CHAT, moveId: "m-crash", from: mac, to: host });
    const macLive = (await mac.read(CHAT))?.live ?? null;
    const hostLive = (await host.read(CHAT))?.live ?? null;
    expect(Number(macLive !== null) + Number(hostLive !== null)).toBe(1);
    const owner = hostLive ? HOST : THIS_MAC;
    const live = hostLive ?? macLive!;
    expect(live.transcript).toBe(chat().transcript);
    expect(live.queued).toEqual(chat().queued);
    expect(["moved", "recovered"]).toContain(after.status);
    expect(["moved", "failed", "partial", "refused", "recovered"]).toContain(first.status);
    expect(owner === HOST || owner === THIS_MAC).toBe(true);
    expect(mac.isFrozen(CHAT)).toBe(false);
  });
});

describe("WP-177 model, effort and resume", () => {
  it("refuses a target whose CLI cannot resume the transcript, and offers the recap path", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    host.canResumeReply = { ok: false, reason: "this CLI version cannot read the transcript" };
    mac.seed(chat());
    const { approval } = await approve(THIS_MAC, HOST);
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT });
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

describe("WP-177 ids", () => {
  it("refuses a source record that names another chat", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const realRead = mac.read.bind(mac);
    mac.read = async (chatId: string) => {
      const rec = await realRead(chatId);
      return rec?.live ? { ...rec, live: { ...rec.live, chatId: "someone-else" } } : rec;
    };
    const { approval } = await approve(THIS_MAC, HOST);
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.refusal.reason).toBe("id-mismatch");
    expect(host.payloads).toHaveLength(0);
  });

  it("a payload that names another chat is refused by the target", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const { approval } = await approve(THIS_MAC, HOST);
    const result = await moveChat({ chatId: "other-chat", from: mac, to: host, approval, moveId: "m1", at: AT }).catch(
      (e: Error) => ({ status: "threw", message: e.message }),
    );
    expect(result.status).not.toBe("moved");
    expect((await host.read(CHAT))?.live ?? null).toBeNull();
  });

  it("a provider session id that is not an id is refused in the plan", async () => {
    const planned = await planMove(chat({ providerSessionId: "../../etc/passwd" }), THIS_MAC, HOST);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.reason).toBe("invalid-session-id");
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
    const { approval } = await approve(THIS_MAC, HOST);
    const [a, b] = await Promise.all([
      moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "desktop", at: AT }),
      moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "host", at: AT }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["moved", "refused"]);
    expect(host.payloads).toHaveLength(1);
    expect((await host.read(CHAT))?.live).not.toBeNull();
    expect((await mac.read(CHAT))?.live ?? null).toBeNull();
  });

  it("the host lease refuses a second receive for the same chat until the first one lets go", () => {
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
    const { approval } = await approve(THIS_MAC, HOST);
    expect((await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m1", at: AT })).status).toBe("moved");
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

export type { MovePlan };

describe("WP-177 HIGH B: a lost reply leaves the move unknown, with the freeze kept", () => {
  it("activate stored the copy, the reply was lost, and holds cannot be asked: the result is unknown and the source stays frozen", async () => {
    const mac = new StubMachine(THIS_MAC);
    const host = new StubMachine(HOST);
    mac.seed(chat());
    const { approval } = await approve(THIS_MAC, HOST);
    const realActivate = host.activate.bind(host);
    host.activate = async (chatId, moveId) => {
      await realActivate(chatId, moveId);
      throw new Error("connection dropped");
    };
    host.holds = async () => {
      throw new Error("connection dropped");
    };
    const result = await moveChat({ chatId: CHAT, from: mac, to: host, approval, moveId: "m-lost", at: AT });
    expect(result.status).toBe("unknown");
    expect(mac.isFrozen(CHAT)).toBe(true);
    // The host did activate, so it is live there. Once the link is back, recovery finishes the move.
    host.holds = StubMachine.prototype.holds;
    const after = await recoverMove({ chatId: CHAT, moveId: "m-lost", from: mac, to: host });
    expect(after.status).toBe("moved");
    expect((await mac.read(CHAT))?.live ?? null).toBeNull();
    expect((await host.read(CHAT))?.live).not.toBeNull();
  });
});

describe("WP-177 LOW G: only a real trusted MouseEvent approves", () => {
  it("a plain object that looks like a trusted click is refused; a real MouseEvent that is trusted is accepted", async () => {
    const { plan } = await approve(THIS_MAC, HOST);
    expect(() => approvePlan(plan, { isTrusted: true, type: "click" })).toThrow(/person's click/);
    const RealLike = globalThis.MouseEvent as unknown as new (type: string) => { isTrusted: boolean; type: string };
    const trusted = new RealLike("click");
    Object.defineProperty(trusted, "isTrusted", { value: true });
    expect(approvePlan(plan, trusted as never).planId).toBe(plan.planId);
    const untrusted = new RealLike("click");
    Object.defineProperty(untrusted, "isTrusted", { value: false });
    expect(() => approvePlan(plan, untrusted as never)).toThrow(/person's click/);
  });
});
