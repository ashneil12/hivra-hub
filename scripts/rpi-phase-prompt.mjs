#!/usr/bin/env node
// WP-84: print the prompt a Hivra phase worker gets. Same function the app calls. Nothing else on stdout.
//
// The task is always a real task record, never free text:
//
//   node scripts/rpi-phase-prompt.mjs --phase <phase> --record <task.json> --repo <repo> [--project <folder>]
//   node scripts/rpi-phase-prompt.mjs --phase <phase> --task <id> --tasks <store.json> --repo <repo> [--project <folder>]
//
// --repo is the Hivra checkout the skill files and the prompt code are read from. --project is the folder
// the prompt names as the worker's project; it defaults to --repo.
//
// A record file holds one task: { "id": "...", "title": "...", "description": "..." }.
// A store file holds records as a list, as { "tasks": [ ... ] }, or as a map by id.

import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL_ROOT = ["src-tauri", "plugins", "hivra-rpi", "skills"];
const RECORD_MAX_BYTES = 1_000_000;

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

/** A task record as the store returns it: an id, a title and a description, all text. */
export function isTaskRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.id !== "string" || !value.id.trim() || value.id.trim().length > 80) return false;
  return typeof value.title === "string" && typeof value.description === "string";
}

/** Every record a file's contents offer, with a map's key as the id when the record has none. */
function recordsIn(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.tasks)) return value.tasks;
  return Object.entries(value).map(([id, entry]) =>
    isTaskRecord(entry) ? entry : entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry, id } : entry,
  );
}

/** The record for this id in a file's contents: one record, a list of them, or a map by id. */
export function findRecord(value, id) {
  const named = typeof id === "string" ? id.trim() : "";
  if (!named) return undefined;
  if (isTaskRecord(value)) return value.id.trim() === named ? value : undefined;
  for (const entry of recordsIn(value)) {
    if (isTaskRecord(entry) && entry.id.trim() === named) return entry;
  }
  return undefined;
}

/** A JSON file the person named. A folder, a broken file or one over a megabyte is no record. */
function readJson(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function parseArgs(argv) {
  const out = { phase: "", task: "", tasks: "", record: "", repo: "", project: "" };
  const flags = new Set(["--phase", "--task", "--tasks", "--record", "--repo", "--project"]);
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!flags.has(arg)) return undefined;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    out[arg.slice(2)] = value;
    i += 1;
  }
  if (!out.phase.trim() || !out.repo.trim()) return undefined;
  if (!out.project.trim()) out.project = out.repo;
  if (out.record) return out.task.trim() || out.tasks.trim() ? undefined : out;
  if (!out.task.trim() || !out.tasks.trim()) return undefined;
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
  if (!parsed) fail("Give a phase, a task record and a repository.");
  let repo;
  try {
    repo = realpathSync(parsed.repo);
    if (!statSync(repo).isDirectory()) fail("That repository is not a folder.");
  } catch {
    fail("That repository is not a folder.");
  }
  let project;
  try {
    project = realpathSync(parsed.project);
    if (!statSync(project).isDirectory()) fail("That project is not a folder.");
  } catch {
    fail("That project is not a folder.");
  }
  const contents = readJson(parsed.record || parsed.tasks);
  if (contents === undefined) fail("That task file is not readable JSON.");
  const record = parsed.record ? (isTaskRecord(contents) ? contents : undefined) : findRecord(contents, parsed.task);
  if (!record) fail(parsed.record ? "That task file is not a task record." : "That task file has no record for this id.");
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
  const prompt = mod.promptForPhase?.(parsed.phase, record, project, text);
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
