// Test double for an opted-in sparse checkout. This is not gion.
// The real program's arguments are set in the same change as a real checksum,
// after that program's help text is checked. Until then the app does not spawn it.
//
// create writes a checkout record and copies no files.
// read prints one relative path from the repo named in that record.
// status prints "clean" or "dirty".
// remove deletes the checkout only when the record is there and it is not the repo.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const MARKER = ".gion-workspace.json";

function noteArgv() {
  const log = process.env.GION_STANDIN_LOG;
  if (!log) return;
  writeFileSync(log, `${process.argv.slice(2).join("\n")}\n`, { flag: "a" });
}

function noteEnvKeys() {
  const log = process.env.GION_STANDIN_ENV_LOG;
  if (!log) return;
  const keys = Object.keys(process.env).sort();
  writeFileSync(log, `${keys.join("\n")}\n`);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

function refusedPath(relative) {
  if (!relative || isAbsolute(relative) || relative.includes("..")) return true;
  if (relative.includes("\\") || relative.includes("\0")) return true;
  if (/^[A-Za-z]:/.test(relative)) return true;
  return false;
}

function markerAt(dest) {
  return JSON.parse(readFileSync(join(dest, MARKER), "utf8"));
}

function inside(root, path) {
  const base = resolve(root);
  const file = resolve(path);
  return file === base || file.startsWith(base.endsWith(sep) ? base : base + sep);
}

noteArgv();
noteEnvKeys();

const command = process.argv[2];

if (command === "create") {
  const repo = arg("--repo");
  const dest = arg("--dest");
  const branch = arg("--branch");
  const commit = arg("--commit");
  if (process.env.GION_STANDIN_LINK === "1") {
    const git = spawnSync(
      "git",
      ["-C", repo, "worktree", "add", "--no-track", "-b", branch, "--", dest, commit],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    if (git.status !== 0) {
      process.stderr.write(git.stderr ?? "");
      process.exit(git.status ?? 1);
    }
  } else {
    mkdirSync(dest, { recursive: true });
  }
  const marker = join(dest, MARKER);
  writeFileSync(marker, `${JSON.stringify({ repo, branch, commit })}\n`);
  if (process.env.GION_STANDIN_FAIL === "nomarker") {
    rmSync(marker);
    process.stderr.write("stopped\n");
    process.exit(1);
  }
  if (process.env.GION_STANDIN_FAIL === "1") {
    process.stderr.write("ghp_EXAMPLETOKEN1234567890\n");
    process.exit(1);
  }
  process.exit(0);
}

if (command === "read") {
  const dest = arg("--dest");
  const relative = arg("--path");
  if (refusedPath(relative)) {
    process.stderr.write("refusing that path\n");
    process.exit(2);
  }
  const record = markerAt(dest);
  const file = resolve(record.repo, relative);
  if (!inside(record.repo, file)) {
    process.stderr.write("refusing that path\n");
    process.exit(2);
  }
  process.stdout.write(readFileSync(file));
  process.exit(0);
}

if (command === "status") {
  const dest = arg("--dest");
  process.stdout.write(existsSync(join(dest, ".gion-dirty")) ? "dirty\n" : "clean\n");
  process.exit(0);
}

if (command === "remove") {
  const dest = arg("--dest");
  const marker = join(dest, MARKER);
  if (!existsSync(marker)) {
    process.stderr.write("no checkout record\n");
    process.exit(2);
  }
  const record = markerAt(dest);
  if (resolve(dest) === resolve(record.repo)) {
    process.stderr.write("refusing the main checkout\n");
    process.exit(2);
  }
  rmSync(dest, { recursive: true, force: true });
  process.exit(0);
}

process.stderr.write("unknown command\n");
process.exit(2);
