// r87, c02 run 1: a finished job's note showed the app's raw "[MonoCode landed] The app put this worker's changes…" line.
import { describe, expect, it } from "vitest";
import { summaryLine } from "./agentNotes";

describe("a landed job's note line", () => {
  it("says it is in the project, then the worker's own first sentence", () => {
    const result =
      "[MonoCode landed] The app put this worker's changes into the project (not committed): README.md.\n\nDocumented `GET /health` in the README endpoints table. No route was added.";
    expect(summaryLine(result)).toBe("In the project. Documented GET /health in the README endpoints table.");
    expect(summaryLine("[MonoCode not landed] Its changes clash with the project.\n\nThe board shows last week.")).toBe(
      "Not in the project yet. The board shows last week.",
    );
    expect(summaryLine("Plain result. More.")).toBe("Plain result.");
  });
});
