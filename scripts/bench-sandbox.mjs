// The macOS seatbelt profile for one bench run. sandbox-exec -f this file starts the agent CLI.
// The lexical fence in bench-guard.mjs still runs first. This is the layer under it.
// A missing sandbox-exec, or a profile that does not load, refuses the run. The agent is never started without it.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lexicalPosix } from "./bench-guard.mjs";

/** Directories a process may read so it can start. Not the user's files. `/Users` is named only as itself, never as a tree. */
const SYSTEM_READS = ["/usr", "/bin", "/sbin", "/opt", "/System", "/Library", "/private", "/dev", "/etc", "/var", "/tmp", "/usr/local", "/opt/homebrew", "/System/Volumes", "/Applications"];

/** Shared temp dirs a bench must not write. `/tmp` and `/var` are the symlink forms of the `/private` ones. The profile does not allow them; a run sets TMPDIR inside its own folder. */
export const SANDBOX_SYSTEM_TEMPS = ["/private/tmp", "/private/var/folders", "/private/var/tmp", "/tmp", "/var/folders"];

const FORBIDDEN_TOP = new Set(["agent-memory", ".ssh", ".claude", "Projects", "Worktrees"]);

export const SANDBOX_UNAVAILABLE = "The bench can't start the agent: the macOS sandbox isn't available, so it would run with nothing under it.";
export const SANDBOX_DIDNT_LOAD = "The bench can't start the agent: the sandbox profile didn't load, so it would run with nothing under it.";
export const SANDBOX_NO_HOME = "The bench can't start the agent: the real home isn't set, so the sandbox can't close it.";
export const SANDBOX_BAD_LIST = "The bench can't start the agent: its folder list couldn't be read, so the sandbox can't close the real home.";

/** The daily app's hub bridge. A bench never reaches it, even when a run names this port. */
export const DAILY_HUB_PORT = 18767;

const GATEWAY_REASON = "the local model gateway the launcher uses";
const CONTROL_REASON = "this dev copy's own control port";
const HUB_REASON = "this run's stub hub port";

function clean(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text.startsWith("/") || /["\\\n\r()]/.test(text)) return null;
  return lexicalPosix(text.replace(/\/+$/, "") || "/");
}

function quote(abs) {
  return `"${abs}"`;
}

function inside(file, root) {
  return !!file && !!root && (file === root || file.startsWith(`${root}/`));
}

function ancestorOf(root, file) {
  return !!root && !!file && file.startsWith(`${root}/`);
}

function unique(paths) {
  const out = [];
  const seen = new Set();
  for (const item of paths) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * True when this path is a read under the real home that the profile must not open.
 * The dev copy's own data folder, and the built app when one is named, are the only exceptions.
 */
export function forbiddenHomeRead(abs, { realHome, devData, builtApp } = {}) {
  const file = clean(abs);
  const home = clean(realHome);
  if (!file || !home || home === "/") return false;
  if (file === home) return true;
  if (!inside(file, home)) return false;
  const top = file.slice(home.length + 1).split("/")[0];
  if (top === "Worktrees") {
    const app = clean(builtApp);
    return !(app && inside(file, app));
  }
  if (FORBIDDEN_TOP.has(top)) return true;
  const support = `${home}/Library/Application Support`;
  if (file === support || inside(file, support)) {
    const data = clean(devData);
    return !(data && inside(file, data));
  }
  return false;
}

function keepRoot(abs, ctx) {
  if (!abs || abs === "/") return false;
  if (abs === ctx.realHome || inside(abs, ctx.realHome) || ancestorOf(abs, ctx.realHome)) return false;
  if (forbiddenHomeRead(abs, ctx)) return false;
  return true;
}

/** True only for the CLI's own install, config and credential files. Nothing else under the real home. */
export function isCliReadPath(abs, ctx = {}) {
  const file = clean(abs);
  const home = clean(ctx.realHome);
  if (!file || !home || home === "/") return false;
  const roots = [`${home}/.monocode-hub-dev/claude-config`, `${home}/.local/share/claude`, `${home}/.local/bin/claude`];
  const cli = clean(ctx.cli);
  if (cli) roots.push(cli);
  const base = path.posix.basename(cli ?? "");
  if (base === "claude-deepseek" || base === "claude-grok") {
    roots.push(`${home}/.local/share/claude-gpt/proxy-key`, `${home}/.local/share/claude-gpt/launcher.py`, `${home}/.local/share/claude-gpt/settings.json`, `${home}/.local/bin/${base}`);
  }
  return roots.some((root) => file === root || file.startsWith(`${root}/`));
}

/** The exact files the agent CLI reads in order to start. The rest of each folder stays closed. */
export function cliReadOnlyPaths({ realHome, cli, devConfig } = {}) {
  const home = clean(realHome);
  const out = [];
  const add = (file, reason) => {
    const abs = clean(file);
    if (!abs || abs === "/") return;
    out.push({ path: abs, reason });
  };
  add(cli, "the agent CLI this run starts");
  add(devConfig, "the dev copies' shared Claude config, read only, so a bench chat can sign in. Writes here stay closed.");
  if (home && home !== "/") {
    add(`${home}/.local/share/claude`, "Claude Code's install directory: the binary and the version files next to it");
    add(`${home}/.local/bin/claude`, "the claude program the DeepSeek and Grok launchers exec, and the one claude and haiku-test start");
    const base = path.posix.basename(clean(cli) ?? "");
    if (base === "claude-deepseek" || base === "claude-grok") {
      add(`${home}/.local/share/claude-gpt/proxy-key`, "the local gateway key the DeepSeek and Grok launchers read once, at start. The rest of that folder (config, auth, logs) stays closed.");
      add(`${home}/.local/share/claude-gpt/launcher.py`, "the Grok launcher script");
      add(`${home}/.local/share/claude-gpt/settings.json`, "the settings file the Grok launcher passes to Claude");
      add(`${home}/.local/bin/${base}`, "the launcher the bench was pointed at");
    }
  }
  return out;
}

function block(head, paths, extras = []) {
  const lines = [`(${head}`];
  for (const abs of paths) {
    lines.push(`    (literal ${quote(abs)})`);
    lines.push(`    (subpath ${quote(abs)})`);
  }
  for (const extra of extras) lines.push(`    ${extra}`);
  lines.push(")");
  return lines.join("\n");
}

/**
 * The profile for this run. realHome is closed for reads except the run folders and the listed read-only files.
 * Writes are the run folders only. Shared temp dirs stay closed; the run sets TMPDIR inside its own folder.
 * Outbound network is the named loopback ports only.
 */
export function benchSandboxProfile({ realHome, home, project, allowed = [], devData, readOnly = [], builtApp, cli, network = [], systemTemps = [] } = {}) {
  const real = clean(realHome);
  if (!real || real === "/") throw new Error("the real home isn't a path the sandbox can close");
  const tempHome = clean(home);
  if (!tempHome || tempHome === "/" || tempHome === real) throw new Error("the temporary home isn't a path the sandbox can keep");
  const ctx = { realHome: real, devData, builtApp, cli };
  if (forbiddenHomeRead(tempHome, ctx) || ancestorOf(tempHome, real)) throw new Error("the temporary home is inside a folder the sandbox keeps closed");
  if (project != null && project !== "" && !clean(project)) throw new Error("the project path can't go in the sandbox profile");
  const namedRoots = unique([tempHome, clean(project), clean(devData), ...allowed.map((item) => clean(item))].filter((abs) => keepRoot(abs, ctx)));
  // `/tmp` is `/private/tmp`. The kernel checks the real path, so a run folder is named both ways. Only that folder, never the shared temp itself.
  const runRoots = unique(
    namedRoots.flatMap((abs) => {
      const both = [abs];
      try {
        const real = clean(fs.realpathSync(abs));
        if (real && real !== abs && keepRoot(real, ctx) && !SANDBOX_SYSTEM_TEMPS.includes(real)) both.push(real);
      } catch {
        // not there yet: the name above is the one the run asked for
      }
      return both;
    }),
  );
  const extras = [];
  for (const item of readOnly) {
    const abs = clean(item?.path ?? item);
    const reason = String(item?.reason ?? "a file the agent CLI reads in order to start").replace(/[\r\n"]/g, " ").trim();
    if (!abs || abs === "/" || abs === real || ancestorOf(abs, real)) continue;
    if (inside(abs, real) && !isCliReadPath(abs, ctx)) continue;
    if (forbiddenHomeRead(abs, ctx)) continue;
    if (abs.startsWith("/Users/") && !inside(abs, real) && !runRoots.some((root) => inside(abs, root))) continue;
    extras.push({ path: abs, reason });
  }
  const temps = unique(systemTemps.map((item) => clean(item)).filter((abs) => abs && abs !== "/"));
  const reads = unique(SYSTEM_READS.map((item) => clean(item)).filter((abs) => abs && abs !== "/"));
  const lines = [];
  lines.push("(version 1)");
  lines.push("(deny default)");
  lines.push(";; Bench seatbelt profile. Closes the real home, writes outside this run, signals to other processes, and outbound network except the named loopback ports.");
  lines.push(";; The process can run, including a script's interpreter. A child inherits this profile.");
  lines.push(";; A child inherits this profile. A modifier that would let it leave the sandbox is not one this macOS accepts, so none is written.");
  lines.push("(allow process-exec*)");
  lines.push("(allow process-fork)");
  lines.push("(allow file-map-executable)");
  lines.push("(allow process-info* (target self))");
  lines.push("(allow sysctl-read)");
  lines.push("(allow file-ioctl)");
  lines.push(";; Signals to anything outside this sandbox are closed. The process and its own children stay allowed.");
  lines.push("(deny signal (target others))");
  lines.push("(allow signal (target self))");
  lines.push("(allow signal (target children))");
  lines.push("(allow signal (target same-sandbox))");
  lines.push(";; The launcher asks the system who this user is, so it can find its own binary. This is not a file under the home.");
  lines.push("(allow mach-lookup");
  lines.push('    (global-name "com.apple.system.opendirectoryd.libinfo")');
  lines.push('    (global-name "com.apple.system.opendirectoryd.libinfo_v2")');
  lines.push('    (global-name "com.apple.system.DirectoryService.libinfo_v1"))');
  lines.push(";; System locations a process needs in order to start. Not the user's files.");
  lines.push(block("allow file-read*", reads, ['(literal "/")', '(literal "/Users")']));
  lines.push(";; The real home is closed. Metadata only, so a path can be walked to the few files below that the CLI must read.");
  lines.push(block("deny file-read*", [real]));
  lines.push(block("allow file-read-metadata", [real]));
  if (runRoots.length) {
    lines.push(";; This run's own folders.");
    lines.push(block("allow file-read*", runRoots));
  }
  for (const item of extras) {
    if (runRoots.includes(item.path)) continue;
    lines.push(`;; ${item.reason}`);
    lines.push(block("allow file-read*", [item.path]));
  }
  lines.push(";; Writes: this run's folders only, including the real path when /tmp or /var/folders is a symlink. The shared temp dirs themselves stay closed. The run sets TMPDIR inside its own folder. No other path there is allowed: no CLI spawn has shown it needs one.");
  const firstWrite = unique([...runRoots, ...temps]);
  if (firstWrite.length) lines.push(block("allow file-write*", firstWrite, ['(literal "/dev/null")', '(literal "/dev/tty")', '(literal "/dev/dtracehelper")']));
  lines.push(block("deny file-write*", [real]));
  if (runRoots.length) lines.push(block("allow file-write*", runRoots));
  lines.push(";; Outbound network is closed. Loopback is closed too, except the ports named below.");
  lines.push("(deny network-outbound)");
  lines.push("(deny network*)");
  for (const item of acceptedPorts(network)) {
    lines.push(`;; ${item.reason} (${item.host}:${item.port}). localhost is this scheme's name for every loopback address.`);
    lines.push("(allow network-outbound");
    lines.push(`    (remote ip "localhost:${item.port}"))`);
  }
  lines.push(";; A TCP client binds an ephemeral local port. The remote port is what the rules above name.");
  lines.push("(allow network-bind");
  lines.push('    (local ip "localhost:*"))');
  lines.push("");
  return lines.join("\n");
}

function loopbackHost(host) {
  const text = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (text === "localhost" || text === "127.0.0.1" || text === "::1") return text;
  return null;
}

function portNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535 || n === DAILY_HUB_PORT) return null;
  return n;
}

/** A loopback host:port, or a bare port meaning 127.0.0.1. The daily hub port and anything else is null. */
export function parseLoopbackEndpoint(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const port = portNumber(text);
    return port ? { host: "127.0.0.1", port } : null;
  }
  const v6 = text.match(/^\[?::1\]?:(\d+)$/);
  if (v6) {
    const port = portNumber(v6[1]);
    return port ? { host: "::1", port } : null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const host = loopbackHost(url.hostname);
  const port = portNumber(url.port);
  if (!host || !port) return null;
  return { host, port };
}

function acceptedPorts(network) {
  const out = [];
  for (const item of network ?? []) {
    const parsed = parseLoopbackEndpoint(item?.host != null && item?.port != null ? `${item.host}:${item.port}` : item);
    if (!parsed || out.some((have) => have.port === parsed.port)) continue;
    const reason = String(item?.reason ?? "a loopback port this run named").replace(/[\r\n"]/g, " ").trim() || "a loopback port this run named";
    out.push({ host: parsed.host, port: parsed.port, reason });
  }
  return out;
}

/**
 * Listen lines for the local gateway. A non-loopback address is reported and not turned into an allow.
 * `*` means the process also listens on every interface; the CLI is still only allowed to dial loopback.
 */
export function parseGatewayListens(text) {
  const ports = [];
  let internet = false;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes("cli-proxy-api")) continue;
    const listen = line.match(/TCP\s+(\S+):(\d+)\s+\(LISTEN\)/);
    if (!listen) continue;
    let host = listen[1];
    if (host === "*") host = "127.0.0.1";
    if (!loopbackHost(host)) {
      internet = true;
      continue;
    }
    const port = portNumber(listen[2]);
    if (!port || ports.some((item) => item.port === port)) continue;
    ports.push({ host: loopbackHost(host), port });
  }
  return { ok: !internet, internet, ports };
}

let gatewayCache = null;

/** What cli-proxy-api is listening on, from lsof. Never reads the gateway's config. Fails closed. */
export function observeGateway(deps = {}) {
  if (gatewayCache && !deps.fresh) return gatewayCache;
  const exec = deps.execFileSync ?? execFileSync;
  try {
    const text = exec("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "+c", "0"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
    const parsed = parseGatewayListens(text);
    if (!deps.fresh && !parsed.internet) gatewayCache = parsed;
    return parsed;
  } catch {
    return { ok: true, internet: false, ports: [] };
  }
}

export function resetGatewayCache() {
  gatewayCache = null;
}

/** The only loopback ports a bench model call may dial. Port 18767 is never among them. */
export function namedLoopbackPorts(env = {}, deps = {}) {
  const out = [];
  const add = (value, reason) => {
    const parsed = parseLoopbackEndpoint(value);
    if (!parsed || out.some((item) => item.port === parsed.port)) return;
    out.push({ host: parsed.host, port: parsed.port, reason });
  };
  const gateway = env.REALTEST_GATEWAY;
  if (gateway != null && String(gateway).trim() !== "") add(gateway, GATEWAY_REASON);
  else if (deps.observe !== false) {
    const seen = (deps.observeGateway ?? observeGateway)(deps);
    if (!seen?.internet) {
      for (const item of seen?.ports ?? []) add(`${item.host}:${item.port}`, GATEWAY_REASON);
    }
  }
  add(env.MONOCODE_CONTROL_ENDPOINT, CONTROL_REASON);
  const hub = env.REALTEST_HUB_PORT != null && String(env.REALTEST_HUB_PORT).trim() !== "" ? env.REALTEST_HUB_PORT : env.MONOCODE_HUB_PORT;
  add(hub, HUB_REASON);
  return out;
}

/** True when this URL is one of the named loopback ports. Used for in-process model calls, which have no seatbelt of their own. */
export function modelUrlAllowed(url, env = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = loopbackHost(parsed.hostname);
  const port = portNumber(parsed.port);
  if (!host || !port) return false;
  return namedLoopbackPorts(env, { observe: false }).some((item) => item.port === port);
}

function plainFailure(error) {
  const text = String(error?.message ?? "");
  if (/real home isn't set/.test(text)) return SANDBOX_NO_HOME;
  if (text.startsWith("the ")) return `The bench can't start the agent: ${text}.`;
  return SANDBOX_DIDNT_LOAD;
}

/**
 * `sandbox-exec -f <profile> <bin> ...`, or a refusal. Never a bare command: a missing sandbox or a profile that
 * does not load is `{ ok: false }` and the caller must not spawn the agent.
 */
export function agentCommand(bin, args, env = {}, deps = {}) {
  if (!env.REALTEST_REAL_HOME || !String(env.REALTEST_REAL_HOME).trim()) return { ok: false, reason: SANDBOX_NO_HOME };
  let allowed = [];
  if (env.REALTEST_ALLOWED) {
    try {
      const parsed = JSON.parse(env.REALTEST_ALLOWED);
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return { ok: false, reason: SANDBOX_BAD_LIST };
      allowed = parsed;
    } catch {
      return { ok: false, reason: SANDBOX_BAD_LIST };
    }
  }
  const execPath = env.REALTEST_SANDBOX_EXEC || "/usr/bin/sandbox-exec";
  const exists = deps.existsSync ?? fs.existsSync;
  if (!exists(execPath)) return { ok: false, reason: SANDBOX_UNAVAILABLE };
  const state = clean(env.REALTEST_STATE);
  if (!state || state === "/") return { ok: false, reason: SANDBOX_DIDNT_LOAD };
  let profile;
  try {
    const readOnly = deps.readOnly ?? cliReadOnlyPaths({ realHome: env.REALTEST_REAL_HOME, cli: bin, devConfig: env.REALTEST_CLAUDE_CONFIG });
    profile = benchSandboxProfile({
      realHome: env.REALTEST_REAL_HOME,
      home: env.HOME,
      project: env.REALTEST_PROJECT,
      allowed,
      devData: env.REALTEST_DEV_DATA,
      readOnly,
      builtApp: env.REALTEST_BUILT_APP,
      cli: bin,
      network: deps.network ?? namedLoopbackPorts(env, deps),
    });
  } catch (error) {
    return { ok: false, reason: plainFailure(error) };
  }
  if (profile.includes("(allow default)")) return { ok: false, reason: SANDBOX_DIDNT_LOAD };
  const file = path.join(state, "sandbox.sb");
  const writeFile = deps.writeFileSync ?? fs.writeFileSync.bind(fs);
  const mkdir = deps.mkdirSync ?? fs.mkdirSync.bind(fs);
  try {
    mkdir(state, { recursive: true });
    writeFile(file, profile);
  } catch {
    return { ok: false, reason: SANDBOX_DIDNT_LOAD };
  }
  const spawnSyncImpl = deps.spawnSync ?? spawnSync;
  const check = spawnSyncImpl(execPath, ["-f", file, "/usr/bin/true"], {
    encoding: "utf8",
    timeout: 15000,
    env: { HOME: env.HOME, TMPDIR: env.TMPDIR || env.HOME, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
  });
  if (!check || check.error || check.status !== 0) {
    try {
      writeFile(path.join(state, "sandbox-error.txt"), `${check?.stderr ?? ""}${check?.stdout ?? ""}${check?.error?.message ?? ""}`);
    } catch {
      // the run folder went away: the refusal still stands
    }
    return { ok: false, reason: SANDBOX_DIDNT_LOAD };
  }
  return { ok: true, command: execPath, args: ["-f", file, bin, ...(args ?? [])], profile, file };
}

/** A path inside a shared temp dir (`/private/tmp`, `/private/var/folders`, or a symlink form of those). */
export function isSharedTemp(abs) {
  const file = clean(abs);
  if (!file || file === "/") return false;
  return SANDBOX_SYSTEM_TEMPS.some((root) => file === root || file.startsWith(`${root}/`));
}

/**
 * This run's temp dir. A TMPDIR already inside the run and outside the shared temps is kept. Anything else,
 * including `/private/tmp` and the per-user dir under `/private/var/folders`, becomes `<home>/tmp`.
 */
export function privateTempDir(env = {}) {
  const real = clean(env.REALTEST_REAL_HOME) || "";
  const home = clean(env.HOME);
  const tmp = clean(env.TMPDIR);
  const inHome = home && home !== "/" && tmp && (tmp === home || inside(tmp, home));
  const outsideReal = !real || (tmp !== real && !inside(tmp, real));
  if (inHome && outsideReal && !isSharedTemp(tmp)) return tmp;
  if (home && home !== "/" && (!real || (home !== real && !inside(home, real)))) return `${home}/tmp`;
  return "";
}

/** A home and a state dir that are not the real home, so a grader or tester can use the same profile. */
export function cliSandboxEnv(env = {}) {
  const real = clean(env.REALTEST_REAL_HOME) || clean(os.homedir());
  const givenHome = clean(env.HOME);
  const homeIsReal = !givenHome || givenHome === real || inside(givenHome, real);
  const home = homeIsReal ? fs.mkdtempSync(path.join(os.tmpdir(), "bench-cli-")) : givenHome;
  let state = clean(env.REALTEST_STATE);
  if (!state || state === "/" || state === real || inside(state, real)) state = home;
  const temp = privateTempDir({ ...env, HOME: home, REALTEST_REAL_HOME: real });
  if (temp && fs.existsSync(home)) {
    try {
      fs.mkdirSync(temp, { recursive: true });
    } catch {
      // a missing dir fails the child's write; it is not pointed back at a shared temp
    }
  }
  return {
    ...env,
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    CLAUDE_TMPDIR: temp,
    REALTEST_REAL_HOME: real,
    REALTEST_STATE: state,
    REALTEST_CLAUDE_CONFIG: env.REALTEST_CLAUDE_CONFIG || env.CLAUDE_CONFIG_DIR || "",
  };
}

function spawnCaptured(bin, args, { input, timeout, env, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout ?? 300_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

function refused(reason) {
  return { status: 2, stdout: "", stderr: reason };
}

/**
 * A directory the sandboxed process can start in. One inside the real home makes the shell die on getcwd,
 * so the temporary home is used instead. A directory outside the real home is kept.
 */
export function sandboxCwd(cwd, env = {}) {
  const real = clean(env.REALTEST_REAL_HOME) || "";
  const home = clean(env.HOME);
  const asked = clean(typeof cwd === "string" ? cwd : "");
  const blocked = !asked || (real && (asked === real || inside(asked, real)));
  if (!blocked) return asked;
  if (home && home !== "/" && !(real && (home === real || inside(home, real)))) return home;
  return os.tmpdir();
}

/** The tester's CLI spawn, under the same profile. A missing sandbox does not run the CLI. */
export function sandboxedCli(bin, args, opts = {}, deps = {}) {
  const env = cliSandboxEnv(opts.env ?? {});
  const launch = agentCommand(bin, args, env, deps);
  if (!launch.ok) return Promise.resolve(refused(launch.reason));
  const run = deps.spawnAsync ?? spawnCaptured;
  return run(launch.command, launch.args, { ...opts, env, cwd: sandboxCwd(opts.cwd ?? process.cwd(), env) });
}

/** The grader's CLI spawn, under the same profile. */
export function sandboxedCliSync(bin, args, opts = {}, deps = {}) {
  const env = cliSandboxEnv(opts.env ?? {});
  const launch = agentCommand(bin, args, env, deps);
  if (!launch.ok) return refused(launch.reason);
  const run = deps.spawnSync ?? spawnSync;
  return run(launch.command, launch.args, { ...opts, env, cwd: sandboxCwd(opts.cwd ?? process.cwd(), env) });
}
