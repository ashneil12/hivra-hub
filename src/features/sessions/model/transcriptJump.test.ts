import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTranscriptJump,
  findAskedBlock,
  peekTranscriptJump,
  pendingTranscriptAsk,
  requestTranscriptAsk,
  requestTranscriptJump,
  resetTranscriptJumps,
  resolveTranscriptAsks,
  setTranscriptAskChats,
  subscribeTranscriptJump,
  type AskBlock,
} from "./transcriptJump";

it("keeps the newest requested message until its navigation completes", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeTranscriptJump(listener);
  requestTranscriptJump("search-test", "old");
  const old = peekTranscriptJump("search-test")!;
  requestTranscriptJump("search-test", "new");
  const latest = peekTranscriptJump("search-test")!;

  clearTranscriptJump("search-test", old.token);
  expect(peekTranscriptJump("search-test")).toEqual(latest);
  clearTranscriptJump("search-test", latest.token);
  expect(peekTranscriptJump("search-test")).toBeNull();
  expect(listener).toHaveBeenCalledTimes(3);
  unsubscribe();
});

// Ash, 11 Nov: an Inbox card's Open chat lands on the message that asked, not on the chat's latest one.
describe("the message that asked", () => {
  const chat: AskBlock[] = [
    { id: "u1", role: "user", text: "How is the boss music coming along?", startedAt: 1_000 },
    { id: "t1", role: "tool", text: "ran the mix" },
    { id: "a1", role: "assistant", text: "Two takes are ready.\n\n**Which take** for the boss music? I'd go with take A." },
    { id: "u2", role: "user", text: "And the controller layout?", startedAt: 5_000 },
    { id: "a2", role: "assistant", text: "Dodge is on the right bumper now." },
    { id: "u3", role: "user", text: "Which take for the boss music? Remind me later.", startedAt: 9_000 },
    { id: "n3", role: "assistant", text: "Which take for the boss music? (a note the app added)", internal: true },
    { id: "a3", role: "assistant", text: "Will do." },
  ];

  afterEach(() => resetTranscriptJumps());

  it("is the newest thing the agent said that holds the ask's words, never the person's own message or a hidden note", () => {
    expect(findAskedBlock(chat, { text: "Which take for the boss music?" })).toEqual({ blockId: "a1", query: "for the boss music?" });
  });

  it("reads past the asker's name, markdown and line breaks, and falls back to the ask's longest sentence", () => {
    expect(findAskedBlock(chat, { text: "EXO lead asks: Which take for the boss music?" })?.blockId).toBe("a1");
    expect(findAskedBlock(chat, { text: "Two takes are ready. Which take for the boss music? Pick one today." })?.blockId).toBe("a1");
  });

  it("with the words nowhere, is the last thing the agent said in the turn that was running when it was asked", () => {
    expect(findAskedBlock(chat, { text: "Pick the headline", at: 6_000 })).toEqual({ blockId: "a2" });
    expect(findAskedBlock(chat, { text: "Pick the headline", at: 1_500 })).toEqual({ blockId: "a1" });
  });

  it("a turn that had ended well before the ask did not ask it", () => {
    const ended: AskBlock[] = [
      { id: "u1", role: "user", text: "Morning.", startedAt: 1_000, durationMs: 4_000 },
      { id: "a1", role: "assistant", text: "Morning. Nothing needs you." },
    ];
    expect(findAskedBlock(ended, { text: "Pick the headline", at: 5_500 })).toEqual({ blockId: "a1" });
    expect(findAskedBlock(ended, { text: "Pick the headline", at: 10 * 60_000 })).toBeNull();
  });

  it("is nothing when neither the words nor the time can tell, so the chat stays on its latest message", () => {
    expect(findAskedBlock(chat, { text: "Pick the headline" })).toBeNull();
    expect(findAskedBlock(chat, { text: "Pick the headline", at: 500 })).toBeNull();
    expect(findAskedBlock([{ id: "a", role: "assistant", text: "No times here." }], { text: "Pick the headline", at: 500 })).toBeNull();
  });

  it("a chat that is already loaded jumps at once", () => {
    const off = setTranscriptAskChats(() => [{ id: "exo", blocks: chat }]);
    requestTranscriptAsk("exo", { text: "Which take for the boss music?" });
    expect(peekTranscriptJump("exo")).toMatchObject({ blockId: "a1" });
    expect(pendingTranscriptAsk("exo")).toBeNull();
    off();
  });

  it("a chat that loads afterwards jumps when its blocks arrive", () => {
    requestTranscriptAsk("exo", { text: "Which take for the boss music?" }, 0);
    resolveTranscriptAsks([{ id: "exo", blocks: [] }, { id: "other", blocks: chat }], 100);
    expect(peekTranscriptJump("exo")).toBeNull();
    expect(pendingTranscriptAsk("exo")).toEqual({ text: "Which take for the boss music?" });
    resolveTranscriptAsks([{ id: "exo", blocks: chat }], 200);
    expect(peekTranscriptJump("exo")).toMatchObject({ blockId: "a1" });
    expect(pendingTranscriptAsk("exo")).toBeNull();
  });

  it("an ask that waited too long, or whose message can't be told, is dropped and moves nothing", () => {
    requestTranscriptAsk("late", { text: "Which take for the boss music?" }, 0);
    resolveTranscriptAsks([{ id: "late", blocks: chat }], 60_000);
    expect(peekTranscriptJump("late")).toBeNull();
    expect(pendingTranscriptAsk("late")).toBeNull();

    requestTranscriptAsk("exo", { text: "Pick the headline" }, 0);
    resolveTranscriptAsks([{ id: "exo", blocks: chat }], 100);
    expect(peekTranscriptJump("exo")).toBeNull();
    expect(pendingTranscriptAsk("exo")).toBeNull();
  });

  it("an empty ask asks for nothing", () => {
    requestTranscriptAsk("exo", { text: "   " });
    requestTranscriptAsk("", { text: "Which take?" });
    expect(pendingTranscriptAsk("exo")).toBeNull();
  });
});
