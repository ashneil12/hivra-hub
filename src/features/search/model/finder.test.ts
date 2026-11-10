import { describe, expect, it } from "vitest";
import type { Mono } from "../../monos/model/mono";
import type { AppSearchHit, ConversationHit, MessageHit } from "./appSearch";
import {
  acceptGeneration,
  assembleFinder,
  commandHits,
  finderKeyAction,
  finderShortcutAction,
  groupFinderHits,
  hitInProject,
  hitsFromIndex,
  monoHits,
  parseFinderQuery,
  rankFinderHits,
  routeFinderHit,
  settle,
  toggleFinderScope,
  type FinderHit,
  type FinderOpener,
} from "./finder";

function hit(partial: Partial<FinderHit> & Pick<FinderHit, "id" | "kind" | "score">): FinderHit {
  return {
    title: partial.id,
    subtitle: "",
    project: "/work/this",
    ...partial,
  };
}

const mono = (partial: Partial<Mono> & Pick<Mono, "id">): Mono =>
  ({
    mascot: "fox",
    color: "hsl(0 0% 50%)",
    projects: [],
    ...partial,
  }) as Mono;

describe("parseFinderQuery", () => {
  it("treats > as commands and a known prefix as one kind", () => {
    expect(parseFinderQuery(">reload")).toEqual({ mode: "commands", kind: null, text: "reload" });
    expect(parseFinderQuery("  >  ")).toEqual({ mode: "commands", kind: null, text: "" });
    expect(parseFinderQuery("t: sidebar")).toEqual({ mode: "search", kind: "task", text: "sidebar" });
    expect(parseFinderQuery("D:notes")).toEqual({ mode: "search", kind: "doc", text: "notes" });
    expect(parseFinderQuery("o:fox")).toEqual({ mode: "search", kind: "mono", text: "fox" });
    expect(parseFinderQuery("c:hello")).toEqual({ mode: "search", kind: "conversation", text: "hello" });
    expect(parseFinderQuery("m:hello")).toEqual({ mode: "search", kind: "message", text: "hello" });
    expect(parseFinderQuery("f:App")).toEqual({ mode: "search", kind: "file", text: "App" });
    expect(parseFinderQuery("p:hub")).toEqual({ mode: "search", kind: "project", text: "hub" });
  });

  it("does not narrow an unknown prefix, and keeps spaces, unicode and blank input", () => {
    expect(parseFinderQuery("z:foo")).toEqual({ mode: "search", kind: null, text: "z:foo" });
    expect(parseFinderQuery("")).toEqual({ mode: "search", kind: null, text: "" });
    expect(parseFinderQuery("   ")).toEqual({ mode: "search", kind: null, text: "" });
    expect(parseFinderQuery("t:\r\n sidebar")).toEqual({ mode: "search", kind: "task", text: "sidebar" });
    expect(parseFinderQuery("über")).toEqual({ mode: "search", kind: null, text: "über" });
  });
});

describe("rankFinderHits", () => {
  const task = hit({ id: "task:1", kind: "task", score: 5, project: "/work/this", title: "Fix the sidebar" });
  const other = hit({ id: "task:2", kind: "task", score: 50, project: "/work/other", title: "Other" });
  const doc = hit({ id: "doc:1", kind: "doc", score: 8, project: "/work/this", title: "Notes" });
  const file = hit({ id: "file:1", kind: "file", score: 3, project: "", title: "App.tsx", path: "/work/this/App.tsx" });
  const message = hit({
    id: "message:1",
    kind: "message",
    score: 4,
    project: "/work/this",
    title: "Chat",
    sessionId: "s1",
    blockId: "b1",
  });
  const conversation = hit({
    id: "conversation:1",
    kind: "conversation",
    score: 2,
    project: "/work/this",
    title: "Chat",
    sessionId: "s1",
  });
  const project = hit({ id: "project:1", kind: "project", score: 6, project: "/work/this", title: "This", path: "/work/this" });
  const monoHit = hit({
    id: "mono:1",
    kind: "mono",
    score: 7,
    project: "/work/this",
    projects: ["/work/this"],
    title: "Fox",
    monoId: "1",
  });

  const all = [other, task, doc, file, message, conversation, project, monoHit];

  it("finds each kind and ranks the current project ahead of a higher score elsewhere", () => {
    const ranked = rankFinderHits(all, "/work/this", ["/work/this"], "all", null);
    expect(ranked.map((item) => item.kind).sort()).toEqual(
      ["conversation", "doc", "file", "message", "mono", "project", "task", "task"].sort(),
    );
    expect(ranked[0].id).not.toBe("task:2");
    expect(ranked.findIndex((item) => item.id === "task:1")).toBeLessThan(
      ranked.findIndex((item) => item.id === "task:2"),
    );
    const here = ranked.filter((item) => item.id !== "task:2");
    const scores = here.map((item) => item.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("hides other projects until All projects, and files stay", () => {
    const scoped = rankFinderHits(all, "/work/this", ["/work/this"], "project", null);
    expect(scoped.some((item) => item.id === "task:2")).toBe(false);
    expect(scoped.some((item) => item.id === "file:1")).toBe(true);
    expect(toggleFinderScope("project")).toBe("all");
    expect(toggleFinderScope("all")).toBe("project");
  });

  it("matches a Windows path and a hub key as the same project", () => {
    const windows = hit({ id: "task:win", kind: "task", score: 1, project: "C:\\Work\\Proj" });
    expect(hitInProject(windows, "c:/work/proj", [])).toBe(true);
    const keyed = hit({ id: "task:key", kind: "task", score: 1, project: "crew" });
    expect(hitInProject(keyed, "/work/this", ["crew", "/work/this"])).toBe(true);
    expect(hitInProject(keyed, "/work/this", [])).toBe(false);
    const odd = hit({ id: "task:odd", kind: "task", score: 1, project: "../elsewhere" });
    expect(hitInProject(odd, "/work/this", [])).toBe(false);
  });

  it("narrows by prefix and drops empty, missing and duplicate ids", () => {
    const dup = hit({ id: "task:1", kind: "task", score: 1, project: "/work/this" });
    const blank = hit({ id: "", kind: "task", score: 9, project: "/work/this" });
    const ranked = rankFinderHits([task, dup, blank, doc], "/work/this", [], "all", "task");
    expect(ranked.map((item) => item.id)).toEqual(["task:1"]);
    expect(rankFinderHits([task, doc], "/work/this", [], "all", "doc").map((item) => item.kind)).toEqual(["doc"]);
    expect(rankFinderHits([], "/work/this", [], "project", null)).toEqual([]);
  });

  it("orders groups by the best hit", () => {
    const ranked = rankFinderHits([task, doc, message], "/work/this", [], "all", null);
    expect(groupFinderHits(ranked).map((group) => group.kind)).toEqual(["doc", "task", "message"]);
  });

  it("keeps one group per kind when a higher scored hit of another kind sits between", () => {
    const best = hit({ id: "task:high", kind: "task", score: 10, project: "/work/this" });
    const middle = hit({ id: "doc:mid", kind: "doc", score: 8, project: "/work/this" });
    const other = hit({ id: "task:low", kind: "task", score: 3, project: "/work/this" });
    const ranked = rankFinderHits([other, middle, best], "/work/this", [], "all", null);
    const groups = groupFinderHits(ranked);
    expect(groups.map((group) => group.kind)).toEqual(["task", "doc"]);
    expect(groups[0]?.hits.map((item) => item.id)).toEqual(["task:high", "task:low"]);
    expect(groups[1]?.hits.map((item) => item.id)).toEqual(["doc:mid"]);
  });
});

// WP-93: the palette is now its own registry (commandRegistry.ts) with its own
// ranking, and the finder no longer carries commands. What is left to guard
// here is the route: a > query never falls through to the finder's search.
describe("commands, monos and the index", () => {
  it("keeps a > query out of the finder's search", () => {
    const commands = [
      { id: "reload", label: "Reload" },
      { id: "", label: "Missing" },
    ];
    expect(commandHits("", commands).map((hit) => hit.commandId)).toEqual(["reload"]);
    const found = assembleFinder({
      query: ">reload",
      scope: "all",
      project: "/work/this",
      commands,
      indexed: [hit({ id: "task:1", kind: "task", score: 9 })],
    });
    expect(found.map((item) => item.kind)).toEqual(["command"]);
  });

  it("matches a Mono on its name, role or mascot, and only when it works on this project", () => {
    const monos = [
      mono({ id: "1", name: "  ", role: "Design review", mascot: "owl", projects: ["/work/this"] }),
      mono({ id: "1", name: "Duplicate", projects: ["/work/other"] }),
      mono({ id: "2", name: "Fox", mascot: "fox", projects: ["C:\\Work\\Other"] }),
      mono({ id: "", name: "Nope", projects: ["/work/this"] }),
    ];
    expect(monoHits(monos, "design").map((item) => item.monoId)).toEqual(["1"]);
    expect(monoHits(monos, "fox").map((item) => item.monoId)).toEqual(["2"]);
    expect(monoHits(monos, "")).toEqual([]);
    const found = assembleFinder({
      query: "o:fox",
      scope: "project",
      project: "/work/this",
      monos,
    });
    expect(found).toEqual([]);
    const anywhere = assembleFinder({
      query: "o:fox",
      scope: "all",
      project: "/work/this",
      monos,
    });
    expect(anywhere.map((item) => item.monoId)).toEqual(["2"]);
  });

  it("drops a bad index payload and keeps a doc's block", () => {
    expect(hitsFromIndex(null)).toEqual([]);
    expect(hitsFromIndex({ tasks: "nope", docs: [null, { id: 1 }, { title: "x" }] })).toEqual([]);
    const docs = hitsFromIndex({
      docs: [{ id: "page-1", title: "Notes", snippet: "side", score: 3, project: "/work/this", blockId: "block-9" }],
      tasks: [{ id: "t1", title: "Fix", score: Number.NaN, project: "../nope" }],
    });
    expect(docs.find((item) => item.kind === "doc")?.blockId).toBe("block-9");
    expect(docs.find((item) => item.kind === "task")?.score).toBe(0);
  });
});

describe("keys, late results and a failed search", () => {
  it("opens beside only for command or ctrl, not alt", () => {
    expect(finderKeyAction({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false })).toEqual({
      type: "open",
      beside: false,
    });
    expect(finderKeyAction({ key: "Enter", metaKey: true, ctrlKey: false, altKey: false })).toEqual({
      type: "open",
      beside: true,
    });
    expect(finderKeyAction({ key: "Enter", metaKey: false, ctrlKey: true, altKey: false })).toEqual({
      type: "open",
      beside: true,
    });
    expect(finderKeyAction({ key: "Enter", metaKey: true, ctrlKey: false, altKey: true })).toEqual({
      type: "open",
      beside: false,
    });
    expect(finderKeyAction({ key: "Tab", metaKey: false, ctrlKey: false, altKey: false })).toEqual({ type: "scope" });
    expect(finderKeyAction({ key: "ArrowDown", metaKey: false, ctrlKey: false, altKey: false })).toEqual({
      type: "move",
      delta: 1,
    });
    expect(finderKeyAction({ key: "Escape", metaKey: false, ctrlKey: false, altKey: false })).toBeNull();
  });

  it("keeps the previous hits when the next load fails, and ignores a late one", () => {
    const previous = [hit({ id: "task:1", kind: "task", score: 1 })];
    expect(settle(previous, { ok: false })).toBe(previous);
    const next = [hit({ id: "doc:1", kind: "doc", score: 2 })];
    expect(settle(previous, { ok: true, value: next })).toBe(next);
    expect(acceptGeneration(2, 2)).toBe(true);
    expect(acceptGeneration(3, 2)).toBe(false);
  });
});

describe("assembleFinder", () => {
  it("prefixes drop the other kinds, and an unknown prefix does not", () => {
    const conversation: ConversationHit = {
      id: "conversation:s",
      kind: "conversation",
      sessionId: "s",
      cwd: "/work/this",
      harness: "claude",
      title: "Sidebar chat",
      updatedAt: 1,
      score: 4,
      positions: [],
    };
    const message: MessageHit = {
      id: "message:s:b",
      kind: "message",
      sessionId: "s",
      cwd: "/work/this",
      harness: "claude",
      title: "Sidebar chat",
      updatedAt: 1,
      blockId: "b",
      role: "user",
      preview: "sidebar",
      score: 3,
    };
    const app: AppSearchHit[] = [conversation, message];
    const indexed = [
      hit({ id: "task:1", kind: "task", score: 5, title: "sidebar" }),
      hit({ id: "doc:1", kind: "doc", score: 6, title: "sidebar", blockId: "block-9" }),
    ];
    const input = {
      scope: "project" as const,
      project: "/work/this",
      indexed,
      app,
      monos: [mono({ id: "m", name: "sidebar", projects: ["/work/this"] })],
    };
    expect(assembleFinder({ ...input, query: "t:sidebar" }).every((item) => item.kind === "task")).toBe(true);
    expect(assembleFinder({ ...input, query: "d:sidebar" }).every((item) => item.kind === "doc")).toBe(true);
    expect(assembleFinder({ ...input, query: "m:sidebar" }).every((item) => item.kind === "message")).toBe(true);
    expect(assembleFinder({ ...input, query: "c:sidebar" }).every((item) => item.kind === "conversation")).toBe(true);
    expect(assembleFinder({ ...input, query: "o:sidebar" }).every((item) => item.kind === "mono")).toBe(true);
    expect(assembleFinder({ ...input, query: "" })).toEqual([]);
    const open = assembleFinder({ ...input, query: "sidebar" });
    expect(open.map((item) => item.kind).sort()).toEqual(
      ["conversation", "doc", "message", "mono", "task"].sort(),
    );
    const unknown = assembleFinder({ ...input, query: "z:sidebar" });
    expect(unknown.some((item) => item.kind === "mono")).toBe(false);
    expect(unknown.some((item) => item.kind === "task")).toBe(true);
  });
});

describe("opening a hit", () => {
  function opener(): FinderOpener & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      openTask: (id, project) => calls.push(`task:${id}:${project}`),
      openDoc: (id, blockId) => calls.push(`doc:${id}:${blockId}`),
      openMessage: (sessionId, blockId, query) => calls.push(`message:${sessionId}:${blockId}:${query}`),
      openConversation: (sessionId) => calls.push(`conversation:${sessionId}`),
      openMono: (id) => calls.push(`mono:${id}`),
      openFile: (path, line, column, beside) => calls.push(`file:${path}:${line}:${column}:${beside}`),
      openProject: (path) => calls.push(`project:${path}`),
      runCommand: (id) => calls.push(`command:${id}`),
    };
  }

  it("opens each kind, and a doc or a message still opens when asked to sit beside", () => {
    const open = opener();
    routeFinderHit(hit({ id: "task:task-1", kind: "task", score: 1, project: "crew" }), false, "", open);
    routeFinderHit(hit({ id: "doc:page-1", kind: "doc", score: 1, blockId: "block-9" }), true, "", open);
    routeFinderHit(
      hit({ id: "message:s:b", kind: "message", score: 1, sessionId: "s", blockId: "b" }),
      true,
      "notes",
      open,
    );
    routeFinderHit(hit({ id: "mono:m", kind: "mono", score: 1, monoId: "m" }), false, "", open);
    routeFinderHit(
      hit({ id: "file:1", kind: "file", score: 1, path: "C:\\Work\\My File.ts" }),
      true,
      "",
      open,
    );
    routeFinderHit(hit({ id: "content:1", kind: "content", score: 1, path: "/work/a.ts", line: 4, column: 2 }), false, "", open);
    routeFinderHit(hit({ id: "command:reload", kind: "command", score: 1, commandId: "reload" }), false, "", open);
    routeFinderHit(hit({ id: "", kind: "task", score: 1 }), false, "", open);
    expect(open.calls).toEqual([
      "task:task-1:crew",
      "doc:page-1:block-9",
      "message:s:b:notes",
      "mono:m",
      "file:C:\\Work\\My File.ts:undefined:undefined:true",
      "file:/work/a.ts:4:2:false",
      "command:reload",
    ]);
  });

  it("leaves Ctrl+K to the terminal and opens the finder for the other chords", () => {
    expect(finderShortcutAction("App: Search", true, true, false)).toBe("leave");
    expect(finderShortcutAction("App: Search", true, false, true)).toBe("open");
    expect(finderShortcutAction("App: Search", false, true, false)).toBe("open");
    expect(finderShortcutAction("App: Go to File", false, true, false)).toBeNull();
    expect(finderShortcutAction(null, false, true, false)).toBeNull();
  });
});
