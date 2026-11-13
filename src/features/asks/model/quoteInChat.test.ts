// @vitest-environment happy-dom
// Ash, 13 Nov: "everything here, you should be able to like quote it in the chat ... whether it's working, needs you,
// or you asked". A quoted row goes into the chat's box as a quote, not sent.
import { afterEach, expect, it } from "vitest";
import { getComposerDraft, setComposerDraft } from "../../sessions/model/draftCache";
import { asQuote, quoteAsked, quoteInChat, quoteJob, quoteNeed } from "./quoteInChat";

afterEach(() => {
  setComposerDraft("chief-main", "");
  localStorage.clear();
});

it("says which list a row came from, where it belongs and the item itself", () => {
  expect(quoteNeed({ kind: "question", sentence: "Which take for the boss music?", who: "EXO lead", suggested: "Take A" }, "EXO")).toBe(
    "Needs you · Question · EXO · EXO lead: Which take for the boss music? (Suggested: Take A)",
  );
  expect(quoteNeed({ kind: "stopped", sentence: "Example: out of credits", who: "EXO lead" })).toBe("Needs you · Stopped · EXO lead: Example: out of credits");
  expect(quoteAsked({ title: "Fix the  Safari export", status: "Open", said: 2 })).toBe("You asked: Fix the Safari export (Open · said 2 times)");
  expect(quoteAsked({ title: "Draft the email", status: "Done", note: "Sent to Priya" })).toBe("You asked: Draft the email (Done · Sent to Priya)");
  expect(quoteJob({ title: "Light the arena", project: "EXO", lead: "EXO lead", state: "Working" })).toBe("Working · EXO · EXO lead: Light the arena (Working)");
});

it("marks every line as quoted", () => {
  expect(asQuote("one\n\ntwo\r\n")).toBe("> one\n>\n> two");
  expect(asQuote("   ")).toBe("");
});

it("puts the quote under what is already typed in that chat, once", () => {
  setComposerDraft("chief-main", "About this:");
  expect(quoteInChat("chief-main", "Working · EXO: Light the arena")).toBe(true);
  expect(getComposerDraft("chief-main")).toBe("About this:\n\n> Working · EXO: Light the arena\n\n");
  quoteInChat("chief-main", "Working · EXO: Light the arena");
  expect(getComposerDraft("chief-main")).toBe("About this:\n\n> Working · EXO: Light the arena\n\n");
  expect(quoteInChat(undefined, "Anything")).toBe(false);
  expect(quoteInChat("chief-main", "  ")).toBe(false);
});
