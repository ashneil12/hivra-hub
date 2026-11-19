// What a MonoCode Hub bundle is, read without launching it: its kind (src-tauri/src/instance.rs's kind table), its
// CFBundleIdentifier and its build stamp (MONOCODE-STAMP, written by src-tauri/build.rs).
//
// Used by scripts/verify-hub-bundle.mjs (hub:verify, hub:install), scripts/identity-guard.test.cjs and the Phase 1b
// ship and doctor scripts. This module only reads.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const HUB_IDENTIFIER = "com.ash.monocode-hub";
export const DEV_IDENTIFIER_PREFIX = "com.ash.monocode-hub.dev.";
export const SANDBOX_IDENTIFIER = "com.ash.monocode-hub.sandbox";
export const UPSTREAM_IDENTIFIER = "com.monocode.desktop";

/** Where `npm run hub:build` leaves the bundle, under a checkout. hub:ship and hub:check-all both look here. */
export const BUNDLE_DIR = "target/release/bundle/macos";
export const BUNDLE_NAME = "MonoCode Hub.app";
export const defaultBundlePath = (repo) => path.join(repo, BUNDLE_DIR, BUNDLE_NAME);

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

/**
 * A string value from an XML plist. Binary plists are left to PlistBuddy, which is macOS-only.
 * WP-09: Windows and Linux tests write the XML plist the ship fixtures already use.
 */
function readXmlPlistString(plist, key) {
  let bytes;
  try {
    bytes = readFileSync(plist);
  } catch {
    return null;
  }
  if (bytes.subarray(0, 6).toString() === "bplist") return null;
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(bytes.toString("utf8"));
  if (!match) return null;
  const value = match[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").trim();
  return value || null;
}

/** CFBundleIdentifier from the bundle's Info.plist, or null. */
export function readIdentifier(app) {
  const plist = path.join(app, "Contents/Info.plist");
  if (!existsSync(plist)) return null;
  // WP-09: PlistBuddy stays the macOS reader (real bundles are binary plists).
  if (process.platform !== "darwin") return readXmlPlistString(plist, "CFBundleIdentifier");
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

/** CFBundleShortVersionString (the version the app shows and running.json records), or null. */
export function readVersion(app) {
  const plist = path.join(app, "Contents/Info.plist");
  if (!existsSync(plist)) return null;
  if (process.platform !== "darwin") return readXmlPlistString(plist, "CFBundleShortVersionString");
  try {
    const value = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return value || null;
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
