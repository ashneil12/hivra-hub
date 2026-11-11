#!/usr/bin/env node
// The Dropwave preview: `npm run dropwave:build` -> target/dropwave/ (dropwave.html + assets/), plus
// target/dropwave/page.html, the whole page as one fragment with its script and styles inlined, for a host that wraps
// a page in its own skeleton (a claude.ai Artifact). Example data only; nothing reaches a CLI, folder or network.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = "target/dropwave";
const vite = spawnSync(
  "npx",
  ["vite", "build", "-c", "vite.dropwave.config.ts"],
  { stdio: "inherit" },
);
if (vite.status !== 0) process.exit(vite.status ?? 1);

const html = readFileSync(join(out, "dropwave.html"), "utf8");
const read = (href) =>
  readFileSync(join(out, href.replace(/^\.\//, "")), "utf8");
const js = /<script type="module" crossorigin src="([^"]+)"><\/script>/.exec(
  html,
)?.[1];
const css = /<link rel="stylesheet" crossorigin href="([^"]+)">/.exec(
  html,
)?.[1];
if (!js || !css)
  throw new Error(
    "dropwave: could not find the built script or stylesheet in dropwave.html",
  );
const fonts = /<link rel="stylesheet" href="(https:\/\/fonts[^"]+)"/.exec(
  html,
)?.[1];
const page = [
  "<title>Dropwave preview</title>",
  fonts ? `<link rel="stylesheet" href="${fonts}">` : "",
  `<style>:root{color-scheme:dark}html,body{margin:0;height:100%;background:#0F1113}\n${read(css)}</style>`,
  '<div id="root"></div>',
  `<script type="module">${read(js).replace(/<\/script/gi, "<\\/script")}</script>`,
  "",
].join("\n");
writeFileSync(join(out, "page.html"), page);
console.log(
  `dropwave: ${out}/page.html (${Math.round(page.length / 1024)} KB)`,
);
