import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLsRemote, newTags, parseArgs } from "./upstream-watch.mjs";

test("parseLsRemote reads the default branch, head and peeled tags", () => {
  const out = parseLsRemote(
    "ref: refs/heads/main\tHEAD\naaa\tHEAD\nt1\trefs/tags/v1.0\nc1\trefs/tags/v1.0^{}\nt2\trefs/tags/v0.9\n",
  );
  assert.equal(out.branch, "main");
  assert.equal(out.head, "aaa");
  assert.deepEqual(out.tags, { "v1.0": "c1", "v0.9": "t2" });
});

test("newTags lists only tags not seen before, newest first", () => {
  assert.deepEqual(newTags({ "v1.2": "x" }, { "v1.2": "x", "v1.10": "y", "v1.3": "z" }), ["v1.10", "v1.3"]);
});

test("parseArgs needs a state file", () => {
  assert.throws(() => parseArgs([]), /--state/);
  assert.equal(parseArgs(["--state", "s.json", "--write"]).write, true);
});

test("the watch list names each repo once and always keeps upstream MonoCode", () => {
  const { repos } = JSON.parse(readFileSync(new URL("../docs/hivra/upstream-watch.json", import.meta.url), "utf8"));
  const keys = repos.map((r) => (r.repo + (r.path ? "/" + r.path : "")).toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(repos.some((r) => r.repo === "hardbeat920/monocode" && r.group === "upstream"));
  for (const r of repos) assert.match(r.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
});
