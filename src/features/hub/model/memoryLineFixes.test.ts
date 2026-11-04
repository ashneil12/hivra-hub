// @vitest-environment happy-dom
// Nothing is shipped as a memory rewrite. A caller can still pass a fix, and it touches only the matching line.
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";
import { findBotChange, setBotFiles, undoBotChange } from "./botChanges";
import { applyMemoryLineFixes, LINE_FIXES, type LineFix } from "./memoryLineFixes";
import { teamMemorySeed } from "./teamSouls";

const FIX: LineFix = {
  id: "note",
  matches: /old fact/,
  line: "- 2026-10-20 · the new fact",
  remembers: "the new fact",
};

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

describe("memory line fixes", () => {
  it("ships none, and a starting memory is empty", async () => {
    expect(LINE_FIXES).toEqual([]);
    expect(teamMemorySeed("ada")).toBe("");
    const f = fakeFiles({ "ada/MEMORY.md": "- 2026-10-19 · old fact\n" });
    expect(await applyMemoryLineFixes(f, [{ id: "ada", name: "Ada" }])).toEqual([]);
    expect(f.files.get("ada/MEMORY.md")).toBe("- 2026-10-19 · old fact\n");
  });

  it("rewrites only the matching line, once, and undo puts it back", async () => {
    const before = "- 2026-10-19 · old fact\n- kept\n";
    const f = fakeFiles({ "ada/MEMORY.md": before, "bo/MEMORY.md": "- something else\n" });
    const monos = [{ id: "ada", name: "Ada" }, { id: "bo", name: "Bo" }, { id: "empty" }];
    expect(await applyMemoryLineFixes(f, monos, [FIX])).toEqual(["ada:note"]);
    expect(f.files.get("ada/MEMORY.md")).toBe("- 2026-10-20 · the new fact\n- kept\n");
    expect(f.files.get("bo/MEMORY.md")).toBe("- something else\n");
    const row = findBotChange("memory-fix:ada:note")!;
    expect(row.line).toBe("Ada will now remember that the new fact.");
    expect(row.now).toBe("old fact");
    expect(row.undoneText).toBe("Undone: Ada's memory is back to how it was.");
    expect(await applyMemoryLineFixes(f, monos, [FIX])).toEqual([]);
    await undoBotChange(["memory-fix:ada:note"]);
    expect(f.files.get("ada/MEMORY.md")).toBe(before);
    expect(await applyMemoryLineFixes(f, monos, [FIX])).toEqual([]);
    expect(f.files.get("ada/MEMORY.md")).toBe(before);
  });

  it("a mono whose memory can't be read does not stop the next one", async () => {
    const f = fakeFiles({ "bo/MEMORY.md": "- old fact\n" });
    const read = f.read;
    f.read = async (id, path) => {
      if (id === "ada") throw new Error("busy");
      return read(id, path);
    };
    expect(await applyMemoryLineFixes(f, [{ id: "ada", name: "Ada" }, { id: "bo" }], [FIX])).toEqual(["bo:note"]);
    expect(f.files.get("bo/MEMORY.md")).toBe("- 2026-10-20 · the new fact\n");
  });

  it("an empty memory and a fix that matches nothing are left alone", async () => {
    const f = fakeFiles({ "ada/MEMORY.md": "", "bo/MEMORY.md": "- other\n" });
    expect(await applyMemoryLineFixes(f, [{ id: "ada" }, { id: "bo" }, { id: "missing" }], [FIX])).toEqual([]);
    expect(f.files.get("bo/MEMORY.md")).toBe("- other\n");
  });
});
