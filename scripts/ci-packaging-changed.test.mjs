// WP-154: RPM builds only when packaging inputs changed, using the same base-sha
// diff as the AppImage job. A missing base, a bad sha or a git failure builds
// anyway. An unrelated push to main does not start Native Preview.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RPM_PACKAGING_FILES,
  packagingPattern,
  parseGitPaths,
  resolvePackagingRun,
} from "./ci-packaging-changed.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "scripts", "ci-packaging-changed.mjs");
const pattern = packagingPattern(RPM_PACKAGING_FILES);
const ci = readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");
const native = readFileSync(path.join(repo, ".github", "workflows", "native.yml"), "utf8");

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function decide(overrides) {
  const calls = [];
  const inner = overrides.git ?? (() => ({ status: 0, stdout: overrides.stdout ?? "" }));
  const decision = resolvePackagingRun({
    base: Object.prototype.hasOwnProperty.call(overrides, "base") ? overrides.base : BASE,
    head: Object.prototype.hasOwnProperty.call(overrides, "head") ? overrides.head : HEAD,
    pattern,
    git: (args) => {
      calls.push(args);
      return inner(args);
    },
  });
  return { decision, calls };
}

function jobBlock(text, name) {
  const marker = `\n  ${name}:\n`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `job ${name} not found`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("every packaging input triggers a build, and ordinary source does not", () => {
  for (const file of RPM_PACKAGING_FILES) {
    const { decision } = decide({ stdout: `${file}\0` });
    assert.equal(decision.run, true, file);
  }
  for (const file of [
    "README.md",
    "docs/hivra/work/WP-154-ci-speed.md",
    "src/app/App.tsx",
    "src-tauri/src/lib.rs",
    "src-tauri/tauri.hub.conf.json",
    "src-tauri/tauri.windows.conf.json",
    "docs/package.json",
    "package.json.bak",
    "crates/monocode-gpui/Cargo.lock",
  ]) {
    const { decision } = decide({ stdout: `${file}\0` });
    assert.equal(decision.run, false, file);
  }
});

test("an empty diff skips, and a packaging file among other files still builds", () => {
  assert.equal(decide({ stdout: "" }).decision.run, false);
  assert.equal(decide({ stdout: "README.md\0package.json\0README.md\0" }).decision.run, true);
});

test("git paths are split on NUL, a trailing CR is ignored, and odd paths do not match", () => {
  assert.deepEqual(parseGitPaths("package.json\0README.md\0"), ["package.json", "README.md"]);
  assert.deepEqual(parseGitPaths("package.json\r\0"), ["package.json"]);
  assert.deepEqual(parseGitPaths(""), []);
  assert.deepEqual(parseGitPaths("\0\0"), []);
  const { decision } = decide({
    stdout: "../package.json\0/etc/package.json\0package.json\\..\0src-tauri/../Cargo.lock\0",
  });
  assert.equal(decision.run, false);
});

test("a missing, zero, short or non-hex sha builds and does not run git", () => {
  for (const base of ["", "   ", "0".repeat(40), "0".repeat(4), "A".repeat(40), `${"a".repeat(39)}g`, `-${"a".repeat(39)}`]) {
    const { decision, calls } = decide({ base });
    assert.equal(decision.run, true, JSON.stringify(base));
    assert.deepEqual(calls, []);
  }
  const head = decide({ head: "" });
  assert.equal(head.decision.run, true);
  assert.deepEqual(head.calls, []);
});

test("a base commit that is not in the checkout builds, and git is given separate arguments", () => {
  const { decision, calls } = decide({ git: () => ({ status: 1, stdout: "" }) });
  assert.equal(decision.run, true);
  assert.deepEqual(calls, [["cat-file", "-e", `${BASE}^{commit}`]]);
});

test("a git failure or an unreadable file list builds", () => {
  assert.equal(decide({ git: () => ({ status: null, error: new Error("no git") }) }).decision.run, true);
  assert.equal(
    decide({
      git: (args) => (args[0] === "cat-file" ? { status: 0, stdout: "" } : { status: 1, stdout: "" }),
    }).decision.run,
    true,
  );
  assert.equal(
    decide({
      git: (args) => (args[0] === "cat-file" ? { status: 0, stdout: "" } : { status: 0, stdout: null }),
    }).decision.run,
    true,
  );
});

test("a clean diff calls git with the two shas and no shell", () => {
  const { decision, calls } = decide({ stdout: "README.md\0" });
  assert.equal(decision.run, false);
  assert.deepEqual(calls[0], ["cat-file", "-e", `${BASE}^{commit}`]);
  assert.deepEqual(calls[1], ["diff", "--name-only", "-z", "--no-renames", BASE, HEAD]);
});

function git(cwd, args) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Packaging Test",
      GIT_AUTHOR_EMAIL: "packaging-test@example.com",
      GIT_COMMITTER_NAME: "Packaging Test",
      GIT_COMMITTER_EMAIL: "packaging-test@example.com",
    },
  });
}

function tempRepo() {
  const cwd = mkdtempSync(path.join(tmpdir(), "ci-packaging-"));
  const hooks = path.join(cwd, ".githooks");
  mkdirSync(hooks);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "packaging-test@example.com"]);
  git(cwd, ["config", "user.name", "Packaging Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["config", "core.hooksPath", hooks]);
  return cwd;
}

function commitFile(cwd, name, body) {
  writeFileSync(path.join(cwd, name), body);
  git(cwd, ["add", "--", name]);
  git(cwd, ["commit", "-m", name]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function runCli(cwd, base, head) {
  return spawnSync(process.execPath, [script, "--kind", "rpm"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PACKAGING_BASE: base, PACKAGING_HEAD: head },
  });
}

test("the CLI builds when package.json changes and skips a docs-only commit", () => {
  const cwd = tempRepo();
  try {
    const base = commitFile(cwd, "README.md", "docs\n");
    const head = commitFile(cwd, "package.json", "{}\n");
    const built = runCli(cwd, base, head);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(built.stdout, "run=true\n");
    assert.match(built.stderr, /packaging files changed/);

    const docsHead = commitFile(cwd, "NOTES.md", "more docs\n");
    const skipped = runCli(cwd, head, docsHead);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(skipped.stdout, "run=false\n");
    assert.match(skipped.stderr, /unchanged/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the CLI builds when the base sha is missing or not a sha, and writes only the output line", () => {
  const missing = spawnSync(process.execPath, [script, "--kind", "rpm"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PACKAGING_BASE: "", PACKAGING_HEAD: "" },
  });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, "run=true\n");

  const junk = spawnSync(process.execPath, [script, "--kind", "rpm"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PACKAGING_BASE: "not a sha", PACKAGING_HEAD: HEAD },
  });
  assert.equal(junk.status, 0, junk.stderr);
  assert.equal(junk.stdout, "run=true\n");
});

test("an unknown kind fails instead of skipping the build", () => {
  const result = spawnSync(process.execPath, [script, "--kind", "deb"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /kind/);
});

test("the RPM jobs run only after the packaging check says so", () => {
  const gate = jobBlock(ci, "rpm-changes");
  assert.match(gate, /fetch-depth:\s*0/);
  assert.match(gate, /ci-packaging-changed\.mjs --kind rpm/);
  assert.match(gate, /PACKAGING_BASE:/);
  assert.match(gate, /github\.event\.pull_request\.base\.sha/);
  assert.match(gate, /github\.event\.before/);
  const rpm = jobBlock(ci, "rpm");
  assert.match(rpm, /needs:\s*rpm-changes/);
  assert.match(rpm, /needs\.rpm-changes\.result == 'success'/);
  assert.match(rpm, /needs\.rpm-changes\.outputs\.run == 'true'/);
  const clean = jobBlock(ci, "rpm-clean-install");
  assert.match(clean, /needs:\s*rpm\b/);
  assert.doesNotMatch(clean, /rpm-changes/);
  for (const job of ["check", "browser", "host", "ship"]) {
    assert.doesNotMatch(jobBlock(ci, job), /rpm-changes/, job);
  }
});

function eventPaths(event) {
  const start = native.indexOf(`\n  ${event}:\n`);
  assert.notEqual(start, -1, event);
  const rest = native.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  const block = next === -1 ? rest : rest.slice(0, next + 1);
  return [...block.matchAll(/^ {6}- '([^']+)'/gm)].map((match) => match[1]);
}

test("push uses the same native path list as pull_request, and a manual run stays open", () => {
  const push = eventPaths("push");
  const pull = eventPaths("pull_request");
  assert.deepEqual(push, pull);
  assert.ok(push.length >= 8);
  assert.ok(push.includes("crates/monocode-core/**"));
  assert.ok(push.includes(".github/workflows/native.yml"));
  assert.match(native, /branches:\s*\[main, mc\/migrate-monocode-to-gpui\]/);
  const manual = native.slice(native.indexOf("\n  workflow_dispatch:"));
  assert.doesNotMatch(manual.slice(0, manual.indexOf("\n", 1) + 20), /paths:/);
  assert.doesNotMatch(native.slice(native.indexOf("\n  workflow_dispatch:"), native.indexOf("\n  pull_request:")), /paths:/);
});
