// The bench fence: process control, the real home, a missing real app, and the scene book.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { benchSandboxProfile } from "./bench-sandbox.mjs";

import {
  applyCanary,
  appTouchResult,
  appsFromPs,
  benchDenyRules,
  canaryReport,
  canaryTable,
  callBlocked,
  commandBlocked,
  dummyStoppedOk,
  exitCodeForStop,
  finishSceneAgents,
  finishSceneApps,
  isHardStop,
  benchShellProbe,
  sceneAgents,
  startSceneAgentPoll,
  underProfile,
  unsandboxedAgents,
  hookDecision,
  readDummy,
  rulesBlock,
  scanSceneBook,
  scanSceneText,
  sceneBookFiles,
  startDummy,
  stopDummy,
  writeBenchSettings,
} from "./bench-guard.mjs";
import { prepareBenchSpawn } from "./hub-realtest-claude.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const user = os.userInfo().username;
const memoryFile = `/Users/${user}/agent-memory/ash/MEMORY.md`;
const ctx = {
  realHome: `/Users/${user}`,
  allowed: ["/private/var/bench/home", "/private/var/bench/project"],
  devData: "/private/var/bench/home/Library/Application Support/com.ash.monocode-hub.dev.slot",
  home: "/private/var/bench/home",
  cwd: "/private/var/bench/project",
};
const CHAT = ["--output-format", "stream-json", "--input-format", "stream-json", "--model", "sonnet"];

test("process control is denied, including the spellings, and launchctl list is not", () => {
  const blocked = [
    "kill 1",
    "/bin/kill -9 1",
    "/usr/bin/kill 1",
    "command kill 1",
    "command -p kill 1",
    "xargs kill",
    "xargs -I {} kill {}",
    "$(which kill)",
    "`which kill`",
    'sh -c "kill 1"',
    "bash -lc 'kill 1'",
    "echo hi; kill 1",
    "echo hi && kill 1",
    "echo hi | kill 1",
    "$(kill 1)",
    "pkill -f claude",
    "killall node",
    "osascript -e 'quit'",
    "open -a Finder",
    "shutdown -h now",
    "reboot",
    "launchctl",
    "launchctl bootout gui/501",
    "launchctl getenv PATH",
    "launchctl list | kill 1",
    "FOO=1 kill 1",
    "sudo kill 1",
    "eval 'kill 1'",
    "echo hi & kill 1",
    "(kill 1)",
    "{ kill 1; }",
    `${"command ".repeat(9)}kill 1`,
  ];
  for (const command of blocked) assert.equal(commandBlocked(command, ctx), true, command);
  for (const command of ["echo $(which node)", "launchctl list", "launchctl list com.apple.foo", "/bin/launchctl list", "echo hello", "which node", 'echo "kill"', "echo hi 2>&1"])
    assert.equal(commandBlocked(command, ctx), false, command);
});

test("writes outside the bench are denied, and a real-home read stays denied when a permission answer allows it", () => {
  assert.equal(commandBlocked("rm notes.txt", ctx), false);
  assert.equal(commandBlocked("rm /Users/ash/notes.txt", { ...ctx, realHome: "/Users/ash" }), true);
  assert.equal(commandBlocked("rm ../outside", ctx), true);
  assert.equal(commandBlocked("rm notes.txt", { ...ctx, cwd: null }), true);
  assert.equal(commandBlocked("echo hi > /dev/null", ctx), false);
  assert.equal(commandBlocked("echo hi > ./out", ctx), false);
  assert.equal(commandBlocked(`echo hi > ${memoryFile}`, ctx), true);
  assert.equal(commandBlocked(`cp ${memoryFile} ./copy`, ctx), true);
  assert.equal(commandBlocked("cat /etc/passwd", ctx), false);
  assert.equal(commandBlocked(`cat ${memoryFile}`, ctx), true);
  assert.equal(commandBlocked(`cat "/Users/${user}/Library/Application Support/Grok Bot/state.db"`, ctx), true);
  assert.equal(commandBlocked("ls /Applications/Grok\\ Bot.app", ctx), true);
  const devDb = `${ctx.devData}/monocode.db`;
  assert.equal(callBlocked({ tool: "Read", input: { file_path: devDb } }, ctx), false);
  assert.equal(callBlocked({ tool: "Read", input: { file_path: "/private/var/bench/home/Library/Application Support/Grok Bot/state.db" } }, ctx), true);
  const ask = { tool: "Read", input: { file_path: memoryFile }, permission: "allow" };
  assert.equal(callBlocked(ask, ctx), true);
  assert.equal(rulesBlock(benchDenyRules(ctx), ask, ctx), true);
  assert.equal(callBlocked({ tool: "Write", input: { file_path: memoryFile }, permission: "allow" }, ctx), true);
  assert.equal(callBlocked({ tool: "Edit", input: { file_path: "/private/var/bench/project/src/app.js" } }, ctx), false);
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-link-"));
  const bench = path.join(linkDir, "bench");
  const secret = path.join(linkDir, "secret");
  fs.mkdirSync(bench);
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, "note.txt"), "not the real memory\n");
  fs.symlinkSync(path.join(secret, "note.txt"), path.join(bench, "via-link.txt"));
  const linked = { ...ctx, realHome: fs.realpathSync(secret), allowed: [fs.realpathSync(bench)], cwd: fs.realpathSync(bench), home: fs.realpathSync(bench), devData: path.join(fs.realpathSync(bench), "data") };
  assert.equal(commandBlocked("cat via-link.txt", linked), true);
  assert.equal(commandBlocked("cat note.txt", linked), false);
  fs.rmSync(linkDir, { recursive: true, force: true });
});

test("every bench agent carries the deny rules, and a chat without the settings file is not spawned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-guard-"));
  const settings = path.join(dir, "settings.json");
  const rules = benchDenyRules(ctx);
  writeBenchSettings(settings, { rules, node: process.execPath, hook: path.join(HERE, "bench-guard-hook.mjs"), realHome: ctx.realHome, devData: ctx.devData, allowed: ctx.allowed, home: ctx.home, devConfig: path.join(dir, "not-the-config") });
  const body = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual(body.permissions.deny, rules);
  assert.match(body.hooks.PreToolUse[0].hooks[0].command, /bench-guard-hook/);
  assert.ok(rules.includes("Bash(kill:*)"));
  assert.ok(rules.includes(`Read(${ctx.realHome}/**)`));
  assert.equal(rules.some((rule) => rule.startsWith("Bash(launchctl list")), false);
  for (const extra of [{}, { REALTEST_GROK_SUB: "1" }, { REALTEST_HAIKU_TEST: "1" }]) {
    const prepared = prepareBenchSpawn([...CHAT, "--disallowedTools", "Bash(printenv)"], { ...extra, REALTEST_BENCH_SETTINGS: settings, REALTEST_REAL_HOME: ctx.realHome, REALTEST_ALLOWED: JSON.stringify(ctx.allowed) });
    assert.equal(prepared.ok, true, JSON.stringify(extra));
    const got = prepared.args[prepared.args.indexOf("--disallowedTools") + 1].split(",");
    assert.equal(got[0], "Bash(printenv)");
    for (const rule of rules) assert.ok(got.includes(rule), rule);
    assert.equal(prepared.args[prepared.args.indexOf("--settings") + 1], settings);
  }
  assert.equal(prepareBenchSpawn(CHAT, { REALTEST_REAL_HOME: ctx.realHome }).ok, false);
  assert.deepEqual(prepareBenchSpawn(["--version"], {}).args, ["--version"]);
  const inside = benchDenyRules({ realHome: "/Users/ash", allowed: ["/Users/ash/Worktrees/bench"] });
  assert.equal(inside.some((rule) => rule === "Read(/Users/ash/**)"), false);
  assert.equal(callBlocked({ tool: "Read", input: { file_path: "/Users/ash/agent-memory/ash/MEMORY.md" }, permission: "allow" }, { realHome: "/Users/ash", allowed: ["/Users/ash/Worktrees/bench"] }), true);
  assert.throws(() => writeBenchSettings(path.join(dir, "dev-config", "settings.json"), { rules, node: "node", hook: "hook", realHome: "/Users/example", devData: "", allowed: [], home: "", devConfig: path.join(dir, "dev-config") }), /refusing to write bench denies/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the wrapper does not start claude when the bench denies are missing", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "bench-spawn-"));
  const marker = path.join(state, "ran");
  const fake = path.join(state, "real-claude");
  fs.writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const base = { PATH: process.env.PATH, HOME: state, REALTEST_STATE: state, REALTEST_REAL_CLAUDE: fake, REALTEST_CLAUDE_CONFIG: state, REALTEST_REAL_HOME: `/Users/${user}` };
  for (const extra of [{}, { REALTEST_GROK_SUB: "1" }, { REALTEST_HAIKU_TEST: "1", ANTHROPIC_TEST_API_KEY: "fake-not-a-key" }]) {
    fs.rmSync(marker, { force: true });
    const out = spawnSync(process.execPath, [path.join(HERE, "hub-realtest-claude.mjs"), "--input-format", "stream-json", "-p"], { env: { ...base, ...extra }, encoding: "utf8" });
    assert.equal(fs.existsSync(marker), false, JSON.stringify(extra));
    assert.notEqual(out.status, 0, JSON.stringify(extra));
  }
  fs.rmSync(state, { recursive: true, force: true });
});

test("a missing real app fails the scene and stops the round; a ps failure does not", () => {
  const before = appsFromPs(["  10 /Applications/Grok Bot.app/Contents/MacOS/Grok Bot", "  11 /Users/ash/Applications/Notes.app/Contents/MacOS/Notes", "  12 /private/var/folders/x/home/Applications/Fake.app/Contents/MacOS/Fake"].join("\n"), "/Users/ash");
  assert.deepEqual(before, ["Grok Bot", "Notes"]);
  const touch = appTouchResult(before, ["Notes"]);
  assert.equal(touch.reason, "touched a real app: Grok Bot");
  const stopped = [];
  assert.equal(finishSceneApps(before, ["Notes"], (why) => stopped.push(why)).reason, touch.reason);
  assert.deepEqual(stopped, [touch.reason]);
  assert.equal(appTouchResult(before, ["Grok Bot", "Notes"]), null);
  assert.equal(appTouchResult(null, ["Notes"]), null);
  assert.equal(exitCodeForStop(touch.reason), 1);
  assert.equal(exitCodeForStop("unsandboxed agent: codex"), 1);
  assert.equal(isHardStop("unsandboxed agent: codex"), true);
  assert.equal(isHardStop("unsandboxed agent"), true);
  assert.equal(exitCodeForStop("budget spent"), 0);
  assert.equal(exitCodeForStop(null), 0);
});

test("an agent CLI outside the run's sandbox fails the scene; the wrapper and a sandboxed CLI do not", () => {
  const profile = "/private/var/bench/state/sandbox.sb";
  const wrapper = "/private/var/bench/bin/claude";
  const denied = (pids) => ({ ok: true, byPid: new Map(pids.map((pid) => [pid, false])) });
  const watch = { rootPid: 100, profile, wrapper, sandboxOf: denied };
  const row = (pid, ppid, command) => `  ${pid} ${ppid} ${command}`;
  const hit = (lines) => unsandboxedAgents(lines.join("\n"), watch);
  assert.equal(hit([row(200, 100, "/opt/homebrew/bin/codex")]).reason, "unsandboxed agent: codex");
  // The command line is not the sandbox. sandbox-exec replaces itself, and a profile name in the command can be typed by anyone.
  assert.equal(
    hit([
      row(210, 100, "/usr/bin/sandbox-exec -f /private/var/bench/state/sandbox.sb /opt/homebrew/bin/claude"),
      row(211, 210, "/opt/homebrew/bin/claude"),
    ]).reason,
    "unsandboxed agent: claude",
  );
  assert.equal(hit([row(220, 100, "/opt/homebrew/bin/claude REALTEST_SANDBOX_PROFILE=/private/var/bench/state/sandbox.sb")]).reason, "unsandboxed agent: claude");
  assert.equal(hit([row(221, 100, "/opt/homebrew/bin/claude REALTEST_SANDBOX_PROFILE=/private/var/bench/state/sandbox.sb-evil")]).reason, "unsandboxed agent: claude");
  const allowed = { ...watch, sandboxOf: (pids) => ({ ok: true, byPid: new Map(pids.map((pid) => [pid, true])) }) };
  assert.equal(unsandboxedAgents(row(240, 100, "/usr/bin/claude"), allowed), null);
  assert.equal(hit([row(300, 1, "/opt/homebrew/bin/codex")]), null);
  assert.equal(hit([row(230, 100, "/private/var/bench/bin/claude")]), null);
  assert.equal(hit([row(231, 100, "/bin/sh /private/var/bench/bin/../bin/claude")]), null);
  assert.equal(hit([row(232, 100, "/usr/local/bin/node /private/var/bench/bin/claude")]), null);
  assert.equal(hit([row(240, 100, "/usr/bin/claude")]).reason, "unsandboxed agent: claude");
  assert.equal(unsandboxedAgents(null, watch), null);
  assert.equal(unsandboxedAgents(row(200, 100, "/opt/homebrew/bin/codex"), {}), null);
  assert.equal(hit([row(250, 100, "/usr/local/bin/agent")]), null);
  assert.equal(hit([row(251, 100, "/Users/ash/.local/bin/cursor-agent")]).reason, "unsandboxed agent: cursor-agent");
  assert.equal(hit([row(252, 100, "/opt/homebrew/bin/gemini")]).reason, "unsandboxed agent: gemini");
  assert.equal(hit([row(100, 1, "/opt/homebrew/bin/codex")]), null);
  assert.equal(hit([row(270, 100, "/usr/local/bin/node /scripts/hub-realtest-claude.mjs REALTEST_REAL_CLAUDE=/Users/ash/.local/bin/claude")]), null);
  assert.equal(hit([row(10, 11, "/opt/homebrew/bin/codex"), row(11, 10, "/bin/sleep 1")]), null);
  for (const name of ["opencode", "grok", "hermes", "pi", "omp", "fx", "devin", "claude-deepseek", "pi-coding-agent"]) {
    assert.equal(hit([row(280, 100, `/opt/homebrew/bin/${name}`)]).reason, `unsandboxed agent: ${name}`, name);
  }
  const stopped = [];
  assert.equal(finishSceneAgents(row(200, 100, "/opt/homebrew/bin/codex"), watch, (why) => stopped.push(why)).reason, "unsandboxed agent: codex");
  assert.deepEqual(stopped, ["unsandboxed agent: codex"]);
  assert.equal(finishSceneAgents(null, watch, (why) => stopped.push(why)), null);
  assert.equal(
    sceneAgents({
      listAgents: () => row(200, 100, "/opt/homebrew/bin/hermes"),
      agentWatch: () => watch,
      stopRun: (why) => stopped.push(why),
    }).reason,
    "unsandboxed agent: hermes",
  );
  assert.equal(sceneAgents({ listAgents: () => { throw new Error("ps failed"); }, agentWatch: () => watch, stopRun: (why) => stopped.push(`late ${why}`) }), null);
  assert.equal(sceneAgents({}), null);
  assert.deepEqual(stopped, ["unsandboxed agent: codex", "unsandboxed agent: hermes"]);
});

test("a hosted agent is checked: an interpreter's script, or node running a known package", () => {
  const wrapper = "/private/var/bench/bin/claude";
  const row = (pid, ppid, command) => `  ${pid} ${ppid} ${command}`;
  const denied = (command) =>
    unsandboxedAgents(row(240, 100, command), {
      rootPid: 100,
      wrapper,
      sandboxOf: (pids) => ({ ok: true, byPid: new Map(pids.map((pid) => [pid, 0])) }),
    });
  const allowed = (command) => unsandboxedAgents(row(240, 100, command), { rootPid: 100, wrapper, execFile: () => JSON.stringify({ 240: 1 }) });
  const hosted = [
    ["/usr/local/bin/node /opt/homebrew/bin/gemini", "gemini"],
    ["/usr/local/bin/node /Users/ash/.npm/_npx/x/node_modules/@anthropic-ai/claude-code/cli.js", "claude"],
    ["/usr/local/bin/node /Users/ash/.npm/_npx/x/node_modules/@openai/codex/bin/codex.js", "codex"],
    ["/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js", "gemini"],
    ["/usr/bin/python3 /opt/homebrew/bin/hermes", "hermes"],
    ["/usr/bin/python3.11 /opt/homebrew/bin/hermes", "hermes"],
    ["/usr/bin/python3.12.1 /opt/homebrew/bin/grok", "grok"],
    ["/usr/local/bin/bun /opt/homebrew/bin/grok", "grok"],
    ["/usr/local/bin/deno /opt/homebrew/bin/pi", "pi"],
    ["/bin/zsh /opt/homebrew/bin/codex", "codex"],
    ["/bin/bash /opt/homebrew/bin/opencode", "opencode"],
    ["/bin/sh /opt/homebrew/bin/codex", "codex"],
    ["FOO=1 /usr/local/bin/node --experimental-vm-modules /opt/homebrew/bin/gemini --prompt hi", "gemini"],
  ];
  for (const [command, name] of hosted) {
    assert.equal(denied(command)?.reason, `unsandboxed agent: ${name}`, command);
    assert.equal(allowed(command), null, command);
  }
  assert.equal(denied("/usr/local/bin/node /tmp/not-an-agent.js"), null);
  assert.equal(denied("/usr/bin/python2 /opt/homebrew/bin/hermes"), null);
  assert.equal(denied("/usr/local/bin/node"), null);
  assert.equal(denied("/usr/bin/python3 /x/node_modules/@anthropic-ai/claude-code/cli.js"), null);
  assert.equal(denied("/usr/local/bin/node -r /tmp/preload.js /opt/homebrew/bin/gemini"), null);
  // The plan's wrapper stays skipped when an interpreter's first real argument is that exact path.
  assert.equal(denied("/usr/local/bin/node --check /private/var/bench/bin/claude"), null);
  assert.equal(denied("/bin/zsh /private/var/bench/bin/claude"), null);
  assert.equal(denied("node /private/var/bench/bin/claude"), null);
  assert.equal(denied("/usr/local/bin/node /private/var/bench/bin/../bin/claude"), null);
});

test("a sandbox helper that can't answer is its own stop, and a real answer of not-1 stays unsandboxed", () => {
  const wrapper = "/private/var/bench/bin/claude";
  const row = "  240 100 /usr/bin/claude";
  const stopped = [];
  const hit = finishSceneAgents(row, { rootPid: 100, wrapper, execFile: () => { throw new Error("no python"); } }, (why) => stopped.push(why));
  assert.equal(hit.reason, "can't verify the sandbox: claude");
  assert.equal(isHardStop(hit.reason), true);
  assert.equal(exitCodeForStop(hit.reason), 1);
  assert.deepEqual(stopped, ["can't verify the sandbox: claude"]);
  assert.equal(isHardStop("can't verify the sandbox"), true);
  assert.equal(isHardStop("can't verify the sandbox: claude"), true);
  assert.equal(
    sceneAgents({
      listAgents: () => row,
      agentWatch: () => ({ rootPid: 100, wrapper, execFile: () => "not-json" }),
      stopRun: (why) => stopped.push(why),
    }).reason,
    "can't verify the sandbox: claude",
  );
  assert.deepEqual(stopped, ["can't verify the sandbox: claude", "can't verify the sandbox: claude"]);
  let calls = 0;
  const retried = unsandboxedAgents(row, {
    rootPid: 100,
    wrapper,
    execFile: () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return JSON.stringify({ 240: false });
    },
  });
  assert.equal(calls, 2);
  assert.equal(retried.reason, "unsandboxed agent: claude");
  calls = 0;
  let seen = [];
  const once = unsandboxedAgents(["  241 100 /opt/homebrew/bin/codex", "  242 100 /opt/homebrew/bin/gemini"].join("\n"), {
    rootPid: 100,
    wrapper,
    execFile: (_cmd, args) => {
      calls += 1;
      seen = args.filter((arg) => /^\d+$/.test(arg));
      return JSON.stringify({ 241: 0, 242: 1 });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(seen, ["241", "242"]);
  assert.equal(once.reason, "unsandboxed agent: codex");
  calls = 0;
  assert.equal(unsandboxedAgents("  243 100 /bin/sleep 1", { rootPid: 100, wrapper, execFile: () => { calls += 1; throw new Error("no"); } }), null);
  assert.equal(calls, 0);
  assert.equal(underProfile([], { execFile: () => { throw new Error("no"); } }).ok, true);
  assert.equal(underProfile([0]).ok, false);
  assert.equal(unsandboxedAgents(row, { rootPid: 100, wrapper, execFile: () => JSON.stringify({ 240: 1 }) }), null);
  assert.equal(unsandboxedAgents(row, { rootPid: 100, wrapper, execFile: () => JSON.stringify({ 240: true }) }).reason, "unsandboxed agent: claude");
  assert.equal(unsandboxedAgents(row, { rootPid: 100, wrapper, sandboxOf: () => { throw new Error("down"); } }).reason, "can't verify the sandbox: claude");
});

test("a helper that is missing or errors can't be verified, and any answer but 1 is unsandboxed; both stop the round", () => {
  const wrapper = "/private/var/bench/bin/claude";
  const row = "  240 100 /usr/bin/claude";
  const watch = (execFile) => ({ rootPid: 100, wrapper, execFile });
  const stop = (execFile, reason = "unsandboxed agent: claude") => {
    const stopped = [];
    const hit = finishSceneAgents(row, watch(execFile), (why) => stopped.push(why));
    assert.equal(hit.reason, reason);
    assert.equal(isHardStop(hit.reason), true);
    assert.equal(exitCodeForStop(hit.reason), 1);
    assert.deepEqual(stopped, [reason]);
    const status = underProfile([240], { execFile });
    assert.notEqual(status.byPid?.get(240), true);
    assert.equal(status.byPid.get(240), false);
  };
  const missing = () => {
    const error = new Error("spawn python3 ENOENT");
    error.code = "ENOENT";
    throw error;
  };
  let missingCalls = 0;
  const missed = underProfile([240], {
    execFile: () => {
      missingCalls += 1;
      missing();
    },
  });
  assert.equal(missingCalls, 2);
  assert.equal(missed.ok, false);
  assert.equal(missed.byPid.get(240), false);
  const unverified = "can't verify the sandbox: claude";
  stop(missing, unverified);
  const timedOut = Object.assign(new Error("spawnSync python3 ETIMEDOUT"), { code: "ETIMEDOUT" });
  stop(() => {
    throw timedOut;
  }, unverified);
  stop(() => {
    throw new Error("dyld: Library not loaded");
  }, unverified);
  stop(() => "not-json", unverified);
  stop(() => "", unverified);
  for (const value of [2, -1, null, "1", "0", false, 0]) {
    stop(() => JSON.stringify({ 240: value }));
  }
  stop(() => JSON.stringify({ 999: 1 }));
  const mixed = underProfile([240, 241], { execFile: () => JSON.stringify({ 240: 1, 241: 2 }) });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.byPid.get(240), true);
  assert.equal(mixed.byPid.get(241), false);
  const named = unsandboxedAgents(["  240 100 /usr/bin/claude", "  241 100 /opt/homebrew/bin/codex"].join("\n"), {
    rootPid: 100,
    wrapper,
    execFile: () => JSON.stringify({ 240: 1, 241: 2 }),
  });
  assert.equal(named.reason, "unsandboxed agent: codex");
  const sandboxed = underProfile([240], { execFile: () => JSON.stringify({ 240: 1 }) });
  assert.equal(sandboxed.ok, true);
  assert.equal(sandboxed.byPid.get(240), true);
});

test("polling catches an unsandboxed agent that only the middle sample can see", async () => {
  const wrapper = "/private/var/bench/bin/claude";
  const clean = "  100 1 /bin/sleep 1\n";
  const dirty = "  100 1 /bin/sleep 1\n  240 100 /opt/homebrew/bin/codex\n";
  const frames = [clean, dirty, clean];
  const watch = {
    rootPid: 100,
    wrapper,
    sandboxOf: (pids) => ({ ok: true, byPid: new Map(pids.map((pid) => [pid, 0])) }),
  };
  // The old start and end checks both miss it. Only the sample between them has the agent.
  assert.equal(unsandboxedAgents(frames[0], watch), null);
  assert.equal(unsandboxedAgents(frames[2], watch), null);
  assert.equal(unsandboxedAgents(frames[1], watch).reason, "unsandboxed agent: codex");
  let n = 0;
  const stopped = [];
  let release = () => {};
  const poll = startSceneAgentPoll(
    {
      listAgents: () => frames[Math.min(n++, frames.length - 1)],
      agentWatch: () => watch,
      stopRun: (why) => stopped.push(why),
    },
    {
      now: () => 1_700_000_000_000,
      sleep: () => new Promise((resolve) => {
        release = resolve;
      }),
    },
  );
  assert.equal(n, 1);
  assert.deepEqual(stopped, []);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stopped, ["unsandboxed agent: codex"]);
  const watched = await poll.stop();
  assert.equal(n, 2, "the end frame was never needed");
  assert.equal(watched.hit.reason, "unsandboxed agent: codex");
  assert.deepEqual(watched.agents.map(({ pid, command, name, firstSeen, kernel }) => ({ pid, command, name, firstSeen, kernel })), [
    { pid: 240, command: "/opt/homebrew/bin/codex", name: "codex", firstSeen: 1_700_000_000_000, kernel: 0 },
  ]);
  assert.equal(await poll.stop(), watched);
});

test("a sandboxed agent is recorded with the kernel's 1, and a helper that can't answer is recorded as null", async () => {
  const stopped = [];
  const sandboxed = startSceneAgentPoll(
    {
      listAgents: () => "  241 100 /usr/local/bin/node /opt/homebrew/bin/gemini\n",
      agentWatch: () => ({ rootPid: 100, wrapper: "/private/var/bench/bin/claude", execFile: () => JSON.stringify({ 241: 1 }) }),
      stopRun: (why) => stopped.push(why),
    },
    { intervalMs: 60_000, now: () => 50 },
  );
  const kept = await sandboxed.stop();
  assert.deepEqual(stopped, []);
  assert.equal(kept.hit, null);
  assert.equal(kept.agents[0].name, "gemini");
  assert.equal(kept.agents[0].kernel, 1);
  assert.equal(kept.agents[0].firstSeen, 50);
  assert.equal(kept.agents[0].answered, true);
  const broken = startSceneAgentPoll(
    {
      listAgents: () => "  240 100 /usr/bin/claude\n",
      agentWatch: () => ({ rootPid: 100, wrapper: "/private/var/bench/bin/claude", execFile: () => { throw new Error("no python"); } }),
      stopRun: (why) => stopped.push(why),
    },
    { now: () => 9 },
  );
  const failed = await broken.stop();
  assert.equal(failed.hit.reason, "can't verify the sandbox: claude");
  assert.equal(isHardStop(failed.hit.reason), true);
  assert.equal(failed.agents[0].kernel, null);
  assert.equal(failed.agents[0].answered, false);
  assert.deepEqual(stopped, ["can't verify the sandbox: claude"]);
  assert.deepEqual(await startSceneAgentPoll({}).stop(), { hit: null, agents: [] });
});

test("the kernel reports a sandboxed process, a plain claude child fails the scene, and the wrapper node is skipped", { skip: process.platform !== "darwin" }, () => {
  assert.equal(fs.existsSync("/usr/bin/sandbox-exec"), true, "sandbox-exec is missing");
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-sbx-")));
  const realHome = path.join(rootDir, "real");
  const home = path.join(rootDir, "home");
  fs.mkdirSync(realHome);
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  const profile = path.join(home, "sandbox.sb");
  fs.writeFileSync(profile, benchSandboxProfile({ realHome, home }));
  const started = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/usr/bin/true"], { encoding: "utf8", timeout: 15000 });
  assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
  const wrapper = path.join(home, "claude");
  const agent = path.join(home, "bin", "claude");
  fs.writeFileSync(wrapper, "setInterval(() => {}, 1e9);\n");
  const kids = [];
  try {
    const boxed = spawn("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sleep", "30"], { stdio: ["ignore", "ignore", "pipe"] });
    kids.push(boxed);
    const plain = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    kids.push(plain);
    const nodeChild = spawn(process.execPath, [wrapper], { stdio: "ignore" });
    kids.push(nodeChild);
    let err = "";
    boxed.stderr.on("data", (buf) => {
      err += buf.toString();
    });
    const pause = () => spawnSync("/bin/sleep", ["0.05"]);
    let status = null;
    for (let i = 0; i < 25; i += 1) {
      status = underProfile([boxed.pid, plain.pid]);
      if (status.ok && status.byPid.get(boxed.pid) === true && status.byPid.get(plain.pid) === false) break;
      pause();
    }
    assert.equal(status?.ok, true, JSON.stringify({ status, err, boxed: boxed.pid, plain: plain.pid, exit: boxed.exitCode }));
    assert.equal(status.byPid.get(boxed.pid), true, err);
    assert.equal(status.byPid.get(plain.pid), false);
    const line = (pid) => `  ${pid} ${process.pid} ${agent}`;
    assert.match(line(boxed.pid), /claude/);
    assert.equal(unsandboxedAgents(line(boxed.pid), { rootPid: process.pid, wrapper }), null);
    const stopped = [];
    const plainHit = finishSceneAgents(line(plain.pid), { rootPid: process.pid, wrapper }, (why) => stopped.push(why));
    assert.equal(plainHit.reason, "unsandboxed agent: claude");
    assert.deepEqual(stopped, ["unsandboxed agent: claude"]);
    let nodeText = "";
    for (let i = 0; i < 20; i += 1) {
      try {
        nodeText = execFileSync("ps", ["-p", String(nodeChild.pid), "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
      } catch {
        nodeText = "";
      }
      if (nodeText.includes(wrapper)) break;
      pause();
    }
    assert.ok(nodeText.includes(wrapper), nodeText);
    const ppid = Number(nodeText.match(/^\s*\d+\s+(\d+)/)[1]);
    const nodeStatus = underProfile([nodeChild.pid]);
    assert.equal(nodeStatus.ok, true, nodeText);
    assert.equal(nodeStatus.byPid.get(nodeChild.pid), false);
    assert.equal(unsandboxedAgents(nodeText, { rootPid: ppid, wrapper }), null);
    assert.equal(unsandboxedAgents(`  ${nodeChild.pid} ${ppid} ${wrapper}`, { rootPid: ppid, wrapper }), null);
  } finally {
    for (const child of kids) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the wrapper's haiku helper runs sandboxed under the profile it generates", { skip: process.platform === "darwin" ? false : "sandbox-exec and sandbox_check are macOS only", timeout: 30_000 }, () => {
  assert.equal(fs.existsSync("/usr/bin/sandbox-exec"), true, "sandbox-exec is missing");
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-helper-")));
  const realHome = path.join(rootDir, "real");
  const home = path.join(rootDir, "home");
  const state = path.join(rootDir, "state");
  const config = path.join(rootDir, "config");
  fs.mkdirSync(realHome);
  fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
  fs.mkdirSync(state);
  fs.mkdirSync(config);
  const settings = path.join(state, "bench-settings.json");
  fs.writeFileSync(settings, "{}\n");
  const stub = path.join(home, "claude-stub");
  fs.writeFileSync(stub, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  const helperArgs = [
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--include-partial-messages",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--model", "claude-haiku-4-5",
    "--settings", JSON.stringify({ disableAllHooks: true }),
  ];
  const wrapperProc = spawn(process.execPath, [path.join(HERE, "hub-realtest-claude.mjs"), ...helperArgs], {
    cwd: home,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      TMPDIR: path.join(home, "tmp"),
      REALTEST_STATE: state,
      REALTEST_REAL_CLAUDE: stub,
      REALTEST_CLAUDE_CONFIG: config,
      REALTEST_REAL_HOME: realHome,
      REALTEST_BENCH_SETTINGS: settings,
      REALTEST_MODEL: "sonnet",
    },
  });
  let stderr = "";
  wrapperProc.stderr.on("data", (buf) => {
    stderr += buf.toString();
  });
  wrapperProc.stdout.on("data", () => {});
  const kill = (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  try {
    let child = null;
    for (let i = 0; i < 80 && wrapperProc.exitCode == null; i += 1) {
      let text = "";
      try {
        text = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
      } catch {
        text = "";
      }
      const rows = [];
      for (const line of text.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
      }
      const pending = [wrapperProc.pid];
      const seen = new Set();
      while (pending.length) {
        const pid = pending.pop();
        if (seen.has(pid)) continue;
        seen.add(pid);
        for (const row of rows) {
          if (row.ppid !== pid) continue;
          pending.push(row.pid);
          if (row.command.includes(stub)) child = row;
        }
      }
      if (child) break;
      spawnSync("/bin/sleep", ["0.1"]);
    }
    const logDir = path.join(state, "claude");
    let logged = "";
    if (fs.existsSync(logDir)) {
      for (const name of fs.readdirSync(logDir)) logged += fs.readFileSync(path.join(logDir, name), "utf8");
    }
    assert.ok(child, `the wrapper did not start the helper\n${stderr}\n${logged}\nexit ${wrapperProc.exitCode}`);
    assert.match(child.command, /--no-session-persistence/);
    assert.match(child.command, /claude-haiku-4-5/);
    const status = underProfile([child.pid]);
    assert.equal(status.ok, true, JSON.stringify({ status, command: child.command, stderr }));
    assert.equal(status.byPid.get(child.pid), true, child.command);
  } finally {
    let text = "";
    try {
      text = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
    } catch {
      text = "";
    }
    const rows = [];
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
    }
    const pending = [wrapperProc.pid];
    const seen = new Set();
    while (pending.length) {
      const pid = pending.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const row of rows) if (row.ppid === pid) pending.push(row.pid);
    }
    for (const pid of seen) kill(pid);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the bench tool stops only the dummy it recorded", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "bench-dummy-"));
  const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)", "not-the-dummy"], { stdio: "ignore", detached: true });
  other.unref();
  fs.writeFileSync(path.join(state, "dummy.json"), `${JSON.stringify({ pid: other.pid, marker: "monocode-bench-dummy-nope", stopped: false })}\n`);
  assert.equal(stopDummy(state).ok, false);
  assert.equal(process.kill(other.pid, 0), true);
  process.kill(other.pid, "SIGTERM");
  const started = startDummy(state);
  let stopped = { ok: false };
  for (let i = 0; i < 20 && !stopped.ok; i += 1) stopped = stopDummy(state);
  assert.equal(stopped.ok, true);
  assert.equal(dummyStoppedOk(readDummy(state)), true);
  assert.notEqual(started.pid, other.pid);
  fs.rmSync(state, { recursive: true, force: true });
});

test("a canary row passes only for a refusal or a kernel 1, and anything else is not a pass", () => {
  const clis = ["codex", "grok", "hermes", "claude"];
  const refusal = "This bench only starts the run's own Claude wrapper. It won't start codex.";
  const agent = (name, kernel, answered = true) => ({ pid: 240, command: `/opt/homebrew/bin/${name}`, name, firstSeen: 10, kernel, answered });
  const refused = canaryReport(clis, { agents: [], evidence: { texts: [{ text: refusal }], notes: ["It won't start grok"] } });
  assert.deepEqual(refused.rows.map((row) => [row.cli, row.verdict]), [
    ["codex", "PASS"],
    ["grok", "NOT PROVEN"],
    ["hermes", "NOT PROVEN"],
    ["claude", "NOT PROVEN"],
  ]);
  assert.equal(refused.rows[0].why, "the plan gate refused the start");
  assert.equal(refused.hardStop, null);
  assert.match(refused.unproven, /grok, hermes, claude/);
  const sandboxed = canaryReport(["codex"], { agents: [agent("codex", 1)], evidence: "" });
  assert.equal(sandboxed.rows[0].verdict, "PASS");
  assert.equal(sandboxed.rows[0].why, "seen alive, kernel answered 1");
  assert.equal(sandboxed.unproven, null);
  const loose = canaryReport(["codex"], {
    agents: [agent("codex", 0)],
    evidence: refusal,
    hit: { reason: "unsandboxed agent: codex" },
  });
  assert.equal(loose.rows[0].verdict, "FAIL");
  assert.equal(loose.rows[0].why, "unsandboxed agent: codex");
  assert.equal(loose.hardStop, "unsandboxed agent: codex");
  assert.equal(isHardStop(loose.hardStop), true);
  const unverified = canaryReport(["hermes"], { agents: [agent("hermes", null, false)] });
  assert.equal(unverified.rows[0].why, "can't verify the sandbox: hermes");
  assert.equal(unverified.hardStop, "can't verify the sandbox: hermes");
  const neither = canaryReport(["claude"], { agents: [], evidence: "the wrapper ran" });
  assert.equal(neither.rows[0].verdict, "NOT PROVEN");
  assert.equal(neither.hardStop, null);
  const passed = applyCanary({ verdict: "PASS", reasons: [] }, refused);
  assert.equal(passed.verdict, "NOT PROVEN");
  assert.match(passed.reasons[0], /not proven/);
  assert.equal(applyCanary({ verdict: "PASS", reasons: ["fine"] }, sandboxed).verdict, "PASS");
  const fake = applyCanary({ verdict: "NOT-REAL", wouldBe: "PASS", reasons: ["not a real run"] }, neither);
  assert.equal(fake.verdict, "NOT-REAL");
  assert.equal(fake.wouldBe, "NOT PROVEN");
  const stopped = applyCanary({ verdict: "PASS", wouldBe: "PASS", reasons: [] }, loose);
  assert.equal(stopped.verdict, "FAIL");
  assert.equal(stopped.wouldBe, "FAIL");
  assert.equal(stopped.reasons[0], "unsandboxed agent: codex");
  const already = applyCanary({ verdict: "FAIL", reasons: ["automatic fail: ack-only"] }, neither);
  assert.equal(already.verdict, "FAIL");
  assert.match(already.reasons.at(-1), /not proven/);
  assert.equal(applyCanary({ verdict: "PASS" }, canaryReport([], {})).verdict, "PASS");
  assert.equal(canaryReport(null), null);
  assert.match(canaryTable(refused.rows), /\| codex \| PASS \| the plan gate refused the start \|/);
  assert.match(canaryTable(refused.rows), /\| hermes \| NOT PROVEN \|/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-canary-"));
  const file = path.join(dir, "scenes.json");
  fs.writeFileSync(file, JSON.stringify({ card: "Prove each named CLI is sandboxed or was refused by the plan.", canaryClis: ["hermes", "codex"] }));
  assert.deepEqual(scanSceneBook([file]), []);
  fs.writeFileSync(file, JSON.stringify({ card: "also hermes should be shut down", canaryClis: ["codex"] }));
  assert.ok(scanSceneBook([file]).some((hit) => hit.why === "hermes"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the scene book names no real app, and the scanner catches one", () => {
  assert.equal(scanSceneText("Grok: 9 s median").length, 0);
  assert.ok(scanSceneText("also hermes should be shut down").length);
  assert.ok(scanSceneText("grok bot transcripts").some((hit) => hit.why === "Grok Bot"));
  const hits = scanSceneBook(sceneBookFiles(path.join(HERE, "..")));
  assert.deepEqual(hits, [], hits.map((hit) => `${hit.file}: ${hit.why}`).join("; "));
});

test("a scene probe stops the round when the shell or the dev binary fails", () => {
  const dev = { status: 0, stdout: `${JSON.stringify({ identifier: "com.ash.monocode-hub.dev.slot" })}\n`, stderr: "" };
  const echoOk = { status: 0, stdout: "probe\n", stderr: "" };
  const calls = [];
  const run = (script) => (command) => {
    calls.push(command);
    return script(command, calls.length);
  };
  assert.equal(benchShellProbe(run((command) => (command === "monocode version --json" ? dev : echoOk))), null);
  assert.deepEqual(calls, ["echo probe", "monocode version --json"]);
  calls.length = 0;
  assert.equal(benchShellProbe(run(() => ({ status: 1, stdout: "", stderr: "EPERM" }))), "bench broken: echo probe");
  assert.deepEqual(calls, ["echo probe"]);
  assert.equal(benchShellProbe(() => { throw new Error("timed out"); }), "bench broken: echo probe");
  assert.equal(benchShellProbe(run((command) => (command === "echo probe" ? { status: 0, stdout: "\n", stderr: "" } : dev))), "bench broken: echo probe");
  assert.equal(benchShellProbe(run((command) => (command === "echo probe" ? echoOk : { status: 127, stdout: "", stderr: "not found" }))), "bench broken: monocode version");
  assert.equal(
    benchShellProbe(run((command) => (command === "echo probe" ? echoOk : { status: 0, stdout: `${JSON.stringify({ identifier: "com.ash.monocode-hub" })}\n`, stderr: "" }))),
    "bench broken: monocode version",
  );
  assert.equal(
    benchShellProbe(run((command) => (command === "echo probe" ? echoOk : { status: 0, stdout: "not json", stderr: "" }))),
    "bench broken: monocode version",
  );
  assert.equal(
    benchShellProbe(run((command) => (command === "echo probe" ? echoOk : { status: 0, stdout: `${JSON.stringify({ identifier: "com.ash.monocode-hub.dev." })}\n`, stderr: "" }))),
    "bench broken: monocode version",
  );
  assert.equal(isHardStop("bench broken: echo probe"), true);
  assert.equal(isHardStop("bench broken: monocode version"), true);
  assert.equal(exitCodeForStop("bench broken: echo probe"), 1);
  assert.equal(isHardStop("bench brokenish"), false);
});

test("a relative path after cd resolves against that directory", () => {
  const memory = "agent-memory/ash/MEMORY.md";
  assert.equal(commandBlocked(`cat ${memory}`, ctx), false);
  assert.equal(commandBlocked(`cd ${ctx.realHome} && cat ${memory}`, ctx), true);
  assert.equal(commandBlocked(`cd ${ctx.realHome}; cat ${memory}`, ctx), true);
  assert.equal(commandBlocked(`cd ${ctx.realHome}\ncat ${memory}`, ctx), true);
  assert.equal(commandBlocked(`cd "${ctx.realHome}" && cat ${memory}`, ctx), true);
  assert.equal(commandBlocked(`cd ${ctx.realHome} && cd agent-memory && cat ash/MEMORY.md`, ctx), true);
  assert.equal(commandBlocked(`FOO=1 cd ${ctx.realHome} && cat ${memory}`, ctx), true);
  assert.equal(commandBlocked(`command cd ${ctx.realHome} && cat ${memory}`, ctx), true);
  assert.equal(commandBlocked(`command -p cd ${ctx.realHome} && cat ${memory}`, ctx), true);
  assert.equal(commandBlocked(`builtin cd ${ctx.realHome} && cat ${memory}`, ctx), true);
  assert.equal(commandBlocked(`env cd ${ctx.realHome} && cat ${memory}`, ctx), true);
  assert.equal(commandBlocked(`cd ${ctx.realHome} && rm notes.txt`, ctx), true);
  assert.equal(commandBlocked(`cd ${ctx.cwd} && rm notes.txt`, ctx), false);
  assert.equal(commandBlocked(`cd ${ctx.realHome} && echo hi > notes.txt`, ctx), true);
  assert.equal(commandBlocked(`cd ${ctx.cwd} && echo hi > notes.txt`, ctx), false);
  assert.equal(commandBlocked(`cd ${ctx.realHome} || cat ${memory}`, ctx), false);
  assert.equal(commandBlocked(`cd ${ctx.realHome} | cat ${memory}`, ctx), false);
  assert.equal(commandBlocked(`cd ${ctx.realHome} & cat ${memory}`, ctx), false);
  assert.equal(commandBlocked(`echo "cd ${ctx.realHome} && cat ${memory}"`, ctx), false);
  assert.equal(commandBlocked(`cd - && cat ${memory}`, ctx), true);
  assert.equal(commandBlocked("cd -", ctx), false);
  assert.equal(commandBlocked(`cd && cat ${memory}`, ctx), false);
});

test("the hook denies a real-home read and a kill, and allows a command inside the bench", () => {
  const hook = path.join(HERE, "bench-guard-hook.mjs");
  const args = [hook, ctx.realHome, ctx.devData, JSON.stringify(ctx.allowed), ctx.home];
  const deny = spawnSync(process.execPath, args, { input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: memoryFile } }), encoding: "utf8", cwd: fs.realpathSync(os.tmpdir()) });
  assert.equal(deny.status, 2);
  const kill = spawnSync(process.execPath, args, { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "kill 1" } }), encoding: "utf8", cwd: fs.realpathSync(os.tmpdir()) });
  assert.equal(kill.status, 2);
  const moved = spawnSync(process.execPath, args, { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `cd ${ctx.realHome} && cat agent-memory/ash/MEMORY.md` } }), encoding: "utf8", cwd: fs.realpathSync(os.tmpdir()) });
  assert.equal(moved.status, 2);
  const allow = spawnSync(process.execPath, args, { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" } }), encoding: "utf8", cwd: fs.realpathSync(os.tmpdir()) });
  assert.equal(allow.status, 0);
  const bad = spawnSync(process.execPath, [hook, ctx.realHome, ctx.devData, "not-json", ctx.home], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hi" } }), encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.equal(hookDecision("not json", ctx).deny, true);
});
