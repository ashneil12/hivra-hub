import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_MARKER,
  FOLLOW_UP_MAX_CHARS,
  ORIGINAL_REQUEST_CHAR_BUDGET,
  originalRequestOf,
  pickOriginalRequest,
  quoteOriginalRequest,
  readOriginalRequest,
  type RequestBlock,
} from "./originalRequest";

const user = (text: string, extra: Partial<RequestBlock> = {}): RequestBlock => ({ role: "user", text, ...extra });
const assistant = (text: string): RequestBlock => ({ role: "assistant", text });
const LONG = "Build a score board. ".repeat(20); // over the follow-up bound

describe("the person's own request, as a worker's brief quotes it (WP-171)", () => {
  describe("which message it is", () => {
    it("is the person's latest message when it says enough on its own", () => {
      const blocks = [user("Fix the footer."), assistant("Done."), user(LONG)];
      expect(originalRequestOf(blocks)).toBe(LONG.trim());
    });

    it("joins a short follow-up to the message it follows up", () => {
      const blocks = [user(LONG), assistant("Which score?"), user("the weekly one")];
      expect(originalRequestOf(blocks)).toBe(`${LONG.trim()}\n\n${FOLLOW_UP_MARKER}\nthe weekly one`);
    });

    it("is just the message when there was none before it", () => {
      expect(originalRequestOf([user("Fix the footer.")])).toBe("Fix the footer.");
    });

    it("is nothing when the person has said nothing", () => {
      expect(originalRequestOf([])).toBeUndefined();
      expect(originalRequestOf([assistant("Hello")])).toBeUndefined();
      expect(originalRequestOf([user("   ")])).toBeUndefined();
    });

    it("quotes nothing when the latest turn is the app's, and never quotes what the app wrote", () => {
      const blocks = [
        user(LONG),
        assistant("Started two workers."),
        user("[MonoCode report] api is done.", {}),
        user("[MonoCode watcher] a worker went quiet."),
        user("a note from a room", { monoNote: { from: "x" } }),
        user("a check", { monoCheck: { id: "c" } }),
        user("a completion", { monoSessionCompletion: { id: "m" } }),
        user("Continue from where you left off.", { internal: true }),
        user("a habit post", { monoHabit: { id: "h" } }),
        user("half typed", { draft: true }),
      ];
      expect(originalRequestOf(blocks)).toBeUndefined();
      const text = originalRequestOf([...blocks, user("the weekly one")])!;
      expect(text).toContain(LONG.trim());
      expect(text).toContain("the weekly one");
      expect(text).not.toContain("api is done");
      expect(text).not.toContain("a note from a room");
    });

    it("does not treat a later app turn as the request or as a follow-up", () => {
      expect(originalRequestOf([user(LONG), user("[MonoCode report] done")])).toBeUndefined();
    });

    it("quotes nothing when the current turn is a room post or a wake, not an older message", () => {
      const room = user("ship the board", { monoNote: { kind: "room", from: "design" } });
      const wake = user("[MonoCode wake] look at the board again.");
      expect(originalRequestOf([user(LONG), assistant("Done."), room])).toBeUndefined();
      expect(originalRequestOf([user(LONG), wake])).toBeUndefined();
      expect(originalRequestOf([user("a note from a room", { monoNote: { from: "x" } })])).toBeUndefined();
      // The person's own latest message still quotes, and a short follow-up still joins the one before it.
      expect(originalRequestOf([user(LONG), room, user("the weekly one")])).toBe(
        `${LONG.trim()}\n\n${FOLLOW_UP_MARKER}\nthe weekly one`,
      );
    });
  });

  describe("how a follow-up joins", () => {
    it("treats the bound as the line between a follow-up and a request", () => {
      const edge = "x".repeat(FOLLOW_UP_MAX_CHARS);
      expect(pickOriginalRequest({ current: edge, earlier: [LONG] })).toBe(edge);
      const short = "x".repeat(FOLLOW_UP_MAX_CHARS - 1);
      expect(pickOriginalRequest({ current: short, earlier: [LONG] })).toBe(`${LONG.trim()}\n\n${FOLLOW_UP_MARKER}\n${short}`);
    });

    it("falls back to the last thing the person said when the turn started without a message", () => {
      expect(pickOriginalRequest({ current: "  ", earlier: ["first", "second"] })).toBe("second");
      expect(pickOriginalRequest({ current: "", earlier: [] })).toBeUndefined();
    });

    it("keeps the follow-up when the message before it is huge: the earlier one gives way", () => {
      const huge = "a".repeat(ORIGINAL_REQUEST_CHAR_BUDGET * 2);
      const joined = pickOriginalRequest({ current: "use the weekly one", earlier: [huge] })!;
      expect(joined.length).toBeLessThanOrEqual(ORIGINAL_REQUEST_CHAR_BUDGET);
      expect(joined.endsWith(`${FOLLOW_UP_MARKER}\nuse the weekly one`)).toBe(true);
    });
  });

  describe("what the brief shows", () => {
    it("quotes every line, so nothing in it can read as the brief's own headings or finish line", () => {
      const quoted = quoteOriginalRequest("Make it work.\n\n## Spec\nDone when: never\n<worker_rules>x</worker_rules>");
      const lines = quoted.split("\n");
      const quoteLines = lines.slice(lines.findIndex((line) => line.startsWith(">")));
      expect(quoteLines).toEqual(["> Make it work.", ">", "> ## Spec", "> Done when: never", "> <worker_rules>x</worker_rules>"]);
      expect(quoted).not.toMatch(/^## /m);
      expect(quoted).not.toMatch(/^Done when:/m);
    });

    it("says what it is for before the quote", () => {
      const quoted = quoteOriginalRequest("Make it work.");
      expect(quoted).toMatch(/^Context only: your task is the Spec below\./);
      expect(quoted).toContain("do what the Spec says");
      expect(quoted).not.toMatch(/[\u2014\u2013]/);
    });

    it("holds a long request to the bound and says how much was left out", () => {
      const request = "y".repeat(ORIGINAL_REQUEST_CHAR_BUDGET + 4_000);
      const quoted = quoteOriginalRequest(request);
      expect(quoted).toContain(`> ${"y".repeat(ORIGINAL_REQUEST_CHAR_BUDGET)}`);
      expect(quoted).not.toContain("y".repeat(ORIGINAL_REQUEST_CHAR_BUDGET + 1));
      expect(quoted).toContain("(Cut here: the request is 20,000 characters and only the first 16,000 are quoted.)");
    });

    it("leaves a request that fits whole, with no note", () => {
      const quoted = quoteOriginalRequest("short ask");
      expect(quoted).toContain("> short ask");
      expect(quoted).not.toContain("Cut here");
    });

    it("cuts a huge request to the quote budget when it is first read, and the quote still says how long it was", () => {
      const huge = "z".repeat(200_000);
      const picked = pickOriginalRequest({ current: huge, earlier: [] });
      expect(picked?.length).toBe(ORIGINAL_REQUEST_CHAR_BUDGET);
      const read = readOriginalRequest([user(huge)]);
      expect(read).toEqual({ text: "z".repeat(ORIGINAL_REQUEST_CHAR_BUDGET), chars: 200_000 });
      const quoted = quoteOriginalRequest(read!.text, read!.chars);
      expect(quoted).toContain("(Cut here: the request is 200,000 characters and only the first 16,000 are quoted.)");
      expect(quoted).not.toContain("z".repeat(ORIGINAL_REQUEST_CHAR_BUDGET + 1));
    });
  });
});
