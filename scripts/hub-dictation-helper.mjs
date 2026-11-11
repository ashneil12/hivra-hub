#!/usr/bin/env node
// WP-131b: the dictation helper inside a MonoCode Hub bundle.
//
// The Hub never holds the microphone. Dictation runs in a small helper app at
// `Contents/Helpers/MonoCode Dictation.app`, with its own identifier (the Hub's plus `.dictation`), its two usage
// strings and the audio-input entitlement. launchd runs it as an SMAppService agent. The Hub does not spawn it.
// Project actions and other children of the Hub inherit nothing. This script copies the agent plist into the bundle.
// It does not call launchctl or SMAppService.
//
//   node scripts/hub-dictation-helper.mjs "target/release/bundle/macos/MonoCode Hub.app"
//
// Run by `npm run hub:build` after `tauri build`: it builds the helper binary, writes its Info.plist, signs the helper
// with its own entitlements, then signs the app again (its seal covers the helper) with the app's entitlements.
// DICTATION_ENABLED below is the kill switch. True means the bundle carries the helper and the setting decides.
// False leaves the bundle as tauri build made it.
// The pure functions below are what the tests pin; the CLI does the file and codesign work.

import { execFileSync, spawnSync } from "node:child_process";
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
/**
 * Kill switch for this build. True lets the saved setting decide, so the bundle must carry the helper and its launch
 * agent. False refuses dictation even when the setting says on, and hub:build puts no helper into the bundle. It moves
 * together with `dictation::ENABLED` (src-tauri/src/dictation.rs) and `protocol::DICTATION_ENABLED`
 * (crates/dictation-helper); a test fails if they differ. The main app's microphone keys are checked either way.
 */
export const DICTATION_ENABLED = true;
/** The LaunchAgent plist name inside `Contents/Library/LaunchAgents`. The same name the Hub registers. */
export const LAUNCH_AGENT_PLIST = "com.ash.monocode-hub.dictation.plist";
/** Where that plist lives, relative to the app bundle. */
export const LAUNCH_AGENT_DIR = "Contents/Library/LaunchAgents";
/**
 * `BundleProgram` in the plist, relative to the app bundle. launchd executes this path, so it is the helper's executable
 * inside its bundle, not the bundle folder (a folder cannot be exec'd, and the agent would never start).
 */
export const HELPER_BUNDLE_PROGRAM = "Contents/Helpers/MonoCode Dictation.app/Contents/MacOS/monocode-dictation";
const INFO_TEMPLATE = path.join(ROOT, "crates/dictation-helper/bundle/Info.plist");
const LAUNCH_AGENT_TEMPLATE = path.join(ROOT, "crates/dictation-helper/bundle/LaunchAgent.plist");
const HELPER_ENTITLEMENTS = path.join(ROOT, "crates/dictation-helper/bundle/Entitlements.plist");

/** The launch agent plist, from the crate. It names the helper bundle and its Mach service, and it does not run at login. */
export function launchAgentPlist() {
  return readFileSync(LAUNCH_AGENT_TEMPLATE, "utf8");
}

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
export function dictationHelperProblems({
  identifier,
  hubInfo,
  hubEntitlements,
  hubTeam,
  helper,
  launchAgent,
  dictationEnabled = DICTATION_ENABLED,
}) {
  const problems = [];
  for (const key of ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"]) {
    if (hasKey(hubInfo, key)) problems.push(`the main app carries ${key}; the microphone belongs to the helper only`);
  }
  if (hasTrueEntitlement(hubEntitlements, HELPER_ENTITLEMENT)) {
    problems.push("the main app carries the audio input entitlement; the microphone belongs to the helper only");
  }
  if (dictationEnabled && stringKey(launchAgent, "BundleProgram") !== HELPER_BUNDLE_PROGRAM) {
    problems.push("the launch agent does not name the helper bundle");
  }
  if (!helper) {
    // Dictation is off, so nothing starts a helper and a bundle without one is a normal build.
    if (dictationEnabled) problems.push("the dictation helper is missing from the bundle");
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
  } else if (entitlementKeys(helper.entitlements).length !== 1) {
    problems.push(
      `helper must carry exactly one entitlement, the audio input one; it carries ${entitlementKeys(helper.entitlements).join(", ")}`,
    );
  }
  if (!/\(runtime\)|,runtime\b/.test(helper.signing ?? "")) {
    problems.push("helper is not signed with the hardened runtime");
  }
  if (!hubTeam || helper.team !== hubTeam) {
    problems.push(
      `helper Team ID is ${helper.team ?? "missing"}; it must be the same Team ID as the app (${hubTeam ?? "missing"})`,
    );
  }
  return problems;
}

function entitlementKeys(entitlements) {
  return [...(entitlements ?? "").matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
}

/**
 * Whether the bundle check applies. Only a Mac app can carry the helper, and only a Hub identity is checked here: the
 * daily check already refuses any other identity.
 */
export function helperCheckApplies({ platform, identifier, exists }) {
  return platform === "darwin" && exists === true && kindOf(identifier) != null;
}

/** Where cargo writes the helper binary: under CARGO_TARGET_DIR when it is set (resolved from the workspace root). */
export function helperBinaryPath(env, root = ROOT) {
  return path.join(path.resolve(root, env.CARGO_TARGET_DIR || "target"), "release", HELPER_EXECUTABLE);
}

/** The bundle tauri build writes, under the same target directory as the helper binary. */
export function helperBundleDefault(env, root = ROOT) {
  return path.join(path.resolve(root, env.CARGO_TARGET_DIR || "target"), "release/bundle/macos/MonoCode Hub.app");
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

/**
 * Reads the three facts the check needs from a built bundle, without launching it. `codesign` is the same binary the
 * ship checks use (a .mjs stand-in is run with node), so the tests can stand in for it.
 */
export function readBundleFacts(appPath, { codesign = "/usr/bin/codesign" } = {}) {
  const plistXml = (file) => {
    if (!existsSync(file)) return null;
    try {
      return execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", file], { encoding: "utf8" });
    } catch {
      return readFileSync(file, "utf8");
    }
  };
  // One codesign call: its stdout and stderr together (codesign -dv writes to stderr).
  const run = (args) => {
    const spawn = codesign.endsWith(".mjs") ? [process.execPath, [codesign, ...args]] : [codesign, args];
    const result = spawnSync(spawn[0], spawn[1], { encoding: "utf8" });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  };
  const entitlements = (target) => run(["-d", "--entitlements", ":-", target]);
  const signing = (target) => run(["-dv", "--verbose=4", target]);
  const teamOf = (text) => /TeamIdentifier=(\S+)/.exec(text)?.[1] ?? null;
  const helperApp = path.join(appPath, HELPER_RELATIVE);
  const helperExists = existsSync(helperApp);
  const launchAgent = plistXml(path.join(appPath, LAUNCH_AGENT_DIR, LAUNCH_AGENT_PLIST));
  const hubSigning = signing(appPath);
  const helperSigning = helperExists ? signing(helperApp) : "";
  return {
    hubInfo: plistXml(path.join(appPath, "Contents/Info.plist")),
    hubEntitlements: entitlements(appPath),
    hubTeam: teamOf(hubSigning),
    helper: helperExists
      ? {
          info: plistXml(path.join(helperApp, "Contents/Info.plist")),
          entitlements: entitlements(helperApp),
          signing: helperSigning,
          team: teamOf(helperSigning),
        }
      : null,
    launchAgent,
  };
}

/** The problems with a built bundle's helper, read from the bundle. The same check hub:verify and hub:ship run. */
export function helperProblemsFor(appPath, { identifier, codesign } = {}) {
  return dictationHelperProblems({ identifier, ...readBundleFacts(appPath, codesign ? { codesign } : {}) });
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
  const binary = helperBinaryPath(env, ROOT);
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
  // The agent plist goes in before the app is signed again, so the app's seal covers it. This copies a file. It does
  // not register the agent.
  const agents = path.join(appPath, LAUNCH_AGENT_DIR);
  mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, LAUNCH_AGENT_PLIST), launchAgentPlist());

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
  if (!DICTATION_ENABLED) {
    // The bundle stays as tauri build signed it: nothing is built, copied or signed again, and hub:build can't fail here.
    console.log("OK: dictation is off in this build, so the dictation helper is not put into the bundle.");
    return;
  }
  const app = path.resolve(argv[0] ?? helperBundleDefault(process.env));
  if (!existsSync(app)) {
    console.error(`no bundle at ${app}; run tauri build first (or pass the path to the .app)`);
    process.exit(2);
  }
  const { helperApp, helperIdentifier } = installHelper(app);
  const problems = dictationHelperProblems({
    identifier: readConfigs().identifier,
    ...readBundleFacts(app),
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
