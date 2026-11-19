// Review of PR #227 (WP-200), round 4: red-first repros for the hold widening in 91332e931. Each command is ordinary
// agent work that skips no hook and writes nothing of the guard's, and each is held today.
import { describe, expect, it } from "vitest";
import { credentialBlock } from "./credentialGuard";

const HOME = "/Users/ash";
const HUB = `${HOME}/Projects/monocode-hub`;

const ordinary: Array<{ command?: string; paths?: string[] }> = [
  // "no-v" anywhere in a command that names git
  { command: "git checkout -b fix/no-version-bump" },
  { command: 'git commit -m "drop the no-var lint rule"' },
  { command: "git log --oneline | grep -i no-verify" },
  // "env ... --flag" anywhere in a command that names git
  { command: "git status && env CI=1 npm test -- --run" },
  // the Hub's own source folder src-tauri/src/attribution, in Ash's main checkout (~/Projects/monocode-hub)
  { paths: [`${HUB}/src-tauri/src/attribution/hooks.rs`] },
  { command: `sed -n 1,40p ${HUB}/src-tauri/src/attribution/hooks.rs` },
];

describe("PR #227 r4: ordinary commands are not held as hook skips or guard-store writes", () => {
  it.each(ordinary)("lets %j through", (call) => {
    expect(credentialBlock(call, HUB, HOME)).toBeUndefined();
  });
});
