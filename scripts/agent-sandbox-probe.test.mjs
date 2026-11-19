// WP-178: the platform measurement for the agent OS sandbox. On macOS it runs the probes under a temporary HOME and
// checks the denylist results. Elsewhere it skips, because the other platforms are not measured yet (design doc).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, "agent-sandbox-probe.mjs");

test("macOS denylist probes: secrets and git hooks refused, known gaps allowed", { skip: process.platform !== "darwin" && "measured on macOS only" }, () => {
  const out = JSON.parse(execFileSync(process.execPath, [probe, "--runs", "3"], { encoding: "utf8" }));
  assert.equal(out.platform, "darwin");

  // The probe runs under its own temporary HOME, never the real one.
  assert.ok(out.home.startsWith(fs.realpathSync(os.tmpdir())), `home ${out.home} is not under the temp dir`);
  assert.notEqual(out.home, fs.realpathSync(os.homedir()));

  const byId = Object.fromEntries(out.probes.map((p) => [p.id, p]));
  assert.equal(byId["read-ssh-key"].outcome, "refused");
  assert.equal(byId["read-zshrc"].outcome, "refused");
  assert.equal(byId["write-git-hooks"].outcome, "refused");
  assert.equal(byId["write-git-config"].outcome, "refused");
  // Known gaps of a denylist: a file outside the list is readable, and writes inside the project are allowed.
  assert.equal(byId["read-outside-list"].outcome, "allowed");
  assert.equal(byId["write-project-src"].outcome, "allowed");
  assert.equal(byId["read-project-readme"].outcome, "allowed");

  // Startup cost: every timed run must succeed, otherwise the number measures a failure.
  assert.equal(out.timing.plain.okRuns, 3);
  assert.equal(out.timing.denylist.okRuns, 3);
  assert.ok(out.timing.denylist.medianMs > 0);

  // The allowlist (deny-default) is recorded as not measured, with the reason, until it starts a binary.
  assert.equal(out.allowlist.status, "not-measured");
  assert.ok(out.allowlist.reason.length > 0);
});

test("probe script is read-only for the real home and prints one JSON document", { skip: process.platform !== "darwin" && "measured on macOS only" }, () => {
  const stdout = execFileSync(process.execPath, [probe, "--runs", "1"], { encoding: "utf8" });
  assert.doesNotThrow(() => JSON.parse(stdout));
});
