// WP-101 review round 3, items 2 and 3: Windows names (trailing dots and spaces, 8.3 short names, AppData stores) and
// the macOS prefixes /.nofollow/ and /.resolve/<n>/ and fish's conf.d.
import { describe, expect, it } from "vitest";
import { credentialInPaths, credentialInWords, credentialPath } from "./credentialPaths";

describe("Windows spellings of a login store (review round 3, item 2)", () => {
  it.each([
    "C:\\Users\\me\\.codex.\\auth.json",
    "C:\\Users\\me\\.codex \\auth.json",
    "C:\\Users\\me\\.codex\\auth.json.",
    "C:\\Users\\me\\CODEX~1\\AUTH~1.JSO",
    "C:\\Users\\me\\.codex\\AUTH~1.JSO",
    "C:\\Users\\me\\AppData\\Roaming\\GitHub CLI\\hosts.yml",
    "C:\\Users\\me\\AppData\\Roaming\\rclone\\rclone.conf",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\etc\\npmrc",
    "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data",
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Login Data",
  ])("holds %s", (path) => {
    expect(credentialPath(path), path).toBe(true);
    expect(credentialInPaths([path]), path).not.toBeNull();
  });
});

describe("macOS prefixes and fish's conf.d (review round 3, item 3)", () => {
  it.each(["/.nofollow/Users/x/.zshrc", "/.resolve/1/Users/x/.zshrc", "/.resolve/12/users/x/.bashrc"])("holds a startup file behind %s", (path) => {
    expect(credentialInPaths([path]), path).not.toBeNull();
  });

  it.each(["/Users/x/.config/fish/conf.d/a.fish", "/Users/x/.config/fish/conf.d/env.fish"])("holds a fish conf.d file %s", (path) => {
    expect(credentialInPaths([path]), path).not.toBeNull();
  });

  it("holds a glob over fish's conf.d", () => {
    expect(credentialInWords(["cat", "/Users/x/.config/fish/conf.d/*.fish"])).not.toBeNull();
  });
});
