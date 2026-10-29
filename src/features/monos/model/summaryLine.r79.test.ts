import { describe, expect, it } from "vitest";
import { summaryLine } from "./agentNotes";

// r79 (c02, Critiquito): a finished job comes back as one short line, not the head of the worker's paste.
describe("summaryLine", () => {
  it("is the result's first sentence in plain words", () => {
    expect(summaryLine("GET `/health` is in place and returns `{ ok: true }`. Tests: 14 pass.\n\n```ts\nconst x = 1;\n```")).toBe(
      "GET /health is in place and returns { ok: true }.",
    );
  });
  it("drops a paste's lead-in colon and list marks, and keeps dotted names whole", () => {
    expect(summaryLine("**Added one row to the Endpoints table in README.md:**\n\n| GET | /health |")).toBe("Added one row to the Endpoints table in README.md");
    expect(summaryLine("- Negative bumps now get a 400 with a plain message")).toBe("Negative bumps now get a 400 with a plain message");
  });
  it("is cut at a word when the sentence runs long, and empty when there is no text", () => {
    const line = summaryLine(`The board ${"shows last week next to this week ".repeat(6)}now.`)!;
    expect(line.length).toBeLessThanOrEqual(101);
    expect(line.endsWith("…")).toBe(true);
    expect(summaryLine("  \n")).toBeUndefined();
    expect(summaryLine(null)).toBeUndefined();
  });
});
