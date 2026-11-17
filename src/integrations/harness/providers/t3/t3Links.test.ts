import { afterEach, describe, expect, it } from "vitest";
import { setT3ThreadChats, t3ShownText } from "./t3Links";

const LINK = "[EXO lead](t3-thread://v2/env-1/thread-exo)";

describe("the engine's links to a conversation, as a chat shows them", () => {
  afterEach(() => setT3ThreadChats(() => undefined));

  it("links a conversation that is a chat here to that chat, and keeps only the name of any other", () => {
    setT3ThreadChats((thread) => (thread === "thread-exo" ? "chat-exo" : undefined));
    expect(t3ShownText(`Check ${LINK} for progress.`, true)).toBe("Check [EXO lead](hivra://local/chat/chat-exo) for progress.");
    expect(t3ShownText("See [Example other](t3-thread://v2/env-1/thread%3Asubagent%3Aabc).", true)).toBe("See Example other.");
    expect(t3ShownText("A [web link](https://example.com) and [x] stay.", true)).toBe("A [web link](https://example.com) and [x] stay.");
  });

  it("holds a link back while it is being written, so what was shown is only ever added to", () => {
    setT3ThreadChats(() => "chat-exo");
    const text = `Check ${LINK} now.`;
    let shown = "";
    for (let end = 1; end <= text.length; end += 1) {
      const next = t3ShownText(text.slice(0, end), false);
      expect(next.startsWith(shown)).toBe(true);
      expect(next).not.toContain("t3-thread");
      shown = next;
    }
    expect(shown).toBe("Check [EXO lead](hivra://local/chat/chat-exo) now.");
    // A bracket that turns out to be something else is let go as soon as that is known.
    expect(t3ShownText("Example: a [note", false)).toBe("Example: a ");
    expect(t3ShownText("Example: a [note] and", false)).toBe("Example: a [note] and");
    expect(t3ShownText("Example: a [page](https://ex", false)).toBe("Example: a [page](https://ex");
    expect(t3ShownText("Example: a [note", true)).toBe("Example: a [note");
  });
});
