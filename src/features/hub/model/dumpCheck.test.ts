// @vitest-environment happy-dom
// The light checker (Ash, 21 Oct): one cheap look after a dump, a private check only when something looks missed.
import { beforeEach, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { answeredDump, claimDumpCheck, dumpCheck, dumpCheckPrompt, isDump, parseMissed } from "./dumpCheck";
import { CHECK_PREFIX } from "./hubChecks";

beforeEach(() => localStorage.clear());

const DUMP = "ok so: the footer is cramped, the save button should say when it worked, and we said fridays for the board review right? also dark mode some day maybe";
const block = (id: string, role: "user" | "assistant", text: string, internal = false) => ({ id, role, text, ...(internal ? { internal } : {}) }) as Block;

it("is a dump when it is long or over several lines; a short ask or the app's own turn is not", () => {
  expect(isDump(DUMP + " ".repeat(10) + "x".repeat(150))).toBe(true);
  expect(isDump("one\ntwo\nthree")).toBe(true);
  expect(isDump("fix the save bug")).toBe(false);
  expect(isDump(`[MonoCode report] ${"x".repeat(400)}`)).toBe(false);
});

it("finds Ash's latest dump once the chat has answered it, skipping the app's hidden turns", () => {
  const long = `${DUMP}\nline two\nline three`;
  expect(answeredDump({ blocks: [block("u1", "user", long)] })).toBeUndefined();
  const answered = answeredDump({ blocks: [block("u1", "user", long), block("a1", "assistant", "Footer and save: on it. Fridays, yes.")] });
  expect(answered?.ask.id).toBe("u1");
  expect(answered?.reply).toBe("Footer and save: on it. Fridays, yes.");
  // A hidden report turn after it doesn't hide the dump; a newer short message from Ash does.
  expect(answeredDump({ blocks: [block("u1", "user", long), block("r", "user", "[MonoCode report] x", true), block("a1", "assistant", "ok")] })?.ask.id).toBe("u1");
  expect(answeredDump({ blocks: [block("u1", "user", long), block("a1", "assistant", "ok"), block("u2", "user", "thanks")] })).toBeUndefined();
});

it("asks for NONE or the missed things in Ash's words, and reads the answer", () => {
  const prompt = dumpCheckPrompt(DUMP, "Footer: on it.");
  expect(prompt).toContain(`<message>\n${DUMP}\n</message>`);
  expect(prompt).toContain("exactly NONE");
  expect(parseMissed("NONE")).toEqual([]);
  expect(parseMissed("none.")).toEqual([]);
  expect(parseMissed('- "the save button should say when it worked"\n- fridays for the board review\nnoise')).toEqual(['"the save button should say when it worked"', "fridays for the board review"]);
  expect(parseMissed("I think it's fine")).toEqual([]);
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
