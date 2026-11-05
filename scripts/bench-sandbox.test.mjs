// The seatbelt profile under the lexical bench fence.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { agentCommand, appCliRead, benchSandboxProfile, claudeHonoursCodeTmpdir, claudeShellTemp, cliReadOnlyPaths, cliSandboxEnv, ControlEndpointRefused, controlEndpoints, DAILY_CONTROL_PORTS, dailyControlPorts, exactShellTemp, forbiddenHomeRead, installedClaudeHonoursTmpdir, isSharedTemp, modelUrlAllowed, namedLoopbackPorts, parseGatewayListens, privateTempDir, privateTempEnv, sandboxCwd, sandboxedCliSync, shellTempAllow, SANDBOX_BAD_CONTROL, SANDBOX_DAILY_CONTROL, SANDBOX_DIDNT_LOAD, SANDBOX_UNAVAILABLE } from "./bench-sandbox.mjs";
import { benchFenceEnv, benchProbeOnce, probeBenchAgent } from "./hub-realtest-claude.mjs";
import { benchDenyRules, writeBenchSettings } from "./bench-guard.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);

const REAL = "/Users/example";
const HOME = "/private/var/bench/home";
const PROJECT = "/private/var/bench/project";
const DEV = "/private/var/bench/home/Library/Application Support/com.ash.monocode-hub.dev.slot";

function allowBlocks(profile, op) {
  const blocks = [];
  const needle = `(allow ${op}`;
  let from = 0;
  while (from < profile.length) {
    const at = profile.indexOf(needle, from);
    if (at < 0) break;
    let depth = 0;
    let closed = false;
    for (let i = at; i < profile.length; i += 1) {
      if (profile[i] === "(") depth += 1;
      else if (profile[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(profile.slice(at, i + 1));
          from = i + 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) break;
  }
  return blocks;
}

function allows(profile, op, abs) {
  return allowBlocks(profile, op).some((block) => block.includes(abs));
}

test("the profile closes the real home, signals, writes and the outbound network", () => {
  const readOnly = cliReadOnlyPaths({ realHome: REAL, cli: `${REAL}/.local/bin/claude-deepseek`, devConfig: `${REAL}/.monocode-hub-dev/claude-config` });
  const profile = benchSandboxProfile({ realHome: REAL, home: HOME, project: PROJECT, allowed: [HOME, PROJECT], devData: DEV, readOnly, cli: `${REAL}/.local/bin/claude-deepseek` });
  assert.match(profile, /\(deny signal \(target others\)\)/);
  assert.equal(profile.includes("(allow default)"), false);
  const denyRead = profile.indexOf('(deny file-read*\n    (literal "/Users/example")');
  const install = profile.indexOf("/Users/example/.local/share/claude");
  assert.ok(denyRead >= 0 && install > denyRead);
  assert.equal(allows(profile, "file-read*", HOME), true);
  assert.equal(allows(profile, "file-write*", HOME), true);
  assert.equal(allows(profile, "file-read*", PROJECT), true);
  assert.equal(allows(profile, "file-write*", PROJECT), true);
  assert.equal(allows(profile, "file-read*", DEV), true);
  assert.equal(allows(profile, "file-write*", DEV), true);
  assert.equal(allows(profile, "file-write*", "/private/var/folders"), false);
  assert.equal(allows(profile, "file-write*", "/private/tmp"), false);
  assert.equal(allows(profile, "file-write*", "/tmp"), false);
  assert.equal(allows(profile, "file-write*", "/var/folders"), false);
  assert.equal(allows(profile, "file-write*", "/private/var/tmp"), false);
  assert.match(profile, /\(deny file-write\*\n {4}\(literal "\/Users\/example"\)/);
  assert.match(profile, /\(deny network-outbound\)/);
  assert.doesNotMatch(profile, /remote ip "[^"]+:\*"/);
  assert.equal(profile.includes(":18767"), false);
  assert.equal(profile.includes("(allow network-outbound"), false);
  assert.match(profile, /local gateway key/);
  assert.match(profile, /shared Claude config/);
  assert.match(profile, /install directory/);
  assert.equal(profile.includes("agent-memory"), false);
  assert.equal(profile.includes("/.ssh"), false);
  assert.equal(profile.includes("/.claude"), false);
  assert.equal(profile.includes("/Projects"), false);
  assert.equal(profile.includes("/Worktrees"), false);
  assert.equal(profile.includes("config.yaml"), false);
  assert.ok(profile.includes("/.local/share/claude-gpt/proxy-key"));
  assert.equal(profile.includes('/.local/share/claude-gpt")'), false);
  assert.equal(profile.includes("no-sandbox"), false);
  assert.match(profile, /com\.apple\.system\.opendirectoryd\.libinfo"/);
  assert.match(profile, /opendirectoryd\.libinfo_v2/);
  assert.match(profile, /DirectoryService\.libinfo_v1/);
  assert.equal(profile.includes("system-socket"), false);
  assert.equal(profile.includes("membership"), false);
});

test("a read under a closed tree is dropped, and haiku does not get the gateway key", () => {
  const dropped = benchSandboxProfile({
    realHome: REAL,
    home: HOME,
    project: PROJECT,
    readOnly: [
      { path: `${REAL}/agent-memory`, reason: "no" },
      { path: `${REAL}/.ssh/id_ed25519`, reason: "no" },
      { path: `${REAL}/.claude/projects`, reason: "no" },
      { path: `${REAL}/Projects/x`, reason: "no" },
      { path: `${REAL}/Worktrees/x`, reason: "no" },
      { path: `${REAL}/Library/Application Support/Other`, reason: "no" },
      { path: `${REAL}/../ash/.ssh/id_ed25519`, reason: "no" },
      { path: `${REAL}/.local/share/claude`, reason: "install" },
    ],
  });
  assert.equal(dropped.includes("agent-memory"), false);
  assert.equal(dropped.includes("/.ssh"), false);
  assert.equal(dropped.includes("/.claude"), false);
  assert.equal(dropped.includes("/Projects"), false);
  assert.equal(dropped.includes("/Worktrees"), false);
  assert.equal(dropped.includes("Application Support/Other"), false);
  assert.ok(dropped.includes(`${REAL}/.local/share/claude`));
  const app = `${REAL}/Worktrees/hivra/target/debug/monocode`;
  const withApp = benchSandboxProfile({ realHome: REAL, home: HOME, readOnly: [{ path: app, reason: "the built app this worktree produced" }], builtApp: `${REAL}/Worktrees/hivra` });
  assert.equal(withApp.includes("Worktrees"), false);
  assert.equal(allows(withApp, "file-read*", app), false);
  const noApp = benchSandboxProfile({ realHome: REAL, home: HOME, readOnly: [{ path: app, reason: "no" }] });
  assert.equal(noApp.includes("Worktrees"), false);
  assert.equal(forbiddenHomeRead(DEV, { realHome: REAL, devData: DEV }), false);
  const ownData = `${REAL}/Library/Application Support/com.ash.monocode-hub.dev.slot`;
  assert.equal(forbiddenHomeRead(ownData, { realHome: REAL, devData: ownData }), false);
  assert.equal(allows(benchSandboxProfile({ realHome: REAL, home: HOME, devData: ownData }), "file-write*", ownData), false);
  assert.equal(allows(benchSandboxProfile({ realHome: REAL, home: HOME, devData: ownData }), "file-read*", ownData), false);
  assert.equal(forbiddenHomeRead(`${REAL}/Library/Application Support`, { realHome: REAL, devData: DEV }), true);
  assert.equal(forbiddenHomeRead(`${REAL}/Library/Application Support/Other`, { realHome: REAL, devData: DEV }), true);
  const haiku = cliReadOnlyPaths({ realHome: REAL, cli: `${REAL}/.local/share/claude/versions/2.1.318`, devConfig: `${REAL}/.monocode-hub-dev/claude-config` });
  assert.equal(haiku.some((item) => item.path.includes("proxy-key")), false);
  const deep = cliReadOnlyPaths({ realHome: REAL, cli: `${REAL}/.local/bin/claude-deepseek`, devConfig: `${REAL}/.monocode-hub-dev/claude-config` });
  assert.ok(deep.some((item) => item.path.endsWith("/proxy-key")));
  const haikuProfile = benchSandboxProfile({ realHome: REAL, home: HOME, project: PROJECT, readOnly: haiku });
  assert.equal(haikuProfile.includes("proxy-key"), false);
  assert.equal(haikuProfile.includes("launcher.py"), false);
});

test("a missing sandbox or a profile that does not load is a refusal", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "bench-sandbox-refuse-"));
  const base = { REALTEST_REAL_HOME: REAL, HOME: state, REALTEST_STATE: state, REALTEST_ALLOWED: "[]" };
  const missing = agentCommand("/bin/echo", ["hi"], { ...base, REALTEST_SANDBOX_EXEC: path.join(state, "missing") });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, SANDBOX_UNAVAILABLE);
  const stub = path.join(state, "stub-sandbox");
  fs.writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const broken = agentCommand("/bin/echo", ["hi"], { ...base, REALTEST_SANDBOX_EXEC: stub });
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, SANDBOX_DIDNT_LOAD);
  assert.equal(fs.existsSync(path.join(state, "sandbox-error.txt")), true);
  const bad = agentCommand("/bin/echo", ["hi"], { ...base, REALTEST_SANDBOX_EXEC: stub, REALTEST_ALLOWED: "{" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /folder list couldn't be read/);
  const unset = agentCommand("/bin/echo", ["hi"], { ...base, REALTEST_REAL_HOME: "  " });
  assert.equal(unset.ok, false);
  assert.match(unset.reason, /real home isn't set/);
  fs.rmSync(state, { recursive: true, force: true });
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

test("the wrapper does not start the agent when the sandbox is missing or the profile does not load", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "bench-sandbox-wrap-"));
  const marker = path.join(state, "ran");
  const fake = path.join(state, "real-claude");
  fs.writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const settings = path.join(state, "settings.json");
  fs.writeFileSync(settings, "{}\n");
  const base = {
    PATH: process.env.PATH,
    HOME: state,
    REALTEST_STATE: state,
    REALTEST_REAL_CLAUDE: fake,
    REALTEST_CLAUDE_CONFIG: state,
    REALTEST_REAL_HOME: REAL,
    REALTEST_ALLOWED: "[]",
    REALTEST_BENCH_SETTINGS: settings,
  };
  const out = spawnSync(process.execPath, [path.join(HERE, "hub-realtest-claude.mjs"), "--input-format", "stream-json", "-p"], {
    env: { ...base, REALTEST_SANDBOX_EXEC: path.join(state, "missing-sandbox-exec") },
    encoding: "utf8",
  });
  assert.equal(fs.existsSync(marker), false);
  assert.notEqual(out.status, 0);
  assert.match(`${out.stderr}`, /macOS sandbox isn't available/);
  const stub = path.join(state, "stub-sandbox");
  fs.writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const broken = spawnSync(process.execPath, [path.join(HERE, "hub-realtest-claude.mjs"), "--input-format", "stream-json", "-p"], {
    env: { ...base, REALTEST_SANDBOX_EXEC: stub },
    encoding: "utf8",
  });
  assert.equal(fs.existsSync(marker), false);
  assert.notEqual(broken.status, 0);
  assert.match(`${broken.stderr}`, /didn't load/);
  fs.rmSync(state, { recursive: true, force: true });
});

test("outbound is only the named loopback ports, and the daily hub port is never one of them", () => {
  const profile = benchSandboxProfile({
    realHome: REAL,
    home: HOME,
    network: [
      { host: "127.0.0.1", port: 8317, reason: "the local model gateway the launcher uses" },
      { host: "127.0.0.1", port: 18767, reason: "the daily hub bridge" },
      { host: "10.0.0.1", port: 80, reason: "not loopback" },
      { host: "127.0.0.1", port: 43111, reason: "this dev copy's control port" },
      { host: "127.0.0.1", port: 44000, reason: "this run's stub hub port" },
    ],
  });
  assert.match(profile, /the local model gateway the launcher uses/);
  assert.match(profile, /remote ip "localhost:8317"/);
  assert.match(profile, /this dev copy's control port/);
  assert.match(profile, /this run's stub hub port/);
  assert.match(profile, /remote ip "localhost:43111"/);
  assert.match(profile, /remote ip "localhost:44000"/);
  assert.equal(profile.includes(":18767"), false);
  assert.equal(profile.includes("10.0.0.1"), false);
  assert.doesNotMatch(profile, /remote ip "[^"]+:\*"/);
});

test("the named ports come from the gateway, the control endpoint and the stub hub, never 18767", () => {
  const ports = namedLoopbackPorts(
    {
      REALTEST_GATEWAY: "http://127.0.0.1:8317/v1",
      MONOCODE_CONTROL_ENDPOINT: "127.0.0.1:43111",
      MONOCODE_HUB_PORT: "18767",
      REALTEST_HUB_PORT: "44000",
    },
    { observe: false },
  );
  assert.deepEqual(ports.map((item) => item.port), [8317, 43111, 44000]);
  assert.equal(ports[0].reason.includes("local model gateway"), true);
  assert.equal(ports[1].reason.includes("control port"), true);
  assert.equal(ports[2].reason.includes("stub hub"), true);
  const daily = namedLoopbackPorts({ REALTEST_GATEWAY: "127.0.0.1:18767", MONOCODE_HUB_PORT: "18767" }, { observe: false });
  assert.deepEqual(daily, []);
  const off = namedLoopbackPorts({ REALTEST_GATEWAY: "10.1.2.3:80" }, { observe: false });
  assert.deepEqual(off, []);
  const seen = parseGatewayListens("cli-proxy-api 844 ash 8u IPv4 TCP 127.0.0.1:8317 (LISTEN)\ncli-proxy-api 844 ash 9u IPv4 TCP *:18767 (LISTEN)\nnode 1 ash 5u IPv4 TCP 127.0.0.1:9 (LISTEN)\n");
  assert.equal(seen.internet, false);
  assert.deepEqual(seen.ports, [{ host: "127.0.0.1", port: 8317 }]);
  const wide = parseGatewayListens("cli-proxy-api 844 ash 8u IPv4 TCP 192.168.1.9:8317 (LISTEN)\n");
  assert.equal(wide.internet, true);
  assert.deepEqual(wide.ports, []);
  assert.equal(modelUrlAllowed("http://127.0.0.1:8317/v1/chat/completions", { REALTEST_GATEWAY: "127.0.0.1:8317" }), true);
  assert.equal(modelUrlAllowed("http://127.0.0.1:9/v1/chat/completions", { REALTEST_GATEWAY: "127.0.0.1:8317" }), false);
  assert.equal(modelUrlAllowed("http://203.0.113.1:8317/v1/chat/completions", { REALTEST_GATEWAY: "127.0.0.1:8317" }), false);
  assert.equal(modelUrlAllowed("http://127.0.0.1:18767/v1/chat/completions", { MONOCODE_HUB_PORT: "18767" }), false);
});

test("the control endpoint the app hands the agent is the one port that opens; the daily app's ports are refused", () => {
  // The canary's bug (PR #77): a chat holding only an app grant got no control port, so every `monocode app` said
  // "Operation not permitted".
  assert.deepEqual(namedLoopbackPorts({ MONOCODE_APP_ENDPOINT: "127.0.0.1:57965" }, { observe: false }), [
    { host: "127.0.0.1", port: 57965, reason: "this dev copy's control port" },
  ]);
  // Both names, the same port: one rule. Two ports: both open, nothing else does.
  assert.deepEqual(
    namedLoopbackPorts({ MONOCODE_APP_ENDPOINT: "127.0.0.1:57965", MONOCODE_CONTROL_ENDPOINT: "http://127.0.0.1:57965/" }, { observe: false }).map((item) => item.port),
    [57965],
  );
  assert.deepEqual(
    controlEndpoints({ MONOCODE_APP_ENDPOINT: "127.0.0.1:57965", MONOCODE_CONTROL_ENDPOINT: "[::1]:57966" }),
    [{ host: "127.0.0.1", port: 57965 }, { host: "::1", port: 57966 }],
  );
  assert.deepEqual(controlEndpoints({ MONOCODE_APP_ENDPOINT: "  ", MONOCODE_CONTROL_ENDPOINT: "" }), []);

  // Not a loopback host:port: no agent is started with it.
  for (const value of ["10.0.0.5:57965", "0.0.0.0:57965", "http://example.com:57965/", "not a port", "127.0.0.1"]) {
    assert.throws(
      () => controlEndpoints({ MONOCODE_APP_ENDPOINT: value }),
      (error) => error instanceof ControlEndpointRefused && error.message === SANDBOX_BAD_CONTROL,
      value,
    );
  }
  // The daily app's fixed hub port is never opened, whichever name carries it.
  for (const key of ["MONOCODE_APP_ENDPOINT", "MONOCODE_CONTROL_ENDPOINT"]) {
    assert.throws(() => controlEndpoints({ [key]: "127.0.0.1:18767" }), (error) => error.message === SANDBOX_DAILY_CONTROL);
  }
  // The daily app's control port is chosen at start, so the bench's own entry env names it. Refused too.
  assert.deepEqual(dailyControlPorts({ [DAILY_CONTROL_PORTS]: "57965, 127.0.0.1:57966" }), [57965, 57966]);
  assert.deepEqual(dailyControlPorts({}), []);
  assert.throws(
    () => controlEndpoints({ [DAILY_CONTROL_PORTS]: "57965", MONOCODE_APP_ENDPOINT: "127.0.0.1:57965" }),
    (error) => error instanceof ControlEndpointRefused && error.message === SANDBOX_DAILY_CONTROL,
  );
  assert.throws(
    () => controlEndpoints({ [DAILY_CONTROL_PORTS]: "57966", MONOCODE_CONTROL_ENDPOINT: "localhost:57966" }),
    (error) => error.message === SANDBOX_DAILY_CONTROL,
  );
  // A daily port named, a dev endpoint on another port: the dev one opens and the daily one is not in the list.
  assert.deepEqual(controlEndpoints({ [DAILY_CONTROL_PORTS]: "57966", MONOCODE_APP_ENDPOINT: "127.0.0.1:57965" }), [{ host: "127.0.0.1", port: 57965 }]);

  // An in-process model call has no agent to refuse: a bad control env only keeps its ports out.
  const env = { REALTEST_GATEWAY: "127.0.0.1:8317", MONOCODE_APP_ENDPOINT: "10.0.0.5:1" };
  assert.equal(modelUrlAllowed("http://127.0.0.1:8317/v1/chat/completions", env), true);
  assert.equal(modelUrlAllowed("http://127.0.0.1:57965/v1/chat/completions", { MONOCODE_APP_ENDPOINT: "127.0.0.1:57965" }), true);
});

test("the agent is not started when its control endpoint is not loopback or names the daily app", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "bench-sandbox-control-"));
  const stub = path.join(state, "stub-sandbox");
  fs.writeFileSync(stub, "#!/bin/sh\nshift 2\nexec \"$@\"\n", { mode: 0o755 });
  const base = { REALTEST_REAL_HOME: REAL, HOME: state, REALTEST_STATE: state, REALTEST_ALLOWED: "[]", REALTEST_SANDBOX_EXEC: stub };
  const bad = agentCommand("/bin/echo", ["hi"], { ...base, MONOCODE_APP_ENDPOINT: "10.0.0.5:57965" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, SANDBOX_BAD_CONTROL);
  const daily = agentCommand("/bin/echo", ["hi"], { ...base, MONOCODE_CONTROL_ENDPOINT: "127.0.0.1:18767" });
  assert.equal(daily.ok, false);
  assert.equal(daily.reason, SANDBOX_DAILY_CONTROL);
  const dailyPort = agentCommand("/bin/echo", ["hi"], { ...base, [DAILY_CONTROL_PORTS]: "57965", MONOCODE_APP_ENDPOINT: "127.0.0.1:57965" });
  assert.equal(dailyPort.ok, false);
  assert.equal(dailyPort.reason, SANDBOX_DAILY_CONTROL);
  // No profile was written for any refusal: nothing could start with one.
  assert.equal(fs.existsSync(path.join(state, "sandbox.sb")), false);

  // The dev copy's own app endpoint is written into the profile, and nothing else is opened for it.
  const ok = agentCommand("/bin/echo", ["hi"], { ...base, MONOCODE_APP_ENDPOINT: "127.0.0.1:57965" }, { observe: false });
  assert.equal(ok.ok, true, ok.reason);
  assert.match(ok.profile, /this dev copy's control port \(127\.0\.0\.1:57965\)/);
  assert.match(ok.profile, /remote ip "localhost:57965"/);
  assert.equal((ok.profile.match(/remote ip "localhost:/g) ?? []).length, 1);
  assert.equal(ok.profile.includes(":18767"), false);
  fs.rmSync(state, { recursive: true, force: true });
});

test("the wrapper probes the control port once per run and writes the round's stop", () => {
  const good = (command) =>
    command === "echo probe"
      ? { status: 0, stdout: "probe\n", stderr: "" }
      : command === "monocode app app.version"
        ? { status: 0, stdout: '{"ok":true}\n', stderr: "" }
        : { status: 0, stdout: `${JSON.stringify({ identifier: "com.ash.monocode-hub.dev.probe" })}\n`, stderr: "" };
  const bad = (command) =>
    command === "monocode app app.version" ? { status: 1, stdout: "", stderr: "EPERM" } : good(command);

  const state = fs.mkdtempSync(path.join(os.tmpdir(), "bench-probe-once-"));
  try {
    assert.equal(benchProbeOnce({ MONOCODE_APP_ENDPOINT: "127.0.0.1:57965" }, state, { run: good }), null);
    assert.equal(fs.existsSync(path.join(state, "bench-broken")), false);
    // The second chat does not probe again, so a different answer cannot change the run.
    assert.equal(benchProbeOnce({ MONOCODE_APP_ENDPOINT: "127.0.0.1:57965" }, state, { run: bad }), null);
    assert.equal(fs.existsSync(path.join(state, "bench-broken")), false);

    // A spawn with no control endpoint (a helper call, or the scene probe) has nothing to prove.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "bench-probe-none-"));
    let ran = false;
    assert.equal(
      benchProbeOnce({}, other, {
        run: () => {
          ran = true;
          return good("");
        },
      }),
      null,
    );
    assert.equal(ran, false);
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }

  const failing = fs.mkdtempSync(path.join(os.tmpdir(), "bench-probe-broken-"));
  try {
    assert.equal(benchProbeOnce({ MONOCODE_APP_ENDPOINT: "127.0.0.1:57965" }, failing, { run: bad }), "bench broken: control port");
    assert.equal(fs.readFileSync(path.join(failing, "bench-broken"), "utf8").trim(), "bench broken: control port");
    assert.equal(fs.readFileSync(path.join(failing, "stop"), "utf8").trim(), "bench broken: control port");
  } finally {
    fs.rmSync(failing, { recursive: true, force: true });
  }
});

test("a chat whose shell cannot reach the control port refuses to start, and the run reads why", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-control-refusal-"));
  const realHome = path.join(root, "real-home");
  const home = path.join(root, "home");
  const state = path.join(home, "state");
  const worktree = path.join(root, "worktree");
  const appBin = path.join(worktree, "target", "debug", "monocode");
  fs.mkdirSync(path.dirname(appBin), { recursive: true });
  fs.mkdirSync(path.join(realHome, "Applications", "MonoCode Hub.app", "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    appBin,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  version) echo '{"identifier":"com.ash.monocode-hub.dev.probe"}'; exit 0 ;;`,
      `  app) echo '{"ok":false,"error":"Cannot connect to MonoCode at 127.0.0.1:57965: Operation not permitted (os error 1)"}'; exit 1 ;;`,
      "esac",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const sandbox = path.join(state, "stub-sandbox-exec");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(sandbox, "#!/bin/sh\nshift 2\nexec \"$@\"\n", { mode: 0o755 });
  const marker = path.join(state, "real-claude-ran");
  const fakeClaude = path.join(state, "real-claude");
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const settings = path.join(state, "settings.json");
  fs.writeFileSync(settings, "{}\n");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    REALTEST_STATE: state,
    REALTEST_REAL_CLAUDE: fakeClaude,
    REALTEST_CLAUDE_CONFIG: state,
    REALTEST_REAL_HOME: realHome,
    REALTEST_ALLOWED: "[]",
    REALTEST_BENCH_SETTINGS: settings,
    REALTEST_SANDBOX_EXEC: sandbox,
    REALTEST_APP_BIN: appBin,
    REALTEST_WORKTREE: worktree,
    MONOCODE_APP_ENDPOINT: "127.0.0.1:57965",
  };
  try {
    const out = spawnSync(process.execPath, [path.join(HERE, "hub-realtest-claude.mjs"), "--input-format", "stream-json", "-p"], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(out.status, 2, `${out.stderr}`);
    assert.match(`${out.stderr}`, /bench broken: control port/);
    const answer = JSON.parse(String(out.stdout).trim().split("\n").pop());
    assert.equal(answer.is_error, true);
    assert.equal(answer.result, "bench broken: control port");
    assert.equal(fs.readFileSync(path.join(state, "bench-broken"), "utf8").trim(), "bench broken: control port");
    assert.equal(fs.existsSync(path.join(state, "stop")), true);
    // The real CLI was never started: the chat did not reach the model.
    assert.equal(fs.existsSync(marker), false);
    // The profile the probe ran under names the one control port.
    assert.match(fs.readFileSync(path.join(state, "sandbox.sb"), "utf8"), /remote ip "localhost:57965"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a shared temp dir is not this run's TMPDIR", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-own-tmp-")));
  const shared = fs.realpathSync(os.tmpdir());
  try {
    assert.equal(isSharedTemp(shared), true);
    assert.equal(isSharedTemp("/private/tmp"), true);
    assert.equal(isSharedTemp("/private/tmp-other"), false);
    const env = cliSandboxEnv({ HOME: home, TMPDIR: shared, REALTEST_REAL_HOME: os.homedir() });
    assert.equal(env.TMPDIR, path.join(home, "tmp"));
    assert.equal(env.TMP, env.TMPDIR);
    assert.equal(env.TEMP, env.TMPDIR);
    assert.equal(env.CLAUDE_TMPDIR, env.TMPDIR);
    assert.equal(env.CLAUDE_CODE_TMPDIR, env.TMPDIR);
    assert.deepEqual(privateTempEnv(""), {});
    assert.deepEqual(privateTempEnv(env.TMPDIR), { TMPDIR: env.TMPDIR, TMP: env.TMPDIR, TEMP: env.TMPDIR, CLAUDE_TMPDIR: env.TMPDIR, CLAUDE_CODE_TMPDIR: env.TMPDIR });
    assert.equal(fs.existsSync(env.TMPDIR), true);
    assert.equal(privateTempDir({ HOME: "/private/var/bench/home", TMPDIR: "/private/var/bench/home/work", REALTEST_REAL_HOME: "/Users/example" }), "/private/var/bench/home/work");
    assert.equal(privateTempDir({ HOME: "/private/var/bench/home", TMPDIR: "/private/tmp", REALTEST_REAL_HOME: "/Users/example" }), "/private/var/bench/home/tmp");
    assert.equal(privateTempDir({ HOME: "/private/var/bench/home", TMPDIR: "/private/var/folders/ab/T", REALTEST_REAL_HOME: "/Users/example" }), "/private/var/bench/home/tmp");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a sandboxed process does not start inside the real home", () => {
  const env = { HOME: "/private/var/bench/home", REALTEST_REAL_HOME: "/Users/example" };
  assert.equal(sandboxCwd("/Users/example/Worktrees/hivra", env), "/private/var/bench/home");
  assert.equal(sandboxCwd("/Users/example", env), "/private/var/bench/home");
  assert.equal(sandboxCwd("/private/var/bench/evidence", env), "/private/var/bench/evidence");
  assert.equal(sandboxCwd("", env), "/private/var/bench/home");
});

test("the grader's working directory is outside the real home", () => {
  let cwd;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cwd-"));
  sandboxedCliSync("/bin/echo", ["hi"], {
    cwd: "/Users/example/Worktrees/hivra",
    env: { REALTEST_GATEWAY: "127.0.0.1:9", REALTEST_REAL_HOME: "/Users/example", HOME: home, REALTEST_STATE: home },
  }, {
    existsSync: () => true,
    mkdirSync: () => {},
    writeFileSync: () => {},
    spawnSync: (_cmd, args, opts) => {
      if (args?.[2] !== "/usr/bin/true") cwd = opts.cwd;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(cwd, home);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the profile can ask the system who this user is without opening the home", { skip: process.platform !== "darwin" }, () => {
  assert.equal(fs.existsSync("/usr/bin/sandbox-exec"), true, "sandbox-exec is missing on macOS");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-who-")));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const profile = benchSandboxProfile({
    realHome: os.homedir(),
    home,
    network: [{ host: "127.0.0.1", port: 9, reason: "the local model gateway the launcher uses" }],
  });
  const file = path.join(home, "sandbox.sb");
  fs.writeFileSync(file, profile);
  const out = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/usr/bin/python3", "-c", "import os,pwd; print(pwd.getpwuid(os.getuid()).pw_dir)"], {
    cwd: home,
    encoding: "utf8",
    timeout: 10000,
    env: { HOME: home, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
  });
  assert.equal(out.status, 0, `${out.stderr ?? ""}\n${out.stdout ?? ""}`);
  assert.equal((out.stdout ?? "").trim(), os.homedir());
  fs.rmSync(root, { recursive: true, force: true });
});

test("a grader or tester CLI is not started when the sandbox is missing", () => {
  const out = sandboxedCliSync("/bin/echo", ["hi"], {
    encoding: "utf8",
    env: { REALTEST_SANDBOX_EXEC: path.join(os.tmpdir(), "missing-sandbox-exec"), REALTEST_GATEWAY: "127.0.0.1:9", REALTEST_REAL_HOME: REAL },
  });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /sandbox isn't available/);
});

test("a child under the profile cannot read the real home, write outside, signal a sibling, or reach a loopback port that was not named", { skip: process.platform !== "darwin" }, async () => {
  assert.equal(fs.existsSync("/usr/bin/sandbox-exec"), true, "sandbox-exec is missing on macOS");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-sandbox-spawn-")));
  const realHome = path.join(root, "real home");
  const home = path.join(root, "temp home");
  const project = path.join(root, "project");
  const okDir = path.join(realHome, "ok");
  fs.mkdirSync(okDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(realHome, "secret.txt"), "secret\n");
  fs.writeFileSync(path.join(okDir, "ok.txt"), "ok\n");
  const sibling = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const gateway = net.createServer((socket) => socket.end());
  const denied = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => {
    denied.once("error", reject);
    denied.listen(0, "127.0.0.1", resolve);
  });
  const gatePort = gateway.address().port;
  const deniedPort = denied.address().port;
  const profile = benchSandboxProfile({
    realHome,
    home,
    project,
    allowed: [home, project],
    devData: path.join(home, "Library/Application Support/dev"),
    readOnly: [{ path: okDir, reason: "an exception inside the closed home, so the deny is not the last word" }],
    network: [{ host: "127.0.0.1", port: gatePort, reason: "the local model gateway the launcher uses" }],
  });
  assert.equal(profile.includes("(allow default)"), false);
  assert.equal(profile.includes(`:${deniedPort}`), false);
  assert.equal(profile.includes(":18767"), false);
  assert.doesNotMatch(profile, /remote ip "[^"]+:\*"/);
  assert.match(profile, new RegExp(`localhost:${gatePort}`));
  const file = path.join(home, "sandbox.sb");
  fs.writeFileSync(file, profile);
  const script = path.join(home, "run.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh
set +e
if cat "$REAL/secret.txt" > "$HOME/stolen.txt" 2>/dev/null; then echo secret=ok; else echo secret=fail; fi
if cat "$REAL/ok/ok.txt" > "$HOME/copied.txt" 2>/dev/null; then echo exception=ok; else echo exception=fail; fi
if echo inside > "$HOME/mine.txt"; then echo write_in=ok; else echo write_in=fail; fi
echo outside > "$REAL/planted.txt" 2>"$HOME/plant.err"
if [ -f "$REAL/planted.txt" ]; then echo write_out=ok; else echo write_out=fail; fi
/bin/sleep 30 &
child=$!
echo "$child" > "$HOME/child.pid"
if kill -TERM "$child" 2>"$HOME/child.err"; then echo child_signal=ok; else echo child_signal=fail; fi
if kill -TERM "$SIBLING" 2>"$HOME/sib.err"; then echo sibling_signal=ok; else echo sibling_signal=fail; fi
if /usr/bin/nc -z -G 2 127.0.0.1 "$GATE"; then echo gate=ok; else echo gate=fail; fi
if /usr/bin/nc -z -G 2 127.0.0.1 "$DENIED"; then echo denied=ok; else echo denied=fail; fi
/usr/bin/nc -z -G 2 203.0.113.1 9 >"$HOME/ext.out" 2>"$HOME/ext.err"
echo ext_status=$?
`,
    { mode: 0o755 },
  );
  let childPid = 0;
  try {
    const started = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/usr/bin/true"], { encoding: "utf8", timeout: 15000 });
    assert.equal(started.status, 0, `true did not start\n${started.stderr}\n${started.stdout}`);
    const out = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", script], {
      encoding: "utf8",
      timeout: 20000,
      env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin:/opt/homebrew/bin", REAL: realHome, SIBLING: String(sibling.pid), GATE: String(gatePort), DENIED: String(deniedPort) },
    });
    assert.equal(out.status, 0, `script failed\n${out.stderr}\n${out.stdout}`);
    const report = Object.fromEntries(out.stdout.trim().split("\n").filter(Boolean).map((line) => line.split("=")));
    assert.equal(report.secret, "fail", out.stdout);
    assert.equal(report.exception, "fail", out.stdout);
    assert.equal(report.write_in, "ok", out.stdout);
    assert.equal(report.write_out, "fail", out.stdout);
    assert.equal(fs.existsSync(path.join(realHome, "planted.txt")), false);
    const stolen = fs.existsSync(path.join(home, "stolen.txt")) ? fs.readFileSync(path.join(home, "stolen.txt"), "utf8") : "";
    assert.equal(stolen.includes("secret"), false);
    assert.equal(fs.readFileSync(path.join(home, "mine.txt"), "utf8").trim(), "inside");
    const copied = fs.existsSync(path.join(home, "copied.txt")) ? fs.readFileSync(path.join(home, "copied.txt"), "utf8") : "";
    assert.equal(copied.includes("ok"), false);
    assert.equal(report.child_signal, "ok", `${out.stdout}\n${fs.readFileSync(path.join(home, "child.err"), "utf8")}`);
    childPid = Number(fs.readFileSync(path.join(home, "child.pid"), "utf8"));
    let gone = false;
    for (let i = 0; i < 20; i += 1) {
      if (!alive(childPid)) {
        gone = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(gone, true, "the sandboxed process could not signal its own child");
    assert.equal(report.sibling_signal, "fail", `${out.stdout}\n${fs.readFileSync(path.join(home, "sib.err"), "utf8")}`);
    assert.equal(alive(sibling.pid), true, "a sibling outside the sandbox was signaled");
    assert.equal(report.gate, "ok", out.stdout);
    assert.equal(report.denied, "fail", out.stdout);
    const extErr = fs.readFileSync(path.join(home, "ext.err"), "utf8");
    const extOut = fs.existsSync(path.join(home, "ext.out")) ? fs.readFileSync(path.join(home, "ext.out"), "utf8") : "";
    const extText = `${extOut}\n${extErr}\n${out.stderr ?? ""}`;
    assert.equal(report.ext_status === "0", false, extText);
    assert.match(extText, /not permitted|Permission denied|Operation not permitted/i, extText);
    assert.doesNotMatch(extText, /timed out/i, extText);
  } finally {
    try {
      sibling.kill("SIGKILL");
    } catch {
      // already gone
    }
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    gateway.close();
    denied.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a child can write its own TMPDIR and cannot write or delete the shared temps", { skip: process.platform !== "darwin" }, () => {
  assert.equal(fs.existsSync("/usr/bin/sandbox-exec"), true, "sandbox-exec is missing on macOS");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-private-tmp-")));
  const home = path.join(root, "home");
  const runTmp = path.join(home, "tmp");
  fs.mkdirSync(runTmp, { recursive: true });
  const id = path.basename(root);
  const realT = fs.realpathSync(os.tmpdir());
  const preTmp = path.join("/private/tmp", `monocode-bench-${id}`);
  const preT = path.join(realT, `monocode-bench-${id}`);
  const newTmp = path.join("/private/tmp", `monocode-bench-new-${id}`);
  const newT = path.join(realT, `monocode-bench-new-${id}`);
  const ours = [preTmp, preT, newTmp, newT];
  fs.writeFileSync(preTmp, "keep\n");
  fs.writeFileSync(preT, "keep\n");
  const profile = benchSandboxProfile({ realHome: os.homedir(), home, project: home });
  const file = path.join(home, "sandbox.sb");
  fs.writeFileSync(file, profile);
  const script = path.join(home, "run.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh
set +e
if echo ok > "$TMPDIR/mine.txt" && rm "$TMPDIR/mine.txt"; then echo tmp_rw=ok; else echo tmp_rw=fail; fi
if echo x > "$NEW_TMP"; then echo tmp_write=ok; else echo tmp_write=fail; fi
if rm "$PRE_TMP"; then echo tmp_del=ok; else echo tmp_del=fail; fi
if echo x > "$NEW_T"; then echo t_write=ok; else echo t_write=fail; fi
if rm "$PRE_T"; then echo t_del=ok; else echo t_del=fail; fi
`,
    { mode: 0o755 },
  );
  try {
    const out = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", script], {
      encoding: "utf8",
      timeout: 15000,
      env: {
        HOME: home,
        TMPDIR: runTmp,
        TMP: runTmp,
        TEMP: runTmp,
        CLAUDE_TMPDIR: runTmp,
        PATH: "/usr/bin:/bin",
        PRE_TMP: preTmp,
        PRE_T: preT,
        NEW_TMP: newTmp,
        NEW_T: newT,
      },
    });
    assert.equal(out.status, 0, `${out.stderr}\n${out.stdout}`);
    const report = Object.fromEntries(out.stdout.trim().split("\n").filter(Boolean).map((line) => line.split("=")));
    assert.equal(report.tmp_rw, "ok", out.stdout);
    assert.equal(report.tmp_write, "fail", out.stdout);
    assert.equal(report.tmp_del, "fail", out.stdout);
    assert.equal(report.t_write, "fail", out.stdout);
    assert.equal(report.t_del, "fail", out.stdout);
    assert.equal(fs.readFileSync(preTmp, "utf8"), "keep\n");
    assert.equal(fs.readFileSync(preT, "utf8"), "keep\n");
    assert.equal(fs.existsSync(newTmp), false);
    assert.equal(fs.existsSync(newT), false);
    assert.equal(fs.existsSync(path.join(runTmp, "mine.txt")), false);
  } finally {
    for (const file of ours) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone, or we never created it
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude Code's shell temp follows CLAUDE_CODE_TMPDIR, not TMPDIR", () => {
  const cwd = "/private/tmp/monocode-realtest-GhKDHU/projects/tally";
  const slug = "-private-tmp-monocode-realtest-GhKDHU-projects-tally";
  assert.equal(claudeShellTemp(cwd, {}, { uid: 501, resolve: false }), `/tmp/claude-501/${slug}`);
  assert.equal(claudeShellTemp(cwd, { CLAUDE_CODE_TMPDIR: "" }, { uid: 501, resolve: false }), `/tmp/claude-501/${slug}`);
  assert.equal(claudeShellTemp(cwd, { CLAUDE_CODE_TMPDIR: "relative", TMPDIR: "/var/should-not-be-used" }, { uid: 501, resolve: false }), `/tmp/claude-501/${slug}`);
  assert.equal(claudeShellTemp("a b", { CLAUDE_CODE_TMPDIR: "/private/var/bench/home/tmp/" }, { uid: 501, resolve: false }), "/private/var/bench/home/tmp/claude-501/a-b");
  const long = "x".repeat(201);
  const rooted = claudeShellTemp(long, { CLAUDE_CODE_TMPDIR: "/private/var/bench/home/tmp" }, { uid: 7, resolve: false });
  assert.ok(rooted.startsWith("/private/var/bench/home/tmp/claude-7/"));
  assert.equal(appCliRead(null, { realHome: REAL }), null);
  assert.equal(appCliRead("monocode", { realHome: REAL }), null);
  assert.equal(appCliRead(`${REAL}/Worktrees/slot/target/debug/monocode`, { realHome: REAL }), `${REAL}/Worktrees/slot/target/debug/monocode`);
  for (const top of [".ssh", ".claude", "Projects", "agent-memory", "Library"]) {
    assert.equal(appCliRead(`${REAL}/${top}/monocode`, { realHome: REAL }), null, top);
  }
  assert.equal(appCliRead(`${REAL}/monocode`, { realHome: REAL }), null);
  assert.equal(appCliRead("/Users/other/Worktrees/slot/monocode", { realHome: REAL }), null);
  assert.equal(appCliRead(`${REAL}/Worktrees/slot/../../../.ssh/monocode`, { realHome: REAL }), null);
  assert.equal(appCliRead(`${REAL}/Worktrees/slot/monocode"`, { realHome: REAL }), null);
  assert.equal(appCliRead("/opt/monocode", { realHome: REAL }), "/opt/monocode");
  const app = `${REAL}/Worktrees/hivra/target/debug/monocode`;
  const profile = benchSandboxProfile({ realHome: REAL, home: HOME, appBin: app });
  assert.ok(profile.includes(`(literal "${app}")`));
  assert.equal(profile.includes(`(subpath "${app}")`), false);
  assert.match(profile, /CLAUDE_CODE_TMPDIR/);
  assert.equal(allowBlocks(profile, "file-write*").some((block) => block.includes("/private/tmp/claude-")), false);
  assert.equal(allowBlocks(profile, "file-read*").some((block) => block.includes("/private/tmp/claude-")), false);
  const ssh = benchSandboxProfile({ realHome: REAL, home: HOME, appBin: `${REAL}/.ssh/monocode` });
  assert.equal(ssh.includes(".ssh"), false);
});

test("a stand-in can mkdir Claude's shell temp inside the run, and a sibling under /private/tmp/claude-<uid> stays closed", { skip: process.platform !== "darwin" }, () => {
  assert.equal(fs.existsSync("/usr/bin/sandbox-exec"), true, "sandbox-exec is missing on macOS");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-shell-temp-")));
  const home = path.join(root, "home");
  const cwd = path.join(root, "projects", "tally");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const env = cliSandboxEnv({ HOME: home, REALTEST_REAL_HOME: os.homedir(), TMPDIR: os.tmpdir() });
  const shellTemp = claudeShellTemp(cwd, env, { resolve: false });
  const uid = process.getuid();
  const id = path.basename(root);
  const sibling = path.join("/private/tmp", `claude-${uid}`, `not-this-run-${id}`);
  const parent = path.dirname(sibling);
  const parentExisted = fs.existsSync(parent);
  const tmpKeep = path.join("/private/tmp", `monocode-bench-shell-${id}`);
  const tmpNew = path.join("/private/tmp", `monocode-bench-shell-new-${id}`);
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, "keep"), "keep\n");
  fs.writeFileSync(tmpKeep, "keep\n");
  const profile = benchSandboxProfile({ realHome: os.homedir(), home, project: cwd, allowed: [root] });
  const file = path.join(home, "sandbox.sb");
  fs.writeFileSync(file, profile);
  const script = path.join(home, "run.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh
set +e
mkdir -p "$SHELL_TEMP" && echo ok > "$SHELL_TEMP/probe.txt" && test -f "$SHELL_TEMP/probe.txt" && echo shell_rw=ok || echo shell_rw=fail
if echo x > "$SIBLING/nope"; then echo sib_write=ok; else echo sib_write=fail; fi
if rm "$SIBLING/keep"; then echo sib_del=ok; else echo sib_del=fail; fi
if echo x > "$TMP_NEW"; then echo tmp_write=ok; else echo tmp_write=fail; fi
if rm "$TMP_KEEP"; then echo tmp_del=ok; else echo tmp_del=fail; fi
`,
    { mode: 0o755 },
  );
  try {
    assert.ok(shellTemp.startsWith(`${env.CLAUDE_CODE_TMPDIR}/claude-${uid}/`), shellTemp);
    assert.equal(shellTemp.includes(`/private/tmp/claude-${uid}`), false, shellTemp);
    assert.equal(profile.includes(`/private/tmp/claude-${uid}`), false);
    const out = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", script], {
      encoding: "utf8",
      timeout: 15000,
      env: { HOME: home, PATH: "/usr/bin:/bin", SHELL_TEMP: shellTemp, SIBLING: sibling, TMP_KEEP: tmpKeep, TMP_NEW: tmpNew, ...privateTempEnv(env.TMPDIR) },
    });
    assert.equal(out.status, 0, `${out.stderr}\n${out.stdout}`);
    const report = Object.fromEntries(out.stdout.trim().split("\n").filter(Boolean).map((line) => line.split("=")));
    assert.equal(report.shell_rw, "ok", out.stdout);
    assert.equal(fs.readFileSync(path.join(shellTemp, "probe.txt"), "utf8"), "ok\n");
    assert.equal(report.sib_write, "fail", out.stdout);
    assert.equal(report.sib_del, "fail", out.stdout);
    assert.equal(report.tmp_write, "fail", out.stdout);
    assert.equal(report.tmp_del, "fail", out.stdout);
    assert.equal(fs.readFileSync(path.join(sibling, "keep"), "utf8"), "keep\n");
    assert.equal(fs.readFileSync(tmpKeep, "utf8"), "keep\n");
    assert.equal(fs.existsSync(path.join(sibling, "nope")), false);
    assert.equal(fs.existsSync(tmpNew), false);
  } finally {
    fs.rmSync(sibling, { recursive: true, force: true });
    if (!parentExisted) {
      try {
        fs.rmdirSync(parent);
      } catch {
        // the user's own Claude sessions still have folders here
      }
    }
    for (const leftover of [tmpKeep, tmpNew]) {
      try {
        fs.unlinkSync(leftover);
      } catch {
        // already gone
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("monocode app tasks.workers answers from a bench shell, and the worktree beside that file stays closed", { skip: process.platform !== "darwin" }, () => {
  assert.equal(fs.existsSync("/usr/bin/sandbox-exec"), true, "sandbox-exec is missing on macOS");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-monocode-path-")));
  const real = path.join(root, "real-home");
  const home = path.join(root, "home");
  const state = path.join(home, "state");
  const bin = path.join(real, "Worktrees", "slot", "target", "debug", "monocode");
  const beside = path.join(path.dirname(bin), "other.txt");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(beside, "secret\n");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "app" ] && [ "$2" = "tasks.workers" ] && [ "$3" = "--json" ] && [ "$4" = "{}" ]; then
  echo '{"workers":[]}'
  exit 0
fi
echo no >&2
exit 2
`,
    { mode: 0o755 },
  );
  const fenced = benchFenceEnv({ PATH: "/usr/bin:/bin", HOME: home, REALTEST_REAL_HOME: real, REALTEST_APP_BIN: bin }, state);
  const profile = benchSandboxProfile({ realHome: real, home, project: home, appBin: bin });
  const file = path.join(home, "sandbox.sb");
  fs.writeFileSync(file, profile);
  const cmd = "monocode app tasks.workers --json '{}'";
  try {
    assert.ok(profile.includes(`(literal "${bin}")`));
    assert.equal(profile.includes(`(subpath "${bin}")`), false);
    assert.equal(profile.includes(".ssh"), false);
    const inherited = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", "-c", `${cmd}; echo beside=$(cat '${beside}' 2>/dev/null || echo closed)`], {
      encoding: "utf8",
      timeout: 15000,
      env: { HOME: home, PATH: fenced.PATH, TMPDIR: home },
    });
    assert.equal(inherited.status, 0, `${inherited.stderr}\n${inherited.stdout}`);
    assert.match(inherited.stdout, /\{"workers":\[\]\}/);
    assert.match(inherited.stdout, /beside=closed/);
    assert.doesNotMatch(inherited.stdout, /secret/);
    const login = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", "-c", `. "$HOME/.zprofile"; ${cmd}`], {
      encoding: "utf8",
      timeout: 15000,
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: home },
    });
    assert.equal(login.status, 0, `${login.stderr}\n${login.stdout}`);
    assert.match(login.stdout, /\{"workers":\[\]\}/);
    if (fs.existsSync("/bin/zsh")) {
      const zsh = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/zsh", "-lc", cmd], {
        encoding: "utf8",
        timeout: 15000,
        env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: home, USER: process.env.USER || "bench", LOGNAME: process.env.LOGNAME || "bench", SHELL: "/bin/zsh" },
      });
      assert.equal(zsh.status, 0, `${zsh.stderr}\n${zsh.stdout}`);
      assert.match(zsh.stdout, /\{"workers":\[\]\}/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude Code's temp root is CLAUDE_CODE_TMPDIR, and the shared temp opens only for this run's slug when it is not", () => {
  assert.equal(claudeHonoursCodeTmpdir(null), null);
  assert.equal(claudeHonoursCodeTmpdir(Buffer.alloc(0)), null);
  assert.equal(claudeHonoursCodeTmpdir(Buffer.from("CLAUDE_TMPDIR only")), false);
  assert.equal(claudeHonoursCodeTmpdir(Buffer.from("xx CLAUDE_CODE_TMPDIR yy")), true);
  const missing = installedClaudeHonoursTmpdir("/no/such/home", () => { throw new Error("gone"); }, (file) => file);
  assert.equal(missing, null);
  const read = (file) => {
    assert.match(file, /\/\.local\/bin\/claude$/);
    return Buffer.from("CLAUDE_CODE_TMPDIR");
  };
  assert.equal(installedClaudeHonoursTmpdir("/Users/example", read, (file) => file), true);
  const cwd = "/private/tmp/monocode-realtest-GhKDHU/projects/tally";
  const slug = "-private-tmp-monocode-realtest-GhKDHU-projects-tally";
  const exact = `/private/tmp/claude-501/${slug}`;
  assert.equal(shellTempAllow(cwd, { honours: true, uid: 501 }), null);
  assert.equal(shellTempAllow(cwd, { honours: null, uid: 501 }), null);
  assert.equal(shellTempAllow(cwd, { honours: false, uid: 501 }), exact);
  assert.equal(exactShellTemp(`/private/tmp/claude-501`), null);
  assert.equal(exactShellTemp(`${exact}-other`), `/private/tmp/claude-501/${slug}-other`);
  assert.equal(exactShellTemp(`/tmp/claude-501/${slug}`), null);
  const closed = benchSandboxProfile({ realHome: REAL, home: HOME });
  assert.equal(closed.includes("regex"), false);
  const opened = benchSandboxProfile({ realHome: REAL, home: HOME, shellTemp: exact });
  assert.match(opened, new RegExp(`regex #"\\^/private/tmp/claude-501/${slug}\\(/\\|\\$\\)"`));
  assert.equal(opened.includes(`${slug}-other`), false);
  assert.equal(opened.includes(`/private/tmp/claude-501")`), false);
  const wide = benchSandboxProfile({ realHome: REAL, home: HOME, shellTemp: "/private/tmp/claude-501" });
  assert.equal(wide.includes("regex"), false);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "bench-shell-allow-"));
  const stub = path.join(state, "stub-sandbox");
  fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    const launch = agentCommand("/bin/echo", ["hi"], {
      REALTEST_REAL_HOME: REAL,
      HOME: state,
      REALTEST_STATE: state,
      REALTEST_ALLOWED: "[]",
      REALTEST_SANDBOX_EXEC: stub,
      REALTEST_CLAUDE_HONOURS_TMPDIR: "0",
    }, { cwd, uid: 501 });
    assert.equal(launch.ok, true, launch.reason);
    const written = fs.readFileSync(path.join(state, "sandbox.sb"), "utf8");
    assert.match(written, new RegExp(`regex #"\\^${exact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(/\\|\\$\\)"`));
    const kept = agentCommand("/bin/echo", ["hi"], {
      REALTEST_REAL_HOME: REAL,
      HOME: state,
      REALTEST_STATE: state,
      REALTEST_ALLOWED: "[]",
      REALTEST_SANDBOX_EXEC: stub,
      REALTEST_CLAUDE_HONOURS_TMPDIR: "1",
    }, { cwd, uid: 501 });
    assert.equal(kept.ok, true, kept.reason);
    assert.equal(fs.readFileSync(path.join(state, "sandbox.sb"), "utf8").includes("regex"), false);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("the monocode on PATH is this worktree's dev build, and the daily bundle is not on PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fence-worktree-"));
  const real = path.join(root, "real");
  const home = path.join(root, "home");
  const state = path.join(home, "state");
  const worktree = path.join(root, "worktree");
  const bin = path.join(worktree, "target", "debug", "monocode");
  const dailyDir = path.join(real, "Applications", "MonoCode Hub.app", "Contents", "MacOS");
  const dailyBin = path.join(dailyDir, "monocode");
  const decoyDir = path.join(root, "decoy");
  const linked = path.join(worktree, "target", "alias", "monocode");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.mkdirSync(decoyDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(bin, "#!/bin/sh\necho dev\n", { mode: 0o755 });
  fs.writeFileSync(dailyBin, "#!/bin/sh\necho daily\n", { mode: 0o755 });
  fs.writeFileSync(path.join(decoyDir, "monocode"), "#!/bin/sh\necho decoy\n", { mode: 0o755 });
  fs.symlinkSync(dailyBin, linked);
  const dailyOnPath = `${dailyDir}${path.delimiter}${decoyDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  try {
    const env = benchFenceEnv({
      PATH: dailyOnPath,
      HOME: home,
      REALTEST_REAL_HOME: real,
      REALTEST_APP_BIN: bin,
      REALTEST_WORKTREE: worktree,
    }, state);
    const shim = path.join(state, "bench-bin", "monocode");
    const resolved = fs.realpathSync(shim);
    assert.equal(resolved.startsWith(`${fs.realpathSync(worktree)}/target/`), true, resolved);
    assert.equal(resolved, fs.realpathSync(bin));
    for (const entry of env.PATH.split(path.delimiter)) {
      assert.equal(entry.includes("MonoCode Hub.app"), false, entry);
    }
    const which = spawnSync("/bin/sh", ["-c", "command -v monocode"], { env, encoding: "utf8" });
    assert.equal(which.status, 0, which.stderr);
    assert.equal(fs.realpathSync(which.stdout.trim()), fs.realpathSync(bin));
    const stolen = path.join(home, "state-stolen");
    const viaDaily = benchFenceEnv({
      PATH: dailyOnPath,
      HOME: home,
      REALTEST_REAL_HOME: real,
      REALTEST_APP_BIN: linked,
      REALTEST_WORKTREE: worktree,
    }, stolen);
    assert.equal(fs.existsSync(path.join(stolen, "bench-bin", "monocode")), false);
    for (const entry of viaDaily.PATH.split(path.delimiter)) assert.equal(entry.includes("MonoCode Hub.app"), false, entry);
    const found = spawnSync("/bin/sh", ["-c", "command -v monocode || true"], { env: viaDaily, encoding: "utf8" });
    assert.equal(found.stdout.includes("MonoCode Hub.app"), false, found.stdout);
    assert.equal(found.stdout.trim().endsWith("/decoy/monocode"), false, found.stdout);
    const stub = path.join(stolen, "stub-sandbox");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const stolenLaunch = agentCommand("/bin/echo", ["hi"], {
      REALTEST_REAL_HOME: real,
      HOME: home,
      REALTEST_STATE: stolen,
      REALTEST_ALLOWED: "[]",
      REALTEST_SANDBOX_EXEC: stub,
      REALTEST_APP_BIN: linked,
      REALTEST_WORKTREE: worktree,
    });
    assert.equal(stolenLaunch.ok, true, stolenLaunch.reason);
    assert.equal(fs.readFileSync(path.join(stolen, "sandbox.sb"), "utf8").includes("MonoCode Hub.app"), false);
    const outside = path.join(home, "state-outside");
    benchFenceEnv({
      PATH: `/usr/bin${path.delimiter}/bin`,
      HOME: home,
      REALTEST_REAL_HOME: real,
      REALTEST_APP_BIN: path.join(root, "opt", "monocode"),
      REALTEST_WORKTREE: worktree,
    }, outside);
    assert.equal(fs.existsSync(path.join(outside, "bench-bin", "monocode")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the scene probe reports which of the two checks failed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-agent-"));
  const real = path.join(root, "real");
  const home = path.join(root, "home");
  const state = path.join(home, "state");
  const worktree = path.join(root, "worktree");
  const bin = path.join(worktree, "target", "debug", "monocode");
  const dailyDir = path.join(real, "Applications", "MonoCode Hub.app", "Contents", "MacOS");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(bin, "#!/bin/sh\necho dev\n", { mode: 0o755 });
  const ctx = {
    home,
    state,
    appBin: bin,
    worktree,
    realHome: real,
    path: `${dailyDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };
  try {
    const echoFail = probeBenchAgent(ctx, { exec: () => ({ status: 1, stdout: "", stderr: "EPERM" }) });
    assert.equal(echoFail, "bench broken: echo probe");
    let commands = [];
    const versionFail = probeBenchAgent(ctx, {
      exec: (command) => {
        commands.push(command);
        if (command === "echo probe") return { status: 0, stdout: "probe\n", stderr: "" };
        return { status: 0, stdout: `${JSON.stringify({ identifier: "com.ash.monocode-hub" })}\n`, stderr: "" };
      },
    });
    assert.equal(versionFail, "bench broken: monocode version");
    assert.deepEqual(commands, ["echo probe", "monocode version --json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a slug allow does not open a sibling under /private/tmp/claude-<uid>", { skip: process.platform !== "darwin" }, () => {
  assert.equal(fs.existsSync("/usr/bin/sandbox-exec"), true, "sandbox-exec is missing on macOS");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-slug-")));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const uid = process.getuid();
  const id = path.basename(root).replace(/[^a-zA-Z0-9]/g, "-");
  const slug = `bench-slug-${id}`;
  const exact = `/private/tmp/claude-${uid}/${slug}`;
  const sibling = `/private/tmp/claude-${uid}/${slug}-other`;
  const parent = path.dirname(exact);
  const parentExisted = fs.existsSync(parent);
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, "keep"), "keep\n");
  const profile = benchSandboxProfile({ realHome: os.homedir(), home, project: home, shellTemp: exact });
  const file = path.join(home, "sandbox.sb");
  fs.writeFileSync(file, profile);
  const script = path.join(home, "run.sh");
  fs.writeFileSync(script, `#!/bin/sh
set +e
mkdir -p "$EXACT" && echo ok > "$EXACT/probe.txt" && test -f "$EXACT/probe.txt" && echo slug_rw=ok || echo slug_rw=fail
if echo x > "$SIBLING/nope"; then echo sib_write=ok; else echo sib_write=fail; fi
if rm "$SIBLING/keep"; then echo sib_del=ok; else echo sib_del=fail; fi
`, { mode: 0o755 });
  try {
    assert.match(profile, new RegExp(`regex #"\\^/private/tmp/claude-${uid}/${slug}\\(/\\|\\$\\)"`));
    assert.equal(profile.includes(sibling), false);
    const out = spawnSync("/usr/bin/sandbox-exec", ["-f", file, "/bin/sh", script], {
      encoding: "utf8",
      timeout: 15000,
      env: { HOME: home, PATH: "/usr/bin:/bin", EXACT: exact, SIBLING: sibling },
    });
    assert.equal(out.status, 0, `${out.stderr}\n${out.stdout}`);
    const report = Object.fromEntries(out.stdout.trim().split("\n").filter(Boolean).map((line) => line.split("=")));
    assert.equal(report.slug_rw, "ok", out.stdout);
    assert.equal(report.sib_write, "fail", out.stdout);
    assert.equal(report.sib_del, "fail", out.stdout);
    assert.equal(fs.readFileSync(path.join(sibling, "keep"), "utf8"), "keep\n");
    assert.equal(fs.existsSync(path.join(sibling, "nope")), false);
  } finally {
    fs.rmSync(exact, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
    if (!parentExisted) {
      try { fs.rmdirSync(parent); } catch { /* the user's Claude sessions still have folders here */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
