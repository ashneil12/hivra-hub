// @vitest-environment happy-dom
// Agent-to-agent notes, PM's look (Critiquito 21 Oct): one quiet muted line, no bubble, the agent with a chat to open
// is a clickable name (no chat: plain text); notes landing together fold into one line that expands. Not a log.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNote } from "../model/agentNotes";
import { setDelegationActions } from "../model/delegationStore";
import { FOLD_MS, foldedLine, noteParts, noteRuns } from "../model/agentNoteView";
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
    expect(foldedLine([a, note({ kind: "stuck", from: worker, to: lead })])).toBe('2 team notes: Lead messaged Worker "Example: fix the save bug", Worker "Example: fix the save bug" got stuck');
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
    expect(row.textContent).toBe('Lead messaged Worker "Example: fix the save bug": Example: fix the save bug');
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
    const notes = [note({ at: 0 }), note({ at: 1, taskId: "t-2", to: { session: "w-2", name: "Worker \"Example: tidy the HUD\"" }, target: "w-2" }), note({ kind: "stuck", from: worker, to: lead, at: 2 })];
    render(createElement(AgentNoteGroup, { notes }));
    const fold = container.querySelector<HTMLButtonElement>("[data-agent-note-fold]")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toMatch(/^3 team notes: Lead messaged/);
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
