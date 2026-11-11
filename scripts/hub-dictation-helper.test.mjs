// WP-131b: the dictation helper bundle inside the Hub. Its identity, its usage strings and its entitlement are
// the only thing that lets macOS grant it the microphone, so these tests pin them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DICTATION_ENABLED,
  dictationHelperProblems,
  helperBinaryPath,
  helperBundleDefault,
  helperBundleId,
  helperCheckApplies,
  helperProblemsFor,
  helperInfoPlist,
  launchAgentPlist,
  LAUNCH_AGENT_PLIST,
  LAUNCH_AGENT_DIR,
  HELPER_BUNDLE_PROGRAM,
  signingCommands,
} from "./hub-dictation-helper.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HUB = "com.ash.monocode-hub";
const DEV = "com.ash.monocode-hub.dev.docs-test";
const HELPER_ENTITLEMENT = "com.apple.security.device.audio-input";

function plist(entries) {
  const body = Object.entries(entries)
    .map(([key, value]) => {
      if (value === true) return `\t<key>${key}</key>\n\t<true/>`;
      if (value === false) return `\t<key>${key}</key>\n\t<false/>`;
      return `\t<key>${key}</key>\n\t<string>${value}</string>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

const goodHelperInfo = plist({
  CFBundleExecutable: "monocode-dictation",
  CFBundleIdentifier: `${HUB}.dictation`,
  NSMicrophoneUsageDescription: "Dictation listens to your microphone while you dictate into the composer.",
  NSSpeechRecognitionUsageDescription: "Dictation turns your words into text on this Mac.",
});
const goodHelperEntitlements = plist({ [HELPER_ENTITLEMENT]: true });
const goodHubInfo = plist({ CFBundleIdentifier: HUB, CFBundleIconName: "AppIcon" });
const goodHubEntitlements = plist({ "com.apple.security.cs.allow-jit": true });

const TEAM = "9SB4XNH8C5";
const RUNTIME = "CodeDirectory v=20500 size=1674 flags=0x10000(runtime) hashes=41+7 location=embedded";

function problemsFor(overrides = {}) {
  return dictationHelperProblems({
    identifier: HUB,
    hubInfo: goodHubInfo,
    hubEntitlements: goodHubEntitlements,
    hubTeam: TEAM,
    helper: { info: goodHelperInfo, entitlements: goodHelperEntitlements, signing: RUNTIME, team: TEAM },
    ...overrides,
  });
}

// LOW 2: the helper carries exactly the audio input entitlement, the hardened runtime, and the app's Team ID.
test("the helper must carry exactly one entitlement, the audio input one", () => {
  const two = plist({ [HELPER_ENTITLEMENT]: true, "com.apple.security.app-sandbox": true });
  assert.ok(
    problemsFor({ helper: { info: goodHelperInfo, entitlements: two, signing: RUNTIME, team: TEAM } }).some((p) =>
      /exactly one entitlement/.test(p),
    ),
  );
});

test("the helper must be signed with the hardened runtime", () => {
  const noRuntime = "CodeDirectory v=20500 size=1674 flags=0x0(none) hashes=41+7 location=embedded";
  assert.ok(
    problemsFor({ helper: { info: goodHelperInfo, entitlements: goodHelperEntitlements, signing: noRuntime, team: TEAM } }).some(
      (p) => /hardened runtime/.test(p),
    ),
  );
});

test("the helper's Team ID must equal the app's", () => {
  assert.ok(
    problemsFor({ helper: { info: goodHelperInfo, entitlements: goodHelperEntitlements, signing: RUNTIME, team: "OTHERTEAM1" } }).some(
      (p) => /same Team ID/.test(p),
    ),
  );
});

// LOW 3: the check runs only where the bundle can be a Mac app.
test("the helper check applies on macOS to a Hub identity only", () => {
  assert.equal(helperCheckApplies({ platform: "darwin", identifier: HUB, exists: true }), true);
  assert.equal(helperCheckApplies({ platform: "win32", identifier: HUB, exists: true }), false);
  assert.equal(helperCheckApplies({ platform: "linux", identifier: HUB, exists: true }), false);
  assert.equal(helperCheckApplies({ platform: "darwin", identifier: "com.monocode.desktop", exists: true }), false);
  assert.equal(helperCheckApplies({ platform: "darwin", identifier: HUB, exists: false }), false);
});

// The helper binary is found where cargo writes it, including a shared CARGO_TARGET_DIR.
test("the helper binary is looked up in CARGO_TARGET_DIR when it is set", () => {
  assert.equal(helperBinaryPath({ CARGO_TARGET_DIR: "/shared/target" }, "/repo"), "/shared/target/release/monocode-dictation");
  assert.equal(helperBinaryPath({}, "/repo"), "/repo/target/release/monocode-dictation");
});

test("the helper identifier is the Hub's identifier plus .dictation, in the daily and the dev slot", () => {
  assert.equal(helperBundleId(HUB), `${HUB}.dictation`);
  assert.equal(helperBundleId(DEV), `${DEV}.dictation`);
  assert.throws(() => helperBundleId("com.monocode.desktop"), /not a Hub identifier/);
});

test("the helper's Info.plist names its identifier, runs with no Dock icon and carries both usage strings", () => {
  const info = helperInfoPlist({ identifier: `${HUB}.dictation`, version: "0.16.14" });
  assert.match(info, /<key>CFBundleIdentifier<\/key>\s*<string>com\.ash\.monocode-hub\.dictation<\/string>/);
  assert.match(info, /<key>CFBundleExecutable<\/key>\s*<string>monocode-dictation<\/string>/);
  assert.match(info, /<key>LSUIElement<\/key>\s*<true\/>/);
  assert.match(info, /<key>NSMicrophoneUsageDescription<\/key>/);
  assert.match(info, /<key>NSSpeechRecognitionUsageDescription<\/key>/);
  assert.match(info, /<key>CFBundleShortVersionString<\/key>\s*<string>0\.16\.14<\/string>/);
});

test("the usage strings a person reads have no dashes and no paths", () => {
  const info = helperInfoPlist({ identifier: `${HUB}.dictation`, version: "0.16.14" });
  for (const key of ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"]) {
    const text = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(info)[1];
    assert.ok(!/[–—]/.test(text), `no en or em dash in ${key}`);
    assert.ok(!text.includes("/"), `no path in ${key}`);
  }
});

test("the helper's entitlements file grants the audio input entitlement and nothing else", () => {
  const file = readFileSync(path.join(root, "crates/dictation-helper/bundle/Entitlements.plist"), "utf8");
  assert.match(file, new RegExp(`<key>${HELPER_ENTITLEMENT}</key>\\s*<true/>`));
  assert.equal((file.match(/<key>/g) ?? []).length, 1, "one entitlement only");
});

test("a good helper and a clean main app pass the check", () => {
  assert.deepEqual(problemsFor(), []);
});

test("the main app must not carry either usage string", () => {
  const info = plist({ CFBundleIdentifier: HUB, NSMicrophoneUsageDescription: "x" });
  assert.ok(problemsFor({ hubInfo: info }).some((p) => /main app.*NSMicrophoneUsageDescription/.test(p)));
  const speech = plist({ CFBundleIdentifier: HUB, NSSpeechRecognitionUsageDescription: "x" });
  assert.ok(problemsFor({ hubInfo: speech }).some((p) => /NSSpeechRecognitionUsageDescription/.test(p)));
});

test("the main app must not carry the audio input entitlement", () => {
  const ent = plist({ [HELPER_ENTITLEMENT]: true });
  assert.ok(problemsFor({ hubEntitlements: ent }).some((p) => /main app.*audio input/.test(p)));
});

test("once dictation is on, the helper must exist, carry its identifier, both strings and the entitlement", () => {
  assert.ok(problemsFor({ helper: null, dictationEnabled: true }).some((p) => /helper is missing/.test(p)));
  assert.ok(
    problemsFor({
      helper: { info: goodHelperInfo.replace(`${HUB}.dictation`, HUB), entitlements: goodHelperEntitlements },
    }).some((p) => /identifier/.test(p)),
  );
  assert.ok(
    problemsFor({
      helper: { info: goodHelperInfo.replace(/<key>NSMicrophoneUsageDescription<\/key>/, "<key>X</key>"), entitlements: goodHelperEntitlements },
    }).some((p) => /NSMicrophoneUsageDescription/.test(p)),
  );
  assert.ok(
    problemsFor({ helper: { info: goodHelperInfo, entitlements: plist({}) } }).some((p) => /audio input/.test(p)),
  );
});

test("signing signs the helper with its own entitlements first, then the app, both with the hardened runtime", () => {
  const steps = signingCommands({
    identity: "ABCDEF",
    identifier: HUB,
    hubApp: "/b/MonoCode Hub.app",
    hubEntitlements: "/src/Entitlements.plist",
    helperApp: "/b/MonoCode Hub.app/Contents/Helpers/MonoCode Dictation.app",
    helperEntitlements: "/crates/bundle/Entitlements.plist",
    helperIdentifier: `${HUB}.dictation`,
  });
  assert.equal(steps.length, 2);
  const [helper, app] = steps;
  assert.ok(helper.includes("/crates/bundle/Entitlements.plist"), "helper uses its own entitlements");
  assert.ok(helper.includes(`${HUB}.dictation`), "helper is signed under its own identifier");
  assert.ok(app.includes("/src/Entitlements.plist"), "the app keeps its own entitlements");
  assert.ok(app.includes(HUB), "the app keeps its identifier");
  assert.ok(app.indexOf("/b/MonoCode Hub.app") === app.length - 1, "the app is signed last");
  for (const step of steps) {
    assert.ok(step.includes("runtime"), "hardened runtime");
    assert.ok(!step.includes("--deep"), "no --deep");
    assert.ok(step.includes("ABCDEF"), "the configured identity");
  }
});

test("the check hub:verify and hub:ship share reads the bundle itself: no helper passes while dictation is off", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "hub-helper-"));
  try {
    fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents/Info.plist"), goodHubInfo);
    assert.deepEqual(helperProblemsFor(app, { identifier: HUB }), []);
    // The main app's own microphone keys are still read from the bundle and refused.
    fs.writeFileSync(path.join(app, "Contents/Info.plist"), plist({ CFBundleIdentifier: HUB, NSMicrophoneUsageDescription: "x" }));
    const problems = helperProblemsFor(app, { identifier: HUB });
    assert.ok(problems.some((p) => /main app carries NSMicrophoneUsageDescription/.test(p)), JSON.stringify(problems));
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

// Dictation is off in this PR: one switch in the Hub, one in the helper, one here. They must say the same thing, so
// turning dictation on is one deliberate change to all three.
test("dictation is off, and the Hub, the helper and the bundle scripts agree on it", () => {
  const switchIn = (file, name) => {
    const match = new RegExp(`pub const ${name}: bool = (true|false);`).exec(readFileSync(path.join(root, file), "utf8"));
    assert.ok(match, `${name} in ${file}`);
    return match[1] === "true";
  };
  assert.equal(DICTATION_ENABLED, false);
  assert.equal(switchIn("src-tauri/src/dictation.rs", "ENABLED"), DICTATION_ENABLED);
  assert.equal(switchIn("crates/dictation-helper/src/protocol.rs", "DICTATION_ENABLED"), DICTATION_ENABLED);
});

test("while dictation is off, a bundle without the helper passes and the main app's microphone keys still refuse", () => {
  assert.deepEqual(problemsFor({ helper: null }), []);
  const info = plist({ CFBundleIdentifier: HUB, NSMicrophoneUsageDescription: "x" });
  assert.ok(problemsFor({ helper: null, hubInfo: info }).some((p) => /main app carries NSMicrophoneUsageDescription/.test(p)));
  const ent = plist({ [HELPER_ENTITLEMENT]: true });
  assert.ok(problemsFor({ helper: null, hubEntitlements: ent }).some((p) => /main app carries the audio input/.test(p)));
});

function stampedHub(dir) {
  const app = path.join(dir, "MonoCode Hub.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), goodHubInfo);
  const stamp = { sha: "a".repeat(40), branch: "hub/test", dirty: false, builtAt: "2026-11-11T10:00:00Z" };
  fs.writeFileSync(path.join(app, "Contents/MacOS/monocode"), `MONOCODE-STAMP:${JSON.stringify(stamp)}\n`);
  return app;
}

test("hub:verify passes a stamped Hub bundle that has no dictation helper while dictation is off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-verify-"));
  try {
    const app = stampedHub(dir);
    const result = spawnSync(process.execPath, [path.join(root, "scripts/verify-hub-bundle.mjs"), app], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /no dictation helper in the bundle/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hub:build's helper step leaves the bundle as tauri signed it while dictation is off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-build-helper-"));
  try {
    const app = stampedHub(dir);
    const before = fs.readFileSync(path.join(app, "Contents/MacOS/monocode"));
    // No cargo and no codesign on PATH: the step must not need either while dictation is off.
    const result = spawnSync(process.execPath, [path.join(root, "scripts/hub-dictation-helper.mjs"), app], {
      encoding: "utf8",
      env: { ...process.env, PATH: dir },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /dictation is off in this build/);
    assert.equal(fs.existsSync(path.join(app, "Contents/Helpers")), false, "no helper put into the bundle");
    assert.deepEqual(fs.readFileSync(path.join(app, "Contents/MacOS/monocode")), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The helper step finds the bundle that tauri build wrote, under CARGO_TARGET_DIR when it is set.
test("the launch agent plist names the helper bundle and is registered only with the switch", () => {
  assert.equal(LAUNCH_AGENT_PLIST, "com.ash.monocode-hub.dictation.plist");
  assert.equal(LAUNCH_AGENT_DIR, "Contents/Library/LaunchAgents");
  assert.equal(HELPER_BUNDLE_PROGRAM, "Contents/Helpers/MonoCode Dictation.app");
  const plist = launchAgentPlist();
  assert.match(plist, /<key>BundleProgram<\/key>\s*<string>Contents\/Helpers\/MonoCode Dictation\.app<\/string>/);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.ash\.monocode-hub\.dictation<\/string>/);
  assert.match(
    plist,
    /<key>MachServices<\/key>\s*<dict>\s*<key>com\.ash\.monocode-hub\.dictation<\/key>\s*<true\/>/,
  );
  assert.ok(!/<key>RunAtLoad<\/key>/.test(plist), "the helper starts when the Hub connects, not at login");
  assert.ok(!plist.includes("/Users/"), "no private path");
  const rust = readFileSync(path.join(root, "src-tauri/src/dictation.rs"), "utf8");
  const rustConst = (name) => {
    const match = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(rust);
    assert.ok(match, name);
    return match[1];
  };
  assert.equal(rustConst("AGENT_PLIST_NAME"), LAUNCH_AGENT_PLIST);
  assert.equal(rustConst("HELPER_BUNDLE_PROGRAM"), HELPER_BUNDLE_PROGRAM);
  assert.equal(rustConst("LAUNCH_AGENTS_DIR"), LAUNCH_AGENT_DIR);
  assert.ok(
    problemsFor({ dictationEnabled: true, launchAgent: null }).some((p) => /launch agent does not name/.test(p)),
  );
  assert.deepEqual(problemsFor({ dictationEnabled: true, launchAgent: plist }), []);
});

test("the default bundle path follows CARGO_TARGET_DIR the way the helper binary does", () => {
  assert.equal(
    helperBundleDefault({ CARGO_TARGET_DIR: "/shared/target" }, "/repo"),
    "/shared/target/release/bundle/macos/MonoCode Hub.app",
  );
  assert.equal(helperBundleDefault({}, "/repo"), "/repo/target/release/bundle/macos/MonoCode Hub.app");
});
