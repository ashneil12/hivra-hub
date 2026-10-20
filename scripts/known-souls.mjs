#!/usr/bin/env node
// Builds src/features/hub/model/knownSouls.generated.ts: a SHA-256 of every soul the app itself ever seeded, from git
// history (every commit on every ref that touched a soul template, plus the working tree). Soul refresh uses it for a
// soul with no recorded template: it only takes the new template when the soul is exactly one of these, so a soul Ash
// edited is never swapped. A Lead's soul has values in it (its name, project, id, folder); those are hashed as tokens,
// and soulRefresh.ts puts the same tokens back in before it hashes a real soul.
//
//   node scripts/known-souls.mjs          write the file
//   node scripts/known-souls.mjs --check  exit 1 if it is out of date
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const esbuild = require("esbuild");
const OUT = "src/features/hub/model/knownSouls.generated.ts";
const FILES = {
  leads: "src/features/hub/model/hubLeads.ts",
  team: "src/features/hub/model/teamSouls.ts",
  checker: "src/features/hub/model/hubChecker.ts",
};
/** Must match soulRefresh.ts SOUL_TOKENS. */
const T = { id: "\u27e6id\u27e7", name: "\u27e6name\u27e7", projectName: "\u27e6projectName\u27e7", projectId: "\u27e6projectId\u27e7", folder: "\u27e6folder\u27e7" };

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });

/** Any value a soul file might import: callable, indexable, never throws at load. */
function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : stub()) });
}

function load(source) {
  const { code } = esbuild.transformSync(source, { loader: "ts", format: "cjs", target: "node20" });
  const module = { exports: {} };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  new Function("module", "exports", "require", "localStorage", code)(module, module.exports, () => stub(), localStorage);
  return module.exports;
}

/** monoFiles.ts defaultSoul, both versions it has had: always wrapping, and keeping a whole "# Soul" as it is. */
function wrapped(instructions) {
  const own = instructions?.trim();
  const plain = `# Soul\n\n## Standing instructions\n${own || "- (Add anything it should always keep in mind.)"}\n`;
  return own && /^# Soul\s*\n/.test(own) ? [plain, `${own}\n`] : [plain];
}

const norm = (text) => text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
const sha = (text) => crypto.createHash("sha256").update(norm(text)).digest("hex");

function versions(file) {
  const commits = git("log", "--all", "--format=%H %cs", "--", file).trim().split("\n").filter(Boolean).map((l) => l.split(" "));
  // Oldest first, so each soul is labelled with the day it was first seeded (stable as history grows).
  // Labelled by day only, so a soul written in the working tree keeps its label once it is committed (same day).
  const out = commits.reverse().map(([c, day]) => ({ from: day, source: git("show", `${c}:${file}`) }));
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (fs.existsSync(path.join(root, file))) out.push({ from: today, source: fs.readFileSync(path.join(root, file), "utf8") });
  return out;
}

/** Must match soulRefresh.ts withoutWho: a Lead's "You are ..." line (its name, project and folder) set aside. */
const WHO = "\u27e6who\u27e7";
const withoutWho = (text) => norm(text).replace(/^You are .*$/m, WHO);

const known = new Map(); // hash -> { kind, from }
const shapes = new Map(); // hash of the soul with its "You are" line set aside -> { kind, from }
const add = (text, kind, from) => {
  const h = sha(text);
  if (!known.has(h)) known.set(h, { kind, from });
  if (kind === "lead") {
    const w = sha(withoutWho(text));
    if (!shapes.has(w)) shapes.set(w, { kind, from });
  }
};
const problems = [];

for (const { from, source } of versions(FILES.leads)) {
  try {
    const { leadSoul } = load(source);
    if (typeof leadSoul !== "function") continue;
    const generic = { id: T.id, name: T.name, projectName: T.projectName, projectId: T.projectId, legacy: undefined };
    // The hub's own Lead has "hub" itself as its project id (and may get extra rules for it).
    for (const lead of [generic, { ...generic, projectId: "hub" }]) {
      for (const folder of [T.folder, null]) {
        for (const text of wrapped(leadSoul(lead, folder))) add(text, "lead", from);
      }
    }
  } catch (e) {
    problems.push(`${FILES.leads} @ ${from}: ${e.message}`);
  }
}
for (const { from, source } of versions(FILES.team)) {
  try {
    const { TEAM_SOULS } = load(source);
    for (const soul of Object.values(TEAM_SOULS ?? {})) for (const text of wrapped(soul)) add(text, "team", from);
  } catch (e) {
    problems.push(`${FILES.team} @ ${from}: ${e.message}`);
  }
}
for (const { from, source } of versions(FILES.checker)) {
  try {
    const { CHECKER_SOUL } = load(source);
    if (typeof CHECKER_SOUL === "string") for (const text of wrapped(CHECKER_SOUL)) add(text, "checker", from);
  } catch (e) {
    problems.push(`${FILES.checker} @ ${from}: ${e.message}`);
  }
}

const sorted = (map) => [...map].sort((a, b) => a[1].kind.localeCompare(b[1].kind) || a[0].localeCompare(b[0]));
const rows = sorted(known);
const shapeRows = sorted(shapes);
const body = `// Generated by scripts/known-souls.mjs from git history. Do not edit; run \`node scripts/known-souls.mjs\`.
// SHA-256 of every soul the app itself ever seeded (normalized: LF line ends, no trailing whitespace; a Lead's own
// values as soulRefresh.ts SOUL_TOKENS). ${rows.length} souls.
export const KNOWN_SOUL_HASHES: ReadonlyMap<string, string> = new Map([
${rows.map(([h, v]) => `  ["${h}", "${v.kind} · ${v.from}"],`).join("\n")}
]);

// The same Lead souls with their "You are ..." line (name, project, folder) set aside: a Lead whose roster has no folder,
// or another one, is still recognised as the app's own text everywhere else. ${shapeRows.length} shapes.
export const KNOWN_LEAD_SHAPES: ReadonlyMap<string, string> = new Map([
${shapeRows.map(([h, v]) => `  ["${h}", "${v.kind} · ${v.from}"],`).join("\n")}
]);
`;
if (problems.length) console.error(`Skipped versions that wouldn't load:\n- ${problems.join("\n- ")}`);
const target = path.join(root, OUT);
if (process.argv.includes("--check")) {
  const now = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (now !== body) {
    console.error(`${OUT} is out of date: run node scripts/known-souls.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date (${rows.length} souls).`);
} else {
  fs.writeFileSync(target, body);
  console.log(`Wrote ${OUT}: ${rows.length} souls.`);
}
