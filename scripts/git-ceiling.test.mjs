// Guard: a test that runs git in a temporary folder cannot discover this checkout above it (WP-105). GIT_CEILING_
// DIRECTORIES is set by the script tests that spawn git and by the web test setup file; this proves what it does.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.realpathSync(os.tmpdir());

function insideRepo(cwd, env) {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

test("without a ceiling, git walks up from a temp folder to a repository that holds it", () => {
  const parent = fs.mkdtempSync(path.join(tmp, "wp105-ceiling-parent-"));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const inner = path.join(repo, "nested");
  fs.mkdirSync(inner);
  try {
    const env = { ...process.env };
    delete env.GIT_CEILING_DIRECTORIES;
    assert.equal(insideRepo(inner, env), true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("with the temp parent as the ceiling, a repository above it is out of reach", () => {
  // The repository sits above the ceiling and the folder git starts in below it, so only the ceiling can stop the walk.
  const root = fs.mkdtempSync(path.join(tmp, "wp105-ceiling-root-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const ceiling = path.join(repo, "ceiling");
  const inner = path.join(ceiling, "nested");
  fs.mkdirSync(inner, { recursive: true });
  try {
    const env = { ...process.env };
    delete env.GIT_CEILING_DIRECTORIES;
    assert.equal(insideRepo(inner, env), true, "without a ceiling the walk reaches the repository");
    assert.equal(insideRepo(inner, { ...process.env, GIT_CEILING_DIRECTORIES: ceiling }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a repository inside the temp area is still found with the ceiling in place", () => {
  // The script tests do want the throwaway repositories they make in the temp folder; the ceiling is at the temp
  // parent, above them, so it must not hide them.
  const parent = fs.mkdtempSync(path.join(tmp, "wp105-ceiling-parent-"));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const inner = path.join(repo, "nested");
  fs.mkdirSync(inner);
  try {
    assert.equal(insideRepo(inner, { ...process.env, GIT_CEILING_DIRECTORIES: tmp }), true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("the script tests that spawn git set the ceiling at the temp parent", () => {
  const files = [
    "setup-worktree.test.cjs",
    "hub-doctor.test.cjs",
    "hub-ship.test.mjs",
    "hub-install.test.mjs",
    "hub-realtest.test.mjs",
    "hub-realconv.test.mjs",
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
    assert.match(text, /GIT_CEILING_DIRECTORIES/, `${file} spawns git without a ceiling`);
    assert.match(text, /os\.tmpdir\(\)/, `${file} must put the temp parent in the ceiling`);
  }
});

test("the web test setup file sets the ceiling too", () => {
  const setup = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "test", "harnessSetup.ts"), "utf8");
  assert.match(setup, /GIT_CEILING_DIRECTORIES/);
  assert.match(setup, /tmpdir\(\)/);
});
