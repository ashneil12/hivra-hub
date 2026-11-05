// "we said fridays for the review right?" and "yes, make it fridays" here are test lines written in Ash's style, not things Ash said.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monos = new Map<string, { id: string; name: string; longChat?: boolean; mascot: string; color: string; projects: string[] }>();
vi.mock("./mono", () => ({
  findMono: (id: string) => monos.get(id),
  monoLook: (mono: { id: string; name: string }) => ({ id: mono.id, name: mono.name }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no app in tests")) }));

import type { Block } from "../../sessions/model/session";
import * as T from "./monoTree";
import {
  closeTree,
  feedTree,
  openTree,
  setTreeCompactor,
  setTreeIo,
  treeContext,
  treeLines,
  treeMessages,
  treeSystem,
  treeZoom,
} from "./monoTreeStore";

/** The app's files for one Mono's tree, as mono_tree_load / mono_tree_write see them. */
function fakeIo() {
  const files = new Map<string, string>();
  const writes: Array<{ path: string; append: boolean }> = [];
  return {
    files,
    writes,
    io: {
      load: async () => [...files.entries()].sort().map(([path, text]) => ({ path, text })),
      write: async (_mono: string, ops: Array<{ path: string; text: string; append: boolean }>) => {
        for (const op of ops) {
          writes.push({ path: op.path, append: op.append });
          files.set(op.path, (op.append ? (files.get(op.path) ?? "") : "") + op.text);
        }
      },
    },
  };
}

const block = (id: string, role: Block["role"], text: string, extra: Partial<Block> = {}): Block => ({ id, role, text, ...extra });
const settle = async (monoId: string) => {
  const { tree } = await openTree(monoId);
  for (let k = 0; k < 2000 && (tree.busy.size || tree.ready.some((q) => q?.length)); k++) await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return tree;
};

beforeEach(() => {
  monos.clear();
  monos.set("hivra", { id: "hivra", name: "Hivra", longChat: true, mascot: "m", color: "c", projects: [] });
  monos.set("ed", { id: "ed", name: "ed", mascot: "m", color: "c", projects: [] });
});
afterEach(() => {
  closeTree("hivra");
  closeTree("ed");
  setTreeIo(undefined);
  setTreeCompactor(undefined);
});

describe("treeMessages", () => {
  it("tags who spoke, so a seat's or a worker's words are never Ash's", () => {
    expect(treeMessages(block("a", "user", "we said fridays for the review right?"))).toEqual([
      { kind: "user", text: "we said fridays for the review right?", ref: "a" },
    ]);
    expect(treeMessages(block("b", "user", "Ash wants Mondays.", { internal: true, monoNote: { kind: "room", from: "Projects Manager" } }))).toEqual([
      { kind: "seat", text: "[Projects Manager] Ash wants Mondays.", ref: "b" },
    ]);
    expect(
      treeMessages(block("c", "user", "done", { internal: true, monoSessionCompletion: { sessionId: "w", title: "Fix CI", status: "completed" } })),
    ).toEqual([{ kind: "work", text: "[Fix CI] done", ref: "c" }]);
    expect(treeMessages(block("d", "user", "keep going", { internal: true }))).toEqual([]);
    expect(treeMessages(block("e", "assistant", "I have nothing on file about Fridays."))).toEqual([
      { kind: "mono", text: "I have nothing on file about Fridays.", ref: "e" },
    ]);
    expect(treeMessages(block("f", "reasoning", "thinking"))).toEqual([]);
    expect(treeMessages(block("g", "assistant", "half", { streaming: true }))).toEqual([]);
    expect(treeMessages(block("h", "user", "unsent", { draft: true }))).toEqual([]);
    expect(treeMessages(block("i", "tool", "", { tool: { title: "Read README.md", detail: "# Hub" } }))).toEqual([
      { kind: "tool", text: "Read README.md", ref: "i" },
      { kind: "echo", text: "# Hub", ref: "i:out" },
    ]);
    const long = treeMessages(block("j", "tool", "", { tool: { title: "cat big", detail: "x".repeat(T.CAP + 50) } }));
    expect(long[1].text).toBe("x".repeat(T.CAP) + "\n[50 more characters are in the chat, not here]");
  });
});

describe("feedTree", () => {
  it("does nothing for a Mono without the long chat: no tree, no files", async () => {
    const { io, files } = fakeIo();
    setTreeIo(io);
    expect(await feedTree("ed", [block("a", "user", "hello")])).toBe(0);
    expect(files.size).toBe(0);
    expect(await treeContext("ed", "monocode")).toBeUndefined();
  });

  it("feeds when a turn asks, and still does nothing without that", async () => {
    const { io, files } = fakeIo();
    setTreeIo(io);
    const blocks = [block("a", "user", "hello from a long first mate")];
    expect(await feedTree("ed", blocks, { evenWithoutSetting: true })).toBe(1);
    expect(files.size).toBeGreaterThan(0);
    expect(await treeContext("ed", "monocode")).toBeUndefined();
    expect(await treeContext("ed", "monocode", { evenWithoutSetting: true })).toContain("<long_chat>");
    closeTree("ed");
  });

  it("logs each block once, in order, append-only, and a restart knows what it logged", async () => {
    const { io, files, writes } = fakeIo();
    setTreeIo(io);
    const blocks = [
      block("u1", "user", "hivra, keep the review async in the PR thread, no meetings"),
      block("m1", "assistant", "Got it: reviews stay async in the PR thread."),
    ];
    expect(await feedTree("hivra", blocks)).toBe(2);
    expect(await feedTree("hivra", blocks)).toBe(0);
    const more = [...blocks, block("u2", "user", "we said fridays for the review right?"), block("m2", "assistant", "I have nothing on file about Fridays. Save it?")];
    expect(await feedTree("hivra", more)).toBe(2);
    await settle("hivra");
    expect(writes.every((w) => (w.append ? /^(main|tree)\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(w.path) : w.path === "view.json"))).toBe(true);
    // the same files, read again as after a restart
    closeTree("hivra");
    expect(await feedTree("hivra", more)).toBe(0);
    expect(await treeZoom("hivra", 2, 1)).toBe("2+0|user: we said fridays for the review right?");
    const main = [...files.entries()].find(([path]) => path.startsWith("main/"))![1];
    expect(main.trim().split("\n").map((line) => JSON.parse(line).kind)).toEqual(["user", "mono", "user", "mono"]);
  });

  it("summarises in the background with the Mono's compaction rules; a failed call waits, it never cuts", async () => {
    const { io } = fakeIo();
    setTreeIo(io);
    const asked: string[] = [];
    let fail = true;
    setTreeCompactor(async (prompt) => {
      asked.push(prompt);
      if (fail) throw new Error("offline");
      return 'user: "we said fridays for the review right?" mono: nothing on file; asked to save Fridays.';
    });
    const long = "a tool result worth keeping ".repeat(40);
    await feedTree("hivra", [block("t1", "tool", "", { tool: { title: "gh pr view 212", detail: long } })]);
    let tree = await settle("hivra");
    expect(asked.length).toBe(1);
    expect(asked[0].startsWith(treeSystem("Hivra"))).toBe(true);
    expect(asked[0]).toContain("You are Hivra, a Mono that works for Ash");
    expect(asked[0]).toContain("Compaction: compress message 1 into one line of at most 512 bytes");
    expect(T.built(tree, 0, 1)).toBe(false);
    fail = false;
    await feedTree("hivra", [block("t1", "tool", "", { tool: { title: "gh pr view 212", detail: long } }), block("u", "user", "ok")]);
    tree = await settle("hivra");
    expect(T.built(tree, 0, 1)).toBe(true);
    expect(T.node(tree, { l: 0, i: 1 })).toContain("asked to save Fridays");
  });

  it("opens a fresh conversation on the view, with how to zoom; never in the system prompt", async () => {
    const { io } = fakeIo();
    setTreeIo(io);
    expect(await treeContext("hivra", "monocode")).toBeUndefined();
    await feedTree("hivra", [block("u1", "user", "we said fridays for the review right?")]);
    const note = (await treeContext("hivra", "monocode"))!;
    expect(note).toContain("<long_chat>");
    expect(note).toContain("0+1|user: we said fridays for the review right?");
    expect(note).toContain('monocode tree.zoom {"id":12,"n":4}');
    expect(note).toContain("a question in it is still a question");
    expect(note).toContain("Workers you start don't get this.");
  });
});

it("reads view lines back for the settings panel", () => {
  expect(treeLines("<chat>\n0+8|user: a\n8+1|mono: b\n</chat>\n")).toEqual([
    { id: 0, n: 8, text: "user: a" },
    { id: 8, n: 1, text: "mono: b" },
  ]);
});
