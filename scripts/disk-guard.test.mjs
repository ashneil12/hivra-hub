// The disk floor (scripts/disk-guard.mjs) and the shared Rust build folder for check:rust (scripts/check-rust.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cargoEnv, SHARED_BUILD_DIR } from "./check-rust.mjs";
import { check, DEFAULT_FLOOR_GB, EXIT_NO_ROOM, floorGb } from "./disk-guard.mjs";

const GB = 1024 ** 3;
const here = path.dirname(fileURLToPath(import.meta.url));

test("the default floor is 30 GB: 29 GB free stops a build, 31 GB lets it start", () => {
  assert.equal(DEFAULT_FLOOR_GB, 30);
  const low = check("check:rust", { env: {}, free: () => 29 * GB });
  assert.equal(low.ok, false);
  assert.match(low.message, /check:rust: not started, 29\.0 GB free is under the 30 GB floor/);
  assert.match(low.message, /npm run hub:clean/);
  assert.equal(check("check:rust", { env: {}, free: () => 31 * GB }).ok, true);
});

test("MONOCODE_DISK_FLOOR_GB sets the floor, 0 turns it off, nonsense keeps the default", () => {
  assert.equal(floorGb({ MONOCODE_DISK_FLOOR_GB: "50" }), 50);
  assert.equal(check("x", { env: { MONOCODE_DISK_FLOOR_GB: "50" }, free: () => 40 * GB }).ok, false);
  assert.equal(check("x", { env: { MONOCODE_DISK_FLOOR_GB: "0" }, free: () => 1 }).ok, true);
  for (const raw of ["", "-3", "lots"]) assert.equal(floorGb({ MONOCODE_DISK_FLOOR_GB: raw }), DEFAULT_FLOOR_GB);
});

test("a volume that can't be read does not stop work", () => {
  const result = check("x", { env: {}, free: () => { throw new Error("EIO"); } });
  assert.equal(result.ok, true);
});

test("the guard exits 75 with the message when the floor is above the free space", () => {
  const run = spawnSync(process.execPath, [path.join(here, "disk-guard.mjs"), "hub:build"], {
    env: { ...process.env, MONOCODE_DISK_FLOOR_GB: "1000000" },
    encoding: "utf8",
  });
  assert.equal(run.status, EXIT_NO_ROOM);
  assert.match(run.stderr, /hub:build: not started/);
  const ok = spawnSync(process.execPath, [path.join(here, "disk-guard.mjs"), "hub:build"], {
    env: { ...process.env, MONOCODE_DISK_FLOOR_GB: "0" },
  });
  assert.equal(ok.status, 0);
});

test("check:rust builds into the shared cache, except in CI, on request, or when one is already set", () => {
  assert.equal(cargoEnv({}, "/Users/x").CARGO_BUILD_BUILD_DIR, path.join("/Users/x", SHARED_BUILD_DIR));
  assert.equal(SHARED_BUILD_DIR, "Library/Caches/monocode-hub/cargo-build", "the same folder hub:dev and hub:build use");
  assert.equal(cargoEnv({ CI: "true" }, "/Users/x").CARGO_BUILD_BUILD_DIR, undefined);
  assert.equal(cargoEnv({ MONOCODE_OWN_TARGET: "1" }, "/Users/x").CARGO_BUILD_BUILD_DIR, undefined);
  assert.equal(cargoEnv({ CARGO_BUILD_BUILD_DIR: "/elsewhere" }, "/Users/x").CARGO_BUILD_BUILD_DIR, "/elsewhere");
});
