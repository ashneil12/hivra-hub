import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIEF_SKILLS } from "../../firstmate/model/briefSkills";
import { renderBrief } from "../../firstmate/model/brief";
import generated from "../../plugins/model/pstackIndex.generated.json";
import {
  AUTO_RUN_ON_MERGE,
  DIFF_MAX,
  MCODE_CALLS,
  MCODE_SKILL_NAMES,
  independentReviewBrief,
} from "./reviewBrief";

const MERGE_FILES = [
  "src-tauri/src/delivery/merge.rs",
  "src-tauri/src/delivery/deliver.rs",
  "src-tauri/src/delivery/github.rs",
  "src-tauri/src/firstmate/gates.rs",
  "src/features/firstmate/model/brief.ts",
  "src/features/firstmate/model/briefSkills.ts",
  "src/features/firstmate/model/completionGates.ts",
];

describe("independent review brief", () => {
  it("gives the reviewer only the diff, the requirement and the test results", () => {
    const secret = "author-chat-secret-do-not-leak";
    const brief = independentReviewBrief({
      diff: "diff --git a/src/a.ts b/src/a.ts\n+export const n = 1;\n",
      requirement: "The counter starts at 1.",
      testResults: "1 passed",
      conversation: secret,
      notes: "the author already decided this",
      author: "kept out",
    });
    expect(brief).toContain("Skill: independent-review");
    expect(brief).toContain("The counter starts at 1.");
    expect(brief).toContain("diff --git a/src/a.ts");
    expect(brief).toContain("1 passed");
    expect(brief).not.toContain(secret);
    expect(brief).not.toContain("already decided");
    expect(brief).not.toContain("kept out");
  });

  it("drops anything that is not three plain strings", () => {
    expect(independentReviewBrief(null)).toBeUndefined();
    expect(independentReviewBrief([])).toBeUndefined();
    expect(independentReviewBrief("diff")).toBeUndefined();
    expect(independentReviewBrief({ diff: "d", requirement: "r" })).toBeUndefined();
    expect(independentReviewBrief({ diff: "d", requirement: "r", testResults: 1 })).toBeUndefined();
    expect(independentReviewBrief({ diff: "  ", requirement: "r", testResults: "t" })).toBeUndefined();
    expect(independentReviewBrief({ diff: "d", requirement: "", testResults: "t" })).toBeUndefined();
    expect(independentReviewBrief({ diff: "d", requirement: "r", testResults: "\n" })).toBeUndefined();
  });

  it("keeps unicode and parent-directory markers inside the diff, and turns CRLF into LF", () => {
    const brief = independentReviewBrief({
      diff: "path: café/../a.ts\r\n+line\r\n",
      requirement: "Keep the name.\r\n",
      testResults: "ok\r\n",
    });
    expect(brief).toContain("café/../a.ts\n+line");
    expect(brief).not.toContain("\r");
  });

  it("refuses a diff, requirement or result that does not fit, rather than cutting it", () => {
    const fit = independentReviewBrief({
      diff: "d".repeat(DIFF_MAX),
      requirement: "r",
      testResults: "t",
    });
    expect(fit).toContain("d".repeat(DIFF_MAX));
    expect(
      independentReviewBrief({
        diff: "d".repeat(DIFF_MAX + 1),
        requirement: "r",
        testResults: "t",
      }),
    ).toBeUndefined();
    expect(
      independentReviewBrief({
        diff: "d",
        requirement: "r".repeat(20_001),
        testResults: "t",
      }),
    ).toBeUndefined();
  });
});

describe("mcode skills stay called by name", () => {
  it("names the three skills and when a person asks for each", () => {
    expect(MCODE_SKILL_NAMES).toEqual([
      "subagent-split-check",
      "independent-review",
      "taste-to-checks",
    ]);
    expect(MCODE_CALLS["subagent-split-check"]).toMatch(/crew/);
    expect(MCODE_CALLS["independent-review"]).toMatch(/diff/);
    expect(MCODE_CALLS["taste-to-checks"]).toMatch(/twice/);
    expect(AUTO_RUN_ON_MERGE).toBe(false);
  });

  it("does not attach them to a brief or the always-on index", () => {
    const indexed = new Set(generated.map((entry) => entry.name));
    for (const name of MCODE_SKILL_NAMES) expect(indexed.has(name), name).toBe(false);
    for (const names of Object.values(BRIEF_SKILLS)) {
      for (const name of MCODE_SKILL_NAMES) expect(names).not.toContain(name);
    }
    const brief = renderBrief(
      { intent: "Ash: review the change", spec: "review the change" },
      { kind: "own-checkout", mainCheckout: "/p" },
      "review",
    );
    for (const name of MCODE_SKILL_NAMES) expect(brief).not.toContain(name);
  });

  it("is not named by merge, delivery or the completion gates", () => {
    for (const path of MERGE_FILES) {
      const text = readFileSync(resolve(path), "utf8");
      for (const name of MCODE_SKILL_NAMES) {
        expect(text, path).not.toContain(name);
      }
    }
  });
});
