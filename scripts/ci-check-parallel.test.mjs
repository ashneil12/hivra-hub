// WP-154: on the one macOS check job, the web half and the Rust half run together.
// A failure in one half must still let the other finish. Each half streams its log
// line by line with a tag in front, so a job that times out still shows what each half
// had printed and which command it was in. Linux and Windows stay split.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CHECK_GROUPS, createLineSplitter, runGroups, spawnStreaming } from "./ci-check-parallel.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "scripts", "ci-check-parallel.mjs");
const ci = readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");

function jobBlock(name) {
  const marker = `\n  ${name}:\n`;
  const start = ci.indexOf(marker);
  assert.notEqual(start, -1, name);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the two halves are the web commands and the rust commands, in order, each with a tag", () => {
  assert.deepEqual(
    CHECK_GROUPS.map((group) => [group.name, group.tag]),
    [
      ["Web checks", "web"],
      ["Rust checks", "rust"],
    ],
  );
  assert.deepEqual(CHECK_GROUPS[0].commands, [
    ["npm", "test"],
    ["npx", "tsc", "--noEmit"],
  ]);
  assert.deepEqual(CHECK_GROUPS[1].commands, [
    ["cargo", "fmt", "--check"],
    ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
    ["cargo", "nextest", "run", "--workspace", "--profile", "ci"],
  ]);
});

test("both halves pass, every line carries its half's tag, and a warning is not a failure", async () => {
  const logs = [];
  const result = await runGroups(CHECK_GROUPS, {
    spawn: async (command, onLine) => {
      onLine(`${command[0]} ok`);
      onLine("warning: unused");
      return { status: 0 };
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failed, []);
  assert.ok(logs.includes("[web] $ npm test"));
  assert.ok(logs.includes("[web] npm ok"));
  assert.ok(logs.includes("[rust] $ cargo nextest run --workspace --profile ci"));
  assert.ok(logs.includes("[rust] warning: unused"));
  assert.ok(logs.includes("[web] Web checks: passed"));
  assert.ok(logs.includes("[rust] Rust checks: passed"));
  for (const line of logs) assert.match(line, /^\[(web|rust)\]( |$)/, `untagged line: ${line}`);
  assert.doesNotMatch(logs.join("\n"), /Failed:/);
});

test("log groups are not used, because two halves stream at once and groups cannot overlap", async () => {
  const logs = [];
  await runGroups(CHECK_GROUPS, { spawn: async () => ({ status: 0 }), log: (line) => logs.push(line) });
  assert.doesNotMatch(logs.join("\n"), /::(end)?group::/);
});

test("a line is logged while its command is still running, and the command line comes first", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const logs = [];
  const pending = runGroups([{ name: "Web checks", tag: "web", commands: [["npm", "test"]] }], {
    spawn: async (_command, onLine) => {
      onLine("started");
      await gate;
      onLine("finished");
      return { status: 0 };
    },
    log: (line) => logs.push(line),
  });
  await tick();
  assert.deepEqual(logs, ["[web] $ npm test", "[web] started"]);
  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(logs, ["[web] $ npm test", "[web] started", "[web] finished", "[web] Web checks: passed"]);
});

test("a half that never finishes still shows everything it printed, and the other half's result", async () => {
  const logs = [];
  void runGroups(CHECK_GROUPS, {
    spawn: (command, onLine) => {
      if (command[0] === "npm") {
        onLine("RUN v3 starting");
        onLine("hung test: src/slow.test.ts");
        return new Promise(() => {});
      }
      onLine(`${command[0]} ${command[1] ?? ""} ok`);
      return Promise.resolve({ status: 0 });
    },
    log: (line) => logs.push(line),
  });
  await tick();
  await tick();
  assert.ok(logs.includes("[web] $ npm test"));
  assert.ok(logs.includes("[web] hung test: src/slow.test.ts"));
  assert.ok(logs.includes("[rust] Rust checks: passed"));
  assert.ok(!logs.some((line) => line.includes("Web checks:")), "the hung half has no result yet");
});

test("a web failure still runs the rust half, and does not run the later web command", async () => {
  const seen = [];
  const logs = [];
  let releaseRust;
  const rustGate = new Promise((resolve) => {
    releaseRust = resolve;
  });
  const pending = runGroups(CHECK_GROUPS, {
    spawn: (command, onLine) => {
      seen.push(command[0]);
      if (command[0] === "npm") {
        onLine("web broke");
        return Promise.resolve({ status: 2 });
      }
      if (command[0] === "cargo" && command[1] === "fmt") return rustGate.then(() => ({ status: 0 }));
      return Promise.resolve({ status: 0 });
    },
    log: (line) => logs.push(line),
  });
  await tick();
  assert.ok(seen.includes("npm"));
  assert.ok(seen.includes("cargo"), "rust started while the web half had already failed");
  assert.ok(!seen.includes("npx"));
  releaseRust();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["Web checks"]);
  assert.equal(seen.filter((name) => name === "cargo").length, 3);
  assert.ok(logs.includes("[web] web broke"));
  assert.ok(logs.includes("[web] exited 2"));
  assert.ok(logs.includes("[web] Web checks: failed (exit 2)"));
  assert.equal(logs.at(-1), "Failed: Web checks");
});

test("a rust failure still runs both web commands, and stops the rest of rust", async () => {
  const seen = [];
  const logs = [];
  const result = await runGroups(CHECK_GROUPS, {
    spawn: (command, onLine) => {
      seen.push(command.join(" "));
      if (command[1] === "fmt") {
        onLine("fmt broke");
        return Promise.resolve({ status: 1 });
      }
      onLine(`${command[0]} ok`);
      return Promise.resolve({ status: 0 });
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["Rust checks"]);
  assert.ok(seen.includes("npm test"));
  assert.ok(seen.includes("npx tsc --noEmit"));
  assert.ok(seen.includes("cargo fmt --check"));
  assert.ok(!seen.some((line) => line.startsWith("cargo clippy")));
  assert.ok(logs.includes("[rust] fmt broke"));
  assert.ok(logs.includes("[web] npm ok"));
  assert.equal(logs.at(-1), "Failed: Rust checks");
});

test("both halves failing is a failure, and a thrown command is a failure too", async () => {
  const both = await runGroups(CHECK_GROUPS, {
    spawn: (command) => Promise.resolve({ status: command[0] === "npm" || command[0] === "cargo" ? 1 : 0 }),
    log: () => {},
  });
  assert.equal(both.ok, false);
  assert.deepEqual(both.failed, ["Web checks", "Rust checks"]);

  const logs = [];
  const thrown = await runGroups(CHECK_GROUPS, {
    spawn: (command) => {
      if (command[0] === "npm") return Promise.reject(new Error("npm missing"));
      return Promise.resolve({ status: 0 });
    },
    log: (line) => logs.push(line),
  });
  assert.equal(thrown.ok, false);
  assert.deepEqual(thrown.failed, ["Web checks"]);
  assert.ok(logs.includes("[web] npm missing"));
  assert.ok(logs.includes("[rust] Rust checks: passed"));
});

test("a missing status is a failure, and an empty group does not run a command", async () => {
  for (const outcome of [{ status: null }, {}, undefined]) {
    const bad = await runGroups([{ name: "Web checks", tag: "web", commands: [["npm", "test"]] }], {
      spawn: () => Promise.resolve(outcome),
      log: () => {},
    });
    assert.equal(bad.ok, false, JSON.stringify(outcome));
  }
  const calls = [];
  const empty = await runGroups([{ name: "Empty", tag: "empty", commands: [] }], {
    spawn: () => {
      calls.push("ran");
      return Promise.resolve({ status: 0 });
    },
    log: () => {},
  });
  assert.equal(empty.ok, true);
  assert.deepEqual(calls, []);
});

test("a half that finishes first reports itself before the slow half is done", async () => {
  let releaseWeb;
  const webGate = new Promise((resolve) => {
    releaseWeb = resolve;
  });
  const logs = [];
  const pending = runGroups(
    [
      { name: "Web checks", tag: "web", commands: [["npm", "test"]] },
      { name: "Rust checks", tag: "rust", commands: [["cargo", "fmt", "--check"]] },
    ],
    {
      spawn: (command, onLine) => {
        if (command[0] === "npm") {
          onLine("web working");
          return webGate.then(() => {
            onLine("web done");
            return { status: 0 };
          });
        }
        onLine("rust done");
        return Promise.resolve({ status: 0 });
      },
      log: (line) => logs.push(line),
    },
  );
  await tick();
  assert.ok(logs.includes("[rust] Rust checks: passed"));
  assert.ok(logs.includes("[web] web working"));
  assert.ok(!logs.includes("[web] web done"));
  releaseWeb();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.ok(logs.indexOf("[rust] rust done") < logs.indexOf("[web] web done"));
});

test("the line splitter joins a line split across chunks and handles LF, CRLF and a lone CR", () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.write("one\ntw");
  splitter.write("o\r\nthree\r");
  splitter.write("\nfour\rfive\n\nsix");
  assert.deepEqual(lines, ["one", "two", "three", "four", "five", ""]);
  assert.equal(splitter.pending(), "six");
  splitter.flush();
  assert.deepEqual(lines, ["one", "two", "three", "four", "five", "", "six"]);
  assert.equal(splitter.pending(), "");
  splitter.flush();
  assert.equal(lines.length, 7, "flushing nothing emits nothing");
});

test("the line splitter drops a line feed only when it completes a CRLF split across chunks", () => {
  const lines = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.write("a\r");
  splitter.write("b\n");
  splitter.write("\nc\n");
  assert.deepEqual(lines, ["a", "b", "", "c"]);
});

test("spawnStreaming streams stdout and stderr lines, and returns the status", async () => {
  const lines = [];
  const ok = await spawnStreaming(
    [process.execPath, "-e", "console.log('out one'); console.error('err one'); console.log('out two')"],
    (line) => lines.push(line),
  );
  assert.equal(ok.status, 0);
  assert.deepEqual([...lines].sort(), ["err one", "out one", "out two"]);

  const failed = await spawnStreaming([process.execPath, "-e", "process.exit(4)"], () => {});
  assert.equal(failed.status, 4);
});

test("spawnStreaming reports a missing program as a failure with a message", async () => {
  const lines = [];
  const missing = await spawnStreaming(["ci-check-parallel-not-a-program"], (line) => lines.push(line));
  assert.equal(missing.status, 1);
  assert.match(lines.join("\n"), /ENOENT|spawn/i);
});

/** A child that prints `first`, waits for a file to exist, then prints `second`. No timing guess. */
function gatedChild(gate, first, second) {
  const code = [
    "const fs = require('node:fs');",
    `process.stdout.write(${JSON.stringify(first)});`,
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); process.stdout.write(${JSON.stringify(second)}); } }, 10);`,
  ].join(" ");
  return [process.execPath, "-e", code];
}

async function waitForLine(lines, expected, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!lines.includes(expected)) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${JSON.stringify(expected)}; got ${JSON.stringify(lines)}`);
    await sleep(10);
  }
}

test("spawnStreaming gives a line to the log before the command exits", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-check-gate-"));
  const gate = path.join(dir, "go");
  try {
    const lines = [];
    const child = spawnStreaming(gatedChild(gate, "early\n", "late\n"), (line) => lines.push(line));
    await waitForLine(lines, "early");
    assert.deepEqual(lines, ["early"], "the command is still waiting for the gate, and its first line is already here");
    writeFileSync(gate, "");
    const result = await child;
    assert.equal(result.status, 0);
    assert.deepEqual(lines, ["early", "late"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnStreaming keeps a multibyte character that arrives in two chunks", async () => {
  const lines = [];
  await spawnStreaming(
    [
      process.execPath,
      "-e",
      "process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80, 0x0a])), 80)",
    ],
    (line) => lines.push(line),
  );
  assert.deepEqual(lines, ["\u{1F600}"]);
});

test("a half-written line is shown after a short quiet spell, so a hung test is named", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-check-gate-"));
  const gate = path.join(dir, "go");
  try {
    const lines = [];
    const child = spawnStreaming(gatedChild(gate, "test slow_one ... ", "ok\n"), (line) => lines.push(line), {
      idleFlushMs: 40,
    });
    await waitForLine(lines, "test slow_one ... ");
    assert.deepEqual(lines, ["test slow_one ... "], "shown while the command is still running");
    writeFileSync(gate, "");
    await child;
    assert.deepEqual(lines, ["test slow_one ... ", "ok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a last line with no newline is shown when the command ends", async () => {
  const lines = [];
  await spawnStreaming([process.execPath, "-e", "process.stdout.write('no newline')"], (line) => lines.push(line));
  assert.deepEqual(lines, ["no newline"]);
});

// The real script, with stand-ins for npm, npx and cargo on PATH. Each stand-in prints a line, waits for a
// file to appear, then finishes. That is the shape of the job: two halves at once, a hang, a timeout.
const posix = process.platform !== "win32";

function standIns() {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-check-parallel-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const body = [
    "#!/bin/sh",
    'tool=$(basename "$0")',
    'echo "$tool $* started"',
    'while [ ! -e "$FAKE_STOP" ]; do sleep 0.05; done',
    'case "$FAKE_FAIL" in *"$tool $1"*) echo "$tool $1 broke" >&2; exit 3;; esac',
    'echo "$tool $* finished"',
    "",
  ].join("\n");
  for (const name of ["npm", "npx", "cargo"]) {
    const file = path.join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  return { dir, bin, stop: path.join(dir, "stop") };
}

function startScript({ bin, stop }, extraEnv = {}) {
  const child = spawn(process.execPath, [script], {
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_STOP: stop, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const state = { out: "", err: "", child };
  child.stdout.on("data", (chunk) => {
    state.out += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    state.err += chunk.toString("utf8");
  });
  state.closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  return state;
}

function killGroup(run) {
  try {
    process.kill(-run.child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function waitFor(run, text, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!run.out.includes(text)) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${JSON.stringify(text)}; got:\n${run.out}\n${run.err}`);
    await sleep(20);
  }
}

test("the real script streams both halves while they run, and a killed job still shows them", { skip: !posix }, async () => {
  const world = standIns();
  const run = startScript(world);
  try {
    await waitFor(run, "[web] npm test started");
    await waitFor(run, "[rust] cargo fmt --check started");
    // Nothing has finished and both halves already printed. This is what a timeout would leave behind.
    assert.ok(run.out.includes("[web] $ npm test"));
    assert.ok(run.out.includes("[rust] $ cargo fmt --check"));
    assert.doesNotMatch(run.out, /finished/);
    killGroup(run);
    await run.closed;
    assert.ok(run.out.includes("[web] npm test started"));
    assert.ok(run.out.includes("[rust] cargo fmt --check started"));
  } finally {
    killGroup(run);
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test("the real script passes when both halves pass, with every line tagged", { skip: !posix }, async () => {
  const world = standIns();
  writeFileSync(world.stop, "");
  const run = startScript(world);
  try {
    const { code } = await run.closed;
    assert.equal(code, 0, `${run.out}\n${run.err}`);
    for (const line of run.out.trimEnd().split("\n")) assert.match(line, /^\[(web|rust)\]( |$)/, line);
    const web = run.out.split("\n").filter((line) => line.startsWith("[web] "));
    assert.ok(web.indexOf("[web] $ npm test") < web.indexOf("[web] $ npx tsc --noEmit"));
    assert.ok(run.out.includes("[rust] cargo nextest run --workspace --profile ci finished"));
    assert.ok(run.out.includes("[web] Web checks: passed"));
    assert.ok(run.out.includes("[rust] Rust checks: passed"));
    assert.doesNotMatch(run.out, /Failed:/);
  } finally {
    killGroup(run);
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test("the real script fails when one half fails, and the other half still finishes", { skip: !posix }, async () => {
  const world = standIns();
  writeFileSync(world.stop, "");
  const run = startScript(world, { FAKE_FAIL: "cargo fmt" });
  try {
    const { code } = await run.closed;
    assert.equal(code, 1, `${run.out}\n${run.err}`);
    assert.ok(run.out.includes("[rust] cargo fmt broke"));
    assert.ok(run.out.includes("[rust] exited 3"));
    assert.doesNotMatch(run.out, /\$ cargo clippy/);
    assert.ok(run.out.includes("[web] npx tsc --noEmit finished"));
    assert.ok(run.out.includes("[web] Web checks: passed"));
    assert.ok(run.out.trimEnd().endsWith("Failed: Rust checks"));
  } finally {
    killGroup(run);
    rmSync(world.dir, { recursive: true, force: true });
  }
});

test("PRs run every check half on Linux; macOS runs the Rust half in the pre-ship run, both halves when every OS runs", () => {
  const check = jobBlock("check");
  // The matrix is chosen by the repository variable HUB_CROSS_PLATFORM_CI, then by the event. A PR or a push runs the
  // web half on two Linux runners and the Rust half on a third; the pre-ship run (workflow_dispatch) runs the Rust
  // half on macOS; when the variable is "true", every OS runs and macOS runs both halves together.
  const include = /include: \$\{\{ fromJSON\(vars\.HUB_CROSS_PLATFORM_CI == 'true' && '(\[.*?\])' \|\| github\.event_name == 'workflow_dispatch' && '(\[.*?\])' \|\| '(\[.*?\])'\) \}\}/.exec(check);
  assert.ok(include, "the check matrix is not chosen by HUB_CROSS_PLATFORM_CI and then the event");
  const full = JSON.parse(include[1]);
  const preShip = JSON.parse(include[2]);
  const byDefault = JSON.parse(include[3]);
  assert.deepEqual(byDefault, [
    { os: "ubuntu-latest", part: "web", shard: "1/2" },
    { os: "ubuntu-latest", part: "web", shard: "2/2" },
    { os: "ubuntu-latest", part: "rust" },
  ]);
  assert.deepEqual(preShip, [
    { os: "ubuntu-latest", part: "web", shard: "1/2" },
    { os: "ubuntu-latest", part: "web", shard: "2/2" },
    { os: "macos-latest", part: "rust" },
  ]);
  assert.ok(!byDefault.some((entry) => entry.os !== "ubuntu-latest"), "a PR waits for no macOS or Windows runner");
  assert.equal(full.filter((entry) => entry.os === "macos-latest").length, 1);
  assert.deepEqual(full.find((entry) => entry.os === "macos-latest"), { os: "macos-latest", part: "all" });
  for (const job of ["host", "ship"]) {
    assert.match(
      jobBlock(job),
      /os: \$\{\{ fromJSON\(vars\.HUB_CROSS_PLATFORM_CI == 'true' && '\[[^\]]*\]' \|\| github\.event_name == 'workflow_dispatch' && '\["macos-latest"\]' \|\| '\["ubuntu-latest"\]'\) \}\}/,
      `${job}: Linux on a PR, macOS in the pre-ship run`,
    );
  }
  assert.match(check, /node scripts\/ci-check-parallel\.mjs/);
  assert.match(check, /if: matrix\.part == 'all'/);
  assert.match(check, /run: npm test[\s\S]*?\n {8}if: matrix\.part == 'web'/);
  assert.match(check, /run: cargo nextest run --workspace --profile ci\n {8}if: matrix\.part == 'rust'/);
  assert.doesNotMatch(check, /\n {6}- run: cargo check\n/);
  assert.doesNotMatch(check, /\n {6}- run: cargo test\n/);
  assert.match(check, /taiki-e\/install-action@[0-9a-f]{40}/);
  assert.match(check, /tool: cargo-nextest@0\.9\.151/);
  assert.match(check, /if: matrix\.part != 'web'/);
  assert.doesNotMatch(check, /\n\s+permissions:/);
  assert.doesNotMatch(check, /\$\{\{\s*secrets\./);
  assert.match(check, /--shard=\{0\}/);
  assert.match(check, /dtolnay\/rust-toolchain@stable[\s\S]*if: matrix\.part != 'web'/);
  assert.doesNotMatch(check, /matrix\.part != 'rust'/);
  for (const job of ["browser", "host", "ship"]) assert.doesNotMatch(jobBlock(job), /ci-check-parallel/);
});
