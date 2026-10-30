// r96 item 1 (c02 BLIND 6968, +216s): the Lead's delegate_task call carried the goal "GET /health says it is alive, a
// negative bump is rejected with a plain-English error, and npm test passed." The preview read a path out of those
// words, so the chat showed "Read health says it is alive, … and npm test passed." while the suite was red. A goal is
// never shown as a result: MonoCode's own tools get no file preview, and their rows use the tool's own words.
import { describe, expect, it } from "vitest";
import { extractToolPreview, titleFromToolInput } from "../../../integrations/harness/core/preview";
import { previewFromTool, toolTitle } from "../../../integrations/harness/providers/claude/claudeProtocol";
import type { Block } from "./session";
import { toolCallLabel, toolCategory } from "./transcriptActivity";

const NAME = "mcp__monocode__delegate_task";
const input = {
  title: "API health and negative bump",
  brief: "Ash said: \"add a GET /health endpoint that says its alive\". May change: packages/api/src/server.ts. Check: npm test.",
  goal: "GET /health says it is alive, a negative bump is rejected with a plain-English error, and npm test passed.",
};

describe("a delegate_task goal is never a result line", () => {
  it("gets no file preview and keeps its tool name as its title, in every provider path", () => {
    expect(extractToolPreview({ title: NAME, name: NAME, kind: NAME, rawInput: input }, { title: NAME, name: NAME })).toBeUndefined();
    expect(previewFromTool(NAME, input)).toBeUndefined();
    expect(titleFromToolInput(NAME, NAME, input)).toBe(NAME);
    expect(toolTitle(NAME, input)).toBe(NAME);
    expect(toolTitle(NAME, input)).not.toMatch(/^Read|npm test passed/);
    // The README job's goal and its file list read as "Read README.md" before; not any more.
    expect(previewFromTool(NAME, { brief: "Document GET /health", goal: "The README documents GET /health, and npm test passed.", files: ["README.md"] })).toBeUndefined();
  });

  it("the row reads 'Delegated a task', even for a block stored with the old read preview (6968's own block)", () => {
    const stored: Block = {
      id: "449405ec",
      role: "tool",
      text: `Read ${input.goal}`,
      tool: {
        callId: "call-4b2d40fb-2",
        kind: NAME,
        status: "completed",
        title: `Read ${input.goal}`,
        detail: JSON.stringify({ taskId: "t1", status: "running", childSessionId: "app-x" }),
        preview: { kind: "read", path: input.goal, fileName: "health says it is alive, a negative bump is rejected with a plain-English error, and npm test passed.", title: NAME },
      },
    } as Block;
    expect(toolCallLabel(stored)).toBe("Delegated a task");
    expect(toolCategory(stored)).toBe("other");
  });

  it("a sentence with a slash in it is not a path, a real path still is", () => {
    const sentence = extractToolPreview({ title: "Read", kind: "read", rawInput: { path: input.goal } }, {});
    expect(sentence?.path).toBeUndefined();
    expect(extractToolPreview({ title: "Read", kind: "read", rawInput: { path: "packages/api/src/server.ts" } }, {})?.path).toBe("packages/api/src/server.ts");
    expect(extractToolPreview({ title: "Read", kind: "read", rawInput: { path: "docs/My Notes.md" } }, {})?.path).toBe("docs/My Notes.md");
  });
});
