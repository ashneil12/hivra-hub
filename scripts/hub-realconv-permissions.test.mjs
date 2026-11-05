// The bench's permission rule (scripts/realconv/permissions.mjs): a Read inside the run's temporary HOME, the
// test project, or that Mono's memory folder is allowed, and anything else is refused. Paths stay lexical.
import assert from "node:assert/strict";
import { test } from "node:test";

import os from "node:os";

import { permissionDecision, stuckPermissionOutcome, testerAllowRefused } from "./realconv/permissions.mjs";

const roots = {
  home: "/tmp/bench-home",
  project: "/tmp/bench-home/projects/tally",
  memory: "/tmp/bench-data/monos/tally-lead",
};

const decide = (ask, extra) => permissionDecision(ask, roots, extra);

test("a Read inside the temporary HOME, the project, or the Mono's memory is allowed", () => {
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/notes.txt"] }).decision, "allow");
  assert.equal(decide({ tool: "read", paths: ["/tmp/bench-home/projects/tally/src/app.js"] }).decision, "allow");
  assert.equal(decide({ tool: "READ", paths: ["/tmp/bench-data/monos/tally-lead/MEMORY.md"] }).decision, "allow");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home"] }).decision, "allow");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/my files/café.txt"] }).decision, "allow");
});

test("a Read outside those folders is refused, including a name that only starts like the root", () => {
  const outside = decide({ tool: "Read", paths: ["/etc/passwd"] });
  assert.equal(outside.decision, "refuse");
  assert.equal(outside.allow, false);
  assert.equal(outside.path, "/etc/passwd");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home-evil/secret"] }).decision, "refuse");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-data/monos/other/MEMORY.md"] }).decision, "refuse");
});

test(".. that stays inside is allowed, and .. that leaves is refused", () => {
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/a/../notes.txt"] }).decision, "allow");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/projects/tally/src/../../readme.md"] }).decision, "allow");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/../etc/passwd"] }).decision, "refuse");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/projects/tally/../../../outside"] }).decision, "refuse");
});

test("a relative path uses the chat's folder, and is refused when the chat has none", () => {
  assert.equal(decide({ tool: "Read", paths: ["src/app.js"] }, { cwd: "/tmp/bench-home/projects/tally" }).decision, "allow");
  assert.equal(decide({ tool: "Read", paths: ["../notes.txt"] }, { cwd: "/tmp/bench-home/projects/tally" }).decision, "allow");
  assert.equal(decide({ tool: "Read", paths: ["../../../../etc/passwd"] }, { cwd: "/tmp/bench-home/projects/tally" }).decision, "refuse");
  assert.equal(decide({ tool: "Read", paths: ["notes.txt"] }).decision, "refuse");
});

test("anything that is not a Read is refused, even inside, and so is a Read with a path outside among its files", () => {
  assert.equal(decide({ tool: "Bash", paths: ["/tmp/bench-home/notes.txt"], command: "cat notes.txt" }).decision, "refuse");
  assert.equal(decide({ tool: "Edit", paths: ["/tmp/bench-home/notes.txt"] }).decision, "refuse");
  assert.equal(decide({ tool: "Grep", paths: ["/tmp/bench-home"] }).decision, "refuse");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/notes.txt", "/etc/passwd"] }).decision, "refuse");
});

test("a missing path, a broken path, a Windows path, and a symlink-looking path are refused", () => {
  assert.deepEqual(decide({ tool: "Read", paths: [] }), { allow: false, decision: "refuse", path: "(no path)" });
  assert.equal(decide({ tool: "Read" }).path, "(no path)");
  assert.equal(decide({ tool: "Read", paths: [""], command: "cat /etc/passwd" }).path, "cat /etc/passwd");
  assert.equal(decide({ tool: "Read", paths: ["C:\\Windows\\note.txt"] }).decision, "refuse");
  assert.equal(decide({ tool: "Read", paths: ["C:/Windows/note.txt"] }).decision, "refuse");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/link -> /etc/passwd"] }).decision, "refuse");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/bad\npath"] }).decision, "refuse");
});

test("a symlink, or a symlink in a folder on the way, is refused without being followed", () => {
  const linked = new Set(["/tmp/bench-home/projects/tally/node_modules"]);
  const isSymlink = (abs) => linked.has(abs);
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/projects/tally/node_modules/pkg/index.js"] }, { isSymlink }).decision, "refuse");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/projects/tally/src/app.js"] }, { isSymlink }).decision, "allow");
  const fileLink = (abs) => abs === "/tmp/bench-home/notes.txt";
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/notes.txt"] }, { isSymlink: fileLink }).decision, "refuse");
  assert.equal(decide({ tool: "Read", paths: ["/tmp/bench-home/notes.txt"] }, { isSymlink: () => { throw new Error("lstat failed"); } }).decision, "refuse");
});

test("a root that is only / or /tmp does not allow every Read", () => {
  assert.equal(permissionDecision({ tool: "Read", paths: ["/etc/passwd"] }, { home: "/", project: "/tmp" }).decision, "refuse");
  assert.equal(permissionDecision({ tool: "Read", paths: ["/etc/passwd"] }, {}).decision, "refuse");
});

test("an ask still open at the end names its path, and is not a plain fail", () => {
  assert.equal(stuckPermissionOutcome([]), null);
  assert.equal(stuckPermissionOutcome(null), null);
  assert.equal(stuckPermissionOutcome([{ tool: "Read", paths: ["/etc/passwd"] }]), "stuck on a permission ask: /etc/passwd");
  assert.equal(stuckPermissionOutcome([{ command: "cat /etc/shadow" }]), "stuck on a permission ask: cat /etc/shadow");
  assert.equal(stuckPermissionOutcome([{}]), "stuck on a permission ask: (no path)");
});

test("the tester refuses Allow for the real user's agent-memory, and allows a Read inside the bench", () => {
  const file = `/Users/${os.userInfo().username}/agent-memory/ash/MEMORY.md`;
  const bench = { home: "/var/bench/home", project: "/var/bench/project" };
  assert.equal(testerAllowRefused("Allow", [{ tool: "Read", paths: [file] }], bench), file);
  assert.equal(testerAllowRefused("Allow once", [{ tool: "Bash", command: `cat ${file}` }], bench), file);
  assert.equal(testerAllowRefused("Always allow", [], bench), "(no path)");
  assert.equal(testerAllowRefused("Deny", [{ tool: "Read", paths: [file] }], bench), null);
  assert.equal(testerAllowRefused("Allow", [{ tool: "Read", paths: ["/var/bench/project/src/app.js"] }], bench), null);
});
