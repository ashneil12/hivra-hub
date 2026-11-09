import { describe, expect, it } from "vitest";
import type { UnifiedBlock, UnifiedLine } from "./unifiedDiff";
import type { UnifiedDiffFileModel } from "./unifiedDiffDocument";
import { splitFileText, textsFromBlocks } from "./splitDiff";

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

describe("textsFromBlocks", () => {
  it("returns null for no lines", () => {
    expect(textsFromBlocks([])).toBeNull();
    expect(textsFromBlocks([{ kind: "hunk", lines: [] }])).toBeNull();
  });

  it("rebuilds before and after, skipping header lines and keeping folds", () => {
    const blocks: UnifiedBlock[] = [
      {
        kind: "hunk",
        lines: [
          line("context", "kept"),
          line("del", "old"),
          line("add", "new"),
          { kind: "hunk", text: "@@ header", oldNumber: null, newNumber: null },
        ],
      },
      { kind: "fold", id: "f", lines: [line("context", "middle")] },
      { kind: "hunk", lines: [line("add", "tail")] },
    ];
    expect(textsFromBlocks(blocks)).toEqual({
      before: "kept\nold\nmiddle",
      after: "kept\nnew\nmiddle\ntail",
    });
  });

  it("keeps an empty line and ignores a line whose text is not a string", () => {
    const blocks: UnifiedBlock[] = [
      {
        kind: "hunk",
        lines: [
          line("context", ""),
          { kind: "add", text: 4 as unknown as string, oldNumber: null, newNumber: null },
        ],
      },
    ];
    expect(textsFromBlocks(blocks)).toEqual({ before: "", after: "\n" });
  });

  it("ignores a block that has no lines array", () => {
    const blocks = [{ kind: "hunk" }] as unknown as UnifiedBlock[];
    expect(textsFromBlocks(blocks)).toBeNull();
  });
});

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

  it("rebuilds from blocks when the full texts are missing", () => {
    expect(
      splitFileText(
        file({
          blocks: [{ kind: "hunk", lines: [line("del", "old"), line("add", "new")] }],
        }),
      ),
    ).toEqual({ id: "a.ts", name: "src/a.ts", before: "old", after: "new" });
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
