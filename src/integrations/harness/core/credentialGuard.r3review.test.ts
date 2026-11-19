// Review of PR #227 (WP-200), round 3: red-first repros. Each command below skips the crew's pre-push hook (checked
// against a real git 2.43 with core.hooksPath set through GIT_CONFIG_COUNT, the way a crew is armed) or writes the
// commit guard's allow list / crew hooks by hand. None is held today.
import { describe, expect, it } from "vitest";
import { chatDeniedTools } from "../../../features/hub/model/hubMcp";
import { credentialBlock } from "./credentialGuard";

const HOME = "/Users/ash";
const DATA = `${HOME}/Library/Application Support/com.ash.monocode-hub`;

const hookSkips = [
  // quoting splits the flag the regex looks for; the shell joins it back
  "git push --'no-verify' origin main",
  "git push --no-'verify' origin main",
  // the flag in a variable
  "V=--no-verify; git push $V origin main",
  // the hooks key spelled through quotes
  "git -c core.hooks''Path=/dev/null push origin main",
  // a clean environment drops GIT_CONFIG_COUNT, so git falls back to the repository's own hooks
  "env -i PATH=$PATH HOME=$HOME git push origin main",
  // plumbing that never runs pre-push
  "git send-pack origin refs/heads/main:refs/heads/main",
];

const guardWrites = [
  `printf '[{"repo":"x","file":"src/a.ts","hash":"y"}]' > "${DATA}/commit-guard-allows.json"`,
  `echo 'exit 0' > "${DATA}/attribution/hooks/abc/pre-push"`,
];

describe("PR #227 r3: an agent's shell cannot skip the pre-push check", () => {
  it.each(hookSkips)("holds %s", (command) => {
    expect(credentialBlock({ command }, "/srv/project", HOME)).toBeDefined();
  });
});

describe("PR #227 r3: an agent cannot write the allow list or the crew hooks", () => {
  it.each(guardWrites)("holds %s", (command) => {
    expect(credentialBlock({ command }, "/srv/project", HOME)).toBeDefined();
  });

  it("denies the Write/Edit tools on the allow list", () => {
    const denied = chatDeniedTools();
    expect(
      denied.some((rule) => /^Edit\(.*(?:commit-guard-allows|Application Support\/com\.ash\.monocode-hub(?:\*|\/\*\*|\)))/.test(rule)),
      `no deny rule names the allow list: ${denied.filter((r) => r.startsWith("Edit(")).join(", ")}`,
    ).toBe(true);
  });
});
