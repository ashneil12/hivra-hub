// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { appendStandingAnswers, loadMonoFiles, monoContext, planAgentContext, recordAgentContext, standingKeyPart, standingNoteToken } from "./monoFiles";

const DEEPSEEK_RULE = '- 2026-10-21 · "workers run DeepSeek on high" · reasoning level';
let asks: string | null = null;
let topics: string[] = [];

beforeEach(() => {
  const stored = new Map<string, string>([["monocode:hub-team-pack", "ash"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: { path?: string }) => {
    if (cmd === "mono_load")
      return { id: "ed", dir: "/m/ed", soul: "# Soul\n\nCheck work.", soulHash: "s1", memory: "- note", memoryHash: "m1", memoryPath: "/m/ed/MEMORY.md", topics };
    if (cmd === "mono_read" && args.path === "memory/ash-asks.md") return { text: asks, hash: "h" };
    return null;
  });
});
afterEach(() => vi.unstubAllGlobals());

const look = { name: "ed", projects: [] } as never;

// r62 (A4): Ash's rules live in memory/ash-asks.md; a listed-only topic note never reached ed's answer.
describe("memory/ash-asks.md reaches the Mono", () => {
  it("loads whole into the memory block, not only by name", async () => {
    asks = `# What Ash asked for\n\n${DEEPSEEK_RULE}\n`;
    topics = ["ash-asks", "people"];
    const files = await loadMonoFiles("ed");
    const note = monoContext(look, files, { soul: false, memory: true });
    expect(note).toContain(DEEPSEEK_RULE);
    expect(note).toContain("memory/ash-asks.md");
  });

  it("is handed over again in an existing chat when the note appears or changes", async () => {
    asks = null;
    topics = [];
    const before = await loadMonoFiles("ed");
    recordAgentContext("chat", "native-1", before);
    expect(planAgentContext("chat", "native-1", before)).toEqual({ soul: false, memory: false });

    asks = `${DEEPSEEK_RULE}\n`;
    topics = ["ash-asks"];
    const seeded = await loadMonoFiles("ed");
    expect(planAgentContext("chat", "native-1", seeded)).toEqual({ soul: false, memory: true });
    recordAgentContext("chat", "native-1", seeded);
    expect(planAgentContext("chat", "native-1", seeded)).toEqual({ soul: false, memory: false });

    asks = `${DEEPSEEK_RULE}\n- 2026-10-28 · "one more" · test\n`;
    expect(planAgentContext("chat", "native-1", await loadMonoFiles("ed"))).toEqual({ soul: false, memory: true });
  });

  it("is in every fresh conversation's note too", async () => {
    asks = DEEPSEEK_RULE;
    topics = ["ash-asks"];
    const files = await loadMonoFiles("ed");
    expect(planAgentContext("new-chat", undefined, files)).toEqual({ soul: true, memory: true });
    expect(monoContext(look, files, { soul: true, memory: true })).toContain(DEEPSEEK_RULE);
  });
});

describe("WP-156: a standing block cannot close its fence", () => {
  it("escapes markup and leaves the fence tags real", () => {
    const text = appendStandingAnswers("Hello", "Keep <script>alert(1)</script> and <b>yes</b>");
    expect(text).toContain("<standing_answers>");
    expect(text).toContain("</standing_answers>");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).toContain("&lt;b&gt;yes&lt;/b&gt;");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<b>");
    const twice = appendStandingAnswers("Hello", "already &lt;safe&gt;");
    expect(twice).toContain("already &lt;safe&gt;");
    expect(twice).not.toContain("&amp;lt;");
  });

  it("adds nothing for an empty block", () => {
    expect(appendStandingAnswers("Hello", undefined)).toBe("Hello");
    expect(appendStandingAnswers("Hello", "   ")).toBe("Hello");
  });

  it("keeps the previous note token when the read fails", () => {
    expect(standingKeyPart(undefined, "soul\nstanding:ab12")).toBe("ab12");
    expect(standingKeyPart(undefined, undefined)).toBe("");
    const token = standingKeyPart("Keep them", undefined);
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(token).toBe(standingNoteToken("Keep them"));
    expect(token).not.toBe(standingKeyPart("", undefined));
  });
});
