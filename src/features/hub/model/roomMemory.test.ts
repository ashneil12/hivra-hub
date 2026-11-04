// A room belongs to a project, so each seat's room turn starts on that project's memory, the same primer its Lead gets
// (hubMemoryPrimer.ts): in the 20 Oct baseline a reviewer challenged the Lead's memory-backed facts because the room
// seats had never read them. Given once per conversation of the seat's chat, again when the memory changed, never when
// nothing can say (and with no reader at all since Ash OS is retired, WP-04, there is none).
import { afterEach, expect, it } from "vitest";
import { forgetMemoryPrimers, type MemoryPrimer } from "./hubMemoryPrimer";
import { forgetRoomMemory, roomMemory } from "./roomMemory";

const PRIMER: MemoryPrimer = {
  project: "tally",
  name: "Tally",
  text: "Current memory of Tally (tally): what holds now.\n\n## Tally: decisions, newest first\n- Brand colour is teal #0F766E [20 Oct]",
  memory_dir: "/m/tally",
};
const seat = (patch: Partial<{ id: string; providerSessionId: string; harness: string }> = {}) => ({
  id: "mono-ed",
  providerSessionId: "conv-1",
  harness: "claude",
  ...patch,
});

afterEach(() => {
  forgetRoomMemory();
  forgetMemoryPrimers();
});

it("a seat's first room turn in a project's room carries the project's memory; later turns in that conversation don't", async () => {
  let calls = 0;
  const call = async (action: string, payload: Record<string, unknown>) => {
    calls++;
    expect(action).toBe("memory-primer");
    expect(payload).toEqual({ project: "tally" });
    return PRIMER;
  };
  const first = await roomMemory(seat(), "tally", { call });
  expect(first?.block).toContain("This room is the tally project's");
  expect(first?.block).toContain("<project_memory>");
  expect(first?.block).toContain("Brand colour is teal #0F766E");
  // No chat has memory tools now: it is told where the files are.
  expect(first?.block).toContain("For more, read never.md");
  // Only once the turn went in does it count as read.
  expect((await roomMemory(seat(), "tally", { call }))?.block).toContain("<project_memory>");
  first!.delivered();
  expect(await roomMemory(seat(), "tally", { call })).toBeUndefined();
  // Another seat, a new conversation (a rotated chat), another project's room, or changed memory: it goes in again.
  expect((await roomMemory(seat({ id: "mono-cam" }), "tally", { call }))?.block).toContain("<project_memory>");
  expect((await roomMemory(seat({ providerSessionId: "conv-2" }), "tally", { call }))?.block).toContain("<project_memory>");
  forgetMemoryPrimers();
  const changed = { ...PRIMER, text: `${PRIMER.text}\n- Sharing is private [20 Oct]` };
  const next = await roomMemory(seat(), "tally", { call: async () => changed });
  expect(next?.block).toContain("Sharing is private");
  expect(calls).toBeGreaterThan(0);
});

it("no primer (no reader, an error, or no such project) adds nothing; another engine is told where to read", async () => {
  expect(await roomMemory(seat(), "tally")).toBeUndefined();
  expect(await roomMemory(seat(), "tally", { call: async () => { throw new Error("offline"); } })).toBeUndefined();
  expect(await roomMemory(seat(), "tally", { call: async () => ({}) })).toBeUndefined();
  const codex = await roomMemory(seat({ harness: "codex" }), "tally", { call: async () => PRIMER });
  expect(codex?.block).toContain("For more, read never.md");
});
