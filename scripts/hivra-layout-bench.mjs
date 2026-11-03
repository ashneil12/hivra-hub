#!/usr/bin/env node
// WP-03: measure upstream's two layouts with upstream's workspace benchmark and print one line per layout.
//   node scripts/hivra-layout-bench.mjs [--runs 5] [--engine chromium|webkit]
// Builds the benchmark bundle once, then alternates Classic and Focused runs on the same machine. The benchmark's own
// 50 ms budget may fail a run; its samples still count.
import { spawnSync } from "node:child_process";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const runs = Number(arg("runs", "5"));
const engine = arg("engine", "chromium");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const built = spawnSync(npm, ["run", "build", "--", "--mode", "benchmark"], { stdio: "inherit", shell: process.platform === "win32" });
if (built.status !== 0) process.exit(built.status ?? 1);

const samples = { classic: [], focused: [] };
for (let run = 0; run < runs; run++) {
  for (const layout of ["classic", "focused"]) {
    const out = spawnSync(
      npx,
      ["playwright", "test", "-c", "tests/browser/layout-performance.config.ts", `--project=${layout}-${engine}`, "--reporter=line"],
      { encoding: "utf8", env: { ...process.env, PERFORMANCE_PREBUILT: "1", LAYOUT_BENCH_ENGINE: engine }, shell: process.platform === "win32" },
    );
    const line = `${out.stdout}`.split("\n").find((l) => l.startsWith('{"samples"'));
    if (!line) {
      process.stderr.write(out.stdout + out.stderr);
      console.error(`no samples from the ${layout} run`);
      process.exit(1);
    }
    samples[layout].push(JSON.parse(line).samples);
  }
}

const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => sorted(a)[Math.floor(a.length / 2)];
const p95 = (a) => sorted(a)[Math.max(0, Math.ceil(a.length * 0.95) - 1)];
for (const [layout, list] of Object.entries(samples)) {
  const cold = list.flatMap((s) => s.slice(0, 6));
  const warm = list.flatMap((s) => s.slice(6));
  console.log(
    `${layout} (${engine}, ${runs} runs): cold median ${Math.round(median(cold))} ms, warm median ${Math.round(median(warm))} ms, warm p95 ${Math.round(p95(warm))} ms; per-run warm p95 ${list.map((s) => Math.round(p95(s.slice(6)))).join(", ")}`,
  );
}
