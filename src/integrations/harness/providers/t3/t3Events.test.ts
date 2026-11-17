import { describe, expect, it } from "vitest";
import { markT3ItemSeen, t3ItemEvents, type T3Item, type T3Seen } from "./t3Events";

const ask = (requestId: string) => (requestId === "request-a" ? 1 : 2);
const item = (fields: Partial<T3Item> & Pick<T3Item, "id" | "type">): T3Item => ({ status: "running", ...fields });

describe("t3ItemEvents", () => {
  it("says only what is new as a message grows, and that it is complete once", () => {
    const seen = new Map<string, T3Seen>();
    const message = (text: string, streaming: boolean) =>
      item({ id: "m1", type: "assistant_message", text, streaming, status: streaming ? "running" : "completed" });
    expect(t3ItemEvents(message("Example: on", true), seen, ask)).toEqual([{ type: "message.delta", text: "Example: on" }]);
    expect(t3ItemEvents(message("Example: on it.", true), seen, ask)).toEqual([{ type: "message.delta", text: " it." }]);
    expect(t3ItemEvents(message("Example: on it.", false), seen, ask)).toEqual([{ type: "message.completed" }]);
    expect(t3ItemEvents(message("Example: on it.", false), seen, ask)).toEqual([]);
  });

  it("keeps thinking apart from the reply", () => {
    const seen = new Map<string, T3Seen>();
    expect(
      t3ItemEvents(item({ id: "r1", type: "reasoning", text: "Example: sort the list", streaming: false, status: "completed" }), seen, ask),
    ).toEqual([{ type: "reasoning.delta", text: "Example: sort the list" }, { type: "reasoning.completed" }]);
  });

  it("starts a command once and finishes it once, with its output", () => {
    const seen = new Map<string, T3Seen>();
    const command = (status: string, output?: string) => item({ id: "c1", type: "command_execution", input: "npm test", status, output });
    expect(t3ItemEvents(command("running"), seen, ask)).toEqual([
      { type: "tool.started", callId: "c1", title: "npm test", kind: "execute", status: "in_progress", command: "npm test" },
    ]);
    expect(t3ItemEvents(command("running"), seen, ask)).toEqual([]);
    expect(t3ItemEvents(command("completed", "Example: 4 passed"), seen, ask)).toEqual([
      { type: "tool.updated", callId: "c1", status: "completed" },
      { type: "tool.updated", callId: "c1", detail: "Example: 4 passed" },
    ]);
    expect(t3ItemEvents(command("completed", "Example: 4 passed"), seen, ask)).toEqual([]);
  });

  it("names an edit by its file, a crew member by its title and a failed step as failed", () => {
    const seen = new Map<string, T3Seen>();
    expect(t3ItemEvents(item({ id: "f1", type: "file_change", fileName: "src/app.ts", status: "failed" }), seen, ask)).toEqual([
      { type: "tool.started", callId: "f1", title: "Edit src/app.ts", kind: "edit", status: "failed", paths: ["src/app.ts"] },
    ]);
    expect(t3ItemEvents(item({ id: "s1", type: "subagent", title: "Example: test runner" }), seen, ask)).toEqual([
      { type: "tool.started", callId: "s1", title: "Example: test runner", kind: "agent", status: "in_progress" },
    ]);
  });

  it("turns T3's plan steps into the chat's task list", () => {
    const steps = [
      { id: "1", text: "Example: read", status: "completed" },
      { id: "2", text: "Example: fix", status: "running" },
      { id: "3", text: "Example: test", status: "pending" },
    ];
    expect(t3ItemEvents(item({ id: "t1", type: "todo_list", steps }), new Map(), ask)).toEqual([
      {
        type: "tasks.updated",
        key: "t3-plan",
        authoritative: true,
        items: [
          { id: "1", text: "Example: read", status: "completed" },
          { id: "2", text: "Example: fix", status: "in_progress" },
          { id: "3", text: "Example: test", status: "pending" },
        ],
      },
    ]);
  });

  it("asks a question on the app's own card and says when it was answered", () => {
    const seen = new Map<string, T3Seen>();
    const question = (status: string) =>
      item({
        id: "q1",
        type: "user_input_request",
        status,
        requestId: "request-a",
        questions: [
          {
            id: "music",
            header: "Example: music",
            question: "Example: which take?",
            allowCustomAnswer: false,
            options: [{ label: "Take A", description: "Take A" }, { label: "Take B", description: "Example: choir first" }],
          },
        ],
      });
    expect(t3ItemEvents(question("waiting"), seen, ask)).toEqual([
      {
        type: "question.asked",
        requestId: 1,
        callId: "q1",
        questions: [
          {
            id: "music",
            header: "Example: music",
            prompt: "Example: which take?",
            multiSelect: false,
            allowCustom: false,
            options: [{ id: "Take A", label: "Take A" }, { id: "Take B", label: "Take B", description: "Example: choir first" }],
          },
        ],
      },
    ]);
    expect(t3ItemEvents(question("waiting"), seen, ask)).toEqual([]);
    expect(t3ItemEvents(question("completed"), seen, ask)).toEqual([{ type: "question.resolved", requestId: 1, decision: "answered" }]);
  });

  it("asks for an approval and reports how it ended", () => {
    const seen = new Map<string, T3Seen>();
    const approval = (status: string) =>
      item({ id: "a1", type: "approval_request", status, requestId: "request-b", requestKind: "command", prompt: "Example: run rm -rf build" });
    expect(t3ItemEvents(approval("waiting"), seen, ask)).toEqual([
      { type: "approval.requested", requestId: 2, callId: "a1", title: "Example: run rm -rf build", kind: "command" },
    ]);
    expect(t3ItemEvents(approval("cancelled"), seen, ask)).toEqual([{ type: "approval.resolved", requestId: 2, decision: "cancelled" }]);
  });

  it("says nothing about what was in the thread before the turn, or about an item type it does not know", () => {
    const seen = new Map<string, T3Seen>();
    const old = item({ id: "m0", type: "assistant_message", text: "Example: earlier", streaming: false, status: "completed" });
    markT3ItemSeen(old, seen);
    expect(t3ItemEvents(old, seen, ask)).toEqual([]);
    expect(t3ItemEvents(item({ id: "x1", type: "from_a_newer_engine" }), seen, ask)).toEqual([]);
  });
});
