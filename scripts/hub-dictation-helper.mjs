#!/usr/bin/env node
// WP-131b: the dictation helper inside a MonoCode Hub bundle.
//
// The Hub never holds the microphone. Dictation runs in a small helper app at
// `Contents/Helpers/MonoCode Dictation.app`, with its own identifier (the Hub's plus `.dictation`), its two usage
// strings and the audio-input entitlement. The Hub starts it with responsibility disclaimed (src-tauri/src/disclaim.rs),
// so macOS charges the microphone request to the helper. Project actions and other children of the Hub inherit nothing.
//
//   node scripts/hub-dictation-helper.mjs "target/release/bundle/macos/MonoCode Hub.app"
//
// Run by `npm run hub:build` after `tauri build`: it builds the helper binary, writes its Info.plist, signs the helper
// with its own entitlements, then signs the app again (its seal covers the helper) with the app's entitlements.
// The pure functions below are what the tests pin; the CLI does the file and codesign work.

import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kindOf } from "./hub-bundle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const HELPER_NAME = "MonoCode Dictation.app";
export const HELPER_EXECUTABLE = "monocode-dictation";
export const HELPER_RELATIVE = path.join("Contents", "Helpers", HELPER_NAME);
export const HELPER_ENTITLEMENT = "com.apple.security.device.audio-input";
const INFO_TEMPLATE = path.join(ROOT, "crates/dictation-helper/bundle/Info.plist");
const HELPER_ENTITLEMENTS = path.join(ROOT, "crates/dictation-helper/bundle/Entitlements.plist");

/** The helper's identifier: the Hub's, plus `.dictation`. A dev slot gets its own, so its grant is its own. */
export function helperBundleId(hubIdentifier) {
  if (kindOf(hubIdentifier) == null) {
    throw new Error(`not a Hub identifier: ${hubIdentifier}`);
  }
  return `${hubIdentifier}.dictation`;
}

/** The helper's Info.plist, from the template in the crate. */
export function helperInfoPlist({ identifier, version }) {
  return readFileSync(INFO_TEMPLATE, "utf8")
    .replaceAll("__BUNDLE_ID__", identifier)
    .replaceAll("__VERSION__", version);
}

function stringKey(plist, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist ?? "");
  return match ? match[1] : null;
}

function hasKey(plist, key) {
  return new RegExp(`<key>${key}</key>`).test(plist ?? "");
}

function hasTrueEntitlement(entitlements, key) {
  return new RegExp(`<key>${key}</key>\\s*<true\\s*/>`).test(entitlements ?? "");
}

/**
 * What is wrong with a built Hub and its helper, as readable lines. Empty when it is right. The main app must have
 * neither usage string nor the audio input entitlement; the helper must have its identifier, both strings and the
 * entitlement.
 */
export function dictationHelperProblems({ identifier, hubInfo, hubEntitlements, helper }) {
  const problems = [];
  for (const key of ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"]) {
    if (hasKey(hubInfo, key)) problems.push(`the main app carries ${key}; the microphone belongs to the helper only`);
  }
  if (hasTrueEntitlement(hubEntitlements, HELPER_ENTITLEMENT)) {
    problems.push("the main app carries the audio input entitlement; the microphone belongs to the helper only");
  }
  if (!helper) {
    problems.push("the dictation helper is missing from the bundle");
    return problems;
  }
  const expected = helperBundleId(identifier);
  const actual = stringKey(helper.info, "CFBundleIdentifier");
  if (actual !== expected) problems.push(`helper identifier is ${actual ?? "missing"}, expected ${expected}`);
  for (const key of ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"]) {
    if (!hasKey(helper.info, key)) problems.push(`helper has no ${key}`);
  }
  if (!hasTrueEntitlement(helper.entitlements, HELPER_ENTITLEMENT)) {
    problems.push("helper has no audio input entitlement");
  }
  return problems;
}

/**
 * The two codesign commands, helper first. Each signs with the hardened runtime and its own entitlements. The app is
 * signed last, because its seal covers the helper.
 */
export function signingCommands({
  identity,
  identifier,
  hubApp,
  hubEntitlements,
  helperApp,
  helperEntitlements,
  helperIdentifier,
}) {
  const sign = (target, bundleId, entitlements) => [
    "codesign",
    "--force",
    "--sign",
    identity,
    "--identifier",
    bundleId,
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    target,
  ];
  return [sign(helperApp, helperIdentifier, helperEntitlements), sign(hubApp, identifier, hubEntitlements)];
}

/** Reads the three facts the check needs from a built bundle, without launching it. */
export function readBundleFacts(appPath) {
  const plistXml = (file) => {
    if (!existsSync(file)) return null;
    return execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", file], { encoding: "utf8" });
  };
  const entitlements = (target) => {
    try {
      return execFileSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", target], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return "";
    }
  };
  const helperApp = path.join(appPath, HELPER_RELATIVE);
  const helperExists = existsSync(helperApp);
  return {
    hubInfo: plistXml(path.join(appPath, "Contents/Info.plist")),
    hubEntitlements: entitlements(appPath),
    helper: helperExists
      ? {
          info: plistXml(path.join(helperApp, "Contents/Info.plist")),
          entitlements: entitlements(helperApp),
        }
      : null,
  };
}

function readConfigs() {
  const tauri = JSON.parse(readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  const hub = JSON.parse(readFileSync(path.join(ROOT, "src-tauri/tauri.hub.conf.json"), "utf8"));
  const identity = hub?.bundle?.macOS?.signingIdentity;
  if (!identity || identity === "-") throw new Error("src-tauri/tauri.hub.conf.json has no signing identity");
  return { identifier: tauri.identifier, version: tauri.version, identity };
}

function buildHelperBinary() {
  const env = { ...process.env };
  env.CARGO_BUILD_BUILD_DIR ??= path.join(process.env.HOME ?? "", "Library/Caches/monocode-hub/cargo-build");
  execFileSync("cargo", ["build", "--release", "--locked", "-p", "monocode-dictation"], {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });
  const binary = path.join(ROOT, "target/release", HELPER_EXECUTABLE);
  if (!existsSync(binary)) throw new Error(`cargo did not produce ${binary}`);
  return binary;
}

/** Puts the helper into the bundle, signs it, then signs the app. Throws on any failure. */
export function installHelper(appPath, { binary = buildHelperBinary() } = {}) {
  const { identifier, version, identity } = readConfigs();
  const helperIdentifier = helperBundleId(identifier);
  const helperApp = path.join(appPath, HELPER_RELATIVE);
  rmSync(helperApp, { recursive: true, force: true });
  const macos = path.join(helperApp, "Contents/MacOS");
  mkdirSync(macos, { recursive: true });
  writeFileSync(path.join(helperApp, "Contents/Info.plist"), helperInfoPlist({ identifier: helperIdentifier, version }));
  writeFileSync(path.join(helperApp, "Contents/PkgInfo"), "APPL????");
  copyFileSync(binary, path.join(macos, HELPER_EXECUTABLE));
  chmodSync(path.join(macos, HELPER_EXECUTABLE), 0o755);

  const commands = signingCommands({
    identity,
    identifier,
    hubApp: appPath,
    hubEntitlements: path.join(ROOT, "src-tauri/Entitlements.plist"),
    helperApp,
    helperEntitlements: HELPER_ENTITLEMENTS,
    helperIdentifier,
  });
  for (const [program, ...args] of commands) {
    execFileSync(program, args, { stdio: "inherit" });
  }
  execFileSync("codesign", ["--verify", "--strict", helperApp], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", appPath], { stdio: "inherit" });
  return { helperApp, helperIdentifier };
}

function main(argv) {
  const app = argv[0];
  if (!app) {
    console.error('usage: node scripts/hub-dictation-helper.mjs "<path to MonoCode Hub.app>"');
    process.exit(2);
  }
  const { helperApp, helperIdentifier } = installHelper(path.resolve(app));
  const problems = dictationHelperProblems({
    identifier: readConfigs().identifier,
    ...readBundleFacts(path.resolve(app)),
  });
  if (problems.length) {
    console.error(`REFUSE: dictation helper in ${helperApp}`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`OK: dictation helper ${helperIdentifier} signed in ${helperApp}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
