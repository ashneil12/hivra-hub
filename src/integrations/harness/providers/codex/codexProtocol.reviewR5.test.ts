// Review r5 repro for PR #208 (WP-178), red at a5bc60a97. While Hivra's sandbox is on, a Codex chat in an auto mode
// runs outside the Hivra profile (codexSkipsOuterSandbox), so the only thing between it and an out-of-workspace write
// is codexAutoFileChange. Its "inside the workspace" test is a string prefix: a `..` segment or a link inside the
// workspace that points out passes, and Codex then applies the approved change itself, outside every sandbox
// (the switch file, a LaunchAgent). MED while the approval request carries no `changes` (it then asks), HIGH on any
// Codex build whose request names the paths. Resolve the real path (the deepest existing parent) before comparing.
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAutoFileChange } from "./codexProtocol";

describe("review r5: codexAutoFileChange while Hivra's sandbox is on", () => {
  it("does not let a .. segment out of the workspace", () => {
    expect(
      codexAutoFileChange(
        "auto-accept-edits",
        true,
        ["/work/../Users/ash/Library/Application Support/com.ash.monocode-hub/settings/agent-sandbox"],
        "/work",
      ),
    ).toBeNull();
  });

  it("does not follow a link inside the workspace that points out of it", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-r5-"));
    try {
      const work = join(root, "work");
      const outside = join(root, "outside");
      mkdirSync(work);
      mkdirSync(outside);
      symlinkSync(outside, join(work, "link"));
      expect(
        codexAutoFileChange("auto-accept-edits", true, [join(work, "link", "agent-sandbox")], work),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
