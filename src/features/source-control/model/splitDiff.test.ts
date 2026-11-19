import { describe, expect, it } from "vitest";
import type { UnifiedBlock, UnifiedLine } from "./unifiedDiff";
import type { UnifiedDiffFileModel } from "./unifiedDiffDocument";
import { canSplit, isPatchOnly, splitFileText, splitFocusId } from "./splitDiff";

function line(kind: UnifiedLine["kind"], text: string): UnifiedLine {
  return { kind, text, oldNumber: null, newNumber: null };
}

function file(over: Partial<UnifiedDiffFileModel> = {}): UnifiedDiffFileModel {
  return {
    id: "a.ts",
    path: "src/a.ts",
    label: "src/a.ts",
    additions: 1,
    deletions: 1,
    blocks: [],
    ...over,
  };
}

describe("splitFileText", () => {
  it("prefers the full texts, including carriage returns", () => {
    expect(
      splitFileText(
        file({
          beforeText: "a\r\nb",
          afterText: "a\r\nc",
          blocks: [{ kind: "hunk", lines: [line("add", "ignored")] }],
        }),
      ),
    ).toEqual({ id: "a.ts", name: "src/a.ts", before: "a\r\nb", after: "a\r\nc" });
  });

  it("uses the label as a name, even when it looks like a path", () => {
    const text = splitFileText(
      file({
        label: "..\\weird name\r\n",
        beforeText: "a",
        afterText: "b",
      }),
    );
    expect(text?.name).toBe("..\\weird name\r\n");
  });

  it("returns null for a file that only has a patch, never a rebuilt half of the file", () => {
    expect(
      splitFileText(
        file({
          blocks: [{ kind: "hunk", lines: [line("del", "old"), line("add", "new")] }],
        }),
      ),
    ).toBeNull();
  });

  it("returns null for a binary, too-large, or message file", () => {
    const texts = { beforeText: "a", afterText: "b" };
    expect(splitFileText(file({ ...texts, binary: true }))).toBeNull();
    expect(splitFileText(file({ ...texts, tooLarge: true }))).toBeNull();
    expect(splitFileText(file({ ...texts, emptyMessage: "Loading…" }))).toBeNull();
  });

  it("returns null when one side of the full text is missing and there are no lines", () => {
    expect(splitFileText(file({ beforeText: "only before" }))).toBeNull();
    expect(splitFileText(file())).toBeNull();
  });

  it("falls back to the path, then the id, for an empty label", () => {
    expect(splitFileText(file({ label: "", beforeText: "a", afterText: "b" }))?.name).toBe(
      "src/a.ts",
    );
    expect(
      splitFileText(file({ label: "", path: "", beforeText: "a", afterText: "b" }))?.name,
    ).toBe("a.ts");
  });
});

const patchBlocks: UnifiedBlock[] = [
  { kind: "hunk", lines: [line("del", "old"), line("add", "new")] },
];

describe("isPatchOnly", () => {
  it("is true for a textual file with hunks and no full text", () => {
    expect(isPatchOnly(file({ blocks: patchBlocks }))).toBe(true);
    expect(isPatchOnly(file({ blocks: patchBlocks, beforeText: "only before" }))).toBe(true);
  });

  it("is false once both full texts are there, empty ones included", () => {
    expect(isPatchOnly(file({ blocks: patchBlocks, beforeText: "a", afterText: "b" }))).toBe(false);
    expect(isPatchOnly(file({ blocks: patchBlocks, beforeText: "", afterText: "new" }))).toBe(false);
  });

  it("is false for a file that shows a message instead of text", () => {
    expect(isPatchOnly(file({ blocks: patchBlocks, binary: true }))).toBe(false);
    expect(isPatchOnly(file({ blocks: patchBlocks, tooLarge: true }))).toBe(false);
    expect(isPatchOnly(file({ blocks: [], emptyMessage: "Loading…" }))).toBe(false);
    expect(isPatchOnly(file({ blocks: [] }))).toBe(false);
  });
});

describe("canSplit", () => {
  const full = file({ id: "full.ts", blocks: patchBlocks, beforeText: "a", afterText: "b" });
  const patch = file({ id: "patch.ts", blocks: patchBlocks });

  it("is true when every file has its full text", () => {
    expect(canSplit([full, { ...full, id: "two.ts" }])).toBe(true);
  });

  it("is false when the review only has a patch", () => {
    expect(canSplit([patch])).toBe(false);
  });

  it("is false when one file among full ones only has a patch", () => {
    expect(canSplit([full, patch])).toBe(false);
  });

  it("is true while files load and for files that show a message", () => {
    const loading = file({ id: "load.ts", blocks: [], emptyMessage: "Loading…" });
    const binary = file({ id: "bin.png", blocks: [], binary: true });
    expect(canSplit([loading, binary, full])).toBe(true);
    expect(canSplit([loading])).toBe(true);
  });

  it("is true for an empty review, which shows its own note", () => {
    expect(canSplit([])).toBe(true);
  });
});

describe("splitFocusId", () => {
  const files = [
    file({ id: "a.ts", path: "/repo/src/a.ts" }),
    file({ id: "b.ts::staged", path: "/repo/src/b.ts" }),
  ];

  it("prefers an explicit id", () => {
    expect(splitFocusId(files, "b.ts::staged", "/repo/src/a.ts")).toBe("b.ts::staged");
  });

  it("finds a file by path or by id, like the unified view does", () => {
    expect(splitFocusId(files, undefined, "/repo/src/b.ts")).toBe("b.ts::staged");
    expect(splitFocusId(files, undefined, "a.ts")).toBe("a.ts");
  });

  it("is undefined with no focus or an unknown path", () => {
    expect(splitFocusId(files, undefined, undefined)).toBeUndefined();
    expect(splitFocusId(files, undefined, "/repo/src/zzz.ts")).toBeUndefined();
  });
});
