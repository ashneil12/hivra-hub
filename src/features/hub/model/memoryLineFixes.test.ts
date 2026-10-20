// @vitest-environment happy-dom
// Chief of Staff's memory line about Grok Bot (decided 20 Oct): the 19 Oct "Grok Bot is no longer used" becomes "The hub
// runs on its own without Grok Bot. Grok Bot leadership can oversee it and set tasks, but isn't required." Only that line
// changes, and Undo puts it back. The Mono files are a stand-in for the Rust mono_read / mono_save commands.
import { beforeEach, describe, expect, it } from "vitest";
import { setBotFiles, undoBotChange, findBotChange } from "./botChanges";
import { applyMemoryLineFixes } from "./memoryLineFixes";
import { GROK_BOT_LINE, teamMemorySeed } from "./teamSouls";
import type { AgentFilePath } from "../../monos/model/monoFiles";

const LIVE_COS_MEMORY = [
  "- 2026-10-19 · The default team is Chief of Staff, Projects Manager, frank and Alfred.",
  "- 2026-10-19 · The team runs on Claude Code in MonoCode Hub; Grok Bot is no longer used (Ash, 19 Oct 2026).",
  "- 2026-10-20 · Ash wants to click the real thing.",
  "",
].join("\n");

function fakeFiles(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const hash = (t: string | undefined) => `h:${t ?? ""}`;
  const api = {
    files,
    read: async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null, hash: hash(files.get(`${id}/${path}`)) }),
    write: async (id: string, path: AgentFilePath, text: string, expected?: string) => {
      if (expected !== undefined && hash(files.get(`${id}/${path}`)) !== expected) throw "conflict";
      files.set(`${id}/${path}`, text);
      return hash(text);
    },
  };
  setBotFiles({ read: api.read, write: api.write });
  return api;
}

beforeEach(() => localStorage.clear());

describe("the Grok Bot memory line", () => {
  it("is the new wording in a fresh Chief of Staff's starting memory", () => {
    const seed = teamMemorySeed("chief-of-staff");
    expect(seed).toContain("The hub runs on its own without Grok Bot. Grok Bot leadership can oversee it and set tasks, but isn't required.");
    expect(seed).not.toContain("no longer used");
    expect(GROK_BOT_LINE).toBe("The hub runs on its own without Grok Bot. Grok Bot leadership can oversee it and set tasks, but isn't required.");
  });

  it("replaces only that line in a live memory, once, with Undo", async () => {
    const f = fakeFiles({ "chief-of-staff/MEMORY.md": LIVE_COS_MEMORY, "frank/MEMORY.md": "- 2026-10-19 · something else\n" });
    const monos = [{ id: "chief-of-staff", name: "Chief of Staff" }, { id: "frank", name: "frank" }, { id: "hivra-lead" }];
    expect(await applyMemoryLineFixes(f, monos)).toEqual(["chief-of-staff:grok-bot-not-required"]);
    const after = f.files.get("chief-of-staff/MEMORY.md")!;
    expect(after.split("\n")).toEqual([
      "- 2026-10-19 · The default team is Chief of Staff, Projects Manager, frank and Alfred.",
      `- 2026-10-20 · ${GROK_BOT_LINE}`,
      "- 2026-10-20 · Ash wants to click the real thing.",
      "",
    ]);
    expect(f.files.get("frank/MEMORY.md")).toBe("- 2026-10-19 · something else\n");
    // The row reads as one sentence about what the Mono will now know (Critiquito), and Undo's as one too.
    const row = findBotChange("memory-fix:chief-of-staff:grok-bot-not-required")!;
    expect(row.line).toBe("Chief of Staff will now remember that Grok Bot isn't required, but may oversee and set tasks.");
    expect(row.undoneText).toBe("Undone: Chief of Staff's memory is back to how it was.");
    // Again: nothing left to fix.
    expect(await applyMemoryLineFixes(f, monos)).toEqual([]);
    await undoBotChange(["memory-fix:chief-of-staff:grok-bot-not-required"]);
    expect(f.files.get("chief-of-staff/MEMORY.md")).toBe(LIVE_COS_MEMORY);
    // Undone stays undone: the next launch doesn't make it again.
    expect(await applyMemoryLineFixes(f, monos)).toEqual([]);
    expect(f.files.get("chief-of-staff/MEMORY.md")).toBe(LIVE_COS_MEMORY);
  });
});
