import { describe, expect, it } from "vitest";
import { checkBrief, renderBrief, sectionProblem } from "./brief";
import { FIRST_MATE_CONTRACT } from "./contract";
import { goalFromBrief } from "../../../integrations/harness/providers/claude/claudeGoal";
import { briefPrompt } from "../../agent-app/model/agentAppTasks";

describe("the brief scaffold (Hivra WP-10)", () => {
  it("lets a filled brief through", () => {
    expect(
      checkBrief({ intent: "Ash: \"the export button does nothing on Safari\"", spec: "Fix src/export.ts.", done: "The export spec passes in WebKit" }),
    ).toBeUndefined();
  });

  it("refuses each empty or placeholder section, naming the field to fill", () => {
    for (const value of [undefined, null, 42, "", "   ", "TODO", "tbd.", "N/A", "...", "…", "?", "same as above", "Placeholder", "lorem ipsum"])
      expect(sectionProblem(value), String(value)).toBeDefined();
    for (const value of [
      "{TASK}",
      "Fix the bug. {{intent}}",
      "<your intent here>",
      "<describe the change>",
      "[fill in]",
      "[TODO]",
      "Lorem ipsum dolor sit amet",
    ])
      expect(sectionProblem(value), value).toMatch(/still has a placeholder/);
    const refusal = checkBrief({ intent: "TODO", spec: "Fix it", done: "" })!;
    expect(refusal).toContain("The intent (intent) is a placeholder");
    expect(refusal).toContain("The definition of done (goal) is empty");
    expect(refusal).not.toContain("(brief)");
  });

  it("doesn't mistake ordinary words for placeholders", () => {
    for (const value of [
      "Remove the TODO comment in src/save.ts",
      "Render <div> and <span> the same way",
      "Wrap the list in [brackets]",
      "Use {count} in the message template",
      "Do it.",
    ])
      expect(sectionProblem(value), value).toBeUndefined();
  });

  it("writes the fixed sections around the intent and spec, with the isolation check the launch needs", () => {
    const own = renderBrief({ intent: "Ash: fix it", spec: "Change a.ts" }, { kind: "own-checkout", mainCheckout: "/p" });
    expect(own.split("\n\n").map((part) => part.split("\n")[0])).toEqual([
      "## Isolation check",
      "## Intent",
      "## Spec",
      "## Status protocol",
      "## Steering",
    ]);
    expect(own).toContain("never in the project's main checkout (/p)");
    expect(own).toContain("stop at once: change nothing");
    expect(renderBrief({ intent: "a", spec: "b" }, { kind: "shared", folder: "/p" })).toContain("the shared folder /p, on purpose");
    expect(renderBrief({ intent: "a", spec: "b" }, { kind: "first-mate" })).toContain("read the project, never edit it");
  });

  it("keeps the definition of done as the prompt's finish line, where /goal reads it", () => {
    const prompt = briefPrompt("EXO lead", renderBrief({ intent: "a", spec: "b" }, { kind: "first-mate" }), "npm test passes");
    expect(goalFromBrief(prompt)).toBe("npm test passes");
  });

  it("ships the role rules without the credit comment", () => {
    expect(FIRST_MATE_CONTRACT.startsWith("# The first mate contract")).toBe(true);
    expect(FIRST_MATE_CONTRACT).toContain("**Never edit the project.**");
    expect(FIRST_MATE_CONTRACT).not.toContain("<!--");
  });
});
