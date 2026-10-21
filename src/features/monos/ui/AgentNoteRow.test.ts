// @vitest-environment happy-dom
// Agent-to-agent notes, PM's look (Critiquito 21 Oct): one quiet muted line, no bubble, the agent with a chat to open
// is a clickable name (no chat: plain text); notes landing together fold into one line that expands. Not a log.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNote } from "../model/agentNotes";
import { setDelegationActions } from "../model/delegationStore";
import { detailOf, FOLD_MS, foldedLine, noteParts, noteRuns, noteText } from "../model/agentNoteView";
import { isActivityBlock } from "../../sessions/model/transcriptActivity";
import { agentNoteBlock } from "../model/agentNotes";
import { AgentNoteGroup, AgentNoteRow } from "./AgentNoteRow";

const lead = { session: "lead-chat", name: "Lead" };
const worker = { session: "w-1", name: 'Worker "Example: fix the save bug"' };
const note = (over: Partial<AgentNote> = {}): AgentNote => ({ kind: "messaged", from: lead, to: worker, target: "w-1", taskId: "t-1", at: 1_000, ...over });

let root: Root;
let container: HTMLElement;
const actions = { openOwner: vi.fn(), openChild: vi.fn(), stopTree: vi.fn(), stopRow: vi.fn() };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  setDelegationActions(actions);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (el: ReturnType<typeof createElement>) => act(() => root.render(el));

describe("the words", () => {
  it("names who did what; only the agent whose chat exists is a link", () => {
    expect(noteParts(note()).head).toEqual([
      { kind: "name", text: "Lead", opens: null },
      { kind: "text", text: " messaged " },
      { kind: "name", text: 'Worker "Example: fix the save bug"', opens: "w-1" },
    ]);
    expect(noteParts(note({ kind: "stuck", from: worker, to: lead })).head.map((p) => p.text).join("")).toBe('Worker "Example: fix the save bug" got stuck');
    expect(noteParts(note({ kind: "reported", from: worker, to: lead })).head.map((p) => p.text).join("")).toBe('Worker "Example: fix the save bug" reported to Lead');
    expect(noteParts(note({ target: null })).head.some((p) => p.kind === "name" && p.opens)).toBe(false);
  });

  it("notes landing together are one run; a gap starts a new one", () => {
    const a = note({ at: 0 }), b = note({ at: 30_000 }), c = note({ at: 60_000 }), d = note({ at: 60_000 + FOLD_MS + 1 });
    expect([...noteRuns([a, b, c, undefined, d]).entries()]).toEqual([[0, 3], [1, 0], [2, 0], [4, 1]]);
    expect([...noteRuns([a, undefined, b]).entries()]).toEqual([[0, 1], [2, 1]]);
    expect(foldedLine([a, b])).toBe("2 team notes");
  });

  it("round 21: a stuck note never folds; routine notes either side of it fold on their own", () => {
    const m = (at: number) => note({ at });
    const stuck = note({ kind: "stuck", from: worker, to: lead, at: 3_000 });
    // three routine, the stuck one, two routine, all within the fold window
    expect([...noteRuns([m(0), m(1_000), m(2_000), stuck, m(4_000), m(5_000)]).entries()]).toEqual([
      [0, 3], [1, 0], [2, 0], [3, 1], [4, 2], [5, 0],
    ]);
    // two stuck in a row stay two lines
    expect([...noteRuns([stuck, { ...stuck, at: 3_500, taskId: "t-2" }]).entries()]).toEqual([[0, 1], [1, 1]]);
  });

  it("round 21: a folded line is just the count", () => {
    expect(foldedLine([note(), note(), note()])).toBe("3 team notes");
  });

  it("round 21: the detail is left off when it only repeats the worker's label", () => {
    expect(detailOf(note({ line: "Example: fix the save bug" }))).toBeUndefined();
    expect(detailOf(note({ line: "Example: fix the save bug." }))).toBeUndefined();
    // the label is cut at 60 characters, the line at 140: still the same task
    const long = "Example: rework the save system so old saves load and the new format is written every time";
    const cut = { session: "w-1", name: `Worker "${long.slice(0, 58)}…"` };
    expect(detailOf(note({ to: cut, line: long }))).toBeUndefined();
    // anything else is kept
    expect(detailOf(note({ kind: "messaged", from: worker, to: lead, line: "Which format? [JSON | binary]" }))).toBe("Which format? [JSON | binary]");
    expect(detailOf(note({ kind: "stuck", from: worker, to: lead, line: "Failed: the build broke" }))).toBe("Failed: the build broke");
    expect(noteText(note({ line: "Example: fix the save bug" }))).toBe('Lead messaged Worker "Example: fix the save bug"');
  });

  it("a note keeps its own line in the chat, never folded into the work trail", () => {
    expect(isActivityBlock(agentNoteBlock(note()))).toBe(false);
    expect(isActivityBlock({ id: "s", role: "system", text: "Still running: 2" })).toBe(true);
  });
});

describe("the row", () => {
  it("is one quiet muted line with no bubble; the worker's name opens its chat", () => {
    render(createElement(AgentNoteRow, { note: note({ line: "Example: fix the save bug" }) }));
    const row = container.querySelector("[data-agent-note]")!;
    expect(row.getAttribute("data-agent-note")).toBe("messaged");
    expect(row.className).toContain("text-content/50");
    expect(row.className).not.toMatch(/rounded|bg-|border|shadow/);
    // the brief's first line is the worker's label: said once, not twice
    expect(row.textContent).toBe('Lead messaged Worker "Example: fix the save bug"');
    expect(row.getAttribute("aria-label")).toBe('Lead messaged Worker "Example: fix the save bug"');
    const links = row.querySelectorAll("[data-agent-note-open]");
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('Worker "Example: fix the save bug"');
    act(() => (links[0] as HTMLButtonElement).click());
    expect(actions.openChild).toHaveBeenCalledWith("lead-chat", "w-1");
  });

  it("with no chat to open, it is plain text: no link at all", () => {
    render(createElement(AgentNoteRow, { note: note({ kind: "stuck", from: worker, to: lead, target: null }) }));
    expect(container.querySelector("[data-agent-note]")?.textContent).toBe('Worker "Example: fix the save bug" got stuck');
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("the fold", () => {
  it("several notes show as one line that expands into each, and folds back", () => {
    const notes = [note({ at: 0 }), note({ at: 1, taskId: "t-2", to: { session: "w-2", name: "Worker \"Example: tidy the HUD\"" }, target: "w-2" }), note({ kind: "reported", from: worker, to: lead, at: 2 })];
    render(createElement(AgentNoteGroup, { notes }));
    const fold = container.querySelector<HTMLButtonElement>("[data-agent-note-fold]")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toBe("3 team notes");
    expect(container.querySelectorAll("[data-agent-note]")).toHaveLength(0);
    act(() => fold.click());
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll("[data-agent-note]")).toHaveLength(3);
    act(() => container.querySelectorAll<HTMLButtonElement>("[data-agent-note-open]")[1].click());
    expect(actions.openChild).toHaveBeenCalledWith("lead-chat", "w-2");
    act(() => fold.click());
    expect(container.querySelectorAll("[data-agent-note]")).toHaveLength(0);
  });
});
