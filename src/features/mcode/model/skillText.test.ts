import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MCODE_SKILL_NAMES } from "./reviewBrief";
import { MCODE_COPIED, mcodeSkillText, skillFileName } from "./skillText";

const ROOT = resolve("src-tauri/plugins/hivra-mcode/skills");

/** A line from each skill that only the upstream text contains. */
const BODY: Record<(typeof MCODE_COPIED)[number], string> = {
  "subagent-split-check": "Default to one main loop with skills loaded on demand.",
  "independent-review": "Give the reviewer exactly three inputs",
  "taste-to-checks": "If we tell an agent the same thing twice, the second time is our fault.",
  "long-session-check": "The context window is a workbench, not a warehouse.",
  "context-tax-audit": "current time, and why stuffing `date` into the system prompt breaks the",
};

describe("mcode skills load", () => {
  it("loads each copied skill under a stable name", () => {
    expect(MCODE_COPIED).toEqual([
      "subagent-split-check",
      "independent-review",
      "taste-to-checks",
      "long-session-check",
      "context-tax-audit",
    ]);
    expect(readdirSync(ROOT).sort()).toEqual([...MCODE_COPIED].sort());
    for (const name of MCODE_COPIED) {
      const text = mcodeSkillText(name);
      expect(text, name).toEqual(expect.any(String));
      expect(skillFileName(text ?? ""), name).toBe(name);
      expect(text).toContain(`Source: stacks/ronny/skills/${name}/SKILL.md`);
      expect(text).toContain("88f84be");
      expect(text).toContain("Licence: MIT");
      expect(text).toContain("Copyright (c) 2026 MiniMax Code");
      expect(text).toContain("disable-model-invocation: true");
      expect(text).toContain(BODY[name]);
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toContain("/Users/");
    }
  });

  it("keeps the three call names, in order, inside the copied set", () => {
    expect([...MCODE_SKILL_NAMES]).toEqual([
      "subagent-split-check",
      "independent-review",
      "taste-to-checks",
    ]);
    expect(MCODE_COPIED.slice(0, 3)).toEqual([...MCODE_SKILL_NAMES]);
  });

  it("does not load a missing, empty or unsafe name", () => {
    expect(mcodeSkillText("")).toBeUndefined();
    expect(mcodeSkillText("not-a-skill")).toBeUndefined();
    expect(mcodeSkillText("..")).toBeUndefined();
    expect(mcodeSkillText("../defaults")).toBeUndefined();
    expect(mcodeSkillText("subagent-split-check/../../plugin.json")).toBeUndefined();
    expect(mcodeSkillText("C:\\skills\\subagent-split-check")).toBeUndefined();
    expect(mcodeSkillText("café")).toBeUndefined();
    expect(mcodeSkillText("subagent-split-check ")).toBeUndefined();
    expect(mcodeSkillText("SUBAGENT-SPLIT-CHECK")).toBeUndefined();
    expect(skillFileName("")).toBeUndefined();
    expect(skillFileName("no frontmatter\nname: subagent-split-check\n")).toBeUndefined();
    expect(skillFileName("---\nname: not a skill\n---\n")).toBeUndefined();
  });
});
