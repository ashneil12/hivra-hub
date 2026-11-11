// The identity guard and the bundle check, run on fixture bundles in a throwaway HOME.
//
// Nothing here reads or writes Ash's real data: every run sets HOME to a fresh temporary folder and
// HUB_GUARD_BASELINE to a file inside it. The fixture bundles are folders with an Info.plist and a fake
// Contents/MacOS/monocode holding (or not holding) a build stamp, the way src-tauri/build.rs embeds it.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GUARD = path.join(__dirname, "identity-guard.sh");
const VERIFY = path.join(__dirname, "verify-hub-bundle.mjs");
const READERS = path.join(__dirname, "hub-bundle.mjs");
// macOS's own bash 3.2, the oldest shell the guard has to run in.
const BASH = fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";
const skip = process.platform !== "darwin" && "the guard reads bundles with macOS PlistBuddy";

const DAILY = "com.ash.monocode-hub";
const UPSTREAM = "com.monocode.desktop";
const STAMP = {
  sha: "09141d88a1b2c3d4e5f60718293a4b5c6d7e8f90",
  branch: "hub/next",
  dirty: false,
  builtAt: "2026-10-19T21:04:05Z",
};

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bundle(root, relative, identifier, stamp = STAMP) {
  const app = path.join(root, relative);
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundleName</key><string>${path.basename(app, ".app")}</string>
</dict></plist>
`,
  );
  // Binary noise around the stamp, and the prefix on its own first, right before another JSON literal, as a real
  // binary may hold it.
  fs.writeFileSync(
    path.join(app, "Contents/MacOS/monocode"),
    Buffer.concat([
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 1]),
      Buffer.from('MONOCODE-STAMP:{"mcpServers":{}}'),
      Buffer.from([0, 7, 0x7d]),
      stamp ? Buffer.from(`MONOCODE-STAMP:${JSON.stringify(stamp)}`) : Buffer.from("no stamp"),
      Buffer.from([0x7d, 0, 0xff]),
    ]),
  );
  // The dictation helper and its launch agent, as hub:build puts them in (scripts/hub-dictation-helper.mjs). Their
  // signatures are read through the stand-in codesign below, so the fixture needs no signing identity.
  const helper = path.join(app, "Contents/Helpers/MonoCode Dictation.app/Contents");
  fs.mkdirSync(path.join(helper, "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(helper, "MacOS/monocode-dictation"), "helper");
  fs.writeFileSync(
    path.join(helper, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${identifier}.dictation</string>
  <key>NSMicrophoneUsageDescription</key><string>Dictation</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Dictation</string>
</dict></plist>
`,
  );
  fs.mkdirSync(path.join(app, "Contents/Library/LaunchAgents"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents/Library/LaunchAgents/com.ash.monocode-hub.dictation.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>BundleProgram</key><string>Contents/Helpers/MonoCode Dictation.app/Contents/MacOS/monocode-dictation</string>
</dict></plist>
`,
  );
  return app;
}

/** A stand-in codesign: the helper carries only the audio input entitlement, both are hardened, one Team ID. */
function fakeCodesign(root) {
  const file = path.join(root, "fake-codesign.mjs");
  fs.writeFileSync(
    file,
    `const args = process.argv.slice(2);
const target = args[args.length - 1];
const helper = target.endsWith("MonoCode Dictation.app");
if (args.includes("--entitlements")) {
  process.stdout.write(helper
    ? '<plist version="1.0"><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>'
    : '<plist version="1.0"><dict></dict></plist>');
} else {
  process.stderr.write("CodeDirectory v=20500 size=1 flags=0x10000(runtime)\\nTeamIdentifier=TESTTEAM01\\n");
}
`,
  );
  return file;
}

function database(root, identifier, sessions) {
  const dir = path.join(root, "Library/Application Support", identifier);
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, "monocode.db");
  const rows = Array.from({ length: sessions }, (_, i) => `('s${i}')`).join(",");
  execFileSync("sqlite3", [
    db,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY); DELETE FROM sessions;${rows ? ` INSERT INTO sessions VALUES ${rows};` : ""}`,
  ]);
  return db;
}

function guard(root) {
  const result = spawnSync(BASH, [GUARD], {
    env: { ...process.env, HOME: root, HUB_GUARD_BASELINE: path.join(root, "baseline.json") },
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout + result.stderr };
}

function verify(app) {
  const root = path.dirname(path.dirname(app));
  const env = { ...process.env, MONOCODE_TEST_CODESIGN: fakeCodesign(root) };
  const result = spawnSync(process.execPath, [VERIFY, app], { encoding: "utf8", env });
  return { code: result.status, out: result.stdout + result.stderr };
}

function healthyHome(t) {
  const root = home(t);
  bundle(root, "Applications/MonoCode Hub.app", DAILY);
  bundle(root, "Projects/monocode-hub/target/release/bundle/macos/MonoCode Hub.app", DAILY);
  bundle(root, "Worktrees/wt-a/target/debug/MonoCode Hub Dev.app", "com.ash.monocode-hub.dev.wt-a", {
    ...STAMP,
    branch: "hub/wt-a}b",
    dirty: true,
  });
  database(root, UPSTREAM, 6);
  database(root, DAILY, 40);
  return root;
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("a healthy Mac passes and every bundle shows its build stamp", { skip }, (t) => {
  const root = healthyHome(t);
  const { code, out } = guard(root);
  assert.equal(code, 0, out);
  assert.match(out, /GUARD OK/);
  assert.match(out, /ok {4}installed: MonoCode Hub\.app: com\.ash\.monocode-hub, hub\/next @ 09141d8, built 2026-10-19T21:04:05Z/);
  assert.match(out, /ok {4}daily build: .*Projects\/monocode-hub\/target\/release.*runs only once shipped/);
  assert.match(out, /ok {4}dev slot wt-a: .*hub\/wt-a\}b @ 09141d8-dirty/);
  assert.match(out, /hub database sessions: {6}40/);
});

test("the installed app with upstream's identifier fails", { skip }, (t) => {
  const root = healthyHome(t);
  bundle(root, "Applications/MonoCode Hub.app", UPSTREAM);
  const { code, out } = guard(root);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}.*Applications\/MonoCode Hub\.app/);
  assert.match(out, /CFBundleIdentifier = com\.monocode\.desktop/);
});

test("a build anywhere that carries upstream's identifier fails", { skip }, (t) => {
  const root = healthyHome(t);
  bundle(root, "Worktrees/wt-b/target/release/bundle/macos/MonoCode.app", UPSTREAM);
  const { code, out } = guard(root);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}.*wt-b.*MonoCode\.app carries upstream's identifier/);
});

test("an unstamped daily build outside ~/Applications is flagged without failing", { skip }, (t) => {
  const root = healthyHome(t);
  bundle(root, "Worktrees/old/target/release/bundle/macos/MonoCode Hub.app", DAILY, null);
  bundle(root, "Worktrees/old/target/release/bundle/macos/MonoCode Test.app", "com.ash.monocode-hub.sandbox");
  bundle(root, "Worktrees/bad/target/debug/MonoCode Hub Dev.app", "com.ash.monocode-hub.dev.Bad_Slot");
  const { code, out } = guard(root);
  assert.equal(code, 0, out);
  assert.match(out, /WARN {2}.*old.*MonoCode Hub\.app carries the daily identity and predates the instance lock/);
  assert.match(out, /note {2}retired test copy: .*MonoCode Test\.app/);
  assert.match(out, /WARN {2}.*bad.* not a valid dev slot/);
});

test("upstream's database growing or the hub database shrinking fails", { skip }, (t) => {
  const root = healthyHome(t);
  assert.equal(guard(root).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8")), {
    upstreamSessions: 6,
    hubSessions: 40,
  });

  database(root, UPSTREAM, 7);
  let run = guard(root);
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /FAIL {2}upstream's database grew \(6 -> 7\)/);

  database(root, DAILY, 39);
  run = guard(root);
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /FAIL {2}the hub database shrank \(40 -> 39\)/);
});

test("the guard reads databases and owner records without changing them", { skip }, (t) => {
  const root = healthyHome(t);
  const support = path.join(root, "Library/Application Support");
  fs.writeFileSync(
    path.join(support, DAILY, "running.json"),
    JSON.stringify({ pid: 999999, kind: "daily", sha: STAMP.sha, branch: "hub/next", dirty: false, bundlePath: "/x/MonoCode Hub.app" }),
  );
  fs.mkdirSync(path.join(support, "com.ash.monocode-hub.dev.wt-a"), { recursive: true });
  const files = [
    path.join(support, UPSTREAM, "monocode.db"),
    path.join(support, DAILY, "monocode.db"),
    path.join(support, DAILY, "running.json"),
  ];
  const before = files.map(sha256);
  const { code, out } = guard(root);
  assert.equal(code, 0, out);
  assert.deepEqual(files.map(sha256), before);
  assert.match(out, /data {2}com\.ash\.monocode-hub: last owner daily pid 999999 \(not running\), hub\/next @ 09141d8/);
  assert.match(out, /data {2}com\.ash\.monocode-hub\.dev\.wt-a: last owner no running\.json/);
  assert.ok(!fs.existsSync(path.join(support, DAILY, "instance-owner.sqlite")), "the guard never creates a lock");
});

test("only a stamped daily build passes the install check", { skip }, async (t) => {
  const root = home(t);
  const ok = verify(bundle(root, "a/MonoCode Hub.app", DAILY));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /OK: .* is the Hub \(com\.ash\.monocode-hub\), hub\/next @ 09141d8, built 2026-10-19T21:04:05Z\./);

  const dirty = verify(bundle(root, "b/MonoCode Hub.app", DAILY, { ...STAMP, dirty: true }));
  assert.equal(dirty.code, 0, dirty.out);
  assert.match(dirty.out, /WARN: .*built with uncommitted changes/);

  for (const [name, identifier, stamp, reason] of [
    ["upstream", UPSTREAM, STAMP, /upstream MonoCode identity/],
    ["dev", "com.ash.monocode-hub.dev.wt-a", STAMP, /dev copy/],
    ["sandbox", "com.ash.monocode-hub.sandbox", STAMP, /retired MonoCode Test/],
    ["unstamped", DAILY, null, /No build stamp/],
  ]) {
    const refused = verify(bundle(root, `${name}/MonoCode Hub.app`, identifier, stamp));
    assert.equal(refused.code, 1, `${name}: ${refused.out}`);
    assert.match(refused.out, /REFUSE/);
    assert.match(refused.out, reason);
  }
  assert.equal(verify(path.join(root, "missing.app")).code, 1);

  // The command line runs however it is reached, here through a symlinked folder.
  const linked = path.join(root, "linked-scripts");
  fs.symlinkSync(__dirname, linked);
  const viaLink = spawnSync(process.execPath, [path.join(linked, "verify-hub-bundle.mjs"), path.join(root, "unstamped/MonoCode Hub.app")], {
    encoding: "utf8",
  });
  assert.equal(viaLink.status, 1, viaLink.stdout + viaLink.stderr);
  assert.match(viaLink.stderr, /REFUSE/);
  const stampOut = spawnSync(process.execPath, [VERIFY, "--stamp", path.join(root, "a/MonoCode Hub.app")], { encoding: "utf8" });
  assert.equal(stampOut.status, 0, stampOut.stderr);
  assert.deepEqual(JSON.parse(stampOut.stdout), STAMP);

  const { findStamp, kindOf } = await import(READERS);
  assert.deepEqual(findStamp(Buffer.from(`xx MONOCODE-STAMP:{"sha":"a","branch":"x}y","dirty":true,"builtAt":"t"} yy`)), {
    sha: "a",
    branch: "x}y",
    dirty: true,
    builtAt: "t",
  });
  assert.equal(findStamp(Buffer.from("MONOCODE-STAMP:{oops")), null);
  assert.equal(kindOf(DAILY), "daily");
  assert.equal(kindOf("com.ash.monocode-hub.dev.hub-1b-identity"), "dev");
  for (const refused of [UPSTREAM, "com.ash.monocode-hub.sandbox", "com.ash.monocode-hub.dev.", "com.ash.monocode-hub.dev.A", "com.ash.monocode-hub.dev.-x"])
    assert.equal(kindOf(refused), null, refused);
});
