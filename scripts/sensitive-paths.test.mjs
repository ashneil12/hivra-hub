import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { repoRoot } from "./guards-common.mjs";
import { globToRegExp, matchFiles, run, validateList, DEFAULT_FILE } from "./sensitive-paths.mjs";

test("globs: * stays in a folder, ** crosses folders", () => {
  assert.ok(globToRegExp("src-tauri/src/secrets/**").test("src-tauri/src/secrets/store.rs"));
  assert.ok(globToRegExp("src-tauri/src/secrets/**").test("src-tauri/src/secrets/a/b.rs"));
  assert.ok(!globToRegExp("src-tauri/src/secrets/**").test("src-tauri/src/secrets.rs"));
  assert.ok(globToRegExp("scripts/hub-ship*.mjs").test("scripts/hub-ship-runner.mjs"));
  assert.ok(!globToRegExp("scripts/*.mjs").test("scripts/a/b.mjs"));
  assert.ok(globToRegExp(".github/**").test(".github/workflows/ci.yml"));
  assert.ok(globToRegExp("**/x.rs").test("x.rs"));
  assert.ok(!globToRegExp("a.b").test("aXb"));
});

test("matchFiles returns the first matching entry and skips the rest", () => {
  const entries = [{ glob: ".github/**", reason: "CI" }, { glob: "src/**", reason: "src" }];
  const out = matchFiles(["README.md", ".github/workflows/ci.yml"], entries);
  assert.deepEqual(out, [{ file: ".github/workflows/ci.yml", glob: ".github/**", reason: "CI" }]);
});

test("validateList flags a bad shape", () => {
  assert.equal(validateList({ paths: [{ glob: "a", reason: "b" }] }).length, 0);
  assert.equal(validateList({ paths: [{ glob: "a" }] }).length, 1);
  assert.equal(validateList(null).length, 1);
});

test("the real list is valid and every entry matches a tracked file", () => {
  const data = JSON.parse(readFileSync(DEFAULT_FILE, "utf8"));
  assert.deepEqual(validateList(data), []);
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return;
  }
  if (tracked.length === 0) return;
  for (const entry of data.paths) {
    assert.ok(tracked.some((f) => globToRegExp(entry.glob).test(f)), `${entry.glob} matches nothing`);
  }
});

test("report only: exits 0 on a match, 1 only with --strict", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sens-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "a");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const list = path.join(dir, "list.json");
  writeFileSync(list, JSON.stringify({ paths: [{ glob: "secret/**", reason: "keys" }] }));
  mkdirSync(path.join(dir, "secret"));
  writeFileSync(path.join(dir, "secret", "k.txt"), "k");
  const out = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  let codes;
  try {
    const base = ["--base", "main", "--file", list, "--repo", dir];
    codes = [run(base, {}), run([...base, "--strict"], {}), run([...base, "--json"], {})];
  } finally {
    process.stdout.write = write;
  }
  assert.deepEqual(codes, [0, 1, 0]);
  const text = out.join("");
  assert.ok(text.includes("secret/k.txt"));
  assert.equal(JSON.parse(text.slice(text.lastIndexOf("{\n  \"base\""))).matches.length, 1);
});
