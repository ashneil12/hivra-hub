// Round 6 repros for PR #220. The repro commit was not in this clone; these assert the same outcomes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const { globToRegExp, isSecuritySensitive } = await import("./security-review/review.mjs");
const neverMerge = JSON.parse(readFileSync(resolve(root, "src/features/leadTick/model/neverMerge.json"), "utf8"));

const PLANNED = [
  "src/features/commit-guard/**",
  "src/integrations/harness/moreAgents/**",
  "src/features/providers/model/moreAgents.ts",
  "scripts/agent-sandbox-probe.mjs",
  "**/commit_guard/**",
  "**/agent_sandbox/**",
];

const GATED_NOW = [
  "src/app/App.tsx",
  "src/features/firstmate/model/steering.ts",
  "src/features/monos/model/delegations.ts",
  "src-tauri/src/fs.rs",
  "src-tauri/src/lib.rs",
  "src/features/hub/model/localHub/decisions.ts",
  "src/features/crew/ui/FirstMateInboxPanel.tsx",
  "src/features/fresh-eyes/model/gate.ts",
  "scripts/hub-check-all.mjs",
  "scripts/hub-rollback.mjs",
  "scripts/verify-hub-bundle.mjs",
  "src-tauri/build.rs",
  ...PLANNED.map((pattern) => {
    if (pattern.endsWith("/**")) return pattern.slice(0, -3) + "/mod.rs";
    if (pattern.endsWith(".ts") || pattern.endsWith(".mjs")) return pattern;
    return "src/crate/commit_guard/mod.rs";
  }),
  "src/crate/commit_guard/mod.rs",
  "src/crate/agent_sandbox/mod.rs",
];

test("repro 220 r5: answer, launch and ship files are security paths", () => {
  const missed = GATED_NOW.filter((file) => isSecuritySensitive({ files: [file], labels: [] }) === "");
  assert.deepEqual(missed, [], "these files merge with no review");
});

test("repro 220 r5: hyphen, camelCase and module folders are planned and gated", () => {
  for (const pattern of PLANNED) {
    assert.ok(neverMerge.securityPaths.includes(pattern), `${pattern} is not a security path`);
    assert.ok((neverMerge.plannedPaths ?? []).includes(pattern), `${pattern} is not planned`);
  }
  const source = readFileSync(resolve(here, "security-review.test.mjs"), "utf8");
  assert.match(source, /"\*\*\/more_agents\*": "more agents, PR #204"/);
  assert.match(source, /"\*\*\/spend_ledger\*": "spend ledger, PR #217"/);
});

test("repro 220 r5: a star does not match across a slash, the directory glob does", () => {
  const fileGlob = globToRegExp("**/commit_guard*");
  const dirGlob = globToRegExp("**/commit_guard/**");
  assert.equal(fileGlob.test("src/crate/commit_guard/mod.rs"), false);
  assert.equal(dirGlob.test("src/crate/commit_guard/mod.rs"), true);
  assert.equal(globToRegExp("**/more_agents*").test("src/integrations/harness/moreAgents/index.ts"), false);
  assert.equal(globToRegExp("src/integrations/harness/moreAgents/**").test("src/integrations/harness/moreAgents/index.ts"), true);
});

function isTestFile(file) {
  return (
    file.startsWith("tests/") ||
    file.includes("/tests/") ||
    file.endsWith("/tests.rs") ||
    file.includes(".test.") ||
    file.includes(".spec.")
  );
}

test("repro 220 r5: code that starts a review or names who answered is a security path", () => {
  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).stdout.split("\n");
  const names =
    /security-review\/model\/launch|\bdecisions_answer\b|delivery::review|delivery::merge|merge::by_person|review::OWNER|decisions::answer/;
  const gated = (file) => neverMerge.securityPaths.some((pattern) => globToRegExp(pattern).test(file));
  const ungated = [];
  for (const file of tracked) {
    if (!file || !/\.(rs|ts|tsx|mjs|js)$/.test(file) || isTestFile(file)) continue;
    if (!existsSync(resolve(root, file))) continue;
    const text = readFileSync(resolve(root, file), "utf8");
    if (names.test(text) && !gated(file)) ungated.push(file);
  }
  assert.deepEqual(ungated, []);
});

test("repro 220 r5: the settings text states the path list limit", () => {
  const card = readFileSync(resolve(root, "src/features/leadTick/ui/LeadTickCard.tsx"), "utf8");
  assert.match(card, /Packages parked for a security check are never merged/);
  assert.match(card, /path list cannot catch a backdoor in unrelated code/);
  assert.match(card, /off until you turn it on/);
});
