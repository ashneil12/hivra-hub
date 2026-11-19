import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLsRemote, newTags, parseArgs, digest } from "./upstream-watch.mjs";

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

const fake = (over) => ({ ok: true, group: "x", why: "w", commits: [], newTags: [], branch: "main", firstSeen: false, ...over });

test("the digest lists the tools we run first, under their own heading", () => {
  const text = digest([
    fake({ name: "Idea", repo: "a/idea", commits: [{ date: "2026-11-01", sha: "abc", subject: "s" }] }),
    fake({ name: "Tool", repo: "a/tool", integrated: "tool", newTags: ["v2"] }),
    fake({ name: "Quiet tool", repo: "a/quiet", integrated: "quiet" }),
  ]);
  assert.ok(text.indexOf("## Tools we run") < text.indexOf("### Tool (a/tool)"));
  assert.ok(text.indexOf("### Tool (a/tool)") < text.indexOf("## Other repos we watch"));
  assert.ok(text.indexOf("## Other repos we watch") < text.indexOf("## Idea (a/idea)"));
  assert.match(text, /Quiet: Quiet tool\./);
  assert.doesNotMatch(digest([fake({ name: "Idea", repo: "a/idea", newTags: ["v1"] })]), /Tools we run/);
});

test("every integrated id in the watch list is a tool in proof-tools.json", () => {
  const { repos } = JSON.parse(readFileSync(new URL("../docs/hivra/upstream-watch.json", import.meta.url), "utf8"));
  const ids = new Set(JSON.parse(readFileSync(new URL("../docs/hivra/proof-tools.json", import.meta.url), "utf8")).tools.map((t) => t.id));
  const named = repos.filter((r) => r.integrated);
  assert.ok(named.length >= 6);
  for (const r of named) assert.ok(ids.has(r.integrated), `${r.repo} names unknown tool ${r.integrated}`);
  for (const id of ids) assert.ok(named.some((r) => r.integrated === id), `${id} is not watched`);
});
