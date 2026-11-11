import { describe, expect, it } from "vitest";
import { sessionInstruction } from "../../plugins/model/pstackAutopilot";
import { monoSessionInstruction } from "./monoSession";

const ROOT = "/plugins/installed/hivra-rpi";

const CATALOG = [
  {
    name: "grill-me",
    for: "Grill a plan until the gaps are named.",
    when: "Use when a plan still has open questions.",
    rel: "skills/grill-me/SKILL.md",
  },
  {
    name: "tdd",
    for: "Write the failing test before the change.",
    when: "Use when behaviour is about to change.",
    rel: "skills/tdd/SKILL.md",
  },
];

function skillNames(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.includes(" | "))
    .map((line) => line.slice(0, line.indexOf(" | ")));
}

describe("a Mono's session instruction", () => {
  it("lists only the skills the Mono names", () => {
    const text = monoSessionInstruction({
      plainEnglish: false,
      skills: ["grill-me"],
      extra: CATALOG,
      extraRoot: ROOT,
    });
    expect(skillNames(text)).toEqual(["grill-me"]);
    expect(text).toContain("grill-me | ");
    expect(text).not.toContain("tdd | ");
  });

  it("is today's instruction byte for byte when skills, commands and fast are unset", () => {
    const today = sessionInstruction({ pstackRoot: "/plugins/installed/pstack", mcodeRoot: "/plugins/installed/hivra-mcode", plainEnglish: true });
    expect(
      monoSessionInstruction({
        pstackRoot: "/plugins/installed/pstack",
        mcodeRoot: "/plugins/installed/hivra-mcode",
        plainEnglish: true,
      }),
    ).toBe(today);
    expect(
      monoSessionInstruction({
        pstackRoot: "/plugins/installed/pstack",
        mcodeRoot: "/plugins/installed/hivra-mcode",
        plainEnglish: true,
        skills: [],
        commands: [],
      }),
    ).toBe(today);
  });
});
