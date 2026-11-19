// WP-173: the CI nextest profile retries once, stops a hung test, and writes JUnit.
// The default profile is not changed, so a local `cargo nextest run` does not retry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(repo, ".config", "nextest.toml");

function text() {
  return readFileSync(file, "utf8");
}

test("the ci profile retries once, passes a flaky result, and does not stop at the first failure", () => {
  const toml = text();
  assert.match(toml, /^\[profile\.ci\]\s*$/m);
  assert.match(toml, /^retries = 1$/m);
  assert.match(toml, /^flaky-result = "pass"$/m);
  assert.match(toml, /^fail-fast = false$/m);
  assert.equal((toml.match(/^retries = /gm) || []).length, 1);
  assert.doesNotMatch(toml, /^\[profile\.default\]/m);
});

test("a hung test is stopped after three 60 second periods, and JUnit goes to the ci report path", () => {
  const toml = text();
  assert.match(toml, /^slow-timeout = \{ period = "60s", terminate-after = 3 \}$/m);
  assert.match(toml, /^\[profile\.ci\.junit\]\s*$/m);
  assert.match(toml, /^path = "target\/nextest\/ci\/junit\.xml"$/m);
});

test("each ci value has a comment saying why it is set", () => {
  const toml = text();
  const lines = toml.split(/\r?\n/);
  const keys = ["retries = 1", 'flaky-result = "pass"', "fail-fast = false", "slow-timeout = ", "path = "];
  for (const key of keys) {
    const at = lines.findIndex((line) => line.startsWith(key));
    assert.ok(at > 0, key);
    assert.match(lines[at - 1], /^# \S/, `${key} needs a comment on the line above`);
  }
});
