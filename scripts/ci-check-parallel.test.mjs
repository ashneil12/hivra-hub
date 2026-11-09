// WP-154: on the one macOS check job, the web half and the Rust half run together.
// A failure in one half must still let the other finish, and the logs stay in
// named groups instead of mixing line by line. Linux and Windows stay split.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CHECK_GROUPS, runGroups, spawnCaptured } from "./ci-check-parallel.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ci = readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");

function jobBlock(name) {
  const marker = `\n  ${name}:\n`;
  const start = ci.indexOf(marker);
  assert.notEqual(start, -1, name);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function ok(command) {
  return { status: 0, stdout: `${command[0]} ok\n`, stderr: "" };
}

test("the two halves are the web commands and the rust commands, in order", () => {
  assert.deepEqual(
    CHECK_GROUPS.map((group) => group.name),
    ["Web checks", "Rust checks"],
  );
  assert.deepEqual(CHECK_GROUPS[0].commands, [
    ["npm", "test"],
    ["npx", "tsc", "--noEmit"],
  ]);
  assert.deepEqual(CHECK_GROUPS[1].commands, [
    ["cargo", "fmt", "--check"],
    ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
    ["cargo", "check"],
    ["cargo", "test"],
  ]);
});

test("both halves pass, and a warning on stderr is not a failure", async () => {
  const logs = [];
  const result = await runGroups(CHECK_GROUPS, {
    spawn: async (command) => ({ status: 0, stdout: `${command[0]} ok\n`, stderr: "warning: unused\n" }),
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failed, []);
  const text = logs.join("\n");
  assert.match(text, /::group::Web checks[\s\S]*::endgroup::/);
  assert.match(text, /::group::Rust checks[\s\S]*::endgroup::/);
  assert.match(text, /warning: unused/);
  assert.doesNotMatch(text, /^Failed:/m);
});

test("a web failure still runs the rust half, and does not run the later web command", async () => {
  const seen = [];
  let releaseRust;
  const rustGate = new Promise((resolve) => {
    releaseRust = resolve;
  });
  const pending = runGroups(CHECK_GROUPS, {
    spawn: (command) => {
      seen.push(command[0]);
      if (command[0] === "npm") return Promise.resolve({ status: 2, stdout: "", stderr: "web broke\n" });
      if (command[0] === "cargo" && command[1] === "fmt") return rustGate.then(() => ok(command));
      return Promise.resolve(ok(command));
    },
    log: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(seen.includes("npm"));
  assert.ok(seen.includes("cargo"), "rust started while the web half had already failed");
  assert.ok(!seen.includes("npx"));
  releaseRust();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["Web checks"]);
  assert.ok(seen.filter((name) => name === "cargo").length >= 4);
});

test("a rust failure still runs both web commands, and stops the rest of rust", async () => {
  const seen = [];
  const logs = [];
  const result = await runGroups(CHECK_GROUPS, {
    spawn: (command) => {
      seen.push(command.join(" "));
      if (command[1] === "fmt") return Promise.resolve({ status: 1, stdout: "", stderr: "fmt broke\n" });
      return Promise.resolve(ok(command));
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["Rust checks"]);
  assert.ok(seen.includes("npm test"));
  assert.ok(seen.includes("npx tsc --noEmit"));
  assert.ok(seen.includes("cargo fmt --check"));
  assert.ok(!seen.some((line) => line.startsWith("cargo clippy")));
  const text = logs.join("\n");
  assert.match(text, /fmt broke/);
  assert.match(text, /npm ok/);
  assert.match(text, /Failed: Rust checks/);
});

test("both halves failing is a failure, and a thrown command is a failure too", async () => {
  const both = await runGroups(CHECK_GROUPS, {
    spawn: (command) => Promise.resolve({ status: command[0] === "npm" || command[0] === "cargo" ? 1 : 0, stdout: "", stderr: "" }),
    log: () => {},
  });
  assert.equal(both.ok, false);
  assert.deepEqual(both.failed, ["Web checks", "Rust checks"]);

  const logs = [];
  const thrown = await runGroups(CHECK_GROUPS, {
    spawn: (command) => {
      if (command[0] === "npm") return Promise.reject(new Error("npm missing"));
      return Promise.resolve(ok(command));
    },
    log: (line) => logs.push(line),
  });
  assert.equal(thrown.ok, false);
  assert.deepEqual(thrown.failed, ["Web checks"]);
  assert.match(logs.join("\n"), /npm missing/);
  assert.match(logs.join("\n"), /::group::Rust checks/);
});

test("a missing status is a failure, and an empty group does not run a command", async () => {
  const bad = await runGroups([{ name: "Web checks", commands: [["npm", "test"]] }], {
    spawn: () => Promise.resolve({ status: null, stdout: "", stderr: "" }),
    log: () => {},
  });
  assert.equal(bad.ok, false);
  const calls = [];
  const empty = await runGroups([{ name: "Empty", commands: [] }], {
    spawn: () => {
      calls.push("ran");
      return Promise.resolve(ok(["x"]));
    },
    log: () => {},
  });
  assert.equal(empty.ok, true);
  assert.deepEqual(calls, []);
});

test("a half that finishes first prints its own group before the slow half", async () => {
  let releaseWeb;
  const webGate = new Promise((resolve) => {
    releaseWeb = resolve;
  });
  const logs = [];
  const pending = runGroups(
    [
      { name: "Web checks", commands: [["npm", "test"]] },
      { name: "Rust checks", commands: [["cargo", "fmt", "--check"]] },
    ],
    {
      spawn: (command) => {
        if (command[0] === "npm") return webGate.then(() => ({ status: 0, stdout: "web done\n", stderr: "" }));
        return Promise.resolve({ status: 0, stdout: "rust done\n", stderr: "" });
      },
      log: (line) => logs.push(line),
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(logs.join("\n"), /::group::Rust checks[\s\S]*rust done[\s\S]*::endgroup::/);
  assert.doesNotMatch(logs.join("\n"), /web done/);
  releaseWeb();
  const result = await pending;
  assert.equal(result.ok, true);
  const text = logs.join("\n");
  assert.ok(text.indexOf("rust done") < text.indexOf("web done"));
  assert.match(text, /::group::Web checks[\s\S]*web done[\s\S]*::endgroup::/);
});

test("spawnCaptured keeps stdout, stderr and the status, including a missing program", async () => {
  const okResult = await spawnCaptured([
    process.execPath,
    "-e",
    "process.stdout.write('out'); process.stderr.write('err')",
  ]);
  assert.equal(okResult.status, 0);
  assert.equal(okResult.stdout, "out");
  assert.equal(okResult.stderr, "err");

  const failed = await spawnCaptured([process.execPath, "-e", "process.exit(4)"]);
  assert.equal(failed.status, 4);

  const missing = await spawnCaptured(["ci-check-parallel-not-a-program"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT|spawn/i);
});

test("macOS stays one check job and runs the two halves together", () => {
  const check = jobBlock("check");
  assert.equal((check.match(/macos-latest/g) || []).length, 1);
  assert.match(check, /node scripts\/ci-check-parallel\.mjs/);
  assert.match(check, /if: matrix\.part == 'all'/);
  assert.match(check, /run: npm test[\s\S]*?\n {8}if: matrix\.part == 'web'/);
  assert.match(check, /run: cargo test\n {8}if: matrix\.part == 'rust'/);
  assert.match(check, /--shard=\{0\}/);
  assert.match(check, /dtolnay\/rust-toolchain@stable[\s\S]*if: matrix\.part != 'web'/);
  assert.doesNotMatch(check, /matrix\.part != 'rust'/);
  for (const job of ["browser", "host", "ship"]) assert.doesNotMatch(jobBlock(job), /ci-check-parallel/);
});
