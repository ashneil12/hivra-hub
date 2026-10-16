// Guard: the Hub's dev loop must open the Hub.
//
// Why this exists. `tauri dev` reads `build.beforeDevCommand` from the *base* config
// (`src-tauri/tauri.conf.json`), which runs plain `npm run dev`. The Hub overlay
// (`tauri.hub.conf.json`) used to set only `bundle`, so no dev path ever set
// `VITE_MONOCODE_HUB=1`. `IS_HUB_BUNDLE` (src/features/hub/model/hubBundle.ts) reads that
// variable at build time, so a dev session came up as MonoCode rather than the Hub — the
// dev loop could not show a Hub change without building and installing the app.
//
// The Hub's identity is fixed the same way and for the same reason (scripts/identity-guard.sh):
// one config file per build path, checked rather than remembered. This asserts the dev half.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const base = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const hub = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.hub.conf.json"), "utf8"));

const HUB_FLAG = "VITE_MONOCODE_HUB=1";

test("the Hub's dev command sets the flag that makes the app open on the Hub", () => {
  const command = hub.build?.beforeDevCommand ?? "";
  assert.ok(
    command.includes(HUB_FLAG),
    `src-tauri/tauri.hub.conf.json build.beforeDevCommand must include ${HUB_FLAG}, or a dev session opens MonoCode instead of the Hub (got: ${JSON.stringify(command)})`,
  );
});

test("the Hub's dev command still runs the dev server the base config points at", () => {
  // devUrl is http://localhost:1420 and only `npm run dev` serves it; a command
  // that forgot the scripts would leave `tauri dev` waiting on nothing.
  const command = hub.build?.beforeDevCommand ?? "";
  assert.ok(
    command.includes("npm run dev"),
    `the Hub's dev command must still start vite (got: ${JSON.stringify(command)})`,
  );
});

test("both build paths set the Hub flag, so no path can open MonoCode under the Hub's id", () => {
  assert.ok(
    (base.build?.beforeBuildCommand ?? "").includes(HUB_FLAG),
    "the base build command must set the Hub flag",
  );
  assert.ok(
    (hub.build?.beforeDevCommand ?? "").includes(HUB_FLAG),
    "the Hub dev command must set the Hub flag",
  );
});

test("a hub:dev script exists and uses the overlay, which is where the flag now lives", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  const dev = scripts["hub:dev"] ?? "";
  assert.ok(dev.startsWith("tauri dev"), `hub:dev must run tauri dev (got: ${JSON.stringify(dev)})`);
  assert.ok(
    dev.includes("tauri.hub.conf.json"),
    "hub:dev must pass --config src-tauri/tauri.hub.conf.json; a bare `tauri dev` misses the Hub flag",
  );
});
