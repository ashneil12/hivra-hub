// WP-131b: the dictation helper bundle inside the Hub. Its identity, its usage strings and its entitlement are
// the only thing that lets macOS grant it the microphone, so these tests pin them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dictationHelperProblems,
  helperBinaryPath,
  helperBundleDefault,
  helperBundleId,
  helperCheckApplies,
  helperProblemsFor,
  helperInfoPlist,
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

test("the helper must exist, carry its identifier, both strings and the entitlement", () => {
  assert.ok(problemsFor({ helper: null }).some((p) => /helper is missing/.test(p)));
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

test("the check hub:verify and hub:ship share reads a missing helper from the bundle itself", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "hub-helper-"));
  try {
    fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents/Info.plist"), goodHubInfo);
    const problems = helperProblemsFor(app, { identifier: HUB });
    assert.ok(problems.some((p) => /the dictation helper is missing/.test(p)), JSON.stringify(problems));
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

// The helper step finds the bundle that tauri build wrote, under CARGO_TARGET_DIR when it is set.
test("the default bundle path follows CARGO_TARGET_DIR the way the helper binary does", () => {
  assert.equal(
    helperBundleDefault({ CARGO_TARGET_DIR: "/shared/target" }, "/repo"),
    "/shared/target/release/bundle/macos/MonoCode Hub.app",
  );
  assert.equal(helperBundleDefault({}, "/repo"), "/repo/target/release/bundle/macos/MonoCode Hub.app");
});
