#!/usr/bin/env node
// Refuse to install a MonoCode Hub build that carries the wrong identity or no build stamp.
//
// Why this exists: Tauri keys the app data directory off the bundle identifier
// (`app_data_dir() = ~/Library/Application Support/<identifier>`). The daily Hub's identity lives in
// `src-tauri/tauri.conf.json` -> `identifier: com.ash.monocode-hub`. If a build ever carries
// upstream's `com.monocode.desktop` instead, that build reads and writes upstream MonoCode's
// database — which is how the Hub's conversation history looked "swallowed" on 2026-10-16.
// A dev copy (`com.ash.monocode-hub.dev.<slot>`) has its own data folder and is never installed.
//
// Every build since Phase 1b carries a build stamp (`MONOCODE-STAMP:{sha,branch,dirty,builtAt}`,
// src-tauri/build.rs). A build without one predates the one-app-per-data-folder lock and the
// "daily runs only from ~/Applications" rule, so it is refused too.
//
// Use it after any build, and before copying a bundle into ~/Applications.
//
//   node scripts/verify-hub-bundle.mjs "target/release/bundle/macos/MonoCode Hub.app"
//   node scripts/verify-hub-bundle.mjs --stamp "$HOME/Applications/MonoCode Hub.app"   # just print the stamp
//
// Exits 0 and prints OK when the bundle is the daily Hub; exits 1 with a refusal otherwise. This file is only the
// command line: it always runs, however it is reached. The readers are in scripts/hub-bundle.mjs.

import { readStamp, stampLabel, verifyDailyBundle } from "./hub-bundle.mjs";
import { dictationHelperProblems, helperBundleId, readBundleFacts } from "./hub-dictation-helper.mjs";

const args = process.argv.slice(2);
const stampOnly = args[0] === "--stamp";
const app = stampOnly ? args[1] : args[0];
if (!app) {
  console.error("usage: node scripts/verify-hub-bundle.mjs [--stamp] <path to .app>");
  process.exit(2);
}
if (stampOnly) {
  const stamp = readStamp(app);
  if (!stamp) {
    console.error(`no build stamp in ${app}`);
    process.exit(1);
  }
  console.log(JSON.stringify(stamp));
  process.exit(0);
}
const result = verifyDailyBundle(app);
for (const warning of result.warnings) console.warn(`WARN: ${app}: ${warning}`);
if (!result.ok) {
  console.error(`REFUSE: ${app}`);
  for (const error of result.errors) console.error(`  ${error}`);
  process.exit(1);
}
// WP-131b: the microphone belongs to the dictation helper inside the bundle, never to the Hub itself.
const helperProblems = dictationHelperProblems({ identifier: result.identifier, ...readBundleFacts(app) });
if (helperProblems.length) {
  console.error(`REFUSE: ${app} (dictation helper)`);
  for (const problem of helperProblems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`OK: ${app} is the Hub (${result.identifier}), ${stampLabel(result.stamp)}, built ${result.stamp.builtAt}.`);
console.log(`OK: dictation helper ${helperBundleId(result.identifier)} is in the bundle, signed with its own entitlements.`);
