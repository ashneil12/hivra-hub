import { describe, expect, it } from "vitest";
import { checkBrief, renderBrief, sectionProblem, withLegacyBriefParts, LEGACY_GOAL } from "./brief";
import { briefView } from "../../sessions/model/briefView";
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
    for (const value of ["{TASK}", "{FIRSTMATE_SPEC}", "Fix the bug. {{intent}}", "<your intent here>", "<spec>", "[fill in]", "[your goal here]"])
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
      // Review of #6: ordinary briefs about code and templates.
      "Start the server on ${PORT}",
      "Run it on ${{ matrix.os }} in CI",
      "Greet {{ user.name }} on the card",
      "Wrap the details in <summary>",
      "Read ${TASK} from the environment",
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
    // A worker never talks to the person; a Lead still does, in its own chat, until WP-05.
    expect(own).toContain("never address the person yourself");
    expect(renderBrief({ intent: "a", spec: "b" }, { kind: "first-mate" })).not.toContain("never address the person");
  });

  it("keeps the definition of done as the prompt's finish line, where /goal reads it", () => {
    const prompt = briefPrompt("EXO lead", renderBrief({ intent: "a", spec: "b" }, { kind: "first-mate" }), "npm test passes");
    expect(goalFromBrief(prompt)).toBe("npm test passes");
  });

  it("ships the role rules without the credit comment", () => {
    expect(FIRST_MATE_CONTRACT.startsWith("# The first mate contract")).toBe(true);
    expect(FIRST_MATE_CONTRACT).toContain("**Never edit the project.**");
    expect(FIRST_MATE_CONTRACT).toContain("code: true");
    expect(FIRST_MATE_CONTRACT).toContain("task_accept");
    expect(FIRST_MATE_CONTRACT).not.toContain("<!--");
  });

  it("lets a worker queued before WP-10 start, with its title as the intent and a plain goal", () => {
    const old = { brief: "Fix the save bug.", title: "Save bug" };
    const filled = withLegacyBriefParts(old, "Save bug");
    expect(checkBrief({ intent: filled.intent, spec: filled.brief, done: filled.goal })).toBeUndefined();
    expect(filled.goal).toBe(LEGACY_GOAL);
    // What it already carries is kept.
    expect(withLegacyBriefParts({ ...old, intent: "Ash: fix it", goal: "It saves" }, "Save bug")).toMatchObject({
      intent: "Ash: fix it",
      goal: "It saves",
    });
  });

  it("shows a templated brief's job and words in the chat, never its fixed sections", () => {
    const prompt = briefPrompt(
      "EXO lead",
      renderBrief({ intent: "Ash: \"the save bug\"", spec: "Fix the save bug in mission two.\nThen run the tests." }, { kind: "own-checkout", mainCheckout: "/p" }),
      "It saves",
      undefined,
      "<worker_rules>\n- rules\n</worker_rules>",
    );
    const view = briefView(prompt)!;
    expect(view.job).toBe("Fix the save bug in mission two.");
    expect(view.body).toContain("the save bug");
    expect(view.body).toContain("Then run the tests.");
    for (const fixed of ["Isolation check", "Status protocol", "Steering", "## Intent", "## Spec", "git rev-parse"])
      expect(view.body).not.toContain(fixed);
  });
});
