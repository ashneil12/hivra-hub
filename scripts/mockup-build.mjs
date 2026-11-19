#!/usr/bin/env node
// The design mockup: the real app as static files, every native call stubbed, example data only (src/dev/mockup).
//
//   npm run mockup:build      -> target/mockup/ (mockup.html + assets/), open it from any static server
//
// It also writes target/mockup/page.html: the same page as a fragment (no doctype, html, head or body tags), for a
// host that wraps the page in its own skeleton (a claude.ai Artifact). Nothing here reaches a real data folder, CLI,
// key or chat.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const out = "target/mockup";
const vite = spawnSync("npx", ["vite", "build", "--mode", "mockup"], {
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_MONOCODE_HUB: "1",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=8192"].filter(Boolean).join(" "),
  },
});
if (vite.status !== 0) process.exit(vite.status ?? 1);

const html = readFileSync(join(out, "mockup.html"), "utf8");
const head = /<head>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
const body = /<body>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? "";
const fragment = [
  head.replace(/<meta charset[^>]*>\s*/i, "").replace(/<meta name="viewport"[^>]*>\s*/i, "").trim(),
  body.trim(),
  "",
].join("\n");
writeFileSync(join(out, "page.html"), fragment);

const files = readdirSync(join(out, "assets"));
const big = files
  .map((name) => ({ name, size: readFileSync(join(out, "assets", name)).length }))
  .filter((file) => file.size > 15 * 1024 * 1024);
console.log(`mockup: ${files.length} asset files in ${out}/assets, page fragment in ${out}/page.html`);
if (files.length > 250) console.warn("mockup: more than 250 asset files; group more chunks in vite.config.ts (mockupChunk)");
for (const file of big) console.warn(`mockup: ${file.name} is over 15 MB`);
