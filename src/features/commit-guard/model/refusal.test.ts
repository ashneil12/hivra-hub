import { describe, expect, it } from "vitest";
import { isGuardRefusal, refusalId } from "./refusal";

describe("refusalId", () => {
  it("reads the id a secret refusal carries", () => {
    expect(
      refusalId("Possible secret in src/config.rs:12 in /srv/project (commit 1a2b3c4d5e6f, refusal 0123456789ab). The value is not shown."),
    ).toBe("0123456789ab");
  });

  it("gives no id for a commit message, a file name or a refusal without one", () => {
    expect(refusalId("Possible secret in a commit message:2. The value is not shown.")).toBeUndefined();
    expect(refusalId("Possible secret in a file name (the name is not shown). The value is not shown.")).toBeUndefined();
    expect(refusalId("Possible secret in src/a.rs:1 (commit none, refusal 0123456789ab)")).toBeUndefined();
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
