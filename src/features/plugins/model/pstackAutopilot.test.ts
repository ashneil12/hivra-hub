import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PLAIN_ENGLISH_RULE, __resetPlainEnglishForTests, savePlainEnglishEndings } from "../../firstmate/model/plainEnglish";
import mcodeGenerated from "./mcodeIndex.generated.json";
import generated from "./pstackIndex.generated.json";
import {
  PSTACK_AUTOPILOT,
  indexLines,
  mcodeIndexText,
  mcodeInstallRoot,
  pstackIndexText,
  pstackInstallRoot,
  sessionInstruction,
} from "./pstackAutopilot";

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
    const lines = text.split("\n").slice(1);
    expect(text.startsWith(`${root}\n`)).toBe(true);
    expect(text.split(root).length - 1).toBe(1);
    expect(lines).toHaveLength(generated.length);
    expect(lines.every((line) => !line.includes(root))).toBe(true);
    expect(text).toContain("tdd | ");
    expect(text).toContain("skills/tdd/SKILL.md");
    expect(text).not.toContain(`${root}/skills/tdd/SKILL.md`);
    const uni = pstackIndexText("C:/Users/阿什/plugins/installed/pstack")!;
    expect(uni.startsWith("C:/Users/阿什/plugins/installed/pstack\n")).toBe(true);
    expect(uni).toContain("skills/unslop/SKILL.md");
    expect(uni.split("C:/Users/阿什/plugins/installed/pstack").length - 1).toBe(1);
    expect(pstackIndexText("/tmp/../plugins/installed/pstack")).toBeUndefined();
    expect(
      indexLines(
        [
          { name: "a", for: "one | two. More.", when: "Reach for it before the change ships.", rel: "skills/a/SKILL.md" },
          { name: "b", for: "Same words.", when: "Same words.", rel: "skills/b/SKILL.md" },
          { name: "c", for: "Draw it.", when: "Use for /c, 'c this'.", rel: "skills/c/SKILL.md" },
          { name: "a", for: "dup", when: "dup", rel: "skills/a/SKILL.md" },
          { name: "", for: "x", when: "x", rel: "skills/x/SKILL.md" },
          null,
          { name: "bad", for: "x", when: "x", rel: "../SKILL.md" },
        ],
        "/plugins/installed/pstack",
      ),
    ).toBe(
      ["a | one / two. | Reach for it before the change ships. | skills/a/SKILL.md", "b | Same words. | skills/b/SKILL.md", "c | Draw it. | skills/c/SKILL.md"].join(
        "\n",
      ),
    );
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
    expect(text).toContain("without waiting for a slash command");
    expect(text).toContain("Say in one plain sentence which one you used");
    expect(text).toContain("Suggest one when it would clearly help");
    for (const entry of generated) expect(text).toContain(entry.name);
    expect(text.startsWith(PSTACK_AUTOPILOT)).toBe(true);
    expect(text).toContain(root);
    expect(text).toContain("skills/tdd/SKILL.md");
    expect(text.split(root).length - 1).toBe(1);
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

describe("the MiniMax skills in the index (WP-117)", () => {
  const pstack = "/tmp/Ash Neil/app-data/plugins/installed/pstack";
  const mcode = "/tmp/Ash Neil/app-data/plugins/installed/hivra-mcode";

  it("finds hivra-mcode's installed folder from its Claude shim, beside pstack's, and refuses a traversal", () => {
    const dirs = [
      "/tmp/Ash Neil/app-data/plugins/claude/hivra-creator",
      "/tmp/Ash Neil/app-data/plugins/claude/hivra-mcode/",
      "/tmp/Ash Neil/app-data/plugins/claude/pstack",
    ];
    expect(mcodeInstallRoot(dirs)).toBe(mcode);
    expect(pstackInstallRoot(dirs)).toBe(pstack);
    expect(mcodeInstallRoot(["C:\\Users\\阿什\\app data\\plugins\\claude\\hivra-mcode"])).toBe(
      "C:/Users/阿什/app data/plugins/installed/hivra-mcode",
    );
    expect(
      mcodeInstallRoot(["/tmp/Ash Neil/app-data/plugins/claude/pstack", "/tmp/plugins/claude/not-hivra-mcode"]),
    ).toBeUndefined();
    expect(mcodeInstallRoot(["/tmp/plugins/claude/../claude/hivra-mcode"])).toBeUndefined();
    expect(mcodeInstallRoot(["", 12, "/claude/hivra-mcode"])).toBeUndefined();
    expect(mcodeInstallRoot([])).toBeUndefined();
  });

  it("writes the folder once, then one line per skill, with the relative path", () => {
    const text = mcodeIndexText(mcode)!;
    const rows = text.split("\n");
    expect(rows[0]).toBe(mcode);
    expect(rows).toHaveLength(mcodeGenerated.length + 1);
    expect(text.split(mcode).length - 1).toBe(1);
    for (const entry of mcodeGenerated) expect(text).toContain(`${entry.name} | `);
    expect(text).toContain("skills/independent-review/SKILL.md");
    expect(mcodeIndexText("/tmp/../plugins/installed/hivra-mcode")).toBeUndefined();
  });

  it("gives a session pstack's skills and then the MiniMax ones, under the one sentence that says to read a fit", () => {
    const text = sessionInstruction({ pstackRoot: pstack, mcodeRoot: mcode, plainEnglish: false });
    expect(text.split(PSTACK_AUTOPILOT).length - 1).toBe(1);
    expect(text).toBe(`${PSTACK_AUTOPILOT}\n${pstackIndexText(pstack)}\n${mcodeIndexText(mcode)}`);
  });

  it("keeps the MiniMax skills when pstack is off, and drops them when their plugin is off", () => {
    expect(sessionInstruction({ mcodeRoot: mcode, plainEnglish: false })).toBe(`${PSTACK_AUTOPILOT}\n${mcodeIndexText(mcode)}`);
    expect(sessionInstruction({ mcodeRoot: mcode, plainEnglish: true })).toBe(
      `${PSTACK_AUTOPILOT}\n${mcodeIndexText(mcode)}\n\n${PLAIN_ENGLISH_RULE}`,
    );
    const pstackOnly = sessionInstruction({ pstackRoot: pstack, plainEnglish: false });
    expect(pstackOnly).toBe(`${PSTACK_AUTOPILOT}\n${pstackIndexText(pstack)}`);
    for (const entry of mcodeGenerated) expect(pstackOnly).not.toContain(`${entry.name} | `);
    expect(sessionInstruction({ mcodeRoot: "/tmp/../hivra-mcode", plainEnglish: false })).toBe("");
    expect(sessionInstruction({ plainEnglish: false })).toBe("");
  });
});
