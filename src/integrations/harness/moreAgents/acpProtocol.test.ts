import { describe, expect, it } from "vitest";
import { MORE_AGENT_COPY } from "../../../features/providers/model/moreAgents";
import {
  eventsFromUpdate,
  namesModels,
  permissionAsk,
  permissionOutcome,
  readInitialize,
} from "./acpProtocol";

const update = (value: Record<string, unknown>) => ({ sessionId: "s", update: value });

describe("generic ACP mapping", () => {
  it("accepts protocol version 1 only", () => {
    expect(readInitialize({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "x" } })).toEqual({
      ok: true,
      loadSession: true,
      agentName: "x",
    });
    expect(readInitialize({ protocolVersion: 2 })).toEqual({ ok: false, message: MORE_AGENT_COPY.wrongVersion });
    expect(readInitialize(null)).toEqual({ ok: false, message: MORE_AGENT_COPY.wrongVersion });
    expect(readInitialize({ protocolVersion: "1" }).ok).toBe(false);
  });

  it("streams message and thought chunks", () => {
    const seen = new Set<string>();
    expect(
      eventsFromUpdate(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } }), seen),
    ).toEqual([{ type: "message.delta", text: "Hi" }]);
    expect(
      eventsFromUpdate(update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Hm" } }), seen),
    ).toEqual([{ type: "reasoning.delta", text: "Hm" }]);
    expect(eventsFromUpdate(update({ sessionUpdate: "something_new" }), seen)).toEqual([]);
    expect(eventsFromUpdate("junk", seen)).toEqual([]);
  });

  it("shows a diff preview, and says when a tool carries none", () => {
    const seen = new Set<string>();
    const edit = eventsFromUpdate(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "e1",
        status: "completed",
        content: [{ type: "diff", path: "notes.txt", oldText: "old\n", newText: "new\n" }],
      }),
      seen,
    );
    expect(edit).toHaveLength(1);
    expect(edit[0]).toMatchObject({ type: "tool.updated", callId: "e1", status: "completed" });
    expect((edit[0] as { preview?: { path?: string } }).preview?.path).toContain("notes.txt");

    const plain = eventsFromUpdate(
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Thinking hard", kind: "think", status: "in_progress" }),
      seen,
    );
    expect(plain).toEqual([
      { type: "tool.started", callId: "t1", title: "Thinking hard", kind: "think", status: "in_progress" },
      { type: "tool.updated", callId: "t1", detail: MORE_AGENT_COPY.noPreview },
    ]);
  });

  it("does not cover a located tool with the no-preview line on a later bare update", () => {
    const seen = new Set<string>();
    eventsFromUpdate(
      update({ sessionUpdate: "tool_call", toolCallId: "r1", title: "Read file", kind: "read", locations: [{ path: "a.ts" }] }),
      seen,
    );
    const later = eventsFromUpdate(update({ sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed" }), seen);
    expect(later).toEqual([{ type: "tool.updated", callId: "r1", status: "completed" }]);
  });

  it("keeps a tool's text output as its detail", () => {
    const events = eventsFromUpdate(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "x1",
        content: [{ type: "content", content: { type: "text", text: "3 files" } }],
      }),
      new Set(),
    );
    expect(events.at(-1)).toEqual({ type: "tool.updated", callId: "x1", detail: "3 files" });
  });

  it("answers allow with a one-time allow only, and deny with a reject", () => {
    const ask = permissionAsk({
      sessionId: "s",
      toolCall: { toolCallId: "e1", title: "Edit notes.txt", kind: "edit" },
      options: [
        { optionId: "always", kind: "allow_always" },
        { optionId: "once", kind: "allow_once" },
        { optionId: "no", kind: "reject_once" },
      ],
    });
    expect(ask).toMatchObject({ callId: "e1", kind: "edit" });
    expect(permissionOutcome(ask, "allow")).toEqual({ outcome: "selected", optionId: "once" });
    expect(permissionOutcome(ask, "deny")).toEqual({ outcome: "selected", optionId: "no" });
    const onlyAlways = permissionAsk({ toolCall: {}, options: [{ optionId: "a", kind: "allow_always" }] });
    expect(permissionOutcome(onlyAlways, "allow")).toEqual({ outcome: "cancelled" });
    expect(onlyAlways.title).toBe("Permission");
  });

  it("knows whether session/new named any models", () => {
    expect(namesModels({ models: { availableModels: [{ modelId: "m" }] } })).toBe(true);
    expect(namesModels({ models: { availableModels: [] } })).toBe(false);
    expect(namesModels({ sessionId: "s" })).toBe(false);
  });
});
