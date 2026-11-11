import { describe, expect, it } from "vitest";
import { checkTurnForProtectedPaths, matchSecret, SECRET_PATHS } from "./protectedPaths";

describe("the secret-paths list (WP-178 item 3.4, report only)", () => {
  it("names SSH keys, cloud logins and keychains as secret places", () => {
    expect(matchSecret("~/.ssh/id_ed25519")).not.toBeNull();
    expect(matchSecret("~/.aws/credentials")).not.toBeNull();
    expect(matchSecret("~/.config/gcloud/application_default_credentials.json")).not.toBeNull();
    expect(matchSecret("~/Library/Keychains/login.keychain-db")).not.toBeNull();
    expect(matchSecret("~/.netrc")).not.toBeNull();
  });

  it("does not name ordinary project or home files", () => {
    expect(matchSecret("~/Documents/notes.txt")).toBeNull();
    expect(matchSecret("src/app.ts")).toBeNull();
    expect(matchSecret("~/.sshconfig-notes")).toBeNull();
  });

  it("is built from the shared JSON list, so the sandbox and the check read the same places", () => {
    const patterns = SECRET_PATHS.map((rule) => rule.pattern);
    expect(patterns).toContain("~/.ssh/**");
    expect(patterns).toContain("~/.netrc");
  });

  it("reports a changed secret path as a secret touch, and says nothing was blocked", () => {
    const report = checkTurnForProtectedPaths({ "~/.ssh/id_ed25519": "1:10" }, { "~/.ssh/id_ed25519": "1:20" });
    expect(report.touched).toEqual([
      expect.objectContaining({ path: "~/.ssh/id_ed25519", kind: "secret" }),
    ]);
    expect(report.summary).toContain("Reported only");
  });

  it("keeps project protected paths reported as kind protected", () => {
    const report = checkTurnForProtectedPaths({ ".git/hooks/pre-commit": "a" }, { ".git/hooks/pre-commit": "b" });
    expect(report.touched).toEqual([expect.objectContaining({ path: ".git/hooks/pre-commit", kind: "protected" })]);
  });
});
