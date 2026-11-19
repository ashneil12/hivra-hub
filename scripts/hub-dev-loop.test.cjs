// Guard: the Hub's dev loop must open the Hub, in a dev slot of its own (Phase 1b WP2, scripts/hub-dev.mjs).
//
// Why this exists. `tauri dev` reads `build.beforeDevCommand` from the *base* config
// (`src-tauri/tauri.conf.json`), which runs plain `npm run dev`. The Hub overlay
// (`tauri.hub.conf.json`) used to set only `bundle`, so no dev path ever set
// `VITE_MONOCODE_HUB=1`. `IS_HUB_BUNDLE` (src/features/hub/model/hubBundle.ts) reads that
// variable at build time, so a dev session came up as MonoCode rather than the Hub — the
// dev loop could not show a Hub change without building and installing the app.
//
// Since WP2 `npm run hub:dev` is scripts/hub-dev.mjs: each worktree gets its own slot (identifier, data folder, vite
// port, devUrl, devCsp) and the daily identifier is never one of them. These tests check the slot rules on fixtures:
// nothing here starts the app, and every HOME is a throwaway folder.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const base = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const hub = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.hub.conf.json"), "utf8"));
const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;

const HUB_FLAG = "VITE_MONOCODE_HUB=1";
const DAILY = "com.ash.monocode-hub";
const DEV_PREFIX = "com.ash.monocode-hub.dev.";

const load = (name) => import(pathToFileURL(path.join(__dirname, name)).href);

function tempDir(t, prefix = "hub-dev-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** RFC 7396 JSON merge patch, the way `tauri dev --config` layers configs. */
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

// ---- the Hub flag -----------------------------------------------------------------------------------------------------------

test("the Hub's dev command sets the flag that makes the app open on the Hub", () => {
  const command = hub.build?.beforeDevCommand ?? "";
  assert.ok(
    command.includes(HUB_FLAG),
    `src-tauri/tauri.hub.conf.json build.beforeDevCommand must include ${HUB_FLAG}, or a dev session opens MonoCode instead of the Hub (got: ${JSON.stringify(command)})`,
  );
});

test("the Hub's dev command still runs the dev server the base config points at", () => {
  // Only `npm run dev` serves the devUrl; a command that forgot the scripts would leave `tauri dev` waiting on nothing.
  const command = hub.build?.beforeDevCommand ?? "";
  assert.ok(command.includes("npm run dev"), `the Hub's dev command must still start vite (got: ${JSON.stringify(command)})`);
});

test("both build paths set the Hub flag, so no path can open MonoCode under the Hub's id", () => {
  assert.ok((base.build?.beforeBuildCommand ?? "").includes(HUB_FLAG), "the base build command must set the Hub flag");
  assert.ok((hub.build?.beforeDevCommand ?? "").includes(HUB_FLAG), "the Hub dev command must set the Hub flag");
});

test("hub:dev runs scripts/hub-dev.mjs, which passes the overlay and then the slot's config to tauri dev", async () => {
  assert.equal(scripts["hub:dev"], "node scripts/hub-dev.mjs");
  assert.equal(scripts["hub:seed-dev"], "node scripts/hub-seed-dev.mjs");
  assert.equal(scripts["hub:doctor"], "node scripts/hub-doctor.mjs");
  const { tauriArgs } = await load("hub-dev.mjs");
  const args = tauriArgs("/x/target/hub-dev/s.conf.json", ["--release"], root);
  assert.deepEqual(args, [
    "dev",
    "--config",
    path.join(root, "src-tauri/tauri.hub.conf.json"),
    "--config",
    "/x/target/hub-dev/s.conf.json",
    "--release",
  ]);
});

test("the merged dev config keeps the Hub flag, runs vite on the slot's port and carries a dev identifier", async () => {
  const { slotConfig } = await load("hub-dev.mjs");
  const slot = slotConfig({ slot: "hub-1b-slots", port: 1460, base, overlay: hub });
  const merged = mergePatch(mergePatch(base, hub), slot);
  assert.equal(merged.identifier, `${DEV_PREFIX}hub-1b-slots`);
  assert.equal(merged.productName, "MonoCode Hub Dev");
  assert.equal(merged.build.devUrl, "http://localhost:1460");
  assert.match(merged.build.beforeDevCommand, /^MONOCODE_VITE_PORT=1460 /);
  assert.ok(merged.build.beforeDevCommand.includes(HUB_FLAG));
  assert.ok(merged.build.beforeDevCommand.includes("npm run dev"));
  // Only devCsp changes: the release CSP, windows and bundle settings are the base's.
  assert.equal(merged.app.security.csp, base.app.security.csp);
  assert.deepEqual(merged.app.windows, base.app.windows);
  assert.deepEqual(merged.bundle.macOS, { ...base.bundle.macOS, ...hub.bundle.macOS });
});

// ---- slot names -------------------------------------------------------------------------------------------------------------

test("slot names: worktree folders and branch names with '/' become a-z0-9 and dashes, 48 at most", async () => {
  const { slugify, isValidSlot } = await load("hub-dev.mjs");
  const cases = {
    "hub-1b-slots": "hub-1b-slots",
    "monocode-hub": "monocode-hub",
    "hub/1b-dev-slots": "hub-1b-dev-slots",
    "feature/Ash's Big_Idea": "feature-ash-s-big-idea",
    "refs/heads/fix//double--slash/": "refs-heads-fix-double-slash",
    "Café Ünïcode": "cafe-unicode",
    "--leading-and-trailing--": "leading-and-trailing",
    "UPPER/case": "upper-case",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(slugify(input), expected, input);
    assert.ok(isValidSlot(slugify(input)), input);
  }
  const long = slugify(`team/${"very-long-branch-name-".repeat(5)}end`);
  assert.ok(long.length <= 48 && isValidSlot(long), long);
  assert.equal(slugify("a".repeat(47) + "/b"), "a".repeat(47), "a cut never ends on a dash");
  assert.equal(slugify("///"), "");
  assert.equal(slugify(""), "");
});

test("the identifier is never the daily one: only a valid slot makes one, and it is always a dev copy's", async () => {
  const { slotIdentifier, slugify } = await load("hub-dev.mjs");
  const { kindOf } = await load("hub-bundle.mjs");
  for (const name of ["hub-1b-slots", "hub/next", "monocode-hub", "default", "x", "a1-b2"]) {
    const identifier = slotIdentifier(slugify(name));
    assert.ok(identifier.startsWith(DEV_PREFIX), identifier);
    assert.notEqual(identifier, DAILY);
    assert.equal(kindOf(identifier), "dev");
  }
  for (const bad of ["", "-x", "x-", "Upper", "a/b", "a.b", "a".repeat(49), "../daily", undefined, null])
    assert.throws(() => slotIdentifier(bad), /not a valid dev slot/, String(bad));
});

test("slot clashes: a second worktree with the same folder name gets a 4-character path hash; nothing else does", async (t) => {
  const { resolveSlot, shortHash } = await load("hub-dev.mjs");
  const home = tempDir(t);
  const first = path.join(home, "Worktrees/feature");
  const second = path.join(home, "Projects/feature");
  for (const dir of [first, second]) fs.mkdirSync(dir, { recursive: true });

  // New: the folder's name.
  assert.deepEqual(resolveSlot({ worktree: first, registry: { slots: {} } }), { slot: "feature", reason: "new" });
  const registry = { slots: { feature: { worktree: first } } };
  // The same worktree keeps its slot.
  assert.deepEqual(resolveSlot({ worktree: first, registry }), { slot: "feature", reason: "registered" });
  // Another worktree, same name: hashed, stable, valid.
  const clash = resolveSlot({ worktree: second, registry });
  assert.equal(clash.reason, "clash");
  assert.equal(clash.slot, `feature-${shortHash(second)}`);
  assert.match(clash.slot, /^feature-[0-9a-f]{4}$/);
  assert.equal(resolveSlot({ worktree: second, registry }).slot, clash.slot);
  // Once registered under its hashed name, it keeps that name.
  registry.slots[clash.slot] = { worktree: second };
  assert.deepEqual(resolveSlot({ worktree: second, registry }), { slot: clash.slot, reason: "registered" });
  // A slot whose worktree is gone is taken over, without a hash.
  const gone = { slots: { feature: { worktree: path.join(home, "Worktrees/removed") } } };
  assert.equal(resolveSlot({ worktree: second, registry: gone }).slot, "feature");
  assert.equal(resolveSlot({ worktree: second, registry: gone }).reason, "taken over");
  // A long name still fits 48 characters with its hash.
  const longName = path.join(home, "Worktrees", "x".repeat(60));
  fs.mkdirSync(longName, { recursive: true });
  const longClash = resolveSlot({ worktree: longName, registry: { slots: { ["x".repeat(48)]: { worktree: first } } } });
  assert.equal(longClash.slot.length, 48);
  assert.match(longClash.slot, /^x{43}-[0-9a-f]{4}$/);
});

test("slot names from a branch with '/' (--slot hub/1b-dev-slots), and a clash on an explicit name", async (t) => {
  const { resolveSlot } = await load("hub-dev.mjs");
  const home = tempDir(t);
  const mine = path.join(home, "a");
  const theirs = path.join(home, "b");
  for (const dir of [mine, theirs]) fs.mkdirSync(dir);
  assert.equal(resolveSlot({ worktree: mine, requested: "hub/1b-dev-slots", registry: { slots: {} } }).slot, "hub-1b-dev-slots");
  const taken = { slots: { "hub-1b-dev-slots": { worktree: theirs } } };
  const result = resolveSlot({ worktree: mine, requested: "hub/1b-dev-slots", registry: taken });
  assert.equal(result.reason, "clash");
  assert.match(result.slot, /^hub-1b-dev-slots-[0-9a-f]{4}$/);
});

test("a clash is also found from the slot's running.json when slots.json has lost it", async (t) => {
  const { planSlot } = await load("hub-dev.mjs");
  const home = tempDir(t);
  const other = path.join(home, "Projects/feature");
  const mine = path.join(home, "Worktrees/feature");
  for (const dir of [other, mine]) fs.mkdirSync(dir, { recursive: true });
  const data = path.join(home, "Library/Application Support", `${DEV_PREFIX}feature`);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    path.join(data, "running.json"),
    JSON.stringify({ pid: 1, kind: "dev", slot: "feature", bundlePath: path.join(other, "target/debug/MonoCode Hub Dev feature.app") }),
  );
  const plan = await planSlot({ worktree: mine, home, isFree: async () => true });
  assert.equal(plan.reason, "clash");
  assert.match(plan.slot, /^feature-[0-9a-f]{4}$/);
});

test("two worktrees plan two slots: different identifiers, data folders and config files, none of them daily", async (t) => {
  const { planSlot, registerSlot, readRegistry } = await load("hub-dev.mjs");
  const home = tempDir(t);
  const first = path.join(home, "Worktrees/hub-1b-slots");
  const second = path.join(home, "Worktrees/hub-1b-slots-two");
  for (const dir of [first, second]) fs.mkdirSync(dir, { recursive: true });
  const used = new Set();
  const isFree = async (port) => !used.has(port);
  const a = await planSlot({ worktree: first, home, isFree });
  registerSlot(a, home);
  used.add(a.port);
  const b = await planSlot({ worktree: second, home, isFree });
  registerSlot(b, home);
  assert.notEqual(a.slot, b.slot);
  assert.notEqual(a.identifier, b.identifier);
  assert.notEqual(a.dataDir, b.dataDir);
  assert.notEqual(a.port, b.port);
  assert.notEqual(a.configFile, b.configFile);
  for (const plan of [a, b]) {
    assert.notEqual(plan.identifier, DAILY);
    assert.ok(plan.identifier.startsWith(DEV_PREFIX));
    assert.equal(path.basename(plan.dataDir), plan.identifier);
    assert.equal(plan.buildDir, path.join(home, "Library/Caches/monocode-hub/cargo-build"));
    assert.ok(!plan.tokenFile.includes(".local/share/exo-cc-studio"), "never the live key");
  }
  const registry = readRegistry(home);
  assert.equal(registry.slots[a.slot].worktree, first);
  assert.equal(registry.slots[b.slot].worktree, second);
});

test("the registry keeps every slot when several are registered", async (t) => {
  const { updateRegistry, readRegistry } = await load("hub-dev.mjs");
  const home = tempDir(t);
  for (let i = 0; i < 10; i += 1) updateRegistry(home, (registry) => (registry.slots[`s${i}`] = { worktree: `/w/${i}` }));
  assert.equal(Object.keys(readRegistry(home).slots).length, 10);
  assert.ok(!fs.existsSync(path.join(home, ".monocode-hub-dev/slots.json.lock")));
});

// ---- ports ------------------------------------------------------------------------------------------------------------------

test("ports: each slot hashes into 1430-1920 in steps of 10, never 1420", async () => {
  const { preferredPort, BASE_PORT, PORT_STEP, PORT_COUNT } = await load("hub-dev.mjs");
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const port = preferredPort(`slot-${i}`);
    assert.ok(port >= BASE_PORT && port <= BASE_PORT + PORT_STEP * (PORT_COUNT - 1), String(port));
    assert.equal((port - BASE_PORT) % PORT_STEP, 0);
    assert.notEqual(port, 1420);
    seen.add(port);
  }
  assert.ok(seen.size > 40, "the hash spreads slots across the grid");
  assert.equal(preferredPort("hub-1b-slots"), preferredPort("hub-1b-slots"), "stable");
});

test("busy-port probe: a port something listens on is skipped for the next free one in the grid", async (t) => {
  const { preferredPort, pickPort, isPortFree, PORT_STEP, BASE_PORT, PORT_COUNT } = await load("hub-dev.mjs");
  // Find a slot whose own port is free right now, then occupy it the way vite would.
  let slot;
  for (let i = 0; i < 200 && !slot; i += 1) if (await isPortFree(preferredPort(`probe-${process.pid}-${i}`))) slot = `probe-${process.pid}-${i}`;
  assert.ok(slot, "found a free slot port");
  const own = preferredPort(slot);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(own, "127.0.0.1", resolve));
  t.after(() => server.close());
  assert.equal(await isPortFree(own), false, "a listening port is busy");
  const picked = await pickPort(slot);
  assert.notEqual(picked, own);
  assert.equal((picked - BASE_PORT) % PORT_STEP, 0);
  assert.ok(picked >= BASE_PORT && picked < BASE_PORT + PORT_STEP * PORT_COUNT);
  // With every port taken, it says so instead of guessing.
  await assert.rejects(pickPort(slot, { isFree: async () => false }), /no free port/);
});

test("vite takes the slot's port from MONOCODE_VITE_PORT, keeps strictPort, and defaults to 1420", () => {
  const read = (env) => {
    const script = `
      const { loadConfigFromFile } = await import("vite");
      const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, "vite.config.ts", process.cwd(), "silent");
      console.log(JSON.stringify({ ...loaded.config.server, cacheDir: loaded.config.cacheDir }));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: { ...process.env, MONOCODE_VITE_PORT: "", ...env },
      encoding: "utf8",
    });
    return JSON.parse(out.trim().split("\n").pop());
  };
  const slot = read({ MONOCODE_VITE_PORT: "1460" });
  assert.equal(slot.port, 1460);
  assert.equal(slot.strictPort, true);
  assert.equal(read({}).port, 1420);
  // Two slots from one worktree never share pre-bundled deps (the second window went blank on the Mac, 21 Oct).
  assert.equal(slot.cacheDir, "target/vite-1460");
  assert.notEqual(read({ MONOCODE_VITE_PORT: "1470" }).cacheDir, slot.cacheDir);
  assert.equal(read({}).cacheDir, "target/vite");
});

// ---- CSP --------------------------------------------------------------------------------------------------------------------

test("the slot's devCsp carries the slot's port, not 1420, and leaves every other directive alone", async () => {
  const { devCsp } = await load("hub-dev.mjs");
  const baseCsp = base.app.security.devCsp;
  assert.ok(baseCsp.includes("localhost:1420"), "the base devCsp hardcodes 1420 (why the slot needs its own)");
  const csp = devCsp(baseCsp, 1460);
  assert.ok(!csp.includes("1420"), csp);
  const directives = Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
  for (const source of ["http://localhost:1460", "ws://localhost:1460", "http://127.0.0.1:1460", "ws://127.0.0.1:1460"])
    assert.ok(directives["connect-src"].includes(source), source);
  const baseDirectives = Object.fromEntries(baseCsp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...rest]) => [name, rest]));
  for (const [name, sources] of Object.entries(baseDirectives))
    if (name !== "connect-src") assert.deepEqual(directives[name], sources, name);
  assert.ok(directives["connect-src"].includes("ipc:"), "keeps the IPC sources");
  // A CSP without connect-src gets one.
  assert.match(devCsp("default-src 'self'", 1470), /connect-src 'self' http:\/\/localhost:1470/);
});

// ---- the environment ----------------------------------------------------------------------------------------------------------

test("the dev environment shares the Rust build cache and drops what an enclosing shell set for another copy", async (t) => {
  const { devEnvironment } = await load("hub-dev.mjs");
  const home = tempDir(t);
  const inherited = {
    PATH: "/usr/bin",
    MONOCODE_HUB_REPO: "/Users/ash/Projects/monocode-hub",
    MONOCODE_HUB_BACKGROUND: "1",
    MONOCODE_VITE_PORT: "1450",
    TAURI_CONFIG: '{"identifier":"com.ash.monocode-hub"}',
    TAURI_ENV_DEBUG: "true",
  };
  const off = devEnvironment({ slot: "a", home, env: inherited });
  assert.equal(off.CARGO_BUILD_BUILD_DIR, path.join(home, "Library/Caches/monocode-hub/cargo-build"));
  assert.equal(off.MONOCODE_DEV_APP_NAME, "MonoCode Hub Dev a");
  for (const key of ["MONOCODE_HUB_REPO", "MONOCODE_HUB_BACKGROUND", "MONOCODE_VITE_PORT", "TAURI_CONFIG", "TAURI_ENV_DEBUG"])
    assert.equal(off[key], undefined, key);
  assert.equal(off.PATH, "/usr/bin");
  // A memory folder for Export comes only from --memory, never from whatever the shell had.
  const leaked = devEnvironment({ slot: "a", home, env: { ...inherited, MONOCODE_HUB_MEMORY_ROOT: "/Users/ash/agent-memory" } });
  assert.equal(leaked.MONOCODE_HUB_MEMORY_ROOT, undefined);
  const asked = devEnvironment({ slot: "a", memory: "/tmp/fixture-memory", home, env: inherited });
  assert.equal(asked.MONOCODE_HUB_MEMORY_ROOT, "/tmp/fixture-memory");
  // SH-3: started from a chat inside the daily app, hub:dev's shell carries that chat's app and control credentials.
  const agent = {
    DROPWAVE_AGENT_PROCESS: "1",
    MONOCODE_APP_ENDPOINT: "127.0.0.1:49152",
    MONOCODE_APP_TOKEN: "daily-app-grant",
    MONOCODE_CONTROL_ENDPOINT: "127.0.0.1:49152",
    MONOCODE_CONTROL_TOKEN: "daily-control-grant",
    MONOCODE_APP_ANYTHING_NEW: "x",
  };
  const fromChat = devEnvironment({ slot: "a", home, env: { ...inherited, ...agent } });
  for (const key of Object.keys(agent)) assert.equal(fromChat[key], undefined, key);
  assert.equal(fromChat.PATH, "/usr/bin");
});

test("--print shows the plan and changes nothing; bad options are refused", (t) => {
  const home = tempDir(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, "hub-dev.mjs"), "--print", "--slot", "hub/print-check"], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.slot, "hub-print-check");
  assert.equal(plan.identifier, `${DEV_PREFIX}hub-print-check`);
  assert.ok(plan.dataDir.startsWith(path.join(home, "Library/Application Support/")));
  assert.equal(plan.hub, undefined, "no Ash OS stand-in any more (WP-04)");
  assert.deepEqual(fs.readdirSync(home), [], "nothing written");
  const bad = spawnSync(process.execPath, [path.join(__dirname, "hub-dev.mjs"), "--print", "--hub", "daily"], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--hub is gone/);
});

// ---- stopping -----------------------------------------------------------------------------------------------------------------

test("descendants walks the whole tree under a pid, and nothing else", async () => {
  const { descendants } = await load("hub-dev.mjs");
  const listing = [
    { pid: 10, ppid: 1, command: "node scripts/hub-dev.mjs" },
    { pid: 11, ppid: 10, command: "tauri dev" },
    { pid: 12, ppid: 11, command: "cargo run" },
    { pid: 13, ppid: 12, command: "rustc" },
    { pid: 14, ppid: 11, command: "npm run dev" },
    { pid: 15, ppid: 14, command: "vite" },
    { pid: 20, ppid: 1, command: "MonoCode Hub (daily)" },
    { pid: 21, ppid: 20, command: "claude" },
  ];
  assert.deepEqual(descendants(11, listing).map((e) => e.pid).sort(), [12, 13, 14, 15]);
  assert.deepEqual(descendants(99, listing), []);
});

test("stopping a run reaches the grandchildren tauri dev would leave behind (cargo run), and only them", { skip: process.platform === "win32" }, async (t) => {
  const { signalTree, sweep } = await load("hub-dev.mjs");
  const { spawn } = require("node:child_process");
  // A stand-in for tauri dev: it ignores SIGINT for its child, which keeps running when only the parent is signalled.
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
       console.log(child.pid);
       process.on("SIGINT", () => process.exit(130));
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const grandchild = Number(await new Promise((resolve) => parent.stdout.once("data", (d) => resolve(String(d).trim()))));
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => {
    for (const pid of [parent.pid, grandchild, bystander.pid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const exited = new Promise((resolve) => parent.once("exit", resolve));
  const tree = signalTree(parent.pid, "SIGINT");
  assert.deepEqual(tree.map((e) => e.pid).sort(), [parent.pid, grandchild].sort());
  await exited;
  const left = await sweep(tree, { grace: 2000 });
  assert.ok(left.length <= 1, "at most the grandchild needed a SIGTERM");
  for (let i = 0; i < 40 && alive(grandchild); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(grandchild), false, "cargo run's stand-in is gone too");
  assert.equal(alive(bystander.pid), true, "nothing outside the tree is signalled");
});

test("--replace (what the seed's refusal says to pass) reseeds, like --reseed", async () => {
  const { parseArgs } = await load("hub-dev.mjs");
  for (const flag of ["--replace", "--reseed"]) {
    const o = parseArgs(["--seed", flag]);
    assert.equal(o.seed, true, flag);
    assert.equal(o.reseed, true, flag);
  }
  assert.equal(parseArgs(["--seed"]).reseed, false);
  assert.equal(parseArgs(["--memory", "/tmp/m"]).memory, "/tmp/m");
  assert.equal(parseArgs([]).memory, undefined);
  assert.throws(() => parseArgs(["--memory"]), /--memory needs a value/);
});

test("an agent's dev copy never takes focus: --background, or no terminal; --foreground overrides", async () => {
  const { parseArgs, devEnvironment } = await load("hub-dev.mjs");
  assert.equal(parseArgs(["--background"]).background, true);
  assert.equal(parseArgs(["--foreground"]).background, false);
  assert.equal(devEnvironment({ slot: "x", hub: null, background: true, env: {} }).MONOCODE_HUB_BACKGROUND, "1");
  assert.equal(devEnvironment({ slot: "x", hub: null, background: false, env: {} }).MONOCODE_HUB_BACKGROUND, undefined);
  // a leftover from an enclosing shell never leaks in
  assert.equal(devEnvironment({ slot: "x", hub: null, background: false, env: { MONOCODE_HUB_BACKGROUND: "1" } }).MONOCODE_HUB_BACKGROUND, undefined);
});
