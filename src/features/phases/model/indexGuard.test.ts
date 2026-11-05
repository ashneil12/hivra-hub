import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { sessionInstruction } from "../../plugins/model/pstackAutopilot";
import generated from "../../plugins/model/pstackIndex.generated.json";
import { LEFT_OUT_SKILLS, RPI_SKILL_NAMES, alwaysOnNames } from "./indexGuard";

const root = resolve("src-tauri/plugins/hivra-rpi/skills");

it("keeps every research skill out of the always-on index", () => {
  const dirs = readdirSync(root).sort();
  expect(dirs).toEqual([...RPI_SKILL_NAMES].sort());
  for (const name of RPI_SKILL_NAMES) {
    const text = readFileSync(resolve(root, name, "SKILL.md"), "utf8");
    expect(text.startsWith("---\n"), name).toBe(true);
    expect(text).toContain("disable-model-invocation: true");
    expect(text).toContain("The first mate runs this phase.");
  }
  for (const name of LEFT_OUT_SKILLS) expect(existsSync(resolve(root, name))).toBe(false);

  const indexed = new Set(generated.map((entry) => entry.name));
  for (const name of RPI_SKILL_NAMES) {
    expect(indexed.has(name), name).toBe(false);
  }
  const tdd = generated.find((entry) => entry.name === "tdd");
  expect(tdd?.rel).toBe("skills/tdd/SKILL.md");
  expect(tdd?.rel).not.toContain("hivra-rpi");

  const instruction = sessionInstruction({ pstackRoot: "/tmp/plugins/claude/pstack", plainEnglish: false });
  const firstColumn = instruction.split("\n").map((line) => line.split(" | ")[0]);
  for (const name of RPI_SKILL_NAMES) {
    expect(firstColumn).not.toContain(name);
  }
  expect(instruction).not.toContain("hivra-rpi");
  expect(alwaysOnNames([{ name: "research" }, { name: "research-questions", invokeOnly: true }, { name: "" }])).toEqual(["research"]);
});
