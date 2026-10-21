// The stub's invented projects can point at throwaway repos instead of /Users/example (so a dev slot's coding-team
// chat has a real folder to start in). node --test scripts/hub-stub-server.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { seedState, throwawayProjects } from "./hub-stub-server.mjs";

test("each invented project gets its own throwaway git repo under the root, with no remote, made once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stub-projects-"));
  const projects = throwawayProjects(seedState().projects, root);
  for (const p of projects) {
    assert.equal(p.folder, path.join(root, p.id));
    assert.ok(fs.existsSync(path.join(p.folder, "README.md")));
    assert.equal(execFileSync("git", ["remote"], { cwd: p.folder, encoding: "utf8" }).trim(), "");
    assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: p.folder, encoding: "utf8" }).trim(), "1");
  }
  fs.writeFileSync(path.join(projects[0].folder, "work.txt"), "kept");
  throwawayProjects(seedState().projects, root);
  assert.equal(fs.readFileSync(path.join(projects[0].folder, "work.txt"), "utf8"), "kept");
});

test("without a root the invented projects keep their example paths", () => {
  assert.ok(seedState().projects.every((p) => p.folder.startsWith("/Users/example/")));
});
