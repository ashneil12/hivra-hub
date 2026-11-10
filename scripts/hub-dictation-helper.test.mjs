// WP-131b: the dictation helper bundle inside the Hub. Its identity, its usage strings and its entitlement are
// the only thing that lets macOS grant it the microphone, so these tests pin them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dictationHelperProblems,
  helperBundleId,
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

function problemsFor(overrides = {}) {
  return dictationHelperProblems({
    identifier: HUB,
    hubInfo: goodHubInfo,
    hubEntitlements: goodHubEntitlements,
    helper: { info: goodHelperInfo, entitlements: goodHelperEntitlements },
    ...overrides,
  });
}

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
