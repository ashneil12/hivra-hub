// WP-173: `npm run check:rust` stays on cargo test, so a machine without nextest can run it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STEPS } from "./check-rust.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("check:rust runs cargo fmt, clippy and cargo test, and does not call nextest", () => {
  assert.deepEqual(STEPS, [
    ["cargo", ["fmt", "--check"]],
    ["cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]],
    ["cargo", ["test"]],
  ]);
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:rust"], "node scripts/check-rust.mjs");
  assert.doesNotMatch(readFileSync(path.join(repo, "scripts", "check-rust.mjs"), "utf8"), /nextest run/);
});
