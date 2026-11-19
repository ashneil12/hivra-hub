import { describe, expect, it } from "vitest";
import { isGuardRefusal, refusalId, refusalWords } from "./refusal";

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
      "Refused to commit .claude/settings.local.json: it is an agent's local approvals, not for GitHub.",
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

describe("refusalWords (WP-248)", () => {
  it("reads a tracked approvals refusal's id, and words it as a whole file for one repository", () => {
    const message =
      "Refused to commit .claude/settings.local.json: it is an agent's local approvals, and this repository tracks it. It saves approved commands with any password typed in them (refusal 0123456789ab). To go on, untrack it.";
    expect(isGuardRefusal(message)).toBe(true);
    expect(refusalId(message)).toBe("0123456789ab");
    const words = refusalWords({ file: ".claude/settings.local.json", folder: "/srv/project", line: 0, commit: "", wholeFile: true });
    expect(words.headline).toContain(".claude/settings.local.json in /srv/project");
    expect(words.headline).not.toContain("line 0");
    expect(words.why).toContain("--cached .claude/settings.local.json");
    expect(words.button).toBe("Allow this file in this repository");
  });

  it("keeps the line wording for a secret on one line", () => {
    const words = refusalWords({ file: "src/config.rs", folder: "/srv/project", line: 12, commit: "1a2b3c4d5e6f" });
    expect(words.headline).toBe(
      "Blocked: a possible secret is on line 12 of src/config.rs in /srv/project (commit 1a2b3c4d5e6f). The value is not shown.",
    );
    expect(words.button).toBe("Allow this line");
  });

  it("uses no em or en dashes", () => {
    for (const wholeFile of [true, false]) {
      const words = refusalWords({ file: "a", folder: "b", line: 1, commit: "c", wholeFile });
      expect(Object.values(words).join(" ")).not.toMatch(/[–—]/);
    }
  });
});
