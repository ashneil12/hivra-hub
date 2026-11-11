import { describe, expect, it } from "vitest";
import { HUB_DB_DENY_RULES } from "./credentialGuard";

// WP-129 M1 (lead review, 11 Nov): the hub's data-folder deny rules used `com.ash.monocode-hub*`, which also matches
// the dev slots' folders (`com.ash.monocode-hub.dev.<slot>`). A dev copy keeps its agent-memory there, so a hub chat
// running in a dev copy could not write its own memory. The rules must fence only the daily folder, exactly.

/** Claude Code's glob for one permission rule: `Tool(pattern)` matches a call of that tool on `subject`. */
function ruleMatches(rule: string, tool: string, subject: string): boolean {
  const parsed = /^(\w+)\((.*)\)$/s.exec(rule);
  if (!parsed || parsed[1] !== tool) return false;
  let body = parsed[2];
  if (body.endsWith(":*")) body = `${body.slice(0, -2)}*`;
  const pattern = body
    .split("*")
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "s").test(subject);
}

const deniedBy = (tool: string, subject: string) => HUB_DB_DENY_RULES.some((rule) => ruleMatches(rule, tool, subject));

const DAILY_FILE = "~/Library/Application Support/com.ash.monocode-hub/agent-memory/monos/ada/SOUL.md";
const DEV_FILE = "~/Library/Application Support/com.ash.monocode-hub.dev.hub-x/agent-memory/monos/ada/SOUL.md";
const DAILY_FOLDER = "~/Library/Application Support/com.ash.monocode-hub";

describe("WP-129 M1: the daily data folder is fenced, a dev slot's agent-memory stays writable", () => {
  it("Write and Edit are denied in the daily folder and allowed in a dev slot's folder", () => {
    expect(deniedBy("Write", DAILY_FILE)).toBe(true);
    expect(deniedBy("Edit", DAILY_FILE)).toBe(true);
    expect(deniedBy("Write", DEV_FILE)).toBe(false);
    expect(deniedBy("Edit", DEV_FILE)).toBe(false);
  });

  it("a shell command that writes the daily folder is denied, and one writing a dev slot's agent-memory is allowed", () => {
    const dailyCommand = `cp draft.md "$HOME/Library/Application Support/com.ash.monocode-hub/agent-memory/monos/ada/SOUL.md"`;
    const devCommand = `cp draft.md "$HOME/Library/Application Support/com.ash.monocode-hub.dev.hub-x/agent-memory/monos/ada/SOUL.md"`;
    const dailyFolderList = `ls "$HOME/Library/Application Support/com.ash.monocode-hub"`;
    expect(deniedBy("Bash", dailyCommand)).toBe(true);
    expect(deniedBy("Bash", dailyFolderList)).toBe(true);
    expect(deniedBy("Bash", devCommand)).toBe(false);
  });

  it("the daily folder itself is still denied for Write and Edit, not only files beneath it", () => {
    expect(deniedBy("Write", `${DAILY_FOLDER}/monocode.db`)).toBe(true);
    expect(deniedBy("Edit", `${DAILY_FOLDER}/monos/ada/notes.md`)).toBe(true);
  });
});
