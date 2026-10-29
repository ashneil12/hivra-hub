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
