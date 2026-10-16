import { describe, test, expect } from "vitest";
import { mergeContextUsage, contextRatio, contextPercent } from "./contextUsage";
import { contextUsedFromAssistant, contextFromResult } from "../../../integrations/harness/providers/claude/claudeProtocol";

/** Real record shapes from a routed DeepSeek session (1M window, `iterations: []` every turn). */
const assistant = (input: number, out: number) => ({
  type: "assistant",
  message: { role: "assistant", usage: {
    input_tokens: input, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, output_tokens: out, iterations: [],
  } },
});

describe("the context ring can render while a turn is running", () => {
  test("mid-turn the stream carries the level but no window", () => {
    const used = contextUsedFromAssistant(assistant(275380, 385) as any);
    expect(used).toBe(275765);
    // Nothing in an `assistant` record names the window — that is why the bar was missing.
    const midTurn = mergeContextUsage(undefined, { used, window: undefined });
    expect(midTurn).toEqual({ used: 275765 });
    expect(contextRatio(midTurn)).toBeNull();
  });

  test("the seeded window is what makes the ring draw", () => {
    // What seedRoutedWindow emits before the turn: window only, no level yet.
    const seeded = mergeContextUsage(undefined, { window: 1048576 });
    expect(seeded).toEqual({ used: 0, window: 1048576 });
    // Then the first assistant reading arrives and the ring has both halves.
    const live = mergeContextUsage(seeded, { used: 275765 });
    expect(contextRatio(live)).toBeCloseTo(0.263, 3);
    expect(contextPercent(live)).toBe(26);
  });

  test("a seeded window is not lost by a later window-less reading", () => {
    const live = mergeContextUsage({ used: 100, window: 1048576 }, { used: 275765 });
    expect(live).toEqual({ used: 275765, window: 1048576 });
  });

  test("the result's own window still wins when the provider reports one", () => {
    const fromResult = contextFromResult({
      type: "result", num_turns: 1,
      usage: { input_tokens: 275380, output_tokens: 385, iterations: [] },
      modelUsage: { "deepseek-ai/DeepSeek-V4.1-Flash": { contextWindow: 1048576 } },
    } as any);
    expect(fromResult).toEqual({ used: 275765, window: 1048576 });
  });

  test("an unknown window stays unknown rather than guessed", () => {
    // Cursor's ACP stream carries no usage at all: no ring, not a made-up one.
    expect(contextRatio(mergeContextUsage(undefined, { used: 5000 }))).toBeNull();
  });
});
