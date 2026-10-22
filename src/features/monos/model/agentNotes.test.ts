// @vitest-environment happy-dom
// Agent-to-agent notes (Ash, 21 Oct 20:45): "Lead messaged Worker X", "Worker X messaged Lead", "Worker X got stuck",
// a report; each a small note in the owner's chat that opens the worker's chat when there is one, else plain text.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Delegation } from "./delegations";
import { agentNoteBlock, agentNotesFor, agentNoteText, defaultNoteNames, newAgentNoteBlocks } from "./agentNotes";
import { setDelegationActions } from "./delegationStore";
import { AgentNoteRow } from "../ui/AgentNoteRow";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "lead-chat", ownerMono: "hivra-lead", batchId: null, parentId: null, rootId: id,
    childSession: `app-lead-chat-${id}`, requestId: id, generation: 1, project: "hivra", title: "Fix the save bug", brief: null,
    goal: null, askIds: [], state: "running", errorClass: null, error: null, retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: NOW - 10 * MIN, updatedAt: NOW - 10 * MIN,
    settledAt: null, log: [], version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  } as Delegation;
}
const all = () => true;

afterEach(() => vi.unstubAllGlobals());

describe("agent notes from the delegation rows", () => {
  it("delegated, asked, stuck and reported each make one typed note, from and to the right chats", () => {
    const asked = agentNotesFor(row("a", { state: "question", pendingQuestion: "Which format? [JSON | binary]", log: [{ event: "asked", at: NOW - 2 * MIN }] }), NOW, all);
    expect(asked.map((n) => [n.kind, n.from.name, n.to.name, n.target])).toEqual([
      ["messaged", "Lead", 'Worker "Fix the save bug"', "app-lead-chat-a"],
      ["messaged", 'Worker "Fix the save bug"', "Lead", "app-lead-chat-a"],
    ]);
    expect(agentNoteText(asked[0])).toBe('Lead messaged Worker "Fix the save bug": Fix the save bug');
    expect(agentNoteText(asked[1])).toBe('Worker "Fix the save bug" messaged Lead: Which format? [JSON | binary]');
    const failed = agentNotesFor(row("f", { state: "failed", error: "The build broke.", settledAt: NOW - MIN }), NOW, all);
    expect(failed[1]).toMatchObject({ kind: "stuck", line: "Failed: the build broke" });
    expect(agentNoteText(failed[1])).toBe('Worker "Fix the save bug" got stuck: Failed: the build broke');
    const done = agentNotesFor(row("d", { state: "completed", result: "Fixed it.\nDetails…", settledAt: NOW - MIN }), NOW, all);
    expect(done[1]).toMatchObject({ kind: "reported", line: "Fixed it.", at: NOW - MIN });
  });

  it("names the owner as the Mono it is, not 'Lead' (Alfred's own team read 'Lead messaged Worker')", () => {
    const names = { alfred: "Alfred", "hub-lead": "MonoCode Hub lead" } as Record<string, string>;
    const own = row("o", { ownerMono: "alfred", title: "Write qa-a8 note" });
    const notes = agentNotesFor(own, NOW, all, defaultNoteNames(own, (id) => names[id]));
    expect(agentNoteText(notes[0])).toBe('Alfred messaged Worker "Write qa-a8 note": Write qa-a8 note');
    expect(defaultNoteNames(row("l", { ownerMono: "hub-lead" }), (id) => names[id]).owner).toBe("MonoCode Hub lead");
    // Unknown Mono: "Lead" as before; no Mono at all: "Chat".
    expect(defaultNoteNames(row("u", { ownerMono: "gone" }), () => undefined).owner).toBe("Lead");
    expect(defaultNoteNames(row("c", { ownerMono: null }), (id) => names[id]).owner).toBe("Chat");
  });

  it("a worker whose chat is gone gets notes without a link", () => {
    const notes = agentNotesFor(row("g", { state: "completed", settledAt: NOW }), NOW, () => false);
    expect(notes.every((n) => n.target === null)).toBe(true);
  });

  it("adds each move once, to the owner's chat, and never replays history from before this run", () => {
    const rows = [row("old", { createdAt: NOW - 60 * MIN }), row("new", { createdAt: NOW - MIN, state: "completed", settledAt: NOW })];
    const chats = [{ id: "lead-chat", blocks: [] as { id: string }[] }];
    const first = newAgentNoteBlocks(rows, chats, NOW - 5 * MIN, NOW, all);
    expect(first.map((n) => [n.chatId, n.block.agentNote!.kind, n.block.agentNote!.taskId])).toEqual([
      ["lead-chat", "messaged", "new"],
      ["lead-chat", "reported", "new"],
    ]);
    expect(first[0].block).toMatchObject({ role: "system", text: expect.stringContaining("Lead messaged") });
    const again = newAgentNoteBlocks(rows, [{ id: "lead-chat", blocks: first.map((n) => n.block) }], NOW - 5 * MIN, NOW, all);
    expect(again).toEqual([]);
    // No owner chat open: nothing to add it to.
    expect(newAgentNoteBlocks(rows, [], NOW - 5 * MIN, NOW, all)).toEqual([]);
  });
});

describe("the default note in a chat", () => {
  it("opens the worker's chat under the owner when it exists, and is plain text when it doesn't", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const openChild = vi.fn();
    const off = setDelegationActions({ openChild } as never);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const [, up] = agentNotesFor(row("a", { state: "question", pendingQuestion: "Which?" }), NOW, all);
    act(() => root.render(createElement(AgentNoteRow, { note: up })));
    act(() => container.querySelector<HTMLButtonElement>("[data-agent-note-open]")!.click());
    expect(openChild).toHaveBeenCalledWith("lead-chat", "app-lead-chat-a");
    const gone = agentNoteBlock(agentNotesFor(row("b"), NOW, () => false)[0]).agentNote!;
    act(() => root.render(createElement(AgentNoteRow, { note: gone })));
    expect(container.querySelector("[data-agent-note-open]")).toBeNull();
    expect(container.querySelector("[data-agent-note]")?.textContent).toContain("Lead messaged");
    act(() => root.unmount());
    container.remove();
    off();
  });
});
