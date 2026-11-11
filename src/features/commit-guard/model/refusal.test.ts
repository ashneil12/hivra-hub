import { describe, expect, it } from "vitest";
import { isGuardRefusal, secretFinding } from "./refusal";

describe("secretFinding", () => {
  const refusal = (file: string, line: number) =>
    `Possible secret in ${file}:${line} in /srv/project (commit 1a2b3c4d5e6f, refusal 0123456789ab). The value is not shown.`;

  it("reads the file, line, folder, commit and id of a secret refusal", () => {
    expect(secretFinding(refusal("src/config.rs", 12))).toEqual({
      id: "0123456789ab",
      file: "src/config.rs",
      line: 12,
      folder: "/srv/project",
      commit: "1a2b3c4d5e6f",
    });
  });

  it("keeps colons in the file name", () => {
    expect(secretFinding(refusal("docs/a:b.md", 3))?.file).toBe("docs/a:b.md");
  });

  it("reads a refusal with no folder or commit", () => {
    expect(secretFinding("Possible secret in src/a.rs:4 (commit none, refusal 0123456789ab). The value is not shown.")).toEqual({
      id: "0123456789ab",
      file: "src/a.rs",
      line: 4,
      folder: null,
      commit: "none",
    });
  });

  it("gives no finding for a refusal with no id, so no button", () => {
    expect(secretFinding("Possible secret in src/config.rs:12. The value is not shown.")).toBeUndefined();
  });

  it("gives no finding for a commit message, since its line is not in a file", () => {
    expect(secretFinding("Possible secret in a commit message:2. The value is not shown.")).toBeUndefined();
  });

  it("gives no finding for any other refusal", () => {
    expect(secretFinding("Refused to push .claude/settings.local.json: it is an agent's local approvals.")).toBeUndefined();
    expect(secretFinding("network down")).toBeUndefined();
  });
});

describe("isGuardRefusal", () => {
  it("recognises every refusal the commit guard raises", () => {
    for (const message of [
      "Possible secret in src/a.rs:1. The value is not shown.",
      "The push's list of refs could not be read, so nothing was sent.",
      "Left out .claude/settings.local.json: an agent's local approvals, not for GitHub.",
      "Refused to push .claude/settings.local.json: it is an agent's local approvals, not for GitHub.",
      "Refused to land .claude/settings.local.json: it is an agent's local approvals.",
      "The secret check did not finish in time, so nothing was sent.",
      "This change is too large for the secret check, so nothing was sent.",
    ]) {
      expect(isGuardRefusal(message), message).toBe(true);
    }
  });

  it("does not take other errors", () => {
    expect(isGuardRefusal("git push failed: rejected")).toBe(false);
  });
});
