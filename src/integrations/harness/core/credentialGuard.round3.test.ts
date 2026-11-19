// WP-101 review round 3, item 2: credentialBlock matched only /Users/... spellings. Windows, Linux and AppData forms too.
import { describe, expect, it } from "vitest";
import { credentialBlock } from "./credentialGuard";

const CWD = "/Users/example/Projects/x";

describe("login files under other spellings of a home folder (review round 3, item 2)", () => {
  it.each([
    "C:\\Users\\me\\.codex\\auth.json",
    "C:/Users/me/.codex/auth.json",
    "C:\\Users\\me\\.codex.\\auth.json",
    "C:\\Users\\me\\.CODEX~1\\AUTH~1.JSO",
    "/home/me/.codex/auth.json",
    "C:\\Users\\me\\AppData\\Roaming\\GitHub CLI\\hosts.yml",
    "C:\\Users\\me\\AppData\\Roaming\\rclone\\rclone.conf",
  ])("holds a read of %s", (path) => {
    expect(credentialBlock({ tool: "Read", paths: [path] }, CWD), path).toBeDefined();
  });

  it("holds a command that prints a Windows login file", () => {
    expect(credentialBlock({ tool: "Bash", command: "type C:\\Users\\me\\.codex\\auth.json" }, CWD)).toBeDefined();
  });
});
