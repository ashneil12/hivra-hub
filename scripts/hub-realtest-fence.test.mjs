// r72: bench chats never reach Ash's real accounts (p01 run 20261029-133123-16d9: `vercel whoami` in the throwaway
// HOME started a device sign-in that was approved in the Mac's browser).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ACCOUNT_CLIS, benchFenceArgs, benchFenceEnv } from "./hub-realtest-claude.mjs";

const CHAT = ["--output-format", "stream-json", "--input-format", "stream-json", "--model", "sonnet"];

test("a bench chat gets the account CLIs and URL openers denied, added to the app's own deny list", () => {
  const out = benchFenceArgs([...CHAT, "--disallowedTools", "Bash(printenv)"]);
  const rules = out[out.indexOf("--disallowedTools") + 1].split(",");
  assert.equal(rules[0], "Bash(printenv)");
  for (const rule of ["Bash(vercel:*)", "Bash(gh:*)", "Bash(open:*)", "Bash(npx vercel:*)", "Bash(supabase:*)"]) assert.ok(rules.includes(rule), rule);
  assert.equal(out.filter((a) => a === "--disallowedTools").length, 1);
});

test("a chat with no deny list gets one; a helper call or --version is left alone", () => {
  const out = benchFenceArgs(CHAT);
  assert.ok(out[out.indexOf("--disallowedTools") + 1].includes("Bash(vercel:*)"));
  assert.deepEqual(benchFenceArgs(["--version"]), ["--version"]);
});

test("the shim folder comes first on PATH, refuses every account CLI, and BROWSER is false", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "fence-"));
  const env = benchFenceEnv({ PATH: "/usr/bin:/bin" }, state);
  assert.equal(env.BROWSER, "false");
  assert.ok(env.PATH.startsWith(path.join(state, "bench-bin")));
  for (const cli of ACCOUNT_CLIS) assert.ok(fs.existsSync(path.join(state, "bench-bin", cli)), cli);
  const run = spawnSync("sh", ["-c", "vercel whoami"], { env, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not available in the MonoCode test bench/);
  fs.rmSync(state, { recursive: true, force: true });
});

test("monocode is linked into the shim folder, and a login profile is written only in the temporary home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fence-mono-"));
  const real = path.join(root, "real");
  const home = path.join(root, "home");
  const state = path.join(home, "state");
  const bin = path.join(real, "Worktrees", "slot", "target", "debug", "monocode");
  const ssh = path.join(real, ".ssh", "monocode");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(path.dirname(ssh), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(bin, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  fs.writeFileSync(ssh, "#!/bin/sh\necho secret\n", { mode: 0o755 });
  try {
    const env = benchFenceEnv({ PATH: "/usr/bin:/bin", HOME: home, REALTEST_REAL_HOME: real, REALTEST_APP_BIN: bin, ZDOTDIR: real }, state);
    assert.equal(fs.readlinkSync(path.join(state, "bench-bin", "monocode")), bin);
    assert.equal(env.ZDOTDIR, undefined);
    const line = `export PATH='${path.join(state, "bench-bin")}':"$PATH"\n`;
    for (const name of [".zprofile", ".bash_profile", ".profile"]) assert.equal(fs.readFileSync(path.join(home, name), "utf8"), line);
    assert.equal(fs.existsSync(path.join(real, ".zprofile")), false);
    assert.equal(fs.existsSync(path.join(real, ".bash_profile")), false);
    assert.equal(fs.existsSync(path.join(real, ".profile")), false);
    const intoReal = benchFenceEnv({ PATH: "/usr/bin:/bin", HOME: real, REALTEST_REAL_HOME: real, REALTEST_APP_BIN: bin }, path.join(real, "state"));
    assert.equal(fs.existsSync(path.join(real, ".zprofile")), false);
    assert.ok(intoReal.PATH.startsWith(path.join(real, "state", "bench-bin")));
    const closed = path.join(home, "state-ssh");
    benchFenceEnv({ PATH: "/usr/bin:/bin", HOME: home, REALTEST_REAL_HOME: real, REALTEST_APP_BIN: ssh }, closed);
    assert.equal(fs.existsSync(path.join(closed, "bench-bin", "monocode")), false);
    benchFenceEnv({ PATH: "/usr/bin:/bin", HOME: "/Users/example", REALTEST_REAL_HOME: "/Users/example", REALTEST_APP_BIN: bin }, state);
    assert.equal(fs.existsSync("/Users/example/.zprofile"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
