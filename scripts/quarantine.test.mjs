import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { expiredEntries, isQuarantined, loadQuarantine, run, validateQuarantine, DEFAULT_FILE } from "./quarantine.mjs";

const entry = (over = {}) => ({
  id: "q1",
  file: "src/a.test.ts",
  reason: "FLAKY-TESTS.md line 3",
  owner: "ash",
  added: "2026-11-01",
  expires: "2026-12-01",
  ...over,
});

test("the shipped list is valid and empty", () => {
  const { data, error } = loadQuarantine(DEFAULT_FILE);
  assert.equal(error, null);
  assert.deepEqual(validateQuarantine(data), []);
  assert.equal(data.tests.length, 0);
});

test("shape problems are named", () => {
  assert.deepEqual(validateQuarantine({ tests: [entry()] }), []);
  assert.match(validateQuarantine([])[0], /object/);
  assert.match(validateQuarantine({})[0], /list/);
  const bad = validateQuarantine({ tests: [entry({ owner: "", expires: "tomorrow" })] });
  assert.ok(bad.some((p) => /owner/.test(p)));
  assert.ok(bad.some((p) => /YYYY-MM-DD/.test(p)));
  assert.ok(validateQuarantine({ tests: [entry(), entry()] }).some((p) => /repeats/.test(p)));
  assert.ok(validateQuarantine({ tests: [entry({ expires: "2026-10-01" })] }).some((p) => /before it was added/.test(p)));
});

test("an entry is expired only after its end date", () => {
  const data = { tests: [entry({ expires: "2026-11-13" }), entry({ id: "q2", expires: "2026-11-12" })] };
  assert.deepEqual(expiredEntries(data, "2026-11-13").map((e) => e.id), ["q2"]);
  assert.equal(isQuarantined(data, "src/a.test.ts", "2026-11-13"), true);
  assert.equal(isQuarantined({ tests: [entry({ expires: "2026-11-12" })] }, "src/a.test.ts", "2026-11-13"), false);
  assert.equal(isQuarantined(data, "other.test.ts", "2026-11-13"), false);
});

test("report mode exits 0 on an expired entry, strict exits 1", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "quarantine-"));
  try {
    const file = path.join(dir, "q.json");
    writeFileSync(file, JSON.stringify({ tests: [entry({ expires: "2026-11-02" })] }));
    const env = {};
    assert.equal(run(["--file", file, "--today", "2026-11-13"], env), 0);
    assert.equal(run(["--file", file, "--today", "2026-11-13", "--strict"], env), 1);
    assert.equal(run(["--file", file, "--today", "2026-11-01", "--strict"], env), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
