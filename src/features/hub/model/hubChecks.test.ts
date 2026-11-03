// @vitest-environment happy-dom
// Checks reach the chat that owns Ash's message (hubChecks.ts): one quiet turn when that chat is idle, never an
// interruption, once per check (a restart only confirms it), and nothing for a chat outside the hub.
import { describe, expect, it, vi } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import { sanitizeSessionForPersist } from "../../sessions/data/sessionStore";
import { groupMonoChatTurns, groupTurns } from "../../sessions/model/transcriptActivity";
import {
  CheckDelivery,
  CHECK_PREFIX,
  checkMeta,
  checkReceipt,
  checkTarget,
  checkVerdict,
  hasCheck,
  inCheckTurn,
  mapChecks,
  takesCheck,
  withoutCheckTurns,
  type CheckTarget,
  type HubCheck,
} from "./hubChecks";

/** One check as Ash OS's `checks` call listed it (ashos/checker.py `listing`); WP-14 brings checks back. */
function wire(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    dumpId: "d_1020abc123",
    owner: "mono:vg-game-lead",
    monoId: "vg-game-lead",
    chatId: "chat-exo",
    finding: "Ash asked for the save fix and the HUD tweak; only the save fix was recorded. Is this right?",
    askIds: ["a_1020save01"],
    createdAt: "2026-10-20T09:00:00Z",
    saidAt: "2026-10-20T08:20:00Z",
    prompt: `[MonoCode check] The checker looked at Ash's message from 20 Oct 08:20 that this chat owns (dump d_1020abc123) and found: Ash asked for the save fix and the HUD tweak. Is this right?\nLook at it (ash_dump_status d_1020abc123). If it was handled right as it is, answer with ash_record check {"id": "${id}", "verdict": "right", "note": "<why>"}.`,
    ...extra,
  };
}

const lead = (patch: Partial<Session> = {}): Session => ({ ...newSession("claude", "/p/vg-game", "claude:opus-5-5"), id: "chat-exo", ...patch });

describe("what Ash OS lists", () => {
  it("keeps each check once, with Ash OS's own turn, and drops malformed rows", () => {
    const checks = mapChecks({ checks: [wire("ck_1"), wire("ck_1"), { id: "bad id", dumpId: "d", finding: "x" }, wire("ck_2", { prompt: "" })], count: 4 });
    expect(checks.map((c) => c.id)).toEqual(["ck_1", "ck_2"]);
    expect(checks[0].prompt.startsWith(CHECK_PREFIX)).toBe(true);
    expect(checks[0]).toMatchObject({ monoId: "vg-game-lead", chatId: "chat-exo", askIds: ["a_1020save01"] });
    // Without a turn from Ash OS, one of our own, with the same answer instruction.
    expect(checks[1].prompt).toContain(CHECK_PREFIX);
    expect(checks[1].prompt).toContain('ash_record check {"id": "ck_2", "verdict": "right"');
    expect(mapChecks({})).toEqual([]);
    expect(mapChecks(null)).toEqual([]);
  });

  it("goes to a Mono's current chat, a hub chat by id, and never to the checker, a worker or a chat outside the hub", () => {
    const [check] = mapChecks({ checks: [wire("ck_1")] });
    const monos = (id: string) => id === "vg-game-lead";
    expect(checkTarget(check, monos)).toEqual({ mono: "vg-game-lead" });
    expect(checkTarget({ ...check, monoId: undefined }, monos)).toEqual({ session: "chat-exo" });
    // A Mono this app doesn't have (yet): its bound chat, if Ash OS knows one.
    expect(checkTarget({ ...check, monoId: "someone-else" }, monos)).toEqual({ session: "chat-exo" });
    expect(checkTarget({ ...check, monoId: "checker", chatId: undefined }, monos)).toBeUndefined();
    expect(checkTarget({ ...check, monoId: undefined, chatId: "app-chat-exo-r1" }, monos)).toBeUndefined();
    // Owner outside the hub: nothing to deliver here (Ash OS handed it back on that chat's next call).
    expect(checkTarget({ ...check, owner: "claude:9f1c", monoId: undefined, chatId: undefined }, monos)).toBeUndefined();
  });
});

describe("when a chat takes a check", () => {
  it("only when idle with nothing queued or waiting on Ash", () => {
    expect(takesCheck(lead())).toBe(true);
    expect(takesCheck(lead({ busy: true }))).toBe(false);
    expect(takesCheck(lead({ queuedMessages: [{ id: "m1", text: "Ash's next message", attachments: [] }] }))).toBe(false);
    expect(takesCheck(lead({ usageLimit: {} }))).toBe(false);
    expect(takesCheck(lead({ queueStatus: "paused" }))).toBe(false);
    expect(takesCheck(lead({ blocks: [{ id: "a", role: "approval", text: "Run it?", approval: { requestId: 3 } }] }))).toBe(false);
  });

  it("knows a check it already has, by receipt or by its card", () => {
    expect(hasCheck(lead(), "ck_1")).toBe(false);
    expect(hasCheck(lead({ blocks: [{ id: "u", role: "user", text: "x", appRequestId: checkReceipt("ck_1") }] }), "ck_1")).toBe(true);
    expect(hasCheck(lead({ blocks: [{ id: "u", role: "user", text: "x", internal: true, monoCheck: { id: "ck_1" } }] }), "ck_1")).toBe(true);
  });
});

/** An app stand-in: chats by id, the turns it was handed, and what Ash OS was told. */
function app(chats: Session[], options: { refuse?: boolean } = {}) {
  const sessions = new Map(chats.map((chat) => [chat.id, chat]));
  const submitted: Array<{ sessionId: string; check: HubCheck }> = [];
  const delivered: string[] = [];
  const opened: CheckTarget[] = [];
  let now = 1_000;
  const delivery = new CheckDelivery({
    open: async (target) => {
      opened.push(target);
      const id = "mono" in target ? (target.mono === "vg-game-lead" ? "chat-exo" : undefined) : target.session;
      return id ? sessions.get(id) : undefined;
    },
    current: (id) => sessions.get(id),
    submit: vi.fn(async (sessionId: string, check: HubCheck) => {
      if (options.refuse) return false;
      submitted.push({ sessionId, check });
      const chat = sessions.get(sessionId)!;
      // What submitSession does: the hidden turn goes in and the chat gets busy.
      sessions.set(sessionId, {
        ...chat,
        busy: true,
        blocks: [...chat.blocks, { id: `b-${check.id}`, role: "user", text: check.prompt, internal: true, monoCheck: checkMeta(check), appRequestId: checkReceipt(check.id) }],
      });
      return true;
    }),
    delivered: async (ids) => void delivered.push(...ids),
    monoExists: (id) => id === "vg-game-lead",
    now: () => now,
  });
  return {
    delivery,
    submitted,
    delivered,
    opened,
    set: (chat: Session) => sessions.set(chat.id, chat),
    get: (id: string) => sessions.get(id)!,
    tick: (ms: number) => (now += ms),
  };
}

describe("delivery", () => {
  it("queues one quiet turn in the idle owner's chat, then tells Ash OS it was delivered", async () => {
    const a = app([lead()]);
    await a.delivery.offer(mapChecks({ checks: [wire("ck_1")] }));
    expect(a.submitted).toHaveLength(1);
    expect(a.submitted[0].sessionId).toBe("chat-exo");
    expect(a.submitted[0].check.prompt.startsWith("[MonoCode check]")).toBe(true);
    const turn = a.get("chat-exo").blocks.at(-1)!;
    expect(turn).toMatchObject({ role: "user", internal: true, appRequestId: "mono-check-ck_1", monoCheck: { id: "ck_1", dumpId: "d_1020abc123" } });
    expect(a.delivered).toEqual(["ck_1"]);
    expect(a.delivery.waiting()).toEqual([]);
  });

  it("never interrupts: a busy chat, or one with Ash's messages queued, waits until it is idle", async () => {
    const a = app([lead({ busy: true })]);
    await a.delivery.offer(mapChecks({ checks: [wire("ck_1")] }));
    expect(a.submitted).toHaveLength(0);
    expect(a.delivered).toEqual([]);
    a.set(lead({ busy: false, queuedMessages: [{ id: "m1", text: "and the HUD", attachments: [] }] }));
    await a.delivery.flush();
    expect(a.submitted).toHaveLength(0);
    a.set(lead());
    await a.delivery.flush();
    expect(a.submitted.map((s) => s.check.id)).toEqual(["ck_1"]);
    expect(a.delivered).toEqual(["ck_1"]);
  });

  it("dedupes by check id: pulled again, or across a restart that came before Ash OS heard, it is never sent twice", async () => {
    const a = app([lead()]);
    const checks = mapChecks({ checks: [wire("ck_1")] });
    await Promise.all([a.delivery.offer(checks), a.delivery.offer(checks)]);
    expect(a.submitted).toHaveLength(1);
    // The app restarted with the turn in the chat but Ash OS still listing it: confirmed, not sent again.
    const restarted = app([lead({ blocks: a.get("chat-exo").blocks })]);
    await restarted.delivery.offer(checks);
    expect(restarted.submitted).toHaveLength(0);
    expect(restarted.delivered).toEqual(["ck_1"]);
  });

  it("hands a chat one check at a time", async () => {
    const a = app([lead()]);
    await a.delivery.offer(mapChecks({ checks: [wire("ck_1"), wire("ck_2")] }));
    expect(a.submitted.map((s) => s.check.id)).toEqual(["ck_1"]);
    expect(a.delivery.waiting()).toEqual(["ck_2"]);
    a.set({ ...a.get("chat-exo"), busy: false });
    await a.delivery.flush();
    expect(a.submitted.map((s) => s.check.id)).toEqual(["ck_1", "ck_2"]);
  });

  it("has nothing to deliver for a chat outside the hub or one this app doesn't have, and leaves it with Ash OS", async () => {
    const a = app([lead()]);
    await a.delivery.offer(
      mapChecks({
        checks: [
          wire("ck_out", { owner: "claude:9f1c", monoId: undefined, chatId: undefined }),
          wire("ck_gone", { monoId: undefined, chatId: "chat-deleted" }),
        ],
      }),
    );
    expect(a.submitted).toHaveLength(0);
    expect(a.delivered).toEqual([]);
    expect(a.delivery.waiting()).toEqual([]);
  });

  it("tries a refused turn again later, and only then", async () => {
    const a = app([lead()], { refuse: true });
    await a.delivery.offer(mapChecks({ checks: [wire("ck_1")] }));
    expect(a.delivered).toEqual([]);
    expect(a.delivery.waiting()).toEqual(["ck_1"]);
  });
});

describe("in the chat", () => {
  const prompt: Block = { id: "p", role: "user", text: "[MonoCode check] ...", internal: true, appRequestId: "mono-check-ck_1", monoCheck: { id: "ck_1", finding: "Only one of two asks was recorded. Is this right?" }, startedAt: 2 };
  const work: Block = { id: "t", role: "tool", text: "", tool: { title: "ash_record", detail: '{"check":{"id":"ck_1","verdict":"right","note":"Ash said the HUD can wait"}}' } };
  const answer: Block = { id: "r", role: "assistant", text: "Right: Ash said the HUD tweak can wait until after the demo." };

  it("is a turn of its own, kept whole, and Ash's own next message is never folded into it", () => {
    const ash: Block = { id: "u1", role: "user", text: "fix the save bug", startedAt: 1 };
    const reply: Block = { id: "a1", role: "assistant", text: "On it." };
    const steer: Block = { id: "u2", role: "user", text: "and the HUD", sentAt: 3 };
    expect(groupTurns([ash, reply, prompt, work, answer]).map((t) => t.map((b) => b.id))).toEqual([["u1", "a1"], ["p", "t", "r"]]);
    expect(groupMonoChatTurns([ash, reply, prompt, work, answer, steer]).map((t) => t.map((b) => b.id))).toEqual([
      ["u1", "a1"],
      ["p", "t", "r"],
      ["u2"],
    ]);
  });

  it("reads how the chat answered, and survives a reload", () => {
    expect(checkVerdict([prompt, work, answer])).toBe("right");
    expect(checkVerdict([prompt, { id: "r", role: "assistant", text: "Fixed: recorded the HUD ask and delegated it." }])).toBe("fixed");
    expect(checkVerdict([prompt])).toBeUndefined();
    const saved = sanitizeSessionForPersist({ ...lead(), blocks: [prompt, answer] });
    expect(saved.blocks[0]).toMatchObject({ internal: true, monoCheck: { id: "ck_1", finding: prompt.monoCheck!.finding } });
  });

  it("is not a reply Ash hasn't read: a chat answering the checker drops out of the unread count's busy set", () => {
    const busy = new Set(["chat-exo", "chat-hivra"]);
    const answering = lead({ busy: true, blocks: [prompt, work] });
    const working = { ...lead({ busy: true }), id: "chat-hivra", blocks: [{ id: "u", role: "user", text: "ship it", startedAt: 1 } as Block] };
    expect(inCheckTurn(answering)).toBe(true);
    expect([...withoutCheckTurns(busy, [answering, working])]).toEqual(["chat-hivra"]);
    // Nothing answering a check: the very same set, so nothing downstream sees a change.
    expect(withoutCheckTurns(busy, [lead({ busy: true }), working])).toBe(busy);
    // Ash wrote into the check's turn: from then on it is his.
    expect(inCheckTurn(lead({ blocks: [prompt, { id: "u2", role: "user", text: "also", sentAt: 4 }] }))).toBe(false);
  });
});
