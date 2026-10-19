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
//
// Exits 0 and prints OK when the bundle is the daily Hub; exits 1 with a refusal otherwise.
// The helpers below are shared with scripts/identity-guard.test.cjs (and the Phase 1b ship and doctor scripts).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const HUB_IDENTIFIER = "com.ash.monocode-hub";
export const DEV_IDENTIFIER_PREFIX = "com.ash.monocode-hub.dev.";
export const SANDBOX_IDENTIFIER = "com.ash.monocode-hub.sandbox";
export const UPSTREAM_IDENTIFIER = "com.monocode.desktop";

const STAMP_MARKER = Buffer.from("MONOCODE-STAMP:{");

/** The same kind table as src-tauri/src/instance.rs: "daily", "dev", or null for anything else. */
export function kindOf(identifier) {
  if (identifier === HUB_IDENTIFIER) return "daily";
  if (typeof identifier === "string" && identifier.startsWith(DEV_IDENTIFIER_PREFIX)) {
    const slot = identifier.slice(DEV_IDENTIFIER_PREFIX.length);
    if (/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slot)) return "dev";
  }
  return null;
}

/** CFBundleIdentifier from the bundle's Info.plist, or null. */
export function readIdentifier(app) {
  const plist = path.join(app, "Contents/Info.plist");
  if (!existsSync(plist)) return null;
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** The build stamp embedded in a binary's bytes, or null. Values may contain "}", so each candidate end is tried. */
export function findStamp(bytes) {
  let from = 0;
  for (;;) {
    const at = bytes.indexOf(STAMP_MARKER, from);
    if (at === -1) return null;
    const start = at + STAMP_MARKER.length - 1;
    for (let end = bytes.indexOf(0x7d, start); end !== -1 && end - start < 4096; end = bytes.indexOf(0x7d, end + 1)) {
      try {
        const stamp = JSON.parse(bytes.subarray(start, end + 1).toString("utf8"));
        if (stamp && typeof stamp.sha === "string" && typeof stamp.branch === "string") return stamp;
      } catch {
        // not the end of the JSON yet
      }
    }
    from = at + STAMP_MARKER.length;
  }
}

/** The build stamp of a bundle, read without launching it, or null. */
export function readStamp(app) {
  const binary = path.join(app, "Contents/MacOS/monocode");
  if (!existsSync(binary)) return null;
  return findStamp(readFileSync(binary));
}

/** "hub/next @ 09141d8", with "-dirty" when the build had uncommitted changes. */
export function stampLabel(stamp) {
  return `${stamp.branch} @ ${String(stamp.sha).slice(0, 7)}${stamp.dirty ? "-dirty" : ""}`;
}

/** Whether `app` may be installed as the daily Hub: {ok, identifier, stamp, errors, warnings}. */
export function verifyDailyBundle(app) {
  const errors = [];
  const warnings = [];
  if (!existsSync(app)) return { ok: false, identifier: null, stamp: null, errors: [`no bundle at ${app}`], warnings };
  if (!existsSync(path.join(app, "Contents/Info.plist")))
    return {
      ok: false,
      identifier: null,
      stamp: null,
      errors: [`${app} has no Contents/Info.plist — not a macOS app bundle.`],
      warnings,
    };
  const identifier = readIdentifier(app);
  if (identifier !== HUB_IDENTIFIER) {
    errors.push(`CFBundleIdentifier = ${identifier ?? "unreadable"}, expected ${HUB_IDENTIFIER}`);
    if (identifier === UPSTREAM_IDENTIFIER)
      errors.push(
        "This is the upstream MonoCode identity. Installing or running it would point the app at " +
          "~/Library/Application Support/com.monocode.desktop — upstream's database, not the Hub's. " +
          "Rebuild with `npm run hub:build`.",
      );
    else if (kindOf(identifier) === "dev")
      errors.push("This is a dev copy: it runs from its worktree with its own data folder and is never installed.");
    else if (identifier === SANDBOX_IDENTIFIER)
      errors.push("This is the retired MonoCode Test copy. Dev copies replace it.");
  }
  const stamp = readStamp(app);
  if (!stamp)
    errors.push(
      "No build stamp (MONOCODE-STAMP) in Contents/MacOS/monocode: this build predates the instance lock and " +
        "would open the live data from anywhere. Rebuild with `npm run hub:build`.",
    );
  else if (stamp.dirty) warnings.push(`built with uncommitted changes (${stampLabel(stamp)})`);
  // The hub flag is a build-time Vite variable; a Hub bundle without it opens on MonoCode's own
  // onboarding first-run flow. Warn rather than refuse: the identity above is the dangerous part.
  const distIndex = path.join(app, "Contents/Resources/dist/index.html");
  if (existsSync(distIndex)) {
    const html = readFileSync(distIndex, "utf8");
    if (!html.includes("VITE_MONOCODE_HUB") && !html.includes("hub"))
      warnings.push("it may not have been built with VITE_MONOCODE_HUB=1");
  }
  return { ok: errors.length === 0, identifier, stamp, errors, warnings };
}

function main() {
  const app = process.argv[2];
  if (!app) {
    console.error("usage: node scripts/verify-hub-bundle.mjs <path to .app>");
    process.exit(2);
  }
  const result = verifyDailyBundle(app);
  for (const warning of result.warnings) console.warn(`WARN: ${app}: ${warning}`);
  if (!result.ok) {
    console.error(`REFUSE: ${app}`);
    for (const error of result.errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log(
    `OK: ${app} is the Hub (${result.identifier}), ${stampLabel(result.stamp)}, built ${result.stamp.builtAt}.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
