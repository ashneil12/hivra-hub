import { describe, expect, it } from "vitest";
import { exportTree } from "./exportFiles";
import { isSafeLinkHref, normalizeLinkHref } from "./links";
import { markdownToBlocks, blocksToMarkdown, stripBlockIds } from "./markdown";
import { mentionsIn, newMentions, resolveMention } from "./mentions";
import { migrateNote } from "./migrate";
import { DocSaveQueue, SaveConflict, SaveTimeout } from "./saveQueue";
import { slashBlock, slashMenuItems } from "./slashMenu";
import { canMove, descendantsOf, dropToMove } from "./tree";
import type { Block, MentionTarget } from "./types";
import { isBlank, planRestore, sameState, shouldSnapshot, stateFrom } from "./versions";

const ada: MentionTarget = { kind: "page", id: "page-ada", name: "Ada" };
const adaLong: MentionTarget = { kind: "page", id: "page-ada-long", name: "Ada Lovelace" };
const task: MentionTarget = { kind: "task", id: "task-1", name: "Write the spec" };

function roundtrip(blocks: Block[]) {
  const again = markdownToBlocks(blocksToMarkdown(blocks));
  expect(stripBlockIds(again)).toEqual(stripBlockIds(blocks));
}

function block(type: string, props: Record<string, unknown>, content: Block["content"], children: Block[] = []): Block {
  return { id: "x", type, props, content, children };
}

const text = (value: string, styles: Record<string, boolean> = {}) =>
  ({ type: "text" as const, text: value, styles });

describe("markdown round trip", () => {
  it("keeps an empty page empty", () => {
    expect(markdownToBlocks("")).toEqual([]);
    expect(markdownToBlocks("  \n\t")).toEqual([]);
    expect(blocksToMarkdown([])).toBe("");
  });

  it("normalizes CRLF before converting", () => {
    const blocks = markdownToBlocks("Hello\r\n\r\nThere\r");
    expect(blocks.map((item) => item.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocksToMarkdown(blocks)).toBe("Hello\n\nThere\n");
  });

  it("round-trips every block type", () => {
    const cases: Block[] = [
      block("paragraph", {}, [text("Hello")]),
      block("heading", { level: 2 }, [text("Section")]),
      block("bulletListItem", {}, [text("One")]),
      block("numberedListItem", {}, [text("Two")]),
      block("checkListItem", { checked: false }, [text("Open")]),
      block("checkListItem", { checked: true }, [text("Done")]),
      block("quote", {}, [text("A quote")]),
      block("callout", { emoji: "💡", backgroundColor: "gray", textColor: "default" }, [text("Watch out")]),
      block("codeBlock", { language: "ts" }, [text("const n = 1")]),
      block("codeBlock", { language: "mermaid" }, [text("flowchart TD\n  A --> B")]),
      block("image", { url: "https://example.com/a.png", caption: "A photo", name: "pic", previewWidth: 512 }, []),
      block("file", { url: "https://example.com/notes/spec.pdf", name: "spec.pdf", caption: "The spec" }, []),
      block("divider", {}, []),
      block("table", {}, {
        type: "tableContent",
        columnWidths: [null, null],
        headerRows: 1,
        rows: [
          { cells: [{ type: "tableCell", props: {}, content: [text("A")] }, { type: "tableCell", props: {}, content: [text("B")] }] },
          { cells: [{ type: "tableCell", props: {}, content: [text("C")] }, { type: "tableCell", props: {}, content: [text("D")] }] },
        ],
      }),
      block("page", { pageId: "page-1" }, []),
      block("paragraph", {}, [
        text("See "),
        { type: "mention", props: { kind: "task", targetId: "task-1", name: "task-1" } },
      ]),
      block("bulletListItem", {}, [text("Parent")], [block("bulletListItem", {}, [text("Child")])]),
    ];
    for (const item of cases) roundtrip([item]);
  });

  it("keeps bold, italic, strike, code and links", () => {
    const blocks = markdownToBlocks("**bold** *italic* ~~gone~~ `code` [docs](https://example.com/docs)");
    const back = blocksToMarkdown(blocks);
    expect(back).toContain("**bold**");
    expect(back).toContain("*italic*");
    expect(back).toContain("~~gone~~");
    expect(back).toContain("`code`");
    expect(back).toContain("[docs](https://example.com/docs)");
  });

  it("does not turn a mention inside code into a mention", () => {
    const blocks = markdownToBlocks("`@task/task-1`", [task]);
    expect(JSON.stringify(blocks)).not.toContain('"type":"mention"');
  });

  it("mentions @kind/id, @note/slug and a unique @Name", () => {
    const structured = markdownToBlocks("See @task/task-1.");
    expect(mentionsIn(structured)).toEqual([{ kind: "task", targetId: "task-1", name: "task-1" }]);
    const note = markdownToBlocks("See @note/my-slug.");
    expect(mentionsIn(note)[0]).toMatchObject({ kind: "page", targetId: "my-slug" });
    const named = markdownToBlocks("Hello @Ada Lovelace", [ada, adaLong]);
    expect(mentionsIn(named)[0]).toMatchObject({ kind: "page", targetId: "page-ada-long", name: "Ada Lovelace" });
  });

  it("does not mention a name when two targets share it, or when it touches a word", () => {
    const dupes = markdownToBlocks("@Ada", [ada, { ...ada, id: "other" }]);
    expect(mentionsIn(dupes)).toEqual([]);
    const stuck = markdownToBlocks("x@Ada", [ada]);
    expect(mentionsIn(stuck)).toEqual([]);
  });

  it("drops javascript links and keeps note assets", () => {
    const blocks = markdownToBlocks("[x](javascript:alert(1)) and ![a](/note-assets/note-1/a.png)");
    expect(JSON.stringify(blocks)).not.toContain("javascript:");
    expect(JSON.stringify(blocks)).toContain("/note-assets/note-1/a.png");
  });

  it("uses a fence longer than the backticks inside the code", () => {
    const blocks = [block("codeBlock", { language: "" }, [text("```")])] as Block[];
    expect(blocksToMarkdown(blocks)).toBe("````\n```\n````\n");
  });
});

// WP-102 item 2 (Orbit ab86dac): a list item's paragraph, quote or heading child needs a blank line before it, and so
// does a numbered list that does not start at 1. Without one, Markdown reads the child as more of the item's own
// paragraph and the child is lost on the way back in.
describe("markdown lists with child blocks (WP-102)", () => {
  const childOf = (child: Block): Block => block("bulletListItem", {}, [text("Parent")], [child]);

  it("keeps a paragraph child of a list item", () => {
    const blocks = [childOf(block("paragraph", {}, [text("The child")]))];
    expect(blocksToMarkdown(blocks)).toBe("- Parent\n\n  The child\n");
    roundtrip(blocks);
  });

  it("keeps a quote child of a list item", () => {
    const blocks = [childOf(block("quote", {}, [text("A quoted child")]))];
    expect(blocksToMarkdown(blocks)).toBe("- Parent\n\n  > A quoted child\n");
    roundtrip(blocks);
  });

  it("keeps a heading child of a list item", () => {
    const blocks = [childOf(block("heading", { level: 2 }, [text("A heading child")]))];
    expect(blocksToMarkdown(blocks)).toBe("- Parent\n\n  ## A heading child\n");
    roundtrip(blocks);
  });

  it("keeps more than one paragraph child, in order", () => {
    const blocks = [
      block("numberedListItem", {}, [text("Parent")], [
        block("paragraph", {}, [text("First child")]),
        block("paragraph", {}, [text("Second child")]),
      ]),
    ];
    expect(blocksToMarkdown(blocks)).toBe("1. Parent\n\n   First child\n\n   Second child\n");
    roundtrip(blocks);
  });

  it("keeps a paragraph child that comes before a nested list child", () => {
    const blocks = [
      block("bulletListItem", {}, [text("Parent")], [
        block("paragraph", {}, [text("The child")]),
        block("bulletListItem", {}, [text("Nested")]),
      ]),
    ];
    expect(blocksToMarkdown(blocks)).toBe("- Parent\n\n  The child\n\n  - Nested\n");
    roundtrip(blocks);
  });

  it("keeps a nested list that starts at 1 on the line under its parent", () => {
    const blocks = [
      block("bulletListItem", {}, [text("Parent")], [
        block("bulletListItem", {}, [text("One")]),
        block("numberedListItem", {}, [text("Two")]),
      ]),
    ];
    expect(blocksToMarkdown(blocks)).toBe("- Parent\n  - One\n  1. Two\n");
    roundtrip(blocks);
  });

  it("puts a blank line before a numbered list that does not start at 1", () => {
    const blocks = [
      block("bulletListItem", {}, [text("Before")]),
      block("numberedListItem", { start: 3 }, [text("three")]),
      block("numberedListItem", {}, [text("four")]),
    ];
    expect(blocksToMarkdown(blocks)).toBe("- Before\n\n3. three\n4. four\n");
    roundtrip(blocks);
  });

  it("puts a blank line before a nested numbered list that does not start at 1", () => {
    const blocks = [
      block("bulletListItem", {}, [text("Parent")], [block("numberedListItem", { start: 3 }, [text("three")])]),
    ];
    expect(blocksToMarkdown(blocks)).toBe("- Parent\n\n  3. three\n");
    roundtrip(blocks);
  });

  it("keeps the Orbit fixture: nesting, numbers, checks, an empty paragraph and a toggle with a child", () => {
    const blocks: Block[] = [
      block("bulletListItem", {}, [text("a")], [
        block("bulletListItem", {}, [text("a.1")]),
        block("numberedListItem", {}, [text("a.n")]),
      ]),
      block("bulletListItem", {}, [text("b")]),
      block("numberedListItem", { start: 3 }, [text("three")]),
      block("numberedListItem", {}, [text("four")], [block("checkListItem", { checked: true }, [text("done")])]),
      block("paragraph", {}, []),
      block("numberedListItem", {}, [text("restart")]),
      block("checkListItem", { checked: false }, [text("todo")]),
      block("toggleListItem", {}, [text("toggle")], [block("paragraph", {}, [text("hidden")])]),
    ];
    expect(blocksToMarkdown(blocks)).toBe(
      "- a\n  - a.1\n  1. a.n\n- b\n\n3. three\n4. four\n   - [x] done\n\n1. restart\n- [ ] todo\n- toggle\n\n  hidden\n",
    );
    // Markdown has no empty paragraph and no toggle marker, so those two cannot come back as themselves (they never
    // could). Everything else in the fixture does.
    roundtrip(blocks.filter((item) => item.type !== "toggleListItem" && (item.type !== "paragraph" || item.content.length > 0)));
  });
});

describe("links", () => {
  it("rejects javascript and upgrades a bare host", () => {
    expect(normalizeLinkHref("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkHref("example.com/a")).toBe("https://example.com/a");
    expect(isSafeLinkHref("/docs/page-1")).toBe(true);
    expect(isSafeLinkHref("/etc/passwd")).toBe(false);
  });
});

describe("migrate", () => {
  it("turns Markdown into blocks and keeps the body", () => {
    const note = { body: "Hello\n\n- [x] Done", blocksJson: null };
    const migrated = migrateNote(note);
    expect(migrated.failed).toBe(false);
    expect(migrated.body).toBe(note.body);
    expect(migrated.blocks?.map((item) => item.type)).toEqual(["paragraph", "checkListItem"]);
  });

  it("keeps the body when conversion throws", () => {
    const note = { body: "do not lose this", blocksJson: null };
    const migrated = migrateNote(note, [], () => {
      throw new Error("convert failed");
    });
    expect(migrated).toEqual({ body: "do not lose this", blocks: null, failed: true });
  });

  it("keeps the body when stored blocks are not JSON", () => {
    const migrated = migrateNote({ body: "still here", blocksJson: "{not json" });
    expect(migrated.body).toBe("still here");
    expect(migrated.blocks).toBeNull();
    expect(migrated.failed).toBe(true);
  });

  it("uses blocks that are already stored", () => {
    const blocks = [block("paragraph", {}, [text("Kept")])];
    const migrated = migrateNote({ body: "old", blocksJson: JSON.stringify(blocks) });
    expect(migrated.body).toBe("old");
    expect(migrated.blocks).toEqual(blocks);
  });
});

describe("versions", () => {
  const empty = stateFrom("", [block("paragraph", {}, [])]);
  const hello = stateFrom("Hello", [block("paragraph", {}, [text("Hello")])]);
  const edited = stateFrom("Hello", [block("paragraph", {}, [text("Hello!")])]);

  it("skips a blank page and a duplicate, and stores an idle or agent edit", () => {
    expect(isBlank(empty)).toBe(true);
    expect(shouldSnapshot(empty, null)).toBe(false);
    expect(shouldSnapshot(hello, null)).toBe(true);
    expect(shouldSnapshot(hello, hello)).toBe(false);
    expect(shouldSnapshot(edited, hello)).toBe(true);
  });

  it("restores by making a new version and keeping the current one", () => {
    const plan = planRestore(edited, hello, hello);
    expect(plan).toEqual({ keepCurrent: true, restore: true });
    expect(planRestore(hello, hello, hello)).toEqual({ keepCurrent: false, restore: false });
    expect(sameState(hello, stateFrom("Hello", [block("paragraph", {}, [text("Hello")])]))).toBe(true);
  });
});

describe("mentions", () => {
  it("resolves a page by id or slug, and a missing task is not a failure", () => {
    const page = resolveMention(
      { kind: "page", targetId: "my-slug", name: "my-slug" },
      [{ kind: "page", id: "page-1", name: "Spec", slug: "my-slug" }],
    );
    expect(page).toMatchObject({ found: true, targetId: "page-1", name: "Spec" });
    const missing = resolveMention({ kind: "task", targetId: "task-1", name: "Write the spec" }, []);
    expect(missing.found).toBe(false);
  });

  it("does not report a mention that was already on the page", () => {
    const before = [{ kind: "task" as const, targetId: "task-1", name: "Write the spec" }];
    const after = [...before, { kind: "chat" as const, targetId: "chat-1", name: "Standup" }];
    expect(newMentions(before, after)).toEqual([{ kind: "chat", targetId: "chat-1", name: "Standup" }]);
  });

  it("finds a mention inside a table cell", () => {
    const table = block("table", {}, {
      type: "tableContent",
      columnWidths: [null],
      headerRows: 1,
      rows: [{ cells: [{ type: "tableCell", props: {}, content: [{ type: "mention", props: { kind: "mono", targetId: "mono-1", name: "Ada" } }] }] }],
    });
    expect(mentionsIn([table])).toEqual([{ kind: "mono", targetId: "mono-1", name: "Ada" }]);
  });
});

describe("tree", () => {
  const pages = [
    { id: "a", parentId: null, sortOrder: 0 },
    { id: "b", parentId: "a", sortOrder: 0 },
    { id: "c", parentId: "b", sortOrder: 0 },
  ];

  it("refuses a move onto itself or into its own subtree, and stops on a cycle", () => {
    expect(canMove(pages, "a", "a")).toBe(false);
    expect(canMove(pages, "a", "c")).toBe(false);
    expect(canMove(pages, "c", "a")).toBe(true);
    expect(dropToMove(pages, "a", "c", "inside")).toBeNull();
    const cycled = [
      { id: "a", parentId: "b", sortOrder: 0 },
      { id: "b", parentId: "a", sortOrder: 0 },
    ];
    expect(descendantsOf(cycled, "a").map((page) => page.id)).toEqual(["b"]);
  });

  it("nests and reorders", () => {
    expect(dropToMove(pages, "c", "a", "inside")).toEqual({ parentId: "a", index: 1 });
    expect(dropToMove(pages, "c", "a", "before")).toEqual({ parentId: null, index: 0 });
  });
});

describe("slash menu", () => {
  it("prefers a title over an alias", () => {
    const items = slashMenuItems("sub");
    expect(items[0]?.key).toBe("subpage");
  });

  it("makes a callout gray and a mermaid block a mermaid code block", () => {
    expect(slashBlock("callout")).toMatchObject({ type: "callout", props: { backgroundColor: "gray", emoji: "💡" } });
    expect(slashBlock("mermaid")).toMatchObject({ type: "codeBlock", props: { language: "mermaid" } });
  });
});

describe("save queue", () => {
  it("chains the version and treats a timeout as not final", async () => {
    const queue = new DocSaveQueue<string>(0);
    const first = queue.enqueue(async (expected) => {
      expect(expected).toBe(0);
      return { version: 1, value: "one" };
    });
    const second = queue.enqueue(async (expected) => {
      expect(expected).toBe(1);
      return { version: 2, value: "two" };
    });
    await expect(first).resolves.toEqual({ version: 1, value: "one" });
    await expect(second).resolves.toEqual({ version: 2, value: "two" });

    const retry = queue.enqueue(async () => {
      throw new SaveTimeout();
    });
    await expect(retry).rejects.toBeInstanceOf(SaveTimeout);
    expect(queue.timedOut).toBe(true);
    expect(queue.currentVersion()).toBe(2);
    await expect(queue.enqueue(async (expected) => ({ version: expected + 1, value: "retried" }))).resolves.toEqual({
      version: 3,
      value: "retried",
    });
    expect(queue.timedOut).toBe(false);
  });

  it("adopts the version from a conflict instead of overwriting", async () => {
    const queue = new DocSaveQueue<string>(1);
    await expect(
      queue.enqueue(async () => {
        throw new SaveConflict(4);
      }),
    ).rejects.toBeInstanceOf(SaveConflict);
    expect(queue.currentVersion()).toBe(4);
  });
});

describe("export files", () => {
  const pages = [
    { id: "root", slug: "notes", title: "Notes", body: "Hi", blocks: null, parentId: null, trashed: false },
    { id: "child", slug: "child-page", title: "Child", body: "There", blocks: null, parentId: "root", trashed: false },
    { id: "gone", slug: "gone", title: "Gone", body: "x", blocks: null, parentId: "root", trashed: true },
  ];

  it("writes a page as a file and a tree as a directory", () => {
    expect(exportTree(pages, "child", false, { page: () => null, url: (url) => url }).map((file) => file.path)).toEqual([
      "child-page.md",
    ]);
    expect(exportTree(pages, "root", true, { page: () => null, url: (url) => url }).map((file) => file.path)).toEqual([
      "notes/index.md",
      "notes/child-page.md",
    ]);
  });

  it("refuses a slug of .. or a slash", () => {
    const bad = { ...pages[0], slug: ".." };
    expect(() => exportTree([bad], "root", false, { page: () => null, url: (url) => url })).toThrow(/safe file name/);
    const slashed = { ...pages[0], slug: "a/b" };
    expect(() => exportTree([slashed], "root", false, { page: () => null, url: (url) => url })).toThrow(/safe file name/);
  });
});
