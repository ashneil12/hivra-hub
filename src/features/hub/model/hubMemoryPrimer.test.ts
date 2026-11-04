// The memory a project's Lead and its workers start with (hubMemoryPrimer.ts): read through the caller's own reader
// (none since Ash OS is retired, WP-04) for the chat's own project only, cached briefly, never holding a send up for long, and worded for what the chat can do next (read
// more from its files: no chat has memory tools since Ash OS is retired).
import { afterEach, describe, expect, it, vi } from "vitest";
import { setHubMcpServers, type HubChatLookups } from "./hubMcp";
import {
  fetchMemoryPrimer,
  forgetMemoryPrimers,
  leadMemoryBlock,
  memoryPrimerBlock,
  PRIMER_TTL_MS,
  workerMemoryBlock,
  type MemoryPrimer,
} from "./hubMemoryPrimer";

const PRIMER: MemoryPrimer = {
  project: "hivra",
  name: "Hivra",
  text: "Current memory of Hivra (hivra) and how Ash works: what holds now.\n\n## Hivra: never do\n- Never delete a customer VM as a fix [14 Oct]\n\n## How Ash works (ash: Ash's global memory, every project): never do\n- Codex is for image generation only [15 Oct]",
  lines: 2,
  more: 0,
  memory_dir: "/Users/ash/agent-memory/hivra",
  global_dir: "/Users/ash/agent-memory/ash",
};

const lookups: HubChatLookups = {
  monoOf: (id) => ({ "chat-hivra": { id: "hivra-lead" }, "chat-cos": { id: "ada" } })[id],
  habitRunMono: () => undefined,
  isLead: (id) => id.endsWith("-lead"),
  leadProject: (id) => (id === "hivra-lead" ? "hivra" : undefined),
};

afterEach(() => {
  forgetMemoryPrimers();
  setHubMcpServers(undefined);
  vi.useRealTimers();
});

describe("reading the primer", () => {
  it("asks the reader for that project, once per minute, and one call at a time", async () => {
    const call = vi.fn(async () => PRIMER);
    let now = 1_000;
    const [a, b] = await Promise.all([
      fetchMemoryPrimer("hivra", { call, now: () => now }),
      fetchMemoryPrimer("hivra", { call, now: () => now }),
    ]);
    expect(a).toEqual(PRIMER);
    expect(b).toEqual(PRIMER);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("memory-primer", { project: "hivra" });
    now += PRIMER_TTL_MS - 1;
    await fetchMemoryPrimer("hivra", { call, now: () => now });
    expect(call).toHaveBeenCalledTimes(1);
    now += 2;
    await fetchMemoryPrimer("hivra", { call, now: () => now });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("is nothing (and not cached) when the reader is down, slow or answers something else", async () => {
    expect(await fetchMemoryPrimer("hivra", { call: async () => Promise.reject(new Error("down")) })).toBeUndefined();
    expect(await fetchMemoryPrimer("hivra", { call: async () => ({ project: "hivra" }) })).toBeUndefined();
    expect(await fetchMemoryPrimer("hivra", { call: async () => ({ ...PRIMER, text: "  " }) })).toBeUndefined();
    vi.useFakeTimers();
    const slow = fetchMemoryPrimer("hivra", { call: () => new Promise(() => undefined), timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    expect(await slow).toBeUndefined();
    vi.useRealTimers();
    const call = vi.fn(async () => PRIMER);
    expect(await fetchMemoryPrimer("hivra", { call })).toEqual(PRIMER);
  });

  it("is nothing at all with no reader: nothing outside the app is asked", async () => {
    expect(await fetchMemoryPrimer("hivra")).toBeUndefined();
  });
});

describe("the block a session reads", () => {
  it("the memory, then where its files are; own project and ash only; a Lead saves Ash's calls there", () => {
    const lead = memoryPrimerBlock("hivra", PRIMER, { worker: false });
    expect(lead.startsWith("<project_memory>\n")).toBe(true);
    expect(lead.endsWith("\n</project_memory>")).toBe(true);
    expect(lead).toContain("Never delete a customer VM");
    expect(lead).toContain("Codex is for image generation only");
    expect(lead).toContain("For more, read never.md and decisions.md in /Users/ash/agent-memory/hivra");
    expect(lead).toContain("You read and write only hivra's memory and Ash's global memory (ash); never another project's.");
    expect(lead).toContain("Save to /Users/ash/agent-memory/hivra/decisions.md at once when Ash makes a call");
    // no chat has memory tools since Ash OS is retired (WP-04)
    expect(lead).not.toMatch(/ash_\w+/);
    // a worker reports what Ash decides; it doesn't save memory itself
    const worker = memoryPrimerBlock("hivra", PRIMER, { worker: true });
    expect(worker).not.toContain("Save to");
    expect(worker).toContain("your report to whoever briefed you");
  });

  it("says how to read the memory when none was loaded", () => {
    for (const worker of [false, true]) {
      const block = memoryPrimerBlock("hivra", undefined, { worker });
      expect(block).toContain("~/agent-memory/hivra/MEMORY.md");
      expect(block).not.toMatch(/ash_\w+/);
    }
  });
});

describe("who gets one", () => {
  it("a project Lead's chat and its workers, on their own engine; nobody else", async () => {
    setHubMcpServers({ cli: null }, lookups);
    const call = vi.fn(async (_action: string, payload: Record<string, unknown>) => ({ ...PRIMER, project: String(payload.project) }));
    const lead = await leadMemoryBlock("chat-hivra", "claude", { call });
    // no chat has memory tools now (WP-04): even Claude Code reads the files
    expect(lead).not.toContain("ash_recall");
    expect(lead).toContain("For more, read never.md");
    expect(lead).toContain("Never delete a customer VM");
    const worker = await workerMemoryBlock("chat-hivra", "codex", { call });
    expect(worker).toContain("For more, read never.md");
    expect(call.mock.calls.every(([, payload]) => payload.project === "hivra")).toBe(true);
    // the leadership team and plain chats read memory as before: no primer, no call
    call.mockClear();
    expect(await leadMemoryBlock("chat-cos", "claude", { call })).toBeUndefined();
    expect(await workerMemoryBlock("chat-cos", "claude", { call })).toBeUndefined();
    expect(await workerMemoryBlock("plain-1", "claude", { call })).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });
});
