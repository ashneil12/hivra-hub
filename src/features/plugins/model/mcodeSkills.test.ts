import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import credits from "../../../../docs/hivra/credits.json";
import { renderBrief } from "../../firstmate/model/brief";
import { BRIEF_SKILLS } from "../../firstmate/model/briefSkills";
import generated from "./mcodeIndex.generated.json";
import pstackGenerated from "./pstackIndex.generated.json";
import { mcodeIndexText, sessionInstruction } from "./pstackAutopilot";

// The same entry reader the pstack index is generated with.
// @ts-expect-error: a plain .mjs script with no types.
const { skillEntries } = (await import("../../../../scripts/pstack-index.mjs")) as {
  skillEntries(dir?: string): { name: string; for: string; when: string; rel: string }[];
};

const SKILLS = fileURLToPath(new URL("../../../../src-tauri/plugins/hivra-mcode/skills", import.meta.url));
const NOTICE = fileURLToPath(new URL("../../../../NOTICE", import.meta.url));

/** The five copied files. The first three are the ones a first mate calls. */
const NAMES = [
  "subagent-split-check",
  "independent-review",
  "taste-to-checks",
  "long-session-check",
  "context-tax-audit",
] as const;
const CALLED = NAMES.slice(0, 3);

/** A line from each skill that only the upstream text contains. */
const BODY: Record<(typeof NAMES)[number], string> = {
  "subagent-split-check": "Default to one main loop with skills loaded on demand.",
  "independent-review": "Give the reviewer exactly three inputs",
  "taste-to-checks": "If we tell an agent the same thing twice, the second time is our fault.",
  "long-session-check": "The context window is a workbench, not a warehouse.",
  "context-tax-audit": "current time, and why stuffing `date` into the system prompt breaks the",
};

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

const read = (name: string) => readFileSync(resolve(SKILLS, name, "SKILL.md"), "utf8");

/** Every file under `dir` that the app can bundle: no tests, no fixtures. A folder that is not there has none. */
function shippedFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__fixtures__" ? [] : shippedFiles(path);
    return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [path] : [];
  });
}

/** The frontmatter block, without its fences. */
const frontmatter = (text: string) => text.slice(4, text.indexOf("\n---\n", 4));

/** Files that name skills for merge, delivery or a completion gate. None of them may name these. */
const MERGE_FILES = [
  "src-tauri/src/delivery/merge.rs",
  "src-tauri/src/delivery/deliver.rs",
  "src-tauri/src/delivery/github.rs",
  "src-tauri/src/firstmate/gates.rs",
  "src/features/firstmate/model/brief.ts",
  "src/features/firstmate/model/briefSkills.ts",
  "src/features/firstmate/model/completionGates.ts",
];

describe("the MiniMax Code skills", () => {
  it("keeps exactly the five copied skills, each spelling out where it came from", () => {
    expect(readdirSync(SKILLS).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      const text = read(name);
      expect(text.startsWith("---\n"), name).toBe(true);
      expect(frontmatter(text)).toContain(`name: ${name}`);
      expect(text).toContain(`Source: stacks/ronny/skills/${name}/SKILL.md`);
      expect(text).toContain("Pin: 88f84be7075106d8ce283e5d3a8138cdb8f9a205");
      expect(text).toContain("Licence: MIT");
      expect(text).toContain("Copyright (c) 2026 MiniMax Code");
      expect(text).toContain(BODY[name]);
      expect(text, name).not.toMatch(/[—–]/);
      expect(text).not.toContain("/Users/");
    }
  });

  it("keeps them out of Claude Code's own skill list, so Hivra's index is how a first mate reaches them", () => {
    // A skill with this flag is not offered to the model by the CLI. Without an index entry nothing would name it.
    for (const name of NAMES) expect(frontmatter(read(name)), name).toContain("disable-model-invocation: true");
  });

  it("reads the skill files only in tests: no node: import in a file the app bundles, and no src/features/mcode", () => {
    // The skill text and the review brief were once modules in src that read files with node:fs. Nothing in the app used
    // them, and a file under src is bundled for the webview, where node:fs does not exist.
    expect(shippedFiles(resolve(SRC, "features/mcode"))).toEqual([]);
    const nodeImport = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'](?:node:[^"']+|fs|path|child_process|os)["']/;
    const files = shippedFiles(resolve(SRC, "features/plugins"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(nodeImport);
  });

  it("lists every one in Hivra's skill index, generated from the plugin so it cannot drift", () => {
    expect(generated).toEqual(skillEntries(SKILLS));
    expect(generated.map((entry) => entry.name).sort()).toEqual([...NAMES].sort());
    for (const entry of generated) {
      expect(entry.rel).toBe(`skills/${entry.name}/SKILL.md`);
      expect(existsSync(resolve(SKILLS, "..", entry.rel)), entry.rel).toBe(true);
      expect(entry.for.length).toBeGreaterThan(0);
    }
    // pstack's own index is still pstack's alone.
    for (const name of NAMES) expect(pstackGenerated.map((entry) => entry.name)).not.toContain(name);
  });

  it("tells a first mate when to reach for each of the three it calls", () => {
    const text = mcodeIndexText("/app-data/plugins/installed/hivra-mcode")!;
    const line = (name: string) => text.split("\n").find((row) => row.startsWith(`${name} | `))!;
    expect(line("subagent-split-check")).toContain("spawning subagents");
    expect(line("independent-review")).toContain("clean context");
    expect(line("independent-review")).toContain("finishes an implementation");
    expect(line("taste-to-checks")).toContain("we keep correcting agents on the same mistake");
    for (const name of NAMES) expect(line(name), name).toMatch(/ \| skills\/[a-z-]+\/SKILL\.md$/);
    const bytes = new TextEncoder().encode(text).length;
    expect(bytes).toBeLessThan(3_000);
  });

  it("keeps independent-review to the requirement, the diff and the test results", () => {
    const text = read("independent-review");
    expect(text).toContain("Give the reviewer exactly three inputs");
    expect(text).toContain("Do **not** pass the author's conversation, plan, intermediate reasoning or");
    expect(text).toContain("self-assessment");
    expect(text).toContain("**The diff.**");
    expect(text).toContain("**The requirement.**");
    expect(text).toContain("**Test results.**");
  });

  it("is never put on a brief, and nothing starts one on merge, delivery or a gate", () => {
    for (const name of CALLED) {
      for (const names of Object.values(BRIEF_SKILLS)) expect(names).not.toContain(name);
    }
    const brief = renderBrief(
      { intent: "Ash: review the change", spec: "review the change" },
      { kind: "own-checkout", mainCheckout: "/p" },
      "review",
    );
    for (const name of CALLED) expect(brief).not.toContain(name);
    for (const path of MERGE_FILES) {
      const text = readFileSync(resolve(path), "utf8");
      for (const name of CALLED) expect(text, path).not.toContain(name);
    }
    // Being listed is information for the session, never a step: the instruction only says to read a skill that fits.
    expect(sessionInstruction({ mcodeRoot: "/app-data/plugins/installed/hivra-mcode", plainEnglish: false })).not.toMatch(
      /\b(?:merge|deliver|gate)\b/i,
    );
  });

  it("names the copied text as MiniMax Code's in the credits and the NOTICE", () => {
    const ours = credits.components.filter((entry) => entry.url === "https://github.com/MiniMax-AI/mcode-stack");
    expect(ours).toHaveLength(1);
    expect(ours[0].copyright).toBe("Copyright (c) 2026 MiniMax Code");
    expect(ours[0].name.startsWith("MiniMax Code's ")).toBe(true);
    const notice = readFileSync(NOTICE, "utf8");
    expect(notice).toContain(`- ${ours[0].name}\n`);
    expect(notice).toContain("Copyright (c) 2026 MiniMax Code");
    expect(notice).not.toContain("- Hivra subagent-split-check");
  });
});
