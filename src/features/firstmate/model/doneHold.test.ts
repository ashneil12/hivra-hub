// SC-3b: the hold on a first mate's "ready to ship". In a project that tests at ship, the claim is held until a ship check
// has passed for the version it is about (src-tauri/src/ship_check.rs). Two halves: what counts as a ship claim (a plain
// sentence in the turn's last message, never code, a quote, a question or a "not yet"), and when the app answers one.
import { describe, expect, it, vi } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import {
  HOLD_NOTE,
  HOLD_PREFIX,
  HOLD_RULES,
  doneHold,
  holdReplyOf,
  shipClaim,
  type HoldDeps,
  type HoldRule,
} from "./doneHold";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEXT = "89abcdef0123456789abcdef0123456789abcdef";

describe("shipClaim: the message tells the person it is ready to ship, or that it shipped", () => {
  it.each([
    "All done. It's ready to ship.",
    "The change is ready to release.",
    "Ready to deploy.",
    "Good to ship.",
    "This is safe to ship.",
    "Everything is ready for release.",
    "It is ready for deployment.",
    "We can go live.",
    "This can be shipped now.",
    "The fix is now live.",
    "It's live.",
    "I've shipped it.",
    "We shipped it.",
    "Shipped.",
    "Shipped: version 1.4.",
    "Released it.",
    "**Ready to ship** — the checks pass.",
    "- All checks green\n- Ready to ship",
    "Done.\r\nReady to ship.\r\n",
    "It’s ready to ship.",
    "READY TO SHIP",
    // The work is the subject, or the line is a status line for production.
    "The fix was released.",
    "The new build was shipped.",
    "The release has been deployed.",
    "Released 1.4 to production.",
    "Deployed to production.",
    "Shipped to prod.",
    "We went live.",
    "It has gone live.",
    "The release is now live.",
    "We're live.",
    "we are live",
    "This is live.",
    // A no in another clause doesn't cancel the claim.
    "I didn't run the tests and it's ready to ship.",
    "I didn't run the tests & it's ready to ship.",
    "Not everything is tested, but it is ready to ship.",
  ])("is a claim: %s", (text) => {
    expect(shipClaim(text)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["only spaces", "  \n\t "],
    ["an ordinary report", "I fixed the sort. The tests pass."],
    ["a not-yet", "Not ready to ship yet."],
    ["an isn't", "It isn't ready to ship."],
    ["a curly isn’t", "It isn’t ready to ship yet."],
    ["a can't", "We can't ship until the test passes."],
    ["a never", "Never shipped to production."],
    ["has not", "It has not been released."],
    ["a nothing", "Nothing is ready to ship."],
    ["almost", "Almost ready to ship."],
    ["a once", "Once it's ready to ship I'll run ship_check."],
    ["a when", "When it is ready to release, tell me."],
    ["an if", "If it's ready to deploy, say so."],
    ["a question", "Should I ship?"],
    ["a question about readiness", "Is it ready to ship?"],
    ["a question with a claim in it", "Ready to ship?"],
    ["an offer", "Want me to ship it?"],
    ["a question with no mark", "Is it ready to ship"],
    ["the ship check as a noun", "The ship check passed."],
    ["the tool's name", "I ran ship_check and it passed."],
    ["the ship check button", "Use the Run ship check button."],
    ["a shipping label", "The shipping label is wrong."],
    ["the word ship as an instruction", "Run ship_check before you ship."],
    // Not about the project being shipped: a local server, staging, a preview.
    ["a dev server", "The dev server is live on localhost:1430; the fix still needs review."],
    ["a local address", "The build is live on 127.0.0.1."],
    ["staging", "Deployed to staging."],
    ["staging, said another way", "It's live on staging."],
    ["a preview", "The preview is live."],
    ["a local build", "The local build is ready to ship to the test box."],
    ["locally", "I shipped it locally."],
    // Something other than the work was released or deployed.
    ["a lock", "The lock was released after the test."],
    ["a handle", "The file handle was released."],
    ["a person who lives somewhere", "I live in Berlin."],
    // Hedged, or only a could.
    ["a could", "It could be shipped."],
    ["not sure", "I'm not sure it is ready to ship."],
    ["a not in the same clause", "I'm not convinced it's ready to ship."],
    ["an if across an and", "If it passes and is ready to ship, say so."],
    ["a once across an and", "Once the tests pass and it's ready to ship I'll run ship_check."],
  ])("is not a claim: %s", (_why, text) => {
    expect(shipClaim(text)).toBe(false);
  });

  it("ignores the phrase inside code, fenced or inline, and a fence left open", () => {
    expect(shipClaim("Run this:\n```\nready to ship\n```\nThen report back.")).toBe(false);
    expect(shipClaim("~~~\nIt's ready to ship\n~~~")).toBe(false);
    expect(shipClaim("The log line `ready to ship` is from the old script.")).toBe(false);
    expect(shipClaim("Output follows:\n```text\nI've shipped it\n")).toBe(false);
    // Code does not hide a claim made in plain words beside it.
    expect(shipClaim("`npm test` passes. It's ready to ship.")).toBe(true);
    expect(shipClaim("```\nnpm test\n```\nReady to ship.")).toBe(true);
  });

  it("ignores quoted text: a quote line, or words in quotation marks", () => {
    expect(shipClaim("> It's ready to ship\n\nThat was the earlier draft.")).toBe(false);
    expect(shipClaim('You wrote "ready to ship" but the tests are red.')).toBe(false);
    expect(shipClaim("The note says “ready to release” and I disagree.")).toBe(false);
    expect(shipClaim("The note says «ready to deploy».")).toBe(false);
    // An unmatched quote mark never swallows the sentence after it.
    expect(shipClaim('It\'s 5" wide. Ready to ship.')).toBe(true);
  });

  it("answers one claim at a time: a question after a claim leaves the claim", () => {
    expect(shipClaim("It's ready to ship. Should I ship it?")).toBe(true);
    expect(shipClaim("Is it ready to ship? Yes, it is ready to ship.")).toBe(true);
    expect(shipClaim("Should I ship it? Not ready to ship yet.")).toBe(false);
  });

  it("reads each clause on its own, so a not in one clause doesn't cancel a claim in the next", () => {
    expect(shipClaim("Not everything is tested, but it is ready to ship.")).toBe(true);
    expect(shipClaim("It is ready to ship, not deployed.")).toBe(true);
    expect(shipClaim("Not ready to ship, but close.")).toBe(false);
  });
});

function chatOf(blocks: Block[], over: Partial<Session> = {}): Session {
  return { ...newSession("claude", "/work/app", "claude:opus-5-5"), id: "chat-1", firstMate: true, blocks, ...over };
}

const user = (text = "Please finish the sort fix.", id = "u1"): Block => ({ id, role: "user", text });
const reply = (text: string, id = "a1"): Block => ({ id, role: "assistant", text });

function deps(over: Partial<HoldDeps> = {}): HoldDeps {
  return {
    mode: vi.fn(async () => "at-ship" as const),
    head: vi.fn(async () => HEAD),
    passed: vi.fn(async () => false),
    ...over,
  };
}

const claiming = () => chatOf([user(), reply("The sort is fixed. It's ready to ship.")]);

describe("holdReplyOf: the reply a finished turn ended on", () => {
  it("is the last assistant message when nothing came after it", () => {
    expect(holdReplyOf(claiming())?.id).toBe("a1");
  });

  it("is nothing while the chat is mid-turn or has a message waiting", () => {
    expect(holdReplyOf({ ...claiming(), busy: true })).toBeUndefined();
    expect(
      holdReplyOf({ ...claiming(), queuedMessages: [{ id: "q", text: "go on", attachments: [] }] }),
    ).toBeUndefined();
  });

  it("is nothing when a newer message answered it, or the turn ended on a tool", () => {
    expect(holdReplyOf(chatOf([user(), reply("Ready to ship."), user("Thanks, merge it", "u2")]))).toBeUndefined();
    expect(
      holdReplyOf(
        chatOf([user(), reply("Ready to ship."), { id: "t1", role: "tool", text: "git status", tool: { title: "Bash" } }]),
      ),
    ).toBeUndefined();
  });

  it("skips the app's own notes and reasoning after the reply", () => {
    const blocks = [
      user(),
      reply("Ready to ship."),
      { id: "n1", role: "system", text: "Still working: 1 of 2 jobs done." } as Block,
      { id: "r1", role: "reasoning", text: "thinking" } as Block,
    ];
    expect(holdReplyOf(chatOf(blocks))?.id).toBe("a1");
  });

  it("is nothing for an empty reply", () => {
    expect(holdReplyOf(chatOf([user(), reply("   ")]))).toBeUndefined();
  });
});

describe("doneHold: a ready-to-ship claim in an at-ship project with no passed check", () => {
  it("holds it with one app message and one grey note", async () => {
    const memo = new Set<string>();
    const held = await doneHold(claiming(), deps(), memo);
    expect(held).toBeDefined();
    expect(held?.message.text.startsWith(HOLD_PREFIX)).toBe(true);
    expect(held?.message.text).toContain(
      "Not ready to ship yet: no ship check has passed for 0123456. Run ship_check, then report what it tested.",
    );
    expect(held?.message.text).toContain("This is an app notification, not a new message from");
    expect(held?.message.attachments).toEqual([]);
    expect(held?.message.waitForIdle).toBe(true);
    expect(held?.note.role).toBe("system");
    expect(held?.note.text).toBe("Held: no ship check for this version yet.");
    expect(HOLD_NOTE).toBe("Held: no ship check for this version yet.");
    expect(memo.has(`chat-1:${HEAD}`)).toBe(true);
  });

  it("asks the app about this chat's own folder", async () => {
    const api = deps();
    await doneHold(claiming(), api, new Set());
    expect(api.mode).toHaveBeenCalledWith("/work/app");
    expect(api.head).toHaveBeenCalledWith("/work/app");
    expect(api.passed).toHaveBeenCalledWith("/work/app", HEAD);
  });

  it("holds once per version per chat, and again for a new version", async () => {
    const memo = new Set<string>();
    expect(await doneHold(claiming(), deps(), memo)).toBeDefined();
    expect(await doneHold(claiming(), deps(), memo)).toBeUndefined();
    // Another chat on the same version is held on its own.
    expect(await doneHold({ ...claiming(), id: "chat-2" }, deps(), memo)).toBeDefined();
    // A new version of the project is a new hold.
    expect(await doneHold(claiming(), deps({ head: vi.fn(async () => NEXT) }), memo)).toBeDefined();
    expect(memo.has(`chat-1:${NEXT}`)).toBe(true);
  });

  it("takes the memo before anything is sent, so two turns ending together hold once", async () => {
    const memo = new Set<string>();
    const [a, b] = await Promise.all([doneHold(claiming(), deps(), memo), doneHold(claiming(), deps(), memo)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("says nothing when a ship check passed for this version", async () => {
    const api = deps({ passed: vi.fn(async () => true) });
    const memo = new Set<string>();
    expect(await doneHold(claiming(), api, memo)).toBeUndefined();
    expect(memo.size).toBe(0);
  });

  it.each(["light", "full", "off"] as const)("does not hold in %s mode, and asks nothing more of the app", async (mode) => {
    const api = deps({ mode: vi.fn(async () => mode) });
    expect(await doneHold(claiming(), api, new Set())).toBeUndefined();
    expect(api.passed).not.toHaveBeenCalled();
  });

  it("does not ask the app anything when the turn made no ship claim", async () => {
    const api = deps();
    const calm = chatOf([user(), reply("I fixed the sort. The tests pass.")]);
    expect(await doneHold(calm, api, new Set())).toBeUndefined();
    expect(api.mode).not.toHaveBeenCalled();
    expect(api.head).not.toHaveBeenCalled();
  });

  it("holds only a first mate's chat", async () => {
    expect(await doneHold({ ...claiming(), firstMate: false }, deps(), new Set())).toBeUndefined();
  });

  it("is not held by a claim that was already answered, or a chat that is mid-turn", async () => {
    const answered = chatOf([user(), reply("Ready to ship."), user("ok", "u2")]);
    expect(await doneHold(answered, deps(), new Set())).toBeUndefined();
    expect(await doneHold({ ...claiming(), busy: true }, deps(), new Set())).toBeUndefined();
  });

  it("is never a verdict when the app can't answer: no hold, no throw, nothing remembered", async () => {
    for (const broken of [
      deps({ mode: vi.fn(async () => Promise.reject("gone")) }),
      deps({ head: vi.fn(async () => Promise.reject(new Error("git is not available"))) }),
      deps({ head: vi.fn(async () => null) }),
      deps({ head: vi.fn(async () => "") }),
      deps({ passed: vi.fn(async () => Promise.reject("gone")) }),
    ]) {
      const memo = new Set<string>();
      await expect(doneHold(claiming(), broken, memo)).resolves.toBeUndefined();
      expect(memo.size).toBe(0);
    }
  });

  it("drops a hold the chat has moved past while the app was answering", async () => {
    const memo = new Set<string>();
    // Mid-turn again by the time the answer came back.
    expect(await doneHold(claiming(), deps({ fresh: () => ({ ...claiming(), busy: true }) }), memo)).toBeUndefined();
    // A newer reply took its place.
    const newer = chatOf([user(), reply("Ready to ship.", "a1"), user("ok", "u2"), reply("Done, nothing else.", "a2")]);
    expect(await doneHold(claiming(), deps({ fresh: () => newer }), memo)).toBeUndefined();
    // The chat is gone.
    expect(await doneHold(claiming(), deps({ fresh: () => undefined }), memo)).toBeUndefined();
    expect(memo.size).toBe(0);
    // Unchanged: held.
    expect(await doneHold(claiming(), deps({ fresh: () => claiming() }), memo)).toBeDefined();
  });
});

describe("the hold rules: one seam for what else holds a done", () => {
  it("starts with the ship check and has room for more", () => {
    expect(HOLD_RULES[0].id).toBe("ship-check");
    expect(HOLD_RULES.length).toBeGreaterThanOrEqual(1);
    expect(new Set(HOLD_RULES.map((rule) => rule.id)).size).toBe(HOLD_RULES.length);
  });

  const extra = (id: string, over: Partial<{ key: string; fires: boolean; throws: boolean }> = {}): HoldRule => ({
    id,
    check: async () => {
      if (over.throws) throw new Error("boom");
      return over.fires === false
        ? undefined
        : { key: over.key ?? id, message: `[rule ${id}]`, note: `Held by ${id}.` };
    },
  });

  it("asks each rule in order and holds on the first that fires", async () => {
    const held = await doneHold(claiming(), deps({ passed: vi.fn(async () => true) }), new Set(), [
      HOLD_RULES[0],
      extra("tasks-open"),
      extra("second"),
    ]);
    expect(held?.note.text).toBe("Held by tasks-open.");
    expect(held?.message.text).toContain("[rule tasks-open]");
  });

  it("remembers each rule's hold under its own key", async () => {
    const memo = new Set<string>();
    expect(await doneHold(claiming(), deps({ passed: vi.fn(async () => true) }), memo, [extra("tasks-open", { key: "t1,t2" })])).toBeDefined();
    expect(memo.has("chat-1:t1,t2")).toBe(true);
    expect(await doneHold(claiming(), deps({ passed: vi.fn(async () => true) }), memo, [extra("tasks-open", { key: "t1,t2" })])).toBeUndefined();
    expect(await doneHold(claiming(), deps({ passed: vi.fn(async () => true) }), memo, [extra("tasks-open", { key: "t3" })])).toBeDefined();
  });

  it("goes past a rule that throws to the next one", async () => {
    const held = await doneHold(claiming(), deps(), new Set(), [extra("broken", { throws: true }), HOLD_RULES[0]]);
    expect(held?.note.text).toBe(HOLD_NOTE);
  });

  it("holds nothing when no rule fires", async () => {
    expect(await doneHold(claiming(), deps(), new Set(), [extra("quiet", { fires: false })])).toBeUndefined();
  });
});
