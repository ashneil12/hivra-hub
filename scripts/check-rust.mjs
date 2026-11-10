#!/usr/bin/env node
// `npm run check:rust`: cargo fmt, clippy and test, with the Rust build output in the shared cache that hub:dev and
// hub:build already use (~/Library/Caches/monocode-hub/cargo-build), not in this worktree's own target/. A worktree
// that ran its checks used to keep 9-12 GB of build output each; with the shared cache it keeps almost nothing and
// the dependencies are built once for every worktree. Two checks at once wait for each other on cargo's lock.
//
// CI runs the same tests through cargo-nextest (WP-173). This script stays on `cargo test`, so it works where nextest
// is not installed.
//
// Refuses to start under the disk floor (scripts/disk-guard.mjs). CI is left as it was (its own target/).
// MONOCODE_OWN_TARGET=1 keeps the build output in this worktree for a run.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { check } from "./disk-guard.mjs";
import { SHARED_BUILD_DIR } from "./hub-dev.mjs";

export { SHARED_BUILD_DIR };
export const STEPS = [
  ["cargo", ["fmt", "--check"]],
  ["cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]],
  ["cargo", ["test"]],
];

/** The environment the cargo steps run with. */
export function cargoEnv(env = process.env, home = os.homedir()) {
  const next = { ...env };
  if (env.CI || env.MONOCODE_OWN_TARGET === "1" || env.CARGO_BUILD_BUILD_DIR) return next;
  next.CARGO_BUILD_BUILD_DIR = path.join(home, SHARED_BUILD_DIR);
  return next;
}

function main() {
  const room = check("check:rust");
  if (!room.ok) {
    console.error(room.message);
    process.exit(75);
  }
  const env = cargoEnv();
  for (const [command, args] of STEPS) {
    const run = spawnSync(command, args, { stdio: "inherit", env });
    if (run.error) throw run.error;
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
