// The version lives in several files. Cargo.lock carries it once for every workspace crate that inherits the
// workspace version (the app, and since WP-131b the dictation helper). One left behind makes the next cargo command
// rewrite Cargo.lock, which leaves the tree dirty, and a dirty tree stops a ship.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(file, at = root) {
  return fs.readFileSync(path.join(at, file), "utf8");
}

/** The workspace crates whose version is the workspace's: their folder and package name. */
function inheritingCrates(at = root) {
  const members = /^members\s*=\s*\[([^\]]*)\]/m.exec(read("Cargo.toml", at))[1];
  return [...members.matchAll(/"([^"]+)"/g)]
    .map(([, member]) => ({ member, manifest: read(path.join(member, "Cargo.toml"), at) }))
    .filter(({ manifest }) => /^version\.workspace\s*=\s*true/m.test(manifest))
    .map(({ member, manifest }) => ({ member, name: /^name\s*=\s*"([^"]+)"/m.exec(manifest)[1] }));
}

function lockedVersion(lock, name) {
  return new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(lock)?.[1] ?? null;
}

test("Cargo.lock names the workspace version for every crate that inherits it", () => {
  const version = /\[workspace\.package\][^[]*?^version = "([^"]+)"/ms.exec(read("Cargo.toml"))[1];
  const crates = inheritingCrates();
  assert.ok(crates.some(({ name }) => name === "monocode-dictation"), JSON.stringify(crates));
  const lock = read("Cargo.lock");
  for (const { name } of crates) assert.equal(lockedVersion(lock, name), version, name);
});

test("set-version moves every inheriting crate in Cargo.lock, and leaves the others alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-"));
  try {
    const files = ["package.json", "package-lock.json", "Cargo.toml", "Cargo.lock", "src-tauri/tauri.conf.json", "scripts/bump-version.mjs"];
    const members = [...(/^members\s*=\s*\[([^\]]*)\]/m.exec(read("Cargo.toml"))[1]).matchAll(/"([^"]+)"/g)].map(([, m]) => m);
    for (const file of [...files, ...members.map((member) => path.join(member, "Cargo.toml"))]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    const result = spawnSync(process.execPath, [path.join(dir, "scripts/bump-version.mjs"), "98.7.6"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lock = read("Cargo.lock", dir);
    for (const { name } of inheritingCrates(dir)) assert.equal(lockedVersion(lock, name), "98.7.6", name);
    assert.equal(lockedVersion(lock, "monocode-mobile-link"), lockedVersion(read("Cargo.lock"), "monocode-mobile-link"));
    assert.match(read("Cargo.toml", dir), /^version = "98\.7\.6"/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
