import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareVersions, drift, latestVersion, outdated, pinnedVersion, readList, renderOutdated, run, validate } from "./proof-tools.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const list = readList(repo);

test("the real list is valid and matches what the repo pins", () => {
  assert.deepEqual(validate(list, repo), []);
  assert.deepEqual(drift(list, repo), []);
  for (const id of ["fast-check", "proptest", "ast-grep", "stryker-js", "cargo-mutants", "playwright"]) {
    assert.ok(list.tools.some((tool) => tool.id === id), `${id} is listed`);
  }
});

test("the pinned versions are the ones package.json, the CI file and the scripts name", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  const byId = Object.fromEntries(list.tools.map((tool) => [tool.id, tool]));
  assert.equal(pkg.devDependencies["@ast-grep/cli"], byId["ast-grep"].version);
  assert.equal(pinnedVersion(byId["cargo-mutants"], repo), "27.1.0");
  assert.equal(pinnedVersion(byId["stryker-js"], repo), byId["stryker-js"].version);
});

test("a bad list is described in plain sentences", () => {
  const bad = { tools: [{ id: "x", use: "magic", repo: "nope", since: "yesterday", version: "1", where: ["missing.txt"] }, { id: "x" }] };
  const text = validate(bad, repo).join("\n");
  assert.match(text, /x: no name/);
  assert.match(text, /use must be one of/);
  assert.match(text, /repo is not owner\/name/);
  assert.match(text, /since is not YYYY-MM-DD/);
  assert.match(text, /missing\.txt does not exist/);
  assert.match(text, /listed twice/);
});

test("drift names the tool whose version moved", () => {
  const moved = { tools: [{ ...list.tools[0], version: "0.0.1" }] };
  assert.match(drift(moved, repo)[0], /fast-check: list says 0\.0\.1, the repo pins 4\./);
});

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
});

test("--outdated says which tools are behind, and survives a dead network", async () => {
  const answers = { "https://registry.npmjs.org/fast-check/latest": { version: "9.0.0" } };
  const fake = async (url) => (url in answers ? { ok: true, json: async () => answers[url] } : { ok: false });
  const rows = await outdated({ tools: list.tools.slice(0, 2) }, fake);
  const text = renderOutdated(rows);
  assert.match(text, /^Tools we run:/);
  assert.match(text, /fast-check: behind\. We run 4\.10\.2, latest is 9\.0\.0/);
  assert.match(text, /proptest: could not check/);
  const down = async () => {
    throw new Error("offline");
  };
  assert.match(renderOutdated(await outdated(list, down)), /could not check/);
  assert.equal(await latestVersion("npm:x", down).catch(() => "threw"), "threw");
  assert.equal(await run(["--outdated"], repo, down), 0);
});

test("the mutants job in ci.yml runs only on a manual run, cannot block, has a timeout and keeps its output", () => {
  const ci = readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8");
  const start = ci.indexOf("\n  mutants:\n");
  assert.notEqual(start, -1);
  const block = ci.slice(start + 1, ci.indexOf("\n  appimage:\n"));
  assert.match(block, /if: github\.event_name != 'schedule' && github\.event_name == 'workflow_dispatch'/);
  assert.match(block, /continue-on-error: true/);
  assert.match(block, /timeout-minutes: \d+/);
  assert.match(block, /cargo-mutants@27\.1\.0/);
  assert.match(block, /node scripts\/mutants-in-diff\.mjs --run --base/);
  assert.match(block, /path: mutants\.out/);
  assert.match(ci, /mutants_base:/);
});
