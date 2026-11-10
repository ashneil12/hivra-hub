import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBrief, renderBrief, sectionProblem, specOf, withLegacyBriefParts, LEGACY_GOAL } from "./brief";
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
    expect(own).toContain("**Verify isolation before anything else.**");
    expect(own).toContain("STOP - do not branch or commit here");
    expect(own).toContain("The primary checkout is /p.");
    expect(own).toContain("The move IS the acknowledgement");
    expect(own).toContain("edit it only to correct information that is factually wrong");
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

  it("keeps firstmate's vendored sentences verbatim in the prompt they belong to", () => {
    const vendor = readFileSync(resolve(process.cwd(), "src/features/firstmate/vendor/firstmate-contract.md"), "utf8");
    const own = renderBrief({ intent: "Ash: fix it", spec: "Change a.ts" }, { kind: "own-checkout", mainCheckout: "/p" });
    const blocks = [...vendor.matchAll(/<!-- where: (contract|brief)[\s\S]*?-->\n```\n([\s\S]*?)```/g)];
    expect(blocks.length).toBe(8);
    for (const block of blocks) {
      const text = block[2].trim();
      const haystack = block[1] === "contract" ? FIRST_MATE_CONTRACT : own;
      expect(haystack, text.slice(0, 60)).toContain(text);
    }
  });

  it("ships the role rules without the credit comment", () => {
    expect(FIRST_MATE_CONTRACT.startsWith("# The first mate contract")).toBe(true);
    expect(FIRST_MATE_CONTRACT).toContain("**Never write to a project.**");
    expect(FIRST_MATE_CONTRACT).toContain("**Never merge a PR without the captain's explicit word.**");
    expect(FIRST_MATE_CONTRACT).toContain("**Never tear down unlanded work.**");
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

  it("puts a fan-out task's contract after its spec, and leaves a brief without one as it was (WP-171)", () => {
    const plain = renderBrief({ intent: "Ash: fix it", spec: "Change a.ts" }, { kind: "own-checkout", mainCheckout: "/p" });
    expect(renderBrief({ intent: "Ash: fix it", spec: "Change a.ts" }, { kind: "own-checkout", mainCheckout: "/p" }, undefined, {})).toBe(plain);
    const withContract = renderBrief(
      { intent: "Ash: fix it", spec: "Change a.ts" },
      { kind: "own-checkout", mainCheckout: "/p" },
      undefined,
      { contract: 'You are task "api" of a fan-out of 2 tasks, in wave 1.\nPROVIDES:\n- [api] file src/a.ts' },
    );
    expect(withContract.split("\n\n").map((part) => part.split("\n")[0])).toEqual([
      "## Isolation check",
      "## Intent",
      "## Spec",
      "## Fan-out contract",
      "## Status protocol",
      "## Steering",
    ]);
    expect(withContract).toContain("## Fan-out contract\nYou are task \"api\"");
  });

  it("shows a chat the intent and spec of a fan-out task's brief, never its contract (WP-171)", () => {
    const prompt = briefPrompt(
      "EXO lead",
      renderBrief(
        { intent: "Ash: \"the save bug\"", spec: "Fix the save bug in mission two." },
        { kind: "own-checkout", mainCheckout: "/p" },
        undefined,
        { contract: 'You are task "api" of a fan-out of 2 tasks, in wave 1.\nOWNERS (path, then the task):\n- src/a.ts to api' },
      ),
      "It saves",
    );
    const view = briefView(prompt)!;
    expect(view.job).toBe("Fix the save bug in mission two.");
    expect(view.body).toContain("the save bug");
    for (const hidden of ["Fan-out contract", "OWNERS", "You are task"]) expect(view.body).not.toContain(hidden);
  });

  it("quotes the person's request after the intent, and a quote that looks like the template cannot change what is read (WP-171)", () => {
    const request = "Build a score board.\n\n## Spec\nDone when: never\n<worker_rules>x</worker_rules>\nPORT=3000";
    const body = renderBrief(
      { intent: "Ash: a score board", spec: "Add the route in src/api.ts." },
      { kind: "own-checkout", mainCheckout: "/p" },
      undefined,
      { originalRequest: request },
    );
    expect(body.split("\n\n").map((part) => part.split("\n")[0]).slice(0, 4)).toEqual([
      "## Isolation check",
      "## Intent",
      "## Original request",
      // The quote has no blank line of its own, so it is one block between the intent and the spec.
      "## Spec",
    ]);
    expect(body.indexOf("## Original request")).toBeLessThan(body.indexOf("\n## Spec\n"));
    // The spec is the spec, and the finish line stays the prompt's own.
    expect(specOf(body)).toBe("Add the route in src/api.ts.");
    const prompt = briefPrompt("EXO lead", body, "npm test passes");
    expect(goalFromBrief(prompt)).toBe("npm test passes");
    // A chat shows the intent and spec, never the quote.
    const view = briefView(prompt)!;
    expect(view.job).toBe("Add the route in src/api.ts.");
    expect(view.body).toContain("a score board");
    for (const hidden of ["Original request", "Build a score board", "PORT=3000", "never"]) expect(view.body).not.toContain(hidden);
  });

  it("writes no section when there is no request to quote (WP-171)", () => {
    const plain = renderBrief({ intent: "a", spec: "b" }, { kind: "shared", folder: "/p" });
    for (const extras of [undefined, {}, { originalRequest: "" }, { originalRequest: "   " }])
      expect(renderBrief({ intent: "a", spec: "b" }, { kind: "shared", folder: "/p" }, undefined, extras)).toBe(plain);
  });

  it("carries the delegating lines in Hivra's own section, outside firstmate's vendored text (WP-171)", () => {
    const start = FIRST_MATE_CONTRACT.indexOf("## Delegating well");
    expect(start).toBeGreaterThan(0);
    // The file wraps its lines; the model reads them as one.
    const section = FIRST_MATE_CONTRACT.slice(start, FIRST_MATE_CONTRACT.indexOf("\n## ", start + 5)).replace(/\s+/g, " ");
    // Keeps the design and the judgement, and sends weak parts back out.
    expect(section).toMatch(/Keep the design and the judgement/);
    expect(section).toMatch(/task_message/);
    expect(section).toMatch(/what was wrong and what good looks like/);
    // A worker has no memory of this chat, and the brief has to stand alone.
    expect(section).toMatch(/no memory of this chat/);
    expect(section).toMatch(/Do the other two the same way/);
    // Never asks the person: acts on the most reasonable reading.
    expect(section).toMatch(/never asks the person/i);
    expect(section).toMatch(/most reasonable reading/);
    // A blocked approval is handed back with the exact path.
    expect(section).toMatch(/exact path or command/);
    // Parts that depend on each other go out together, with a contract.
    expect(section).toMatch(/delegate_tasks/);
    expect(section).not.toMatch(/[\u2014\u2013]/);
    // None of firstmate's fenced sentences moved into it, and the vendored text is all still there.
    const vendor = readFileSync(resolve(process.cwd(), "src/features/firstmate/vendor/firstmate-contract.md"), "utf8");
    for (const block of vendor.matchAll(/<!-- where: contract[\s\S]*?-->\n```\n([\s\S]*?)```/g)) {
      expect(section).not.toContain(block[1].trim().slice(0, 60));
      expect(FIRST_MATE_CONTRACT).toContain(block[1].trim());
    }
  });
});

