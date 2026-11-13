// SC-3b: the hold on a first mate's "ready to ship". In a project that tests at ship, the claim is held until a ship check
// has passed for the version it is about (src-tauri/src/ship_check.rs). Two halves: what counts as a ship claim (a plain
// sentence in the turn's last message, never code, a quote, a question or a "not yet"), and when the app answers one.
import { describe, expect, it, vi } from "vitest";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import {
  BUGS_NOTE,
  HOLD_NOTE,
  HOLD_PREFIX,
  HOLD_RULES,
  OPEN_WORK_NOTE,
  SORTING_NOTE,
  doneClaim,
  doneHold,
  holdDeps,
  holdReplyOf,
  openWorkMessage,
  readOpenWork,
  shipClaim,
  type HoldDeps,
  type HoldRule,
  type OpenWork,
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

/** The ship-check rule, wherever it sits in the list. */
const SHIP_RULE = (): HoldRule => HOLD_RULES.find((rule) => rule.id === "ship-check")!;

describe("the hold rules: one seam for what else holds a done", () => {
  it("has the open-work rule first (finish the work before a ship check) and the ship check after it", () => {
    // SC-7 put the open-work rule ahead of the ship check: a ship check over work that is still going is wasted.
    expect(HOLD_RULES.map((rule) => rule.id)).toEqual(["work-open", "ship-check"]);
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
      SHIP_RULE(),
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
    const held = await doneHold(claiming(), deps(), new Set(), [extra("broken", { throws: true }), SHIP_RULE()]);
    expect(held?.note.text).toBe(HOLD_NOTE);
  });

  it("holds nothing when no rule fires", async () => {
    expect(await doneHold(claiming(), deps(), new Set(), [extra("quiet", { fires: false })])).toBeUndefined();
  });

  it("asks a rule only about the claim it is for", async () => {
    const asked = vi.fn(async () => undefined);
    const looser: HoldRule = { id: "loose", claim: doneClaim, check: asked };
    const stricter: HoldRule = { id: "strict", check: asked };
    const calm = chatOf([user(), reply("It's done.")]);
    await doneHold(calm, deps(), new Set(), [looser, stricter]);
    // "It's done." is a done claim and not a ship claim: only the rule that reads done claims is asked.
    expect(asked).toHaveBeenCalledTimes(1);
  });
});

// ---- SC-7: a first mate is not done while its work is open -------------------------------------------------------------

describe("doneClaim: the message tells the person the work is done", () => {
  it.each([
    "All done.",
    "I'm done.",
    "We're finished.",
    "We are done with it.",
    "Everything is complete.",
    "Everything's done.",
    "It's done.",
    "That's done.",
    "It's ready.",
    "It is ready for your review.",
    "You're all set.",
    "It's all set.",
    "It's shipped.",
    "The work is done.",
    "The fix is done and tested.",
    "I've finished everything.",
    "We've completed it.",
    "Done.",
    "Finished.",
    "Complete!",
    "All set.",
    "Shipped.",
    "It's ready to ship.",
    "The sort is fixed. We're done.",
    "**All done.**",
  ])("is a claim: %s", (text) => {
    expect(doneClaim(text), text).toBe(true);
  });

  it.each([
    "Not done yet.",
    "I'm not done.",
    "It's not ready.",
    "We're not finished, two jobs are still running.",
    "Is it done?",
    "Are we done?",
    "Should I mark it done",
    "Once it's done I'll tell you.",
    "If it's done, ship it.",
    "I'll be done soon.",
    "Almost done.",
    "The first task is done, the second is running.",
    "The sort is done, the filter is still open.",
    "I've finished the first task.",
    "We're ready to start the next one.",
    "Everything's done except the docs.",
    "Let me know when you're done.",
    "I'm all set up to begin.",
    "Working on it.",
    "I fixed the sort. The tests pass.",
    // A report's own headings and list items are not the report saying it is finished.
    "## Done\n- Fix the save bug\n## Remaining\n- the export",
    "**Done:** the sort. **Remaining:** the filter.",
    "Done so far:\n- one\n- two",
    "- done",
    "1. Done",
    "",
  ])("is not a claim: %s", (text) => {
    expect(doneClaim(text), text).toBe(false);
  });

  it("ignores the words in code, a fence, a quote and quoted words", () => {
    expect(doneClaim("Run `done` to see it.")).toBe(false);
    expect(doneClaim("```\nall done\n```")).toBe(false);
    expect(doneClaim("> It's done.")).toBe(false);
    expect(doneClaim('The status line says "all done" for the other task.')).toBe(false);
    expect(doneClaim("Here is the log:\n```\nDone.\n```\nStill two jobs to go.")).toBe(false);
  });

  it("reads each sentence on its own", () => {
    expect(doneClaim("Is the sort done? I think so. It's done.")).toBe(true);
    expect(doneClaim("It's done?")).toBe(false);
    expect(doneClaim("Not yet. It's done, and the tests pass.")).toBe(true);
  });

  it("counts every ship claim as a done claim", () => {
    for (const text of ["Ready to ship.", "We can go live.", "I've shipped it.", "The fix was released."]) {
      expect(shipClaim(text), text).toBe(true);
      expect(doneClaim(text), text).toBe(true);
    }
    expect(doneClaim("Please run the ship check.")).toBe(false);
  });

  it("leaves a ship claim exactly as it was", () => {
    // A done claim is wider, and "it's done" says nothing about shipping.
    expect(shipClaim("It's done.")).toBe(false);
    expect(shipClaim("All done. It's ready to ship.")).toBe(true);
  });
});

const task = (id: string, title: string, status: OpenWork["tasks"][number]["status"] = "working") => ({ id, title, status });

function withWork(work: OpenWork | undefined, over: Partial<HoldDeps> = {}): HoldDeps {
  return deps({ work: vi.fn(async () => work), ...over });
}

const finished = () => chatOf([user(), reply("All done. The sort is fixed.")]);

describe("openWorkMessage: what the app tells the first mate", () => {
  it("names the open tasks and the unanswered questions, as the brief words it", () => {
    expect(
      openWorkMessage({
        tasks: [task("t1", "Fix the save bug", "working"), task("t2", "Add the export", "failed")],
        unanswered: [{ taskId: "t1", title: "Fix the save bug" }],
      }),
    ).toBe(
      "Not done yet: 2 tasks are still open (Fix the save bug: working; Add the export: failed) and 1 worker question is unanswered. Finish or close them, then report.",
    );
  });

  it("reads as one task, tasks only, questions only", () => {
    expect(openWorkMessage({ tasks: [task("t1", "Fix the save bug")], unanswered: [] })).toBe(
      "Not done yet: 1 task is still open (Fix the save bug: working). Finish or close it, then report.",
    );
    expect(
      openWorkMessage({ tasks: [task("t1", "A"), task("t2", "B", "needs-you")], unanswered: [] }),
    ).toBe("Not done yet: 2 tasks are still open (A: working; B: needs you). Finish or close them, then report.");
    expect(
      openWorkMessage({ tasks: [], unanswered: [{ taskId: "t1", title: "A" }, { taskId: "t2", title: "B" }] }),
    ).toBe("Not done yet: 2 worker questions are unanswered. Answer them, then report.");
    expect(openWorkMessage({ tasks: [], unanswered: [{ taskId: "t1", title: "A" }] })).toBe(
      "Not done yet: 1 worker question is unanswered. Answer it, then report.",
    );
  });

  it("says each status in plain words", () => {
    const text = openWorkMessage({
      tasks: [task("a", "A", "waiting"), task("b", "B", "paused"), task("c", "C", "needs-you"), task("d", "D", "failed")],
      unanswered: [],
    });
    expect(text).toContain("A: waiting; B: paused; C: needs you; D: failed");
  });

  it("names the first few and counts the rest", () => {
    const tasks = Array.from({ length: 9 }, (_, n) => task(`t${n}`, `Job ${n}`));
    const text = openWorkMessage({ tasks, unanswered: [] });
    expect(text).toContain("9 tasks are still open (Job 0: working; Job 1: working; Job 2: working; Job 3: working; Job 4: working and 4 more)");
  });

  it("uses no long dash", () => {
    const text = openWorkMessage({ tasks: [task("t1", "A")], unanswered: [{ taskId: "t1", title: "A" }] });
    expect(text).not.toMatch(/[–—]/);
    expect(OPEN_WORK_NOTE).toBe("Held: tasks still open.");
  });
});

describe("readOpenWork: what the app answers is untrusted", () => {
  it("keeps good entries and drops the rest, with plain one-line titles", () => {
    const read = readOpenWork({
      tasks: [
        { id: "t1", title: "Fix\nthe\tsave bug", status: "working" },
        { id: "t2", title: "x".repeat(300), status: "failed" },
        { id: "t3", title: "No status", status: "done" },
        { id: 4, title: "Bad id", status: "working" },
        { id: "t5", status: "paused" },
        "junk",
        null,
      ],
      unanswered: [{ taskId: "t1", title: "Fix the save bug" }, { taskId: 2 }, "x"],
    });
    expect(read?.tasks.map((t) => t.id)).toEqual(["t1", "t2", "t5"]);
    expect(read?.tasks[0].title).toBe("Fix the save bug");
    expect(read?.tasks[1].title.length).toBeLessThanOrEqual(80);
    expect(read?.tasks[2].title).toBe("Untitled task");
    expect(read?.unanswered).toEqual([{ taskId: "t1", title: "Fix the save bug" }]);
  });

  it("is nothing for an answer that isn't a list of work, and caps a long one", () => {
    for (const raw of [null, undefined, "x", 5, [], { tasks: "no" }]) expect(readOpenWork(raw), String(raw)).toBeUndefined();
    const many = Array.from({ length: 200 }, (_, n) => ({ id: `t${n}`, title: `Job ${n}`, status: "working" }));
    expect(readOpenWork({ tasks: many, unanswered: [] })?.tasks).toHaveLength(50);
  });
});

describe("doneHold: a first mate's done is held while its work is open (every testing mode)", () => {
  it("holds a done claim while a task is open, with the app's message and one grey note", async () => {
    const memo = new Set<string>();
    const open: OpenWork = {
      tasks: [task("t1", "Fix the save bug", "working"), task("t2", "Add the export", "failed")],
      unanswered: [{ taskId: "t1", title: "Fix the save bug" }],
    };
    const held = await doneHold(finished(), withWork(open), memo);
    expect(held?.message.text.startsWith(HOLD_PREFIX)).toBe(true);
    expect(held?.message.text).toContain(
      "Not done yet: 2 tasks are still open (Fix the save bug: working; Add the export: failed) and 1 worker question is unanswered. Finish or close them, then report.",
    );
    expect(held?.message.text).toContain("This is an app notification, not a new message from");
    expect(held?.message.waitForIdle).toBe(true);
    expect(held?.note.role).toBe("system");
    expect(held?.note.text).toBe("Held: tasks still open.");
  });

  it("asks the app about this chat's own tasks", async () => {
    const api = withWork({ tasks: [task("t1", "A")], unanswered: [] });
    await doneHold(finished(), api, new Set());
    expect(api.work).toHaveBeenCalledWith("chat-1");
  });

  it.each(["at-ship", "light", "full", "off"] as const)("holds in %s mode too", async (mode) => {
    const api = withWork({ tasks: [task("t1", "A")], unanswered: [] }, { mode: vi.fn(async () => mode) });
    expect(await doneHold(finished(), api, new Set())).toBeDefined();
  });

  it("holds a failed task, and a worker's question with no other task open", async () => {
    expect(await doneHold(finished(), withWork({ tasks: [task("t1", "A", "failed")], unanswered: [] }), new Set())).toBeDefined();
    const asked = await doneHold(
      finished(),
      withWork({ tasks: [], unanswered: [{ taskId: "t1", title: "A" }] }),
      new Set(),
    );
    expect(asked?.message.text).toContain("Not done yet: 1 worker question is unanswered. Answer it, then report.");
  });

  it("is not held when nothing is open: every task done or cancelled, no question waiting", async () => {
    const memo = new Set<string>();
    expect(await doneHold(finished(), withWork({ tasks: [], unanswered: [] }), memo)).toBeUndefined();
    expect(memo.size).toBe(0);
  });

  it("counts a worker waiting for a seat as open work", async () => {
    const api = withWork(
      { tasks: [], unanswered: [] },
      { waiting: vi.fn(() => [{ id: "app-chat-1-r1", title: "Add the export" }]) },
    );
    const held = await doneHold(finished(), api, new Set());
    expect(held?.message.text).toContain("1 task is still open (Add the export: waiting)");
    expect(api.waiting).toHaveBeenCalledWith("chat-1");
  });

  it("holds once per distinct set of open work per chat", async () => {
    const memo = new Set<string>();
    const one = { tasks: [task("t1", "A")], unanswered: [] };
    expect(await doneHold(finished(), withWork(one), memo)).toBeDefined();
    expect(await doneHold(finished(), withWork(one), memo)).toBeUndefined();
    // Another chat with the same tasks is held on its own.
    expect(await doneHold({ ...finished(), id: "chat-2" }, withWork(one), memo)).toBeDefined();
    // The same task in another state is another set; so is one more task, or a question.
    expect(await doneHold(finished(), withWork({ tasks: [task("t1", "A", "failed")], unanswered: [] }), memo)).toBeDefined();
    expect(await doneHold(finished(), withWork({ tasks: [task("t1", "A", "failed"), task("t2", "B")], unanswered: [] }), memo)).toBeDefined();
    expect(
      await doneHold(
        finished(),
        withWork({ tasks: [task("t1", "A", "failed"), task("t2", "B")], unanswered: [{ taskId: "t2", title: "B" }] }),
        memo,
      ),
    ).toBeDefined();
    // Seen already, in any order: not held again.
    expect(
      await doneHold(
        finished(),
        withWork({ tasks: [task("t2", "B"), task("t1", "A", "failed")], unanswered: [{ taskId: "t2", title: "B" }] }),
        memo,
      ),
    ).toBeUndefined();
  });

  it("takes the memo before anything is sent, so two turns ending together hold once", async () => {
    const memo = new Set<string>();
    const open = { tasks: [task("t1", "A")], unanswered: [] };
    const [a, b] = await Promise.all([
      doneHold(finished(), withWork(open), memo),
      doneHold(finished(), withWork(open), memo),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("is not a verdict when the app can't answer: no hold, no throw, nothing remembered", async () => {
    for (const api of [
      deps(),
      withWork(undefined),
      deps({ work: vi.fn(async () => Promise.reject(new Error("the store is busy"))) }),
      deps({ work: vi.fn(async () => ({ tasks: "x" }) as unknown as OpenWork) }),
    ]) {
      const memo = new Set<string>();
      await expect(doneHold(finished(), api, memo)).resolves.toBeUndefined();
      expect(memo.size).toBe(0);
    }
  });

  it("does not ask the app anything when the turn made no done claim", async () => {
    const api = withWork({ tasks: [task("t1", "A")], unanswered: [] });
    const calm = chatOf([user(), reply("Two jobs are still running. I'll report when they finish.")]);
    expect(await doneHold(calm, api, new Set())).toBeUndefined();
    expect(api.work).not.toHaveBeenCalled();
    expect(api.mode).not.toHaveBeenCalled();
  });

  it("does not hold a done claim made as a question, in a code block or behind a not", async () => {
    const api = withWork({ tasks: [task("t1", "A")], unanswered: [] });
    for (const said of ["Is it done?", "```\nall done\n```", "It's not done yet.", "I'm not done."]) {
      expect(await doneHold(chatOf([user(), reply(said)]), api, new Set()), said).toBeUndefined();
    }
  });

  it("holds only a first mate's chat", async () => {
    const api = withWork({ tasks: [task("t1", "A")], unanswered: [] });
    expect(await doneHold({ ...finished(), firstMate: false }, api, new Set())).toBeUndefined();
    expect(api.work).not.toHaveBeenCalled();
  });

  it("drops a hold the chat has moved past while the app was answering", async () => {
    const memo = new Set<string>();
    const open = { tasks: [task("t1", "A")], unanswered: [] };
    expect(await doneHold(finished(), withWork(open, { fresh: () => ({ ...finished(), busy: true }) }), memo)).toBeUndefined();
    expect(memo.size).toBe(0);
  });

  it("holds the open work before the ship check, then the ship check once the work is closed", async () => {
    const memo = new Set<string>();
    const claim = () => chatOf([user(), reply("All done. It's ready to ship.")]);
    const open = { tasks: [task("t1", "A")], unanswered: [] };
    const first = await doneHold(claim(), withWork(open), memo);
    expect(first?.note.text).toBe("Held: tasks still open.");
    // The work is closed; the same claim now meets the ship check, in a project that tests at ship.
    const second = await doneHold(claim(), withWork({ tasks: [], unanswered: [] }), memo);
    expect(second?.note.text).toBe(HOLD_NOTE);
  });
});

// ---- PT-4: a ship check whose end-to-end step did not pass is not a pass --------------------------------------------------

describe("the hold and the end-to-end step", () => {
  type Step = { name: string; outcome: string; detail: string };
  const e2e = (outcome: string, detail: string): Step => ({ name: "End-to-end", outcome, detail });

  const savedRecord = (steps: Step[], head = HEAD) => ({
    project: "/work/app",
    head,
    base: null,
    commitsCovered: 3,
    at: 1,
    outcome: "passed",
    note: null,
    steps: [{ name: "Project checks", outcome: "passed", detail: "ran and passed" }, ...steps],
    tested: [],
    notTested: [],
  });

  /** The app's own answers where `passed` says what the app's pass record says, and `latest` is what its newest record is. */
  function fromApp(passed: boolean, latest: unknown) {
    const backend = {
      head: vi.fn(async () => HEAD),
      passed: vi.fn(async () => passed),
      latest: vi.fn(async () => latest),
    };
    return holdDeps(backend as never, vi.fn(async () => ({ mode: "at-ship" as const })), vi.fn(async () => undefined), () => []);
  }

  it("holds a ready-to-ship claim when the version's end-to-end step could not run, even if the pass record says passed", async () => {
    const held = await doneHold(
      claiming(),
      fromApp(true, savedRecord([e2e("couldNotRun", "No end-to-end check is available for this project.")])),
      new Set(),
    );
    expect(held?.message.text).toContain("no ship check has passed for 0123456");
  });

  it("holds when the end-to-end step failed, or did not run for a reason that is not 'no screen'", async () => {
    for (const step of [e2e("failed", "e2e: its tests failed"), e2e("notRun", "it did not run for another reason")]) {
      const held = await doneHold(claiming(), fromApp(true, savedRecord([step])), new Set());
      expect(held, step.detail).toBeDefined();
    }
  });

  it("lets a pass stand when the step passed, did not apply, or the person switched its tools off", async () => {
    for (const step of [
      e2e("passed", "e2e: replayed"),
      e2e("notRun", "no screen to test"),
      e2e("notRun", "switched off for this project"),
    ]) {
      expect(await doneHold(claiming(), fromApp(true, savedRecord([step])), new Set()), step.detail).toBeUndefined();
    }
    // A record from before the step existed has none.
    expect(await doneHold(claiming(), fromApp(true, savedRecord([])), new Set())).toBeUndefined();
  });

  it("reads only the record for this version, and never holds because the record couldn't be read", async () => {
    const other = savedRecord([e2e("couldNotRun", "No end-to-end check is available for this project.")], NEXT);
    expect(await doneHold(claiming(), fromApp(true, other), new Set())).toBeUndefined();
    const broken = {
      head: vi.fn(async () => HEAD),
      passed: vi.fn(async () => true),
      latest: vi.fn(async () => {
        throw new Error("the app is busy");
      }),
    };
    const api = holdDeps(broken as never, vi.fn(async () => ({ mode: "at-ship" as const })), vi.fn(async () => undefined), () => []);
    expect(await doneHold(claiming(), api, new Set())).toBeUndefined();
    // And the app saying there is no pass is still a hold, whatever the record says.
    expect(await doneHold(claiming(), fromApp(false, savedRecord([e2e("passed", "ok")])), new Set())).toBeDefined();
  });
});

describe("holdDeps: the app's own answers", () => {
  it("reads the open work from the app and keeps a waiting worker of this chat only", async () => {
    const api = holdDeps(
      { head: vi.fn(), passed: vi.fn() } as never,
      vi.fn(async () => ({ mode: "light" as const })),
      vi.fn(async () => ({ tasks: [{ id: "t1", title: "Fix the save bug", status: "working" }], unanswered: [] })),
      () => [
        { id: "w1", ownerSession: "chat-1", title: "Add the export" },
        { id: "w2", ownerSession: "chat-2", title: "Someone else's" },
      ],
    );
    expect(await api.work?.("chat-1")).toEqual({ tasks: [{ id: "t1", title: "Fix the save bug", status: "working" }], unanswered: [] });
    expect(api.waiting?.("chat-1")).toEqual([{ id: "w1", title: "Add the export" }]);
    expect(api.waiting?.("chat-3")).toEqual([]);
  });
});

// PT-5 follow-up: a test the fixer named as a real bug holds the version until the person answers Ship anyway or the test passes.
describe("the hold and a real bug that waits on the person", () => {
  const waiting = (bugs: number, toSort = 0) => vi.fn(async () => ({ toSort, sorting: false, bugs }));

  it("holds a ready-to-ship claim while a named real bug waits on the person, even over a pass", async () => {
    const held = await doneHold(claiming(), deps({ passed: vi.fn(async () => true), sorting: waiting(2) }), new Set());
    expect(held?.message.text).toContain("Not ready to ship yet: 2 failing tests name real bugs and wait on the person.");
    expect(held?.message.text).toContain("Needs you");
    expect(held?.message.text).toContain("Ship anyway");
    // An answer that leaves the test failing comes back at the next ship check, so the way to put it to them is to run one.
    expect(held?.message.text).toContain("Run ship_check");
    expect(held?.note.text).toBe(BUGS_NOTE);
    expect(held?.key).toContain(`${HEAD}:bugs:2`);
  });

  it("says one bug in the singular", async () => {
    const held = await doneHold(claiming(), deps({ sorting: waiting(1) }), new Set());
    expect(held?.message.text).toContain("Not ready to ship yet: 1 failing test names a real bug and waits on the person.");
  });

  it("waits for the test fixer first: tests still to sort are the hold, not the bug", async () => {
    const held = await doneHold(claiming(), deps({ sorting: waiting(1, 2) }), new Set());
    expect(held?.message.text).toContain("2 failing tests");
    expect(held?.message.text).not.toContain("real bug");
  });

  it("holds once for the same bugs and again when the count changes", async () => {
    const memo = new Set<string>();
    const count = waiting(2);
    const api = deps({ sorting: count });
    expect(await doneHold(claiming(), api, memo)).toBeDefined();
    expect(await doneHold(claiming(), api, memo)).toBeUndefined();
    count.mockResolvedValue({ toSort: 0, sorting: false, bugs: 1 });
    expect(await doneHold(claiming(), api, memo)).toBeDefined();
  });

  it("holds nothing for no bugs, an answer it can't read, or an app that can't say", async () => {
    for (const bugs of [0, -1, Number.NaN, 1.5, undefined, "2"]) {
      const sorting = vi.fn(async () => ({ toSort: 0, sorting: false, bugs })) as never;
      expect(await doneHold(claiming(), deps({ passed: vi.fn(async () => true), sorting }), new Set())).toBeUndefined();
    }
  });

  it("reads the bugs from the app's own list: only the ones still waiting count, not the ones the person shipped anyway", async () => {
    const backend = { head: vi.fn(async () => HEAD), passed: vi.fn(async () => true), latest: vi.fn(async () => null) };
    const items = [{ state: "real-bug" }, { state: "shipping-anyway" }, { state: "flaky" }, { state: "to-sort" }, { state: "real-bug" }];
    const read = vi.fn(async () => ({ count: 0, sorting: false, items }));
    const api = holdDeps(backend as never, vi.fn(async () => ({ mode: "at-ship" as const })), vi.fn(async () => undefined), () => [], read);
    expect(await api.sorting?.("/work/app")).toEqual({ toSort: 0, sorting: false, bugs: 2 });
    expect(await doneHold(claiming(), api, new Set())).toBeDefined();
    // Every bug shipped anyway: nothing is held for it.
    const shipped = vi.fn(async () => ({ count: 0, sorting: false, items: [{ state: "shipping-anyway" }] }));
    const none = holdDeps(backend as never, vi.fn(async () => ({ mode: "at-ship" as const })), vi.fn(async () => undefined), () => [], shipped);
    expect(await doneHold(claiming(), none, new Set())).toBeUndefined();
  });
});

// PT-5: failing tests still being sorted at ship mean the version is not ready, whatever a ship check record says.
describe("the hold and tests still being sorted", () => {
  it("holds a ready-to-ship claim while failing tests are waiting to be sorted, even over a pass", async () => {
    const held = await doneHold(
      claiming(),
      deps({ passed: vi.fn(async () => true), sorting: vi.fn(async () => ({ toSort: 3, sorting: true })) }),
      new Set(),
    );
    expect(held?.message.text).toContain("Not ready to ship yet: 3 failing tests are still being sorted by the test fixer.");
    expect(held?.message.text).toContain("run ship_check again");
    expect(held?.note.text).toBe(SORTING_NOTE);
    expect(SORTING_NOTE).toBe("Held: tests still being sorted.");
  });

  it("says one test in the singular, and when no fixer is working says to run the ship check, which starts one, not to wait", async () => {
    const held = await doneHold(claiming(), deps({ sorting: vi.fn(async () => ({ toSort: 1, sorting: false })) }), new Set());
    expect(held?.message.text).toContain("Not ready to ship yet: 1 failing test is waiting to be sorted and no test fixer is working on them.");
    expect(held?.message.text).toContain("Run ship_check: it starts one, then wait for its report.");
    expect(held?.message.text).not.toContain("Wait for its report, then run ship_check again");
  });

  it("holds once for the same list and again when the count changes", async () => {
    const memo = new Set<string>();
    const count = vi.fn(async () => ({ toSort: 2, sorting: true }));
    const api = deps({ sorting: count });
    expect(await doneHold(claiming(), api, memo)).toBeDefined();
    expect(await doneHold(claiming(), api, memo)).toBeUndefined();
    count.mockResolvedValue({ toSort: 1, sorting: true });
    expect(await doneHold(claiming(), api, memo)).toBeDefined();
  });

  it("holds nothing for an empty list, an answer it can't read, or an app that can't say", async () => {
    for (const sorting of [
      vi.fn(async () => ({ toSort: 0, sorting: false })),
      vi.fn(async () => undefined),
      vi.fn(async () => ({ toSort: -2, sorting: true })),
      vi.fn(async () => ({ toSort: Number.NaN, sorting: true })),
      vi.fn(async () => {
        throw new Error("the app is busy");
      }),
    ]) {
      const held = await doneHold(claiming(), deps({ passed: vi.fn(async () => true), sorting: sorting as never }), new Set());
      expect(held).toBeUndefined();
    }
    // Without the dependency at all, the hold is exactly what it was.
    expect(await doneHold(claiming(), deps({ passed: vi.fn(async () => true) }), new Set())).toBeUndefined();
  });

  it("is only for a project that tests at ship", async () => {
    const sorting = vi.fn(async () => ({ toSort: 3, sorting: true }));
    expect(await doneHold(claiming(), deps({ mode: vi.fn(async () => "light" as const), sorting }), new Set())).toBeUndefined();
    expect(sorting).not.toHaveBeenCalled();
  });

  it("reads the app's own list through holdDeps, and a failed read is no answer", async () => {
    const backend = { head: vi.fn(async () => HEAD), passed: vi.fn(async () => true), latest: vi.fn(async () => null) };
    const read = vi.fn(async () => ({ count: 2, sorting: true }));
    const api = holdDeps(backend as never, vi.fn(async () => ({ mode: "at-ship" as const })), vi.fn(async () => undefined), () => [], read);
    expect(await api.sorting?.("/work/app")).toEqual({ toSort: 2, sorting: true });
    expect(await doneHold(claiming(), api, new Set())).toBeDefined();
    const nothing = holdDeps(backend as never, vi.fn(async () => ({ mode: "at-ship" as const })), vi.fn(async () => undefined), () => [], vi.fn(async () => null));
    expect(await nothing.sorting?.("/work/app")).toBeUndefined();
    expect(await doneHold(claiming(), nothing, new Set())).toBeUndefined();
  });
});
