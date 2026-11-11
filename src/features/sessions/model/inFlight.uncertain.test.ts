// WP-243: a call a quit, crash or reload cut while it may have been running is recorded as uncertain, never run again,
// and named in the resume note.
import { describe, expect, it } from "vitest";
import { markTurnInterrupted, resumePrompt, uncertainCalls, uncertainNote, CONTINUE_PROMPT } from "./inFlight";
import type { Block, Session } from "./session";

function chat(blocks: Block[]): Session {
  return { id: "s-uncertain", harness: "claude", model: "m", modelSettings: {}, runtimeMode: "supervised", title: "t", cwd: "/tmp/example", busy: true, blocks } as Session;
}

const user: Block = { id: "u", role: "user", text: "Example: deploy the preview", startedAt: 1 };

describe("an interrupted tool call", () => {
  it("is marked uncertain when it was running, or allowed and not yet back", () => {
    const sealed = markTurnInterrupted(
      chat([
        user,
        { id: "run", role: "tool", text: "Deploy", tool: { callId: "toolu_1", title: "Bash", status: "in_progress", command: "npm run deploy:preview" } },
        {
          id: "allowed",
          role: "tool",
          text: "Migrate",
          tool: { callId: "toolu_2", title: "Bash", status: "pending", command: "npm run migrate" },
          approval: { requestId: 1, decided: "allow", call: { tool: "Bash", command: "npm run migrate" } },
        },
      ]),
    );
    const tools = sealed.blocks.filter((b) => b.role === "tool");
    expect(tools.map((b) => [b.tool?.status, b.tool?.uncertain])).toEqual([
      ["cancelled", true],
      ["cancelled", true],
    ]);
    expect(uncertainCalls(sealed.blocks).map((b) => b.id)).toEqual(["run", "allowed"]);
  });

  it("is not uncertain when it never started: its card was still waiting on Ash, or he refused it", () => {
    const sealed = markTurnInterrupted(
      chat([
        user,
        {
          id: "waiting",
          role: "tool",
          text: "Publish",
          tool: { title: "Bash", status: "pending", command: "npm publish" },
          approval: { requestId: 2, call: { tool: "Bash", command: "npm publish" } },
        },
        {
          id: "denied",
          role: "tool",
          text: "Drop",
          tool: { title: "Bash", status: "pending", command: "dropdb example" },
          approval: { requestId: 3, decided: "deny" },
        },
        { id: "done", role: "tool", text: "Read", tool: { title: "Read", status: "completed" } },
      ]),
    );
    expect(uncertainCalls(sealed.blocks)).toEqual([]);
    expect(uncertainNote(sealed.blocks)).toBeNull();
  });

  it("is named in the resume note and not run again: the resume is words to the agent, never the call", () => {
    const sealed = markTurnInterrupted(
      chat([user, { id: "run", role: "tool", text: "Deploy", tool: { callId: "toolu_9", title: "Bash", status: "running", command: "npm run deploy:preview" } }]),
    );
    const prompt = resumePrompt({ ...sealed, cutWork: [], queuedMessages: [] });
    expect(prompt).toContain("whether they finished is unknown. They were not run again.");
    expect(prompt).toContain("- npm run deploy:preview (id toolu_9)");
    expect(prompt).toContain("Do not repeat one as it was");
    expect(prompt.endsWith(CONTINUE_PROMPT)).toBe(true);
    // Nothing is left open that a later answer could send: the call is sealed, its status cancelled.
    const call = sealed.blocks.find((b) => b.id === "run");
    expect(call?.tool?.status).toBe("cancelled");
    expect(call?.approval).toBeUndefined();
  });

  it("names only the last turn's uncertain calls", () => {
    const blocks: Block[] = [
      { id: "old", role: "tool", text: "Old", tool: { title: "Bash", status: "cancelled", uncertain: true, command: "old" } },
      { id: "u2", role: "user", text: "Example: carry on", startedAt: 2 },
      { id: "new", role: "tool", text: "New", tool: { title: "Bash", status: "cancelled", uncertain: true, command: "new" } },
    ];
    expect(uncertainCalls(blocks).map((b) => b.id)).toEqual(["new"]);
  });
});
