import { describe, expect, it } from "vitest";
import { isGuardRefusal, secretFinding } from "./refusal";

describe("secretFinding", () => {
  it("reads the file and line of a secret refusal", () => {
    expect(
      secretFinding("Possible secret in src/config.rs:12. The value is not shown. To go on, either remove it."),
    ).toEqual({ file: "src/config.rs", line: 12 });
  });

  it("keeps colons in the file name", () => {
    expect(secretFinding("Possible secret in docs/a:b.md:3. The value is not shown.")).toEqual({
      file: "docs/a:b.md",
      line: 3,
    });
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
