// @vitest-environment happy-dom
// The light checker (Ash, 21 Oct): one cheap look after a dump, a private check only when something looks missed.
// B5 + I6 (22 Oct): any hub chat, a plain New-session one included; the dump is written down when it arrives; the look
// sees what the chat actually built, not only what its reply says.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { askStore, setAskStore } from "../../asks/model/askStore";
import { routeHubDump } from "../../asks/model/hubRoute";
import { freshAskStore, openAsksIn as openAsks } from "../../asks/testbed/hubAsks";
import type { Block, Session } from "../../sessions/model/session";
import {
  builtEvidence,
  claimDumpCheck,
  dumpCheck,
  dumpCheckPrompt,
  isDump,
  lastUserBlockId,
  lookAtDumps,
  noteDumps,
  parseMissed,
  readDumpNotes,
  replyAfter,
} from "./dumpCheck";
import { CHECK_PREFIX } from "./hubChecks";

// The asks go into the one ask ledger (asks/model/asks.ts); this file holds the dump check's own notes and looks.
beforeEach(() => {
  localStorage.clear();
  freshAskStore();
});
afterEach(() => setAskStore(undefined));

const DUMP =
  "ok so: the footer is cramped, the save button should say when it worked\nand we said fridays for the board review right? also dark mode some day maybe\nalso the settings panel needs a tidy";
const block = (id: string, role: "user" | "assistant", text: string, extra: Partial<Block> = {}) =>
  ({ id, role, text, ...extra }) as Block;
const tool = (id: string, extra: Record<string, unknown>) => ({ id, role: "tool", tool: extra }) as Block;
const session = (id: string, blocks: Block[], extra: Record<string, unknown> = {}) =>
  ({ id, blocks, busy: false, ...extra }) as unknown as Session;
const edit = (id: string, path: string) => tool(id, { callId: id, kind: "edit", status: "completed", title: `Edit ${path}`, paths: [path] });
const shell = (id: string, title: string, detail = "", status = "completed") =>
  tool(id, { callId: id, kind: "execute", status, title, detail });

it("is a dump when it asks for something, is long or is over several lines; chatter and the app's own turn are not", () => {
  expect(isDump(DUMP + " ".repeat(10) + "x".repeat(150))).toBe(true);
  expect(isDump("one\ntwo\nthree")).toBe(true);
  // A short ask is enough now (B5): it goes into the ledger and is checked like any dump.
  expect(isDump("fix the save bug")).toBe(true);
  expect(isDump("thanks!")).toBe(false);
  expect(isDump("ok")).toBe(false);
  expect(isDump("nice, that works")).toBe(false);
  expect(isDump(`[MonoCode report] ${"x".repeat(400)}`)).toBe(false);
});

it("finds a chat's latest message from Ash, so a new one is noticed", () => {
  expect(lastUserBlockId({ blocks: [] })).toBe("");
  expect(lastUserBlockId({ blocks: [block("u1", "user", "a"), block("d", "user", "draft", { draft: true })] })).toBe("u1");
  expect(lastUserBlockId({ blocks: [block("u1", "user", "a"), block("a1", "assistant", "b")] })).toBe("u1");
});

it("writes a dump down when it arrives, before any answer exists, and keeps it across a restart", async () => {
  const now = Date.now();
  const busy = session("chat-1", [block("u1", "user", DUMP, { startedAt: now })], { busy: true });
  noteDumps([busy], now);
  const notes = readDumpNotes();
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ chatId: "chat-1", blockId: "u1" });
  // The chat is quit mid-answer and comes back with no reply at all: the note is still there, and the look offers a
  // "never answered" check instead of silently losing it.
  const look = vi.fn(async () => "NONE");
  const offered: unknown[] = [];
  await lookAtDumps(
    [session("chat-1", [block("u1", "user", DUMP, { startedAt: now })])],
    look,
    (checks) => offered.push(...checks),
    { now },
  );
  expect(look).not.toHaveBeenCalled();
  expect(offered).toHaveLength(1);
  expect((offered[0] as { id: string; finding: string }).id).toBe("dc-u1-unanswered");
  expect((offered[0] as { finding: string }).finding).toBe("- the whole message was never answered");
  expect(readDumpNotes()).toEqual([]);
});

it("still writes down a dump that a short follow-up arrived after", () => {
  noteDumps([session("chat-1", [block("u1", "user", DUMP), block("u2", "user", "thanks")])], Date.now());
  expect(readDumpNotes().map((note) => note.blockId)).toEqual(["u1"]);
});

it("leaves an old answered dump alone, so nothing sweeps the backlog", () => {
  const now = Date.now();
  const old = session("chat-1", [
    block("u1", "user", DUMP, { startedAt: now - 3 * 60 * 60 * 1000 }),
    block("a1", "assistant", "Footer and save: on it."),
  ]);
  noteDumps([old], now);
  expect(readDumpNotes()).toEqual([]);
});

it("checks a dump in a plain New-session chat, not only Mono or coding-team chats", async () => {
  const look = vi.fn(async () => '- "the save button should say when it worked"');
  const offered: unknown[] = [];
  await lookAtDumps(
    [session("chat-1", [block("u1", "user", DUMP), block("a1", "assistant", "Footer: on it.")])],
    look,
    (checks) => offered.push(...checks),
  );
  expect(look).toHaveBeenCalledTimes(1);
  expect(offered).toHaveLength(1);
  expect((offered[0] as { owner: string }).owner).toBe("chat-1");
  // Each dump is looked at once: the note is gone and a second pass does no work.
  await lookAtDumps(
    [session("chat-1", [block("u1", "user", DUMP), block("a1", "assistant", "Footer: on it.")])],
    look,
    (checks) => offered.push(...checks),
  );
  expect(look).toHaveBeenCalledTimes(1);
  expect(offered).toHaveLength(1);
});

it("checks one short ask in a plain New-session chat, and writes it into the ledger", async () => {
  const asked = Date.now() - 60_000;
  const look = vi.fn(async () => '- "fix the save bug"');
  const offered: unknown[] = [];
  const chat = session("chat-1", [
    block("u1", "user", "fix the save bug", { startedAt: asked }),
    block("a1", "assistant", "Where does it fail?"),
  ]);
  // The dump noticed for the first time is written into the ask ledger (the app hands it to hubRoute.ts), with the time he sent it.
  const routed: Promise<unknown>[] = [];
  await lookAtDumps([chat], look, (checks) => offered.push(...checks), { onNewDump: (dump) => routed.push(routeHubDump(dump, () => undefined, askStore())) });
  await Promise.all(routed);
  expect(look).toHaveBeenCalledTimes(1);
  expect(offered).toHaveLength(1);
  expect((offered[0] as { id: string }).id).toBe("dc-u1");
  const rows = openAsks("chat-1");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ blockId: "u1", title: "fix the save bug", words: "fix the save bug", at: asked });
});

it("hands each dump to the ask ledger once, when it is first noticed, and never writes an ask of its own", () => {
  const now = Date.now();
  const seen: unknown[] = [];
  const chat = session("chat-1", [block("u1", "user", DUMP, { startedAt: now - 5_000 })], { busy: true });
  noteDumps([chat], now, undefined, (dump) => seen.push(dump));
  noteDumps([chat], now + 1000, undefined, (dump) => seen.push(dump));
  expect(seen).toEqual([{ chatId: "chat-1", blockId: "u1", text: DUMP, at: now - 5_000 }]);
  // The dump check keeps its notes and nothing else: the old hub ledger's key is never written.
  expect(localStorage.getItem("monocode:hub-ask-ledger")).toBeNull();
});

it("leaves chats alone while they are busy or queued, and never checks a worker or the checker's own chat", async () => {
  const look = vi.fn(async () => "- something");
  const offered: unknown[] = [];
  const blocks = (id: string) => [block(id, "user", DUMP), block(`${id}-a`, "assistant", "ok")];
  await lookAtDumps(
    [
      session("chat-1", blocks("u1"), { busy: true }),
      session("chat-2", blocks("u2"), { queuedMessages: ["hi"] }),
      session("app-worker", blocks("u3")),
      session("checker", blocks("u4")),
    ],
    look,
    (checks) => offered.push(...checks),
    { skip: (id) => id === "checker" },
  );
  expect(look).not.toHaveBeenCalled();
  expect(offered).toEqual([]);
  // Still waiting: the notes stay for when those chats are free; a worker never owns a check, so it is not noted.
  expect(readDumpNotes().map((note) => note.chatId).sort()).toEqual(["chat-1", "chat-2"]);
});

it("hands the look what the chat built: files changed, the commit and the checks it ran", async () => {
  const look = vi.fn(async () => "NONE");
  const blocks = [
    block("u1", "user", DUMP),
    edit("t1", "src/a.ts"),
    edit("t2", "src/b.ts"),
    shell("t3", "git commit -m \"footer\"", "[hub-export abc1234] say when saving worked"),
    shell("t4", "npm run check", "Tests 12 passed\nTests 1 failed"),
    shell("t5", "npx tsc --noEmit", ""),
    shell("t6", "npm run build", ""),
    shell("t7", "npm run check", "boom", "failed"),
    block("a1", "assistant", "Done: footer fixed, save confirms."),
  ];
  await lookAtDumps([session("chat-1", blocks)], look, () => undefined);
  const prompt = look.mock.calls[0][0] as unknown as string;
  expect(prompt).toContain("<what the chat built>");
  expect(prompt).toContain("- changed src/a.ts, src/b.ts");
  expect(prompt).toContain("- committed say when saving worked");
  expect(prompt).toContain("- ran npm run check (12 passed, 1 failed)");
  expect(prompt).toContain("- ran npx tsc --noEmit");
  expect(prompt).not.toContain("npm run build");
  // The failed run keeps its command out of the evidence (only successful tool calls count).
  expect(prompt.match(/ran npm run check/g)).toHaveLength(1);
});

it("still compares when the chat built something but said nothing", async () => {
  const look = vi.fn(async () => "- dark mode");
  const offered: unknown[] = [];
  await lookAtDumps([session("chat-1", [block("u1", "user", DUMP), edit("t1", "src/a.ts")])], look, (checks) =>
    offered.push(...checks),
  );
  expect((look.mock.calls[0][0] as unknown as string)).toContain("- changed src/a.ts");
  expect(offered).toHaveLength(1);
});

it("collects evidence from successful tools only, and says what a check reported", () => {
  const blocks = [
    edit("t1", "src/a.ts"),
    tool("t2", { callId: "t2", kind: "edit", status: "failed", title: "Edit src/b.ts", paths: ["src/b.ts"] }),
    shell("t3", "git commit -m x", "nothing to commit"),
    shell("t4", "cargo test", "test result: ok. 40 passed; 0 failed", "success"),
    block("a1", "assistant", "ok"),
  ];
  expect(builtEvidence(blocks, -1)).toEqual(["changed src/a.ts", "committed", "ran cargo test (40 passed, 0 failed)"]);
  expect(builtEvidence(blocks, 4)).toEqual([]);
});

it("asks for NONE or the missed things in Ash's words, and reads the answer", () => {
  const prompt = dumpCheckPrompt(DUMP, "Footer: on it.");
  expect(prompt).toContain(`<message>\n${DUMP}\n</message>`);
  expect(prompt).toContain("exactly NONE");
  // Without evidence the prompt is exactly the one from before (the golden prompt fixture in userName.test.ts).
  expect(dumpCheckPrompt(DUMP, "Footer: on it.", [])).toBe(prompt);
  expect(prompt).not.toContain("<what the chat built>");
  expect(parseMissed("NONE")).toEqual([]);
  expect(parseMissed("none.")).toEqual([]);
  expect(parseMissed('- "the save button should say when it worked"\n- fridays for the board review\nnoise')).toEqual([
    '"the save button should say when it worked"',
    "fridays for the board review",
  ]);
  expect(parseMissed("I think it's fine")).toEqual([]);
});

it("adds what was built after the usual comparison, and counts it as handled", () => {
  const prompt = dumpCheckPrompt(DUMP, "Footer: on it.", ["changed src/a.ts", "ran npm run check (12 passed)"]);
  expect(prompt).toContain("- changed src/a.ts\n- ran npm run check (12 passed)\n</what the chat built>");
  expect(prompt).toContain("counts as handled, even when the reply doesn't mention it");
});

it("keeps the reply as what the chat said after the dump", () => {
  const blocks = [block("a0", "assistant", "earlier"), block("u1", "user", DUMP), block("a1", "assistant", " one "), block("a2", "assistant", "two")];
  expect(replyAfter(blocks, 1)).toBe("one\n\ntwo");
});

it("turns a finding into one private check for the owning chat, answered Right or Fixed, and looks at each dump once", () => {
  const check = dumpCheck("chat-1", block("u1", "user", DUMP), ["the save button should say when it worked"]);
  expect(check).toMatchObject({ id: "dc-u1", owner: "chat-1", chatId: "chat-1", dumpId: "u1" });
  expect(check.prompt.startsWith(CHECK_PREFIX)).toBe(true);
  expect(check.prompt).toContain("- the save button should say when it worked\nIs this right?");
  expect(check.prompt).toContain('"Right:" or "Fixed:"');
  expect(claimDumpCheck("u1")).toBe(true);
  expect(claimDumpCheck("u1")).toBe(false);
});

// r61: verify-live's crash_loop_capped flake (28 Oct, evidence 20261028-174828-b222). The Lead stopped resuming after
// three restarts, then a "never answered" check on the app's own resend started it a fourth time behind Ash's back.
it("never sends a check into a chat that stopped resuming itself, nor counts the app's resend as Ash's message", async () => {
  const now = Date.now();
  const stopped = session("chat-1", [
    block("u1", "user", DUMP, { startedAt: now }),
    { id: "s1", role: "system", text: "stopped", notice: "resume-stopped" } as Block,
  ]);
  const offered: unknown[] = [];
  await lookAtDumps([stopped], vi.fn(async () => "NONE"), (checks) => offered.push(...checks), { now });
  expect(offered).toEqual([]);
  // Ash's message waits for him; the look comes back to it once he writes and the chat moves on.
  expect(readDumpNotes().map((note) => note.blockId)).toEqual(["u1"]);

  localStorage.clear();
  const resent = `MonoCode Hub restarted before this message reached you, so it is sent again:\n\n${DUMP}`;
  noteDumps([session("chat-2", [block("r1", "user", resent, { startedAt: now })])], now);
  expect(readDumpNotes()).toEqual([]);
});
