#!/usr/bin/env node
// The list of open-source tools Hivra runs for real (docs/hivra/proof-tools.json): validates it, checks that each
// version in it is what the repo really pins, and with --outdated asks the registries for the latest versions.
//
//   node scripts/proof-tools.mjs               validate; exit 1 on a bad list or a version that drifted
//   node scripts/proof-tools.mjs --outdated    also look up the latest versions (no network: "could not check", exit 0)

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isIsoDate, parseFlags, repoRoot } from "./guards-common.mjs";

export const USES = ["dependency", "cli", "ci", "skill-text"];
const REQUIRED = ["id", "name", "repo", "licence", "use", "version", "where", "since", "check", "registry"];

export function readList(root = repoRoot) {
  return JSON.parse(readFileSync(path.join(root, "docs/hivra/proof-tools.json"), "utf8"));
}

/** Shape problems of the list, as plain sentences. */
export function validate(list, root = repoRoot) {
  const problems = [];
  const tools = list?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return ["the list has no tools"];
  const seen = new Set();
  for (const tool of tools) {
    const id = tool?.id ?? "(no id)";
    for (const key of REQUIRED) if (tool?.[key] === undefined || tool[key] === "") problems.push(`${id}: no ${key}`);
    if (seen.has(id)) problems.push(`${id}: listed twice`);
    seen.add(id);
    if (tool.use && !USES.includes(tool.use)) problems.push(`${id}: use must be one of ${USES.join(", ")}`);
    if (tool.repo && !/^[\w.-]+\/[\w.-]+$/.test(tool.repo)) problems.push(`${id}: repo is not owner/name`);
    if (tool.since && !isIsoDate(tool.since)) problems.push(`${id}: since is not YYYY-MM-DD`);
    if (tool.version && !/^\d+\.\d+\.\d+$/.test(tool.version)) problems.push(`${id}: version is not x.y.z`);
    if (!Array.isArray(tool.where) || tool.where.length === 0) problems.push(`${id}: where is empty`);
    else for (const file of tool.where) if (!existsSync(path.join(root, file))) problems.push(`${id}: ${file} does not exist`);
  }
  return problems;
}

function lockVersion(root, kind, name) {
  if (kind === "npm-lock") {
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
    return lock.packages?.[`node_modules/${name}`]?.version ?? null;
  }
  const text = readFileSync(path.join(root, "Cargo.lock"), "utf8");
  const match = new RegExp(`\\[\\[package\\]\\]\\nname = "${name.replace(/[-/]/g, "\\$&")}"\\nversion = "([^"]+)"`).exec(text);
  return match ? match[1] : null;
}

/** The version the repo really pins for a tool, from its `check` field, or null when it cannot be read. */
export function pinnedVersion(tool, root = repoRoot) {
  try {
    const [kind, ...rest] = String(tool.check).split(":");
    if (kind === "npm-lock" || kind === "cargo-lock") return lockVersion(root, kind, rest.join(":"));
    if (kind === "file") {
      const file = rest.shift();
      const match = new RegExp(rest.join(":")).exec(readFileSync(path.join(root, file), "utf8"));
      return match ? match[1] : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Tools whose listed version is not the pinned one. */
export function drift(list, root = repoRoot) {
  const out = [];
  for (const tool of list.tools ?? []) {
    const pinned = pinnedVersion(tool, root);
    if (pinned !== tool.version) out.push(`${tool.id}: list says ${tool.version}, the repo pins ${pinned ?? "(not found)"}`);
  }
  return out;
}

export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Latest released version from the registry named in `registry` ("npm:<pkg>" or "crate:<name>"), or null. */
export async function latestVersion(registry, fetchImpl = fetch) {
  const [kind, ...rest] = String(registry).split(":");
  const name = rest.join(":");
  const signal = AbortSignal.timeout(8000);
  if (kind === "npm") {
    const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, { signal });
    return res.ok ? ((await res.json()).version ?? null) : null;
  }
  if (kind === "crate") {
    const res = await fetchImpl(`https://crates.io/api/v1/crates/${name}`, { signal, headers: { "User-Agent": "hivra-proof-tools" } });
    if (!res.ok) return null;
    const crate = (await res.json()).crate;
    return crate?.max_stable_version ?? crate?.max_version ?? null;
  }
  return null;
}

export async function outdated(list, fetchImpl = fetch) {
  const rows = [];
  for (const tool of list.tools) {
    let latest = null;
    try {
      latest = await latestVersion(tool.registry, fetchImpl);
    } catch {
      latest = null;
    }
    rows.push({ id: tool.id, repo: tool.repo, version: tool.version, latest });
  }
  return rows;
}

export function renderOutdated(rows) {
  if (rows.every((row) => row.latest === null)) return "Tools we run: could not check (no answer from the registries).";
  const lines = ["Tools we run:"];
  for (const row of rows) {
    if (row.latest === null) lines.push(`- ${row.id}: could not check`);
    else if (compareVersions(row.version, row.latest) < 0) lines.push(`- ${row.id}: behind. We run ${row.version}, latest is ${row.latest} (https://github.com/${row.repo}/releases)`);
    else lines.push(`- ${row.id}: up to date (${row.version})`);
  }
  return lines.join("\n");
}

export async function run(argv, root = repoRoot, fetchImpl = fetch) {
  const flags = parseFlags(argv);
  let list;
  try {
    list = readList(root);
  } catch (error) {
    console.log(`proof-tools.json cannot be read: ${error.message}`);
    return 1;
  }
  const problems = [...validate(list, root), ...drift(list, root)];
  if (problems.length > 0) {
    console.log(["The tools list has problems:", ...problems.map((p) => `- ${p}`)].join("\n"));
    if (!flags.outdated) return 1;
  } else console.log(`${list.tools.length} tools listed; every version matches what the repo pins.`);
  if (flags.outdated) console.log(renderOutdated(await outdated(list, fetchImpl)));
  return problems.length > 0 ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await run(process.argv.slice(2));
