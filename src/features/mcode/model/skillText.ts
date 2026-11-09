// WP-117: the copied MiniMax skills, read by name. Nothing here starts one.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Skills copied from stacks/ronny/skills. The first three are the ones a first mate calls.
 * The order is part of the contract.
 */
export const MCODE_COPIED = [
  "subagent-split-check",
  "independent-review",
  "taste-to-checks",
  "long-session-check",
  "context-tax-audit",
] as const;

export type McodeCopiedSkill = (typeof MCODE_COPIED)[number];

const SKILL_NAME = /^[a-z0-9-]+$/;

/** The skill file, or nothing when the name is not one of the copied skills. */
export function mcodeSkillText(name: string): string | undefined {
  if (!SKILL_NAME.test(name) || !MCODE_COPIED.includes(name as McodeCopiedSkill)) return undefined;
  try {
    return readFileSync(resolve("src-tauri/plugins/hivra-mcode/skills", name, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
}

/** The `name` in a skill file's frontmatter, or nothing when the block is missing or the name is not plain. */
export function skillFileName(text: string): string | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  const line = text.slice(4, end).split("\n").find((row) => row.startsWith("name:"));
  if (!line) return undefined;
  const name = line.slice("name:".length).trim();
  return SKILL_NAME.test(name) ? name : undefined;
}
