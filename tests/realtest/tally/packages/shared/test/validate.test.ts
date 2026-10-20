import { test } from "node:test";
import assert from "node:assert/strict";

import { checkBump, checkName, checkOwner } from "../src/validate.ts";

test("names are trimmed and 1-40 characters", () => {
  assert.deepEqual(checkName("  water "), { ok: true, value: "water" });
  assert.equal(checkName("").ok, false);
  assert.equal(checkName("x".repeat(41)).ok, false);
});

test("owners are lowercase handles", () => {
  assert.equal(checkOwner("ash").ok, true);
  assert.equal(checkOwner("Ash").ok, false);
});

test("a bump defaults to 1 and stays within 1-100", () => {
  assert.deepEqual(checkBump(undefined), { ok: true, value: 1 });
  assert.equal(checkBump(0).ok, false);
  assert.equal(checkBump(2.5).ok, false);
  assert.deepEqual(checkBump(3), { ok: true, value: 3 });
});
