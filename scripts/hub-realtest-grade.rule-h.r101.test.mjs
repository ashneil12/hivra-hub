// r101 (7): our bench grader agrees with rule (h): a count line that leaves out an empty "running" bucket is not marked
// down. (frank's scorecard is untouched; this is the bench's own grader and the B5 scenario's criteria.)
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { SYSTEM } from "./hub-realtest-grade.mjs";

test("the grader is told an empty bucket may be left out", () => {
  assert.match(SYSTEM, /never mark a run down for omitting "running"/);
});

test("B5's criteria no longer ask for a running or lost count", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../tests/realtest/scenarios/b5-restart-blind.json", import.meta.url), "utf8"));
  const b5 = (Array.isArray(raw) ? raw : raw.scenarios).find((s) => s.id === "b5-dump-restart-blind");
  assert.doesNotMatch(b5.criteria, /done, running, waiting and lost/);
  assert.match(b5.criteria, /an empty bucket is left out/);
  assert.match(b5.criteria, /nothing may be lost/);
});
