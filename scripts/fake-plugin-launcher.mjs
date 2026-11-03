#!/usr/bin/env node
// A stand-in for the app binary's `plugin-mcp` launcher (src-tauri/src/plugins/wiring.rs) in tests that run without
// the Rust side (WP-30). It replays a launch the real launcher worked out: HIVRA_FAKE_LAUNCHES names a JSON file of
// { "<server>": { launcherArgs, program, args, cwd, env } } (the "launch" part of
// src/features/plugins/model/__fixtures__/rust-wiring.json, made by the Rust tests). It refuses arguments the real
// launcher wasn't given, and starts the program as the launcher does: from a clean environment (PATH and HOME only
// here) plus the server's own variables.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const launches = JSON.parse(readFileSync(process.env.HIVRA_FAKE_LAUNCHES ?? "", "utf8"));
const launch = Object.values(launches).find((l) => JSON.stringify(l.launcherArgs) === JSON.stringify(args));
if (!launch) {
  process.stderr.write(`hivra plugin server (stand-in): no launch for ${JSON.stringify(args)}\n`);
  process.exit(78);
}
const program = launch.program === "node" ? process.execPath : launch.program;
const child = spawn(program, launch.args, {
  cwd: launch.cwd,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...launch.env },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
