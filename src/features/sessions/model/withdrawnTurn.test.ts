// WP-243: a turn Ash stopped, or one the provider failed, is withdrawn: its words stay visible but stop counting.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "./session";
import { isWithdrawnTurn, withdrawRunningTurn } from "./withdrawnTurn";

const base = { id: "s", harness: "claude", model: "m", modelSettings: {}, runtimeMode: "supervised", title: "t", cwd: "/tmp/example" } as unknown as Session;

describe("a withdrawn turn", () => {
  it("marks the running turn's message, and every message steered into it, when Ash stops it", () => {
    const blocks: Block[] = [
      { id: "old", role: "user", text: "Example: earlier", startedAt: 1 },
      { id: "a", role: "assistant", text: "done" },
      { id: "start", role: "user", text: "Example: deploy it", startedAt: 2 },
      { id: "steer", role: "user", text: "Example: and publish", sentAt: 3 },
    ];
    const stopped = withdrawRunningTurn({ ...base, busy: true, blocks }, "stopped");
    expect(stopped.blocks.map((b) => b.withdrawn)).toEqual([undefined, undefined, "stopped", "stopped"]);
    // Still in the chat, words and all.
    expect(stopped.blocks.map((b) => b.text)).toEqual(blocks.map((b) => b.text));
  });

  it("leaves a chat that isn't running as it was", () => {
    const session = { ...base, busy: false, blocks: [{ id: "u", role: "user", text: "Example: hi", startedAt: 1 } as Block] };
    expect(withdrawRunningTurn(session, "stopped")).toBe(session);
  });

  it("reads a provider failure from the error notice that ended the turn", () => {
    const blocks: Block[] = [
      { id: "u1", role: "user", text: "Example: one" },
      { id: "e", role: "system", text: "Overloaded", notice: "error" },
      { id: "u2", role: "user", text: "Example: two" },
      { id: "a", role: "assistant", text: "ok" },
    ];
    expect(isWithdrawnTurn(blocks, 0)).toBe(true);
    expect(isWithdrawnTurn(blocks, 2)).toBe(false);
    expect(isWithdrawnTurn(blocks, 3)).toBe(false);
  });
});
