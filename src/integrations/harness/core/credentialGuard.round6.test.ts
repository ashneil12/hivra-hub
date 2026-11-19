// WP-101 review round 6, HIGH-1: the hub database's copies and its WebKit storage are held wherever the shell reads them
// from, and the quote-stripped reading covers the hub's own store (a quote split inside the path used to pass).
// Fixtures are invented paths only; nothing here reads a real file.
import { describe, expect, it } from "vitest";
import { HUB_DB_BLOCK_MESSAGE, HUB_DB_DENY_RULES, credentialBlock } from "./credentialGuard";

const CWD = "/Users/example/Projects/x";
const bash = (command: string) => ({ tool: "Bash", command });

describe("the hub database and its copies (review round 6, HIGH-1)", () => {
  it.each([
    "head -c 400000 '/Users/example/Library/WebKit/com.ash.monocode-h'ub/WebsiteData/localstorage.sqlite3",
    "head -c 400000 /Users/example/Library/WebKit/com.ash.monocode-hub/WebsiteData/localstorage.sqlite3",
    "cat /Users/example/Archive/monocode/ships/abc123/backup/monocode.db",
    "grep -a -o -E 'sk-ant-\\S+' /Users/example/Archive/monocode/backups-20261110/monocode.db",
    "tail -c 50000 /Users/example/Archive/monocode/ships/abc123/monocode.db-wal",
    "cat ~/Archive/monocode/backups-20261110/monocode.db",
    "sqlite3 ~/Archive/monocode/recover/monocode.db 'select 1'",
  ])("holds %s", (command) => {
    expect(credentialBlock(bash(command), CWD)).toBe(HUB_DB_BLOCK_MESSAGE);
  });

  it("names the Archive copies in the deny rules too", () => {
    expect(HUB_DB_DENY_RULES).toContain("Read(~/Archive/monocode/**/monocode.db*)");
    expect(HUB_DB_DENY_RULES).toContain("Bash(*Archive/monocode*monocode.db*)");
  });

  it("does not hold an ordinary read of a file named for the project", () => {
    expect(credentialBlock(bash("cat docs/monocode-notes.md"), CWD)).toBeUndefined();
  });
});
