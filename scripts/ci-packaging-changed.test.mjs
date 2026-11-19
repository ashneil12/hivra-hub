// WP-154: the full RPM set (both images and the clean install) runs on every push to main, every
// nightly run, and every pull request whose diff touches a packaging input. A pull request that does
// not touch one still builds the image the release workflow ships on, so a production build runs on
// every pull request. The decision uses the same base-sha diff as the AppImage job. A missing base,
// a bad sha or a git failure builds the full set anyway. An unrelated push to main does not start
// Native Preview.

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
  planRpmBuild,
  resolvePackagingRun,
} from "./ci-packaging-changed.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "scripts", "ci-packaging-changed.mjs");
const pattern = packagingPattern(RPM_PACKAGING_FILES);
const ci = readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");
const native = readFileSync(path.join(repo, ".github", "workflows", "native.yml"), "utf8");
const release = readFileSync(path.join(repo, ".github", "workflows", "release.yml"), "utf8");

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

function plan(overrides) {
  const calls = [];
  const inner = overrides.git ?? (() => ({ status: 0, stdout: overrides.stdout ?? "" }));
  const result = planRpmBuild({
    event: overrides.event,
    base: Object.prototype.hasOwnProperty.call(overrides, "base") ? overrides.base : BASE,
    head: Object.prototype.hasOwnProperty.call(overrides, "head") ? overrides.head : HEAD,
    pattern,
    git: (args) => {
      calls.push(args);
      return inner(args);
    },
  });
  return { result, calls };
}

test("a push to main and a nightly run build everything, without asking git", () => {
  for (const event of ["push", "schedule"]) {
    const { result, calls } = plan({ event, stdout: "README.md\0" });
    assert.equal(result.full, true, event);
    assert.deepEqual(calls, [], `${event} must not need the diff`);
    assert.match(result.reason, /every image builds/);
  }
  const noShas = plan({ event: "push", base: "", head: "" });
  assert.equal(noShas.result.full, true);
  assert.deepEqual(noShas.calls, []);
});

test("an event that is not a pull request, or is missing, builds everything", () => {
  for (const event of ["workflow_dispatch", "", undefined, "pull_request_target", "Pull_Request", " pull_request"]) {
    const { result, calls } = plan({ event, stdout: "README.md\0" });
    assert.equal(result.full, true, JSON.stringify(event));
    assert.deepEqual(calls, []);
  }
});

test("a pull request builds the full set only when a packaging input changed", () => {
  assert.equal(plan({ event: "pull_request", stdout: "README.md\0src/app/App.tsx\0" }).result.full, false);
  assert.equal(plan({ event: "pull_request", stdout: "" }).result.full, false);
  for (const file of RPM_PACKAGING_FILES) {
    assert.equal(plan({ event: "pull_request", stdout: `${file}\0` }).result.full, true, file);
  }
  assert.equal(plan({ event: "pull_request", stdout: "README.md\0package.json\0" }).result.full, true);
});

test("a pull request that cannot be diffed builds the full set", () => {
  assert.equal(plan({ event: "pull_request", base: "" }).result.full, true);
  assert.equal(plan({ event: "pull_request", base: "0".repeat(40) }).result.full, true);
  assert.equal(plan({ event: "pull_request", git: () => ({ status: 1, stdout: "" }) }).result.full, true);
  assert.equal(plan({ event: "pull_request", git: () => ({ status: null, error: new Error("no git") }) }).result.full, true);
  assert.equal(
    plan({
      event: "pull_request",
      git: (args) => (args[0] === "cat-file" ? { status: 0, stdout: "" } : { status: 1, stdout: "" }),
    }).result.full,
    true,
  );
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

function runCli(cwd, base, head, event = "pull_request") {
  return spawnSync(process.execPath, [script, "--kind", "rpm"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PACKAGING_EVENT: event, PACKAGING_BASE: base, PACKAGING_HEAD: head },
  });
}

test("the CLI builds the full set when package.json changes in a pull request, and not for a docs-only one", () => {
  const cwd = tempRepo();
  try {
    const base = commitFile(cwd, "README.md", "docs\n");
    const head = commitFile(cwd, "package.json", "{}\n");
    const built = runCli(cwd, base, head);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(built.stdout, "full=true\n");
    assert.match(built.stderr, /packaging files changed/);

    const docsHead = commitFile(cwd, "NOTES.md", "more docs\n");
    const skipped = runCli(cwd, head, docsHead);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(skipped.stdout, "full=false\n");
    assert.match(skipped.stderr, /unchanged/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the CLI builds the full set for a docs-only push to main and for the nightly run", () => {
  const cwd = tempRepo();
  try {
    const base = commitFile(cwd, "README.md", "docs\n");
    const head = commitFile(cwd, "NOTES.md", "more docs\n");
    assert.equal(runCli(cwd, base, head, "pull_request").stdout, "full=false\n");
    for (const event of ["push", "schedule"]) {
      const result = runCli(cwd, base, head, event);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "full=true\n", event);
    }
    const nightly = runCli(cwd, "", "", "schedule");
    assert.equal(nightly.stdout, "full=true\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the CLI builds the full set when the event is missing, the base sha is missing or not a sha, and writes only the output line", () => {
  const noEvent = spawnSync(process.execPath, [script, "--kind", "rpm"], {
    cwd: repo,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", PACKAGING_BASE: BASE, PACKAGING_HEAD: HEAD },
  });
  assert.equal(noEvent.status, 0, noEvent.stderr);
  assert.equal(noEvent.stdout, "full=true\n");

  const missing = spawnSync(process.execPath, [script, "--kind", "rpm"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PACKAGING_EVENT: "pull_request", PACKAGING_BASE: "", PACKAGING_HEAD: "" },
  });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, "full=true\n");

  const junk = spawnSync(process.execPath, [script, "--kind", "rpm"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PACKAGING_EVENT: "pull_request", PACKAGING_BASE: "not a sha", PACKAGING_HEAD: HEAD },
  });
  assert.equal(junk.status, 0, junk.stderr);
  assert.equal(junk.stdout, "full=true\n");
});

test("an unknown kind fails instead of skipping the build", () => {
  const result = spawnSync(process.execPath, [script, "--kind", "deb"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /kind/);
});

function jobIf(block) {
  const lines = block.split("\n");
  const at = lines.findIndex((line) => /^ {4}if:/.test(line));
  assert.notEqual(at, -1, "job has no if");
  const first = lines[at].replace(/^ {4}if:\s*/, "");
  if (first !== ">-" && first !== ">") return first.trim();
  const folded = [];
  for (let i = at + 1; i < lines.length && /^ {6}\S/.test(lines[i]); i += 1) folded.push(lines[i].trim());
  return folded.join(" ");
}

test("the gate tells the RPM jobs what to build, from the event and the pull request's base", () => {
  const gate = jobBlock(ci, "rpm-changes");
  assert.match(gate, /fetch-depth:\s*0/);
  assert.match(gate, /ci-packaging-changed\.mjs --kind rpm >> "\$GITHUB_OUTPUT"/);
  assert.match(gate, /PACKAGING_EVENT: \$\{\{ github\.event_name \}\}/);
  assert.match(gate, /PACKAGING_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(gate, /PACKAGING_HEAD: \$\{\{ github\.sha \}\}/);
  assert.match(gate, /outputs:\n\s+full: \$\{\{ steps\.packaging\.outputs\.full \}\}/);
  assert.doesNotMatch(gate, /outputs\.run\b/);
  // A push to main does not diff against github.event.before any more: it always builds the full set.
  assert.doesNotMatch(gate, /github\.event\.before/);
});

test("the production build runs on every run, and only the second image and the clean install wait for the gate", () => {
  const rpm = jobBlock(ci, "rpm");
  assert.match(rpm, /needs:\s*rpm-changes/);
  assert.match(jobIf(rpm), /needs\.rpm-changes\.result == 'success'/);
  assert.doesNotMatch(jobIf(rpm), /outputs/, "the build job itself no longer waits for the gate's answer");
  const matrix =
    /image: \$\{\{ fromJSON\(needs\.rpm-changes\.outputs\.full == 'true' && '(\[[^']*\])' \|\| '(\[[^']*\])'\) \}\}/.exec(rpm);
  assert.ok(matrix, "the image list is not chosen by the gate's full output");
  const full = JSON.parse(matrix[1]);
  const one = JSON.parse(matrix[2]);
  assert.deepEqual(full, ["almalinux:10", "fedora:43"]);
  assert.deepEqual(one, ["almalinux:10"]);
  // The one image every run builds is the image the release workflow publishes from.
  const releaseJob = /\n {2}linux-rpm:\n(?:.*\n)*?\s+container: (\S+)/.exec(release);
  assert.ok(releaseJob, "release.yml has no linux-rpm container");
  assert.equal(one[0], releaseJob[1]);
  // That build is the production build: tauri's release build, not a dev build or a check.
  assert.match(rpm, /run: npm run build:fedora/);
  assert.match(rpm, /timeout-minutes:\s*25/);
});

test("the clean install needs the second image's run, so it waits for the gate's full answer", () => {
  const clean = jobBlock(ci, "rpm-clean-install");
  assert.match(clean, /needs:\s*\[rpm-changes, rpm\]/);
  assert.match(jobIf(clean), /needs\.rpm-changes\.outputs\.full == 'true'/);
  const rpm = jobBlock(ci, "rpm");
  const upload = rpm.slice(rpm.indexOf("name: Upload rpm for the clean install check"));
  assert.match(upload, /if: matrix\.image == 'almalinux:10' && needs\.rpm-changes\.outputs\.full == 'true'/);
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
