// review/220-r5 repro (red at 348326363): the round-5 list test only looks for four literals (REVIEW_OWNER,
// REQUEST_PREFIX, app-security-review, security-review-). A file that reaches the gate through an import, a command or a
// module path names none of them, so it is never required to be a security path: App.tsx (starts the reviewer and wires
// its settle), firstmate/model/steering.ts (labels who answered a decision), monos/model/delegations.ts (the boot skip and
// the settle), fs.rs (the Inbox merge button into merge::by_person), lib.rs (registers decisions_answer).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { globToRegExp } from "./security-review/review.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const list = JSON.parse(readFileSync(resolve(root, "src/features/leadTick/model/neverMerge.json"), "utf8"));

test("r5: every file that reaches the gate through an import, a command or a module path is a security path", () => {
  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).stdout.split("\n");
  const reaches =
    /security-review\/model\/launch|\bdecisions_answer\b|delivery::(review|merge)\b|merge::by_person|review::OWNER\b|decisions::answer\b/;
  const gated = (file) => list.securityPaths.some((pattern) => globToRegExp(pattern).test(file));
  const ungated = [];
  for (const file of tracked) {
    if (!file || file.startsWith("tests/") || file.startsWith("docs/") || file.endsWith(".md")) continue;
    if (/\.test\.(mjs|cjs|ts|tsx)$/.test(file) || file.endsWith("/tests.rs") || file.includes("/tests/")) continue;
    if (!existsSync(resolve(root, file))) continue;
    let text;
    try {
      text = readFileSync(resolve(root, file), "utf8");
    } catch {
      continue;
    }
    if (reaches.test(text) && !gated(file)) ungated.push(file);
  }
  assert.deepEqual(ungated, [], "files that reach the gate but are not security paths");
});

// Round 4 MED-4 asked for the open PRs' planned files and the ship path. The `**/name*` globs miss the spellings and
// folders those PRs actually use (files read from GitHub's file lists of #204, #208, #227 on 11 Nov 2026), and the ship
// path's own helpers sit outside `scripts/hub-ship*.mjs`.
test("r5: the planned PRs' real files and the ship helpers are security paths", () => {
  const gated = (file) => list.securityPaths.some((pattern) => globToRegExp(pattern).test(file));
  const files = [
    "src/features/commit-guard/model/allows.ts", // #227: the commit guard's allow list
    "src/features/commit-guard/model/refusal.ts", // #227
    "src-tauri/src/commit_guard/mod.rs", // a commit_guard module folder
    "src/integrations/harness/moreAgents/moreAgentAdapter.ts", // #204: the ACP agents' adapter
    "src/features/providers/model/moreAgents.ts", // #204
    "scripts/agent-sandbox-probe.mjs", // #208
    "src-tauri/src/agent_sandbox/policy.rs", // an agent_sandbox module folder
    "scripts/hub-check-all.mjs", // writes the pass record ship requires
    "scripts/hub-rollback.mjs",
    "scripts/verify-hub-bundle.mjs",
    "src-tauri/build.rs", // runs at every build of the shipped app
  ];
  assert.deepEqual(files.filter((file) => !gated(file)), [], "not security paths");
});
