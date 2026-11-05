// The seatbelt profile under the lexical bench fence.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { agentCommand, appCliRead, benchSandboxProfile, claudeShellTemp, cliReadOnlyPaths, cliSandboxEnv, forbiddenHomeRead, isSharedTemp, modelUrlAllowed, namedLoopbackPorts, parseGatewayListens, privateTempDir, privateTempEnv, sandboxCwd, sandboxedCliSync, SANDBOX_DIDNT_LOAD, SANDBOX_UNAVAILABLE } from "./bench-sandbox.mjs";
import { benchFenceEnv } from "./hub-realtest-claude.mjs";

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
      { host: "127.0.0.1", port: 43111, reason: "this dev copy's own control port" },
      { host: "127.0.0.1", port: 44000, reason: "this run's stub hub port" },
    ],
  });
  assert.match(profile, /the local model gateway the launcher uses/);
  assert.match(profile, /remote ip "localhost:8317"/);
  assert.match(profile, /this dev copy's own control port/);
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
