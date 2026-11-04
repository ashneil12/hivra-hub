import { describe, expect, it } from "vitest";
import { briefView } from "../../sessions/model/briefView";
import { briefPrompt } from "../../agent-app/model/agentAppTasks";
import { renderBrief, withoutTemplate } from "./brief";
import { BRIEF_SKILLS, briefSkillsSection, classifyBriefTask } from "./briefSkills";
import generated from "../../plugins/model/pstackIndex.generated.json";

const NAMES = new Set(generated.map((entry) => entry.name));

describe("brief skills", () => {
  it("only names skills that exist", () => {
    for (const names of Object.values(BRIEF_SKILLS)) for (const name of names) expect(NAMES.has(name), name).toBe(true);
  });

  it("classifies by the words, with the earlier kind winning", () => {
    expect(classifyBriefTask("Fix the save bug in src/save.ts")).toBe("debug");
    expect(classifyBriefTask("FIX the BUG\r\n")).toBe("debug");
    expect(classifyBriefTask("Change a.ts")).toBe("code");
    expect(classifyBriefTask("design the settings screen")).toBe("design");
    expect(classifyBriefTask("write the readme")).toBe("writing");
    expect(classifyBriefTask("Write the tests")).toBe("code");
    expect(classifyBriefTask("Write the tests for the save bug")).toBe("code");
    expect(classifyBriefTask("Copy the file into src/")).toBe("code");
    expect(classifyBriefTask("Fix the save bug in the docs")).toBe("debug");
    expect(classifyBriefTask("benchmark the export")).toBe("measure");
    expect(classifyBriefTask("design the benchmark")).toBe("measure");
    expect(classifyBriefTask("review the change")).toBe("review");
    expect(classifyBriefTask("prefix the changelog")).toBeUndefined();
    expect(classifyBriefTask("")).toBeUndefined();
    expect(classifyBriefTask("   ")).toBeUndefined();
    expect(classifyBriefTask("修改 the thing")).toBeUndefined();
  });

  it("attaches those skills to the brief, and the chat never shows the path", () => {
    const classified = renderBrief(
      { intent: "Ash: Write the tests for the save bug", spec: "Write the tests for the save bug" },
      { kind: "own-checkout", mainCheckout: "/p" },
      classifyBriefTask("Write the tests for the save bug"),
    );
    expect(classified).toContain("tdd");
    expect(classified).toContain("principle-prove-it-works");
    expect(classified).not.toContain("technical-writing");
    expect(classified).not.toContain("unslop");
    const brief = renderBrief({ intent: "Ash: change it", spec: "Change a.ts" }, { kind: "own-checkout", mainCheckout: "/p" }, "code");
    expect(brief).toContain("## Skills");
    for (const name of BRIEF_SKILLS.code) expect(brief).toContain(name);
    expect(brief).not.toContain("/Users");
    expect(brief).not.toContain("/p/skills");
    expect(withoutTemplate(brief)).not.toContain("## Skills");
    expect(withoutTemplate(brief)).not.toContain("tdd");
    const view = briefView(briefPrompt("EXO lead", brief, "npm test passes"))!;
    expect(view.body).not.toContain("tdd");
    expect(view.body).not.toContain("SKILL.md");
    expect(view.job).toBe("Change a.ts");
    expect(renderBrief({ intent: "a", spec: "b" }, { kind: "first-mate" })).not.toContain("## Skills");
    expect(briefSkillsSection("debug")).toContain("principle-fix-root-causes");
  });
});
