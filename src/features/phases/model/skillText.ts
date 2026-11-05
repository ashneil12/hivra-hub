// WP-84: the phase skill's own text, read when a run starts. A missing file is not a document.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The skill file for this phase, or nothing when the name is not one of ours. */
export function skillText(name: string): string | undefined {
  if (!/^[a-z0-9-]+$/.test(name)) return undefined;
  try {
    return readFileSync(resolve("plugins/hivra-rpi/skills", name, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
}
