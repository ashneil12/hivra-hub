#!/usr/bin/env node
// WP-84: print the prompt a Hivra phase worker gets. Same function the app calls. Nothing else on stdout.
//
//   node scripts/rpi-phase-prompt.mjs --phase <phase> --task <task> --repo <repo>
//   node scripts/rpi-phase-prompt.mjs <phase> <task> <repo>

import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL_ROOT = ["src-tauri", "plugins", "hivra-rpi", "skills"];

/** The skill file inside this repository, or nothing. A path that leaves the repository is refused. */
export function skillFile(repo, skill) {
  if (typeof repo !== "string" || typeof skill !== "string") return undefined;
  if (!/^[a-z0-9-]+$/.test(skill)) return undefined;
  let root;
  try {
    root = realpathSync(repo);
    if (!statSync(root).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const file = resolve(root, ...SKILL_ROOT, skill, "SKILL.md");
  let canonical;
  try {
    canonical = realpathSync(file);
  } catch {
    return undefined;
  }
  const rel = relative(root, canonical);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return undefined;
  return canonical;
}

export function parseArgs(argv) {
  const out = { phase: "", task: "", repo: "" };
  const rest = [];
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--phase" || arg === "--task" || arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      out[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith("--")) return undefined;
    else rest.push(arg);
  }
  if (!out.phase && rest.length > 0) {
    if (rest.length !== 3) return undefined;
    out.phase = rest[0];
    out.task = rest[1];
    out.repo = rest[2];
  }
  if (!out.phase.trim() || !out.task.trim() || !out.repo.trim()) return undefined;
  return out;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function loadPrompt(repo) {
  const entry = resolve(repo, "src/features/phases/model/phasePrompt.ts");
  try {
    statSync(entry);
  } catch {
    fail("That repository has no phase prompt.");
  }
  const esbuild = await import("esbuild");
  const built = await esbuild.build({
    absWorkingDir: repo,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    legalComments: "none",
  });
  const source = built.outputFiles?.[0]?.text;
  if (!source) fail("Could not build the phase prompt.");
  const dir = mkdtempSync(resolve(tmpdir(), "rpi-phase-"));
  const file = resolve(dir, "phasePrompt.mjs");
  try {
    writeFileSync(file, source);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed) fail("Give a phase name, a task and a repository.");
  let repo;
  try {
    repo = realpathSync(parsed.repo);
    if (!statSync(repo).isDirectory()) fail("That repository is not a folder.");
  } catch {
    fail("That repository is not a folder.");
  }
  const mod = await loadPrompt(repo);
  const skill = mod.skillNameFor?.(parsed.phase);
  if (!skill) fail("That phase name is not a skill.");
  const file = skillFile(repo, skill);
  if (!file) fail("That repository has no skill file for this phase.");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    fail("That repository has no skill file for this phase.");
  }
  const prompt = mod.promptForPhase?.(parsed.phase, parsed.task, repo, text);
  if (typeof prompt !== "string" || !prompt) fail("Could not build the phase prompt.");
  process.stdout.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch(() => fail("Could not build the phase prompt."));
}
