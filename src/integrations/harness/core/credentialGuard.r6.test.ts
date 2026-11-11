// WP-200 round 6: `-n` is a flag of the git push or commit itself, not of a later command or a commit message.
import { describe, expect, it } from "vitest";
import { credentialBlock } from "./credentialGuard";

const held = [
  "git push -n origin main",
  "git commit -n -m wip",
  "git push origin main -n",
  'git commit -m "x" -n',
  "git push --'no-verify'",
  "git push --no-'verify'",
  "V=--no-verify; git push $V origin main",
];

const ordinary = [
  "git commit -m wip && grep -n TODO a.ts",
  "git push origin main | grep -n rejected",
  "git push && pytest -n 4",
  'git commit -m "grep -n TODO"',
  "git checkout -b fix/no-version-bump",
  'git commit -m "drop the no-var lint rule"',
  "git log --oneline | grep -i no-verify",
  "git status && env CI=1 npm test -- --run",
];

describe("a hook skip is the git command's own flag", () => {
  it.each(held)("holds %s", (command) => {
    expect(credentialBlock({ command }, "/srv/project")).toBeDefined();
  });

  it.each(ordinary)("lets %s through", (command) => {
    expect(credentialBlock({ command }, "/srv/project")).toBeUndefined();
  });
});
