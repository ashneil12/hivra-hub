import { describe, expect, it } from "vitest";
import { LONG_CHAT_THRESHOLD, chatBytes, pickSummaryTree, usesSummaryTree } from "./longChat";

const block = (role: string, text: string, extra: { streaming?: boolean; draft?: boolean } = {}) => ({ role, text, ...extra });

describe("usesSummaryTree", () => {
  it("uses the tree for a long chat, and for any first mate at the threshold", () => {
    expect(usesSummaryTree({ firstMate: true, longChat: true, bytes: 0 })).toBe(true);
    expect(usesSummaryTree({ firstMate: true, longChat: false, bytes: LONG_CHAT_THRESHOLD - 1 })).toBe(false);
    expect(usesSummaryTree({ firstMate: true, longChat: false, bytes: LONG_CHAT_THRESHOLD })).toBe(true);
    expect(usesSummaryTree({ firstMate: false, longChat: true, bytes: LONG_CHAT_THRESHOLD })).toBe(false);
    expect(usesSummaryTree({ firstMate: false, longChat: false, bytes: LONG_CHAT_THRESHOLD * 2 })).toBe(false);
  });

  it("counts finished user and assistant text, as LF, and not tool output", () => {
    const emoji = "👍";
    expect(chatBytes([])).toBe(0);
    expect(chatBytes([block("user", "a\r\nb")])).toBe(3);
    expect(chatBytes([block("tool", "x".repeat(100))])).toBe(0);
    expect(chatBytes([block("user", "x".repeat(50), { streaming: true })])).toBe(0);
    expect(chatBytes([block("assistant", "x".repeat(50), { draft: true })])).toBe(0);
    expect(chatBytes([block("user", emoji)])).toBe(new TextEncoder().encode(emoji).length);
    expect(chatBytes([block("user", ""), block("assistant", undefined as unknown as string)])).toBe(0);
  });
});

describe("pickSummaryTree", () => {
  const big = "x".repeat(LONG_CHAT_THRESHOLD);
  const base = {
    sessionId: "s1",
    mono: true,
    teamId: undefined,
    raw: false,
    hasProviderSession: false,
    blocks: [block("user", big)],
    own: { id: "ed", sessionId: "s1" } as { id: string; longChat?: boolean; sessionId?: string } | undefined,
    lead: undefined as { id: string; longChat?: boolean; sessionId?: string } | undefined,
  };

  it("opens the tree past the threshold even when the setting is off", () => {
    expect(pickSummaryTree(base)).toEqual({ id: "ed", evenWithoutSetting: true });
    expect(pickSummaryTree({ ...base, blocks: [block("user", "short")] })).toBeUndefined();
    expect(pickSummaryTree({ ...base, own: { id: "ed", longChat: true, sessionId: "s1" }, blocks: [block("user", "short")] })).toEqual({
      id: "ed",
      evenWithoutSetting: false,
    });
  });

  it("does not give a room or a second chat the lead's tree", () => {
    expect(pickSummaryTree({ ...base, own: { id: "ed", sessionId: "other" } })).toBeUndefined();
    expect(pickSummaryTree({ ...base, raw: true })).toBeUndefined();
    expect(pickSummaryTree({ ...base, hasProviderSession: true })).toBeUndefined();
    expect(
      pickSummaryTree({
        ...base,
        mono: false,
        teamId: "proj",
        own: undefined,
        lead: { id: "proj-lead", sessionId: "lead-chat" },
      }),
    ).toBeUndefined();
    expect(
      pickSummaryTree({
        ...base,
        mono: false,
        teamId: "proj",
        own: undefined,
        lead: { id: "proj-lead" },
      }),
    ).toEqual({ id: "proj-lead", evenWithoutSetting: true });
    expect(
      pickSummaryTree({
        ...base,
        mono: false,
        teamId: "proj",
        own: undefined,
        blocks: [block("user", "short")],
        lead: { id: "proj-lead" },
      }),
    ).toBeUndefined();
  });
});
