import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PLAIN_ENGLISH_RULE, __resetPlainEnglishForTests, savePlainEnglishEndings } from "../../firstmate/model/plainEnglish";
import generated from "./pstackIndex.generated.json";
import { PSTACK_AUTOPILOT, indexLines, pstackIndexText, pstackInstallRoot, sessionInstruction } from "./pstackAutopilot";

// @ts-expect-error a plain .mjs script with no types.
const { skillEntries } = (await import("../../../../scripts/pstack-index.mjs")) as {
  skillEntries(): { name: string; for: string; when: string; rel: string }[];
};

const SKILLS = fileURLToPath(new URL("../../../../src-tauri/plugins/pstack/skills", import.meta.url));

afterEach(() => __resetPlainEnglishForTests());

describe("the pstack index", () => {
  it("has every skill on disk, and fails when the generated file drifts", () => {
    const fresh = skillEntries();
    const dirs = readdirSync(SKILLS).filter((name) => name !== "." && name !== "..");
    expect(fresh.map((entry) => entry.rel).sort()).toEqual(dirs.map((dir) => `skills/${dir}/SKILL.md`).sort());
    expect(generated).toEqual(fresh);
    expect(fresh.map((entry) => entry.name)).toContain("tdd");
    expect(fresh.map((entry) => entry.name)).toContain("create-verification-skill");
  });

  it("finds the installed folder from the Claude shim, and refuses a traversal", () => {
    expect(pstackInstallRoot(["/tmp/Ash Neil/app-data/plugins/claude/pstack/"])).toBe(
      "/tmp/Ash Neil/app-data/plugins/installed/pstack",
    );
    expect(pstackInstallRoot(["C:\\Users\\阿什\\app data\\plugins\\claude\\pstack"])).toBe(
      "C:/Users/阿什/app data/plugins/installed/pstack",
    );
    expect(pstackInstallRoot(["/tmp/plugins/claude/../claude/pstack", "/opt/plugins/claude/pstack"])).toBe(
      "/opt/plugins/installed/pstack",
    );
    expect(pstackInstallRoot(["", "/tmp/other", 12])).toBeUndefined();
    expect(pstackInstallRoot([])).toBeUndefined();
  });

  it("writes one line per skill, with the absolute path, and skips bad entries", () => {
    const root = "C:/Users/Ash Neil/plugins/installed/pstack";
    const text = pstackIndexText(root)!;
    const lines = text.split("\n");
    expect(lines).toHaveLength(generated.length);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(text).toContain(`tdd | `);
    expect(text).toContain(`${root}/skills/tdd/SKILL.md`);
    const uni = pstackIndexText("C:/Users/阿什/plugins/installed/pstack")!;
    expect(uni).toContain("C:/Users/阿什/plugins/installed/pstack/skills/unslop/SKILL.md");
    expect(pstackIndexText("/tmp/../plugins/installed/pstack")).toBeUndefined();
    expect(
      indexLines(
        [
          { name: "a", for: "one | two", when: "now", rel: "skills/a/SKILL.md" },
          { name: "a", for: "dup", when: "dup", rel: "skills/a/SKILL.md" },
          { name: "", for: "x", when: "x", rel: "skills/x/SKILL.md" },
          null,
          { name: "bad", for: "x", when: "x", rel: "../SKILL.md" },
        ],
        "/plugins/installed/pstack",
      ),
    ).toBe("a | one / two | now | /plugins/installed/pstack/skills/a/SKILL.md");
    expect(indexLines("nope", "/plugins/installed/pstack")).toBeUndefined();
    expect(indexLines([], "/plugins/installed/pstack")).toBeUndefined();
    const bytes = new TextEncoder().encode(text).length;
    console.info(`pstack index: ${lines.length} lines, ${bytes} bytes, ${Math.ceil(bytes / 4)} tokens at bytes/4`);
  });
});

describe("the session instruction", () => {
  const root = "/tmp/Ash Neil/app-data/plugins/installed/pstack";

  it("is on by default: the autopilot, every skill, and the plain-English ending", () => {
    const text = sessionInstruction({ pstackRoot: root, plainEnglish: true });
    expect(text.startsWith(PSTACK_AUTOPILOT)).toBe(true);
    expect(text).toContain("without waiting for a slash command");
    expect(text).toContain("Say in one plain sentence which one you used");
    expect(text).toContain("Suggest one when it would clearly help");
    for (const entry of generated) expect(text).toContain(entry.name);
    expect(text).toContain(`${root}/skills/tdd/SKILL.md`);
    expect(text).toContain(PLAIN_ENGLISH_RULE);
  });

  it("drops the index when pstack is off, and both when the switch is off", () => {
    const plain = sessionInstruction({ plainEnglish: true });
    expect(plain).toBe(PLAIN_ENGLISH_RULE);
    expect(plain).not.toContain(PSTACK_AUTOPILOT);
    expect(plain).not.toContain("SKILL.md |");
    const skillsOnly = sessionInstruction({ pstackRoot: root, plainEnglish: false });
    expect(skillsOnly).toContain(PSTACK_AUTOPILOT);
    expect(skillsOnly).not.toContain(PLAIN_ENGLISH_RULE);
    expect(sessionInstruction({ pstackRoot: "/tmp/../pstack", plainEnglish: false })).toBe("");
    savePlainEnglishEndings(false);
    expect(sessionInstruction({ pstackRoot: root, plainEnglish: false })).not.toContain(PLAIN_ENGLISH_RULE);
  });
});
