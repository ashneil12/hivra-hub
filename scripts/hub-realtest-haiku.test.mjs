// r72 (Ash, 29 Oct): "wiring ANTHROPIC_TEST_API_KEY safely into Haiku test workers (never logged)". `--agents haiku-test`
// runs every chat on Haiku with the test key and nothing else that could sign in. Fake values only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { haikuArgs, haikuTestEnv, pickModel, rewriteArgs, testKey, TEST_KEY_ENV } from "./hub-realtest-claude.mjs";
import { DEEPSEEK_BRIDGE, DEEPSEEK_BRIDGE_MODEL, graderVia, parseArgs as benchArgs } from "./hub-realtest.mjs";
import { parseArgs as convArgs } from "./hub-realconv.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = "sk-ant-api03-FAKE-test-key-for-unit-tests";

test("a Haiku test worker gets the test key as its API key and no other way to sign in", () => {
  const env = haikuTestEnv(
    { PATH: "/bin", [TEST_KEY_ENV]: FAKE, ANTHROPIC_AUTH_TOKEN: "sub", CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_BASE_URL: "http://127.0.0.1:18317", CLAUDE_CONFIG_DIR: "/Users/ash/.monocode-hub-dev/claude-config" },
    FAKE,
    "/tmp/state/haiku-test-config",
  );
  assert.equal(env.ANTHROPIC_API_KEY, FAKE);
  for (const gone of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", TEST_KEY_ENV]) assert.equal(env[gone], undefined, gone);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/state/haiku-test-config");
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, "/tmp/state/haiku-test-config");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "haiku");
  assert.equal(env.PATH, "/bin");
});

test("no test key: it refuses, never a Claude login instead", () => {
  assert.throws(() => haikuTestEnv({}, null, "/tmp/x"), /need ANTHROPIC_TEST_API_KEY.*never a Claude login/);
  assert.equal(testKey({}, () => ""), null);
  assert.equal(testKey({}, () => { throw new Error("no launchctl"); }), null);
  assert.equal(testKey({}, () => `${FAKE}\n`), FAKE);
  assert.equal(testKey({ [TEST_KEY_ENV]: FAKE }, () => "other"), FAKE);
});

test("every call is Haiku with no effort, whatever the app asked", () => {
  assert.equal(pickModel("claude-opus-4-1", { haiku: true }), "haiku");
  assert.equal(pickModel("sonnet", { haiku: true }), "haiku");
  assert.deepEqual(haikuArgs(["--input-format", "stream-json", "--model", "claude-opus-4-1", "--effort", "max"]), ["--input-format", "stream-json", "--model", "haiku"]);
  assert.deepEqual(haikuArgs(["-p", "--model=sonnet", "--effort=high"]), ["-p", "--model=haiku"]);
  assert.deepEqual(haikuArgs(["--input-format", "stream-json"]), ["--input-format", "stream-json", "--model", "haiku"]);
  assert.deepEqual(rewriteArgs(["--input-format", "x", "--model", "opus"], { haiku: true }), ["--input-format", "x", "--model", "haiku"]);
  // A routed chat (one of Ash's custom models through the hub's router) keeps its own model.
  assert.deepEqual(rewriteArgs(["--model", "deepseek-chat"], { routed: true, haiku: true }), ["--model", "deepseek-chat"]);
});

test("the benches take --agents haiku-test, graded on DeepSeek", () => {
  const bench = benchArgs(["--agents", "haiku-test"]);
  assert.equal(bench.haikuTest, true);
  assert.equal(bench.deepseekSub, false);
  assert.throws(() => benchArgs(["--agents", "haiku-test", "--deepseek-sub"]), /two different agents' models/);
  if (fs.existsSync(DEEPSEEK_BRIDGE)) assert.equal(graderVia({ haikuTest: true }).model, DEEPSEEK_BRIDGE_MODEL);
  const conv = convArgs(["--agents", "haiku-test"], {});
  assert.equal(conv.agents, "haiku-test");
  assert.equal(conv.tester.provider, "deepseek-sub");
});

test("the wrapper with no key exits before any Claude starts, and never prints a key", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "haiku-test-"));
  const marker = path.join(state, "ran");
  const fakeClaude = path.join(state, "real-claude");
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: state, REALTEST_STATE: state, REALTEST_REAL_CLAUDE: fakeClaude, REALTEST_CLAUDE_CONFIG: state, REALTEST_HAIKU_TEST: "1" };
  // launchctl getenv on this Mac may hold the real key: point PATH at a launchctl that has none.
  const bin = path.join(state, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  env.PATH = `${bin}:${process.env.PATH}`;
  const out = spawnSync(process.execPath, [path.join(HERE, "hub-realtest-claude.mjs"), "--input-format", "stream-json", "-p"], { env, encoding: "utf8" });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /need ANTHROPIC_TEST_API_KEY/);
  assert.equal(fs.existsSync(marker), false);
  // Starting for real needs the macOS sandbox the wrapper puts the agent under; elsewhere it refuses to start bare.
  if (process.platform !== "darwin") return fs.rmSync(state, { recursive: true, force: true });
  // With a (fake) key it starts, and neither the log nor the output holds the key.
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch '${marker}'\n[ -n "$ANTHROPIC_API_KEY" ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo '{"type":"result","subtype":"success","ok":true}'\n`, { mode: 0o755 });
  const settings = path.join(state, "bench-settings.json");
  fs.writeFileSync(settings, "{}\n");
  const ok = spawnSync(process.execPath, [path.join(HERE, "hub-realtest-claude.mjs"), "--input-format", "stream-json", "-p"], { env: { ...env, [TEST_KEY_ENV]: FAKE, CLAUDE_CODE_OAUTH_TOKEN: "oauth", REALTEST_BENCH_SETTINGS: settings, REALTEST_REAL_HOME: "/Users/example", REALTEST_ALLOWED: "[]" }, encoding: "utf8", input: "" });
  assert.equal(fs.existsSync(marker), true);
  assert.match(ok.stdout, /"ok":true/);
  const logs = fs.readdirSync(path.join(state, "claude")).map((f) => fs.readFileSync(path.join(state, "claude", f), "utf8")).join("");
  assert.ok(!logs.includes(FAKE) && !ok.stdout.includes(FAKE) && !ok.stderr.includes(FAKE));
  assert.match(logs, /"model"|haiku/);
  fs.rmSync(state, { recursive: true, force: true });
});
