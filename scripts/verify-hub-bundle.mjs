#!/usr/bin/env node
// Refuse to install or launch a MonoCode Hub build that carries the wrong identity.
//
// Why this exists: Tauri keys the app data directory off the bundle identifier
// (`app_data_dir() = ~/Library/Application Support/<identifier>`). The Hub's identity lives in
// `src-tauri/tauri.conf.json` -> `identifier: com.ash.monocode-hub`. If a build ever carries
// upstream's `com.monocode.desktop` instead, that build reads and writes upstream MonoCode's
// database — which is how the Hub's conversation history looked "swallowed" on 2026-10-16.
//
// Use it after any build, and before copying a bundle into ~/Applications.
//
//   node scripts/verify-hub-bundle.mjs "target/release/bundle/macos/MonoCode Hub.app"
//
// Exits 0 and prints OK when the bundle is the Hub; exits 1 with a refusal otherwise.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const HUB_IDENTIFIER = "com.ash.monocode-hub";
const UPSTREAM_IDENTIFIER = "com.monocode.desktop";

const app = process.argv[2];
if (!app) {
  console.error("usage: node scripts/verify-hub-bundle.mjs <path to .app>");
  process.exit(2);
}
if (!existsSync(app)) {
  console.error(`REFUSE: no bundle at ${app}`);
  process.exit(1);
}

const plist = `${app}/Contents/Info.plist`;
if (!existsSync(plist)) {
  console.error(`REFUSE: ${app} has no Contents/Info.plist — not a macOS app bundle.`);
  process.exit(1);
}

let identifier = "";
try {
  identifier = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])
    .toString()
    .trim();
} catch {
  console.error(`REFUSE: cannot read CFBundleIdentifier from ${plist}`);
  process.exit(1);
}

if (identifier !== HUB_IDENTIFIER) {
  console.error(`REFUSE: ${app}`);
  console.error(`  CFBundleIdentifier = ${identifier}`);
  console.error(`  expected           = ${HUB_IDENTIFIER}`);
  if (identifier === UPSTREAM_IDENTIFIER) {
    console.error("");
    console.error("  This is the upstream MonoCode identity. Installing or running it would point the app at");
    console.error("  ~/Library/Application Support/com.monocode.desktop — upstream's database, not the Hub's.");
    console.error("  Rebuild with `npm run hub:build`.");
  }
  process.exit(1);
}

// The hub flag is a build-time Vite variable; a Hub bundle without it opens on MonoCode's own
// onboarding first-run flow. Warn rather than refuse: the identity above is the dangerous part.
const distIndex = `${app}/Contents/Resources/dist/index.html`;
if (existsSync(distIndex)) {
  const html = readFileSync(distIndex, "utf8");
  if (!html.includes("VITE_MONOCODE_HUB") && !html.includes("hub")) {
    console.warn(`WARN: ${app} looks like it may not have been built with VITE_MONOCODE_HUB=1.`);
  }
}

console.log(`OK: ${app} is the Hub (${identifier}).`);
