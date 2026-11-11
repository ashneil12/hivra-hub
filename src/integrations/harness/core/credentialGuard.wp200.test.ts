// WP-200 round 3 (review item 3): a crew agent must not skip the pre-push hook or point git at another hooks folder.
// The hook checks secrets and agent files before a push, so a command that turns it off is held like a secret action.
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_DENY_RULES,
  GIT_HOOK_BLOCK_MESSAGE,
  GIT_HOOK_DENY_RULES,
  credentialBlock,
} from "./credentialGuard";

const skips = [
  "git push --no-verify origin main",
  "git push origin main --no-verify",
  "git push --no-v origin main",
  "git commit -nm wip",
  "git commit -anm wip",
  "git commit --no-verify -m wip",
  "git commit -n -m wip",
  "cd repo && git push --no-verify",
  "git -c core.hooksPath=/dev/null push origin main",
  "git -c core.hooksPath=/tmp/none commit -m x",
  "git config core.hooksPath /tmp/none",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push origin main",
  "GIT_CONFIG_PARAMETERS=\"'core.hooksPath=/dev/null'\" git push origin main",
  "git -c alias.p='push --no-verify' p",
  "git -c alias.up=push up origin main",
  "git --config-env=core.hooksPath=HOOKS push origin main",
  "sh -c \"git push --no-verify origin main\"",
];

const ordinary = [
  "git push origin main",
  "git push -n origin main",
  "git push -u origin wp/200-commit-secret-scan",
  "git commit -m \"fix the gate\"",
  "git status --short",
  "git log --oneline -5",
  "git diff --cached --stat",
  "npm run check",
];

describe("git hook skips are held", () => {
  it.each(skips)("holds %s", (command) => {
    expect(credentialBlock({ command }, "/srv/project")).toBe(GIT_HOOK_BLOCK_MESSAGE);
  });

  it.each(ordinary)("lets %s through", (command) => {
    expect(credentialBlock({ command }, "/srv/project")).toBeUndefined();
  });

  it("names the rule in the deny lists every Claude process and hub chat carries", () => {
    for (const rule of GIT_HOOK_DENY_RULES) {
      expect(CREDENTIAL_DENY_RULES).toContain(rule);
    }
    expect(GIT_HOOK_DENY_RULES).toContain("Bash(*git*push*--no-v*)");
  });
});
