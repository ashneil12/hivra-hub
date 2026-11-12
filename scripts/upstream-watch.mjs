#!/usr/bin/env node
// Daily watch over every upstream and borrowed-idea repo Hivra tracks (docs/hivra/upstream-watch.json).
// For each repo it asks git (no GitHub API, no token) for the default branch head and the tags, compares them with
// the state file, and for a moved head fetches only the new commits (blob-less, shallow) to list their subjects.
//
//   node scripts/upstream-watch.mjs --state <file> [--write] [--json] [--only owner/repo,...] [--days 7]
//
// Without --write the state file is only read. A repo with no state yet is reported over the last --days (default 7)
// and then remembered. Output: a Markdown digest on stdout (or JSON with --json). It never changes this checkout.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const listFile = path.join(here, "..", "docs", "hivra", "upstream-watch.json");

export function parseArgs(argv) {
  const args = { write: false, json: false, days: 7, only: null, state: null, cache: null, concurrency: 8 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--json") args.json = true;
    else if (a === "--state") args.state = argv[++i];
    else if (a === "--cache") args.cache = argv[++i];
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.state) throw new Error("--state <file> is required");
  args.cache ??= path.join(homedir(), ".cache", "hivra-upstream-watch");
  return args;
}

const git = (argv, opts = {}) =>
  run("git", argv, { maxBuffer: 64 * 1024 * 1024, timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...opts });

/** Parse `git ls-remote --symref <url> HEAD 'refs/tags/*'` into { head, branch, tags: {name: sha} }. */
export function parseLsRemote(text) {
  const out = { head: null, branch: null, tags: {} };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const sym = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/);
    if (sym) { out.branch = sym[1]; continue; }
    const [sha, ref] = line.split(/\s+/);
    if (ref === "HEAD") out.head = sha;
    else if (ref?.startsWith("refs/tags/")) {
      const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
      // A peeled annotated tag (^{}) names the commit; prefer it.
      if (ref.endsWith("^{}") || !(name in out.tags)) out.tags[name] = sha;
    }
  }
  return out;
}

/** Tags in `now` that `before` did not have, newest-looking first. */
export function newTags(before, now) {
  const had = new Set(Object.keys(before ?? {}));
  return Object.keys(now).filter((t) => !had.has(t)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

async function commitsSince(entry, url, prev, now, args) {
  const dir = path.join(args.cache, entry.repo.toLowerCase().replace("/", "__") + ".git");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    await git(["init", "--bare", "-q", dir]);
  }
  const since = prev?.checkedAt ? new Date(Date.parse(prev.checkedAt) - 2 * 86400_000) : new Date(Date.now() - args.days * 86400_000);
  const fetchArgs = ["-C", dir, "fetch", "-q", "--filter=blob:none", "--no-tags", url, `+${now.head}:refs/watch/head`];
  try {
    await git([...fetchArgs.slice(0, 4), `--shallow-since=${since.toISOString()}`, ...fetchArgs.slice(4)]);
  } catch {
    await git([...fetchArgs.slice(0, 4), "--depth=100", ...fetchArgs.slice(4)]);
  }
  const range = prev?.head && (await git(["-C", dir, "cat-file", "-e", `${prev.head}^{commit}`]).then(() => true, () => false))
    ? [`${prev.head}..refs/watch/head`]
    : ["refs/watch/head", `--since=${since.toISOString()}`];
  const logArgs = ["-C", dir, "log", "--no-merges", "--format=%h%x09%as%x09%an%x09%s", ...range];
  if (entry.path) logArgs.push("--", entry.path);
  const { stdout } = await git(logArgs).catch(() => ({ stdout: "" }));
  return stdout.split("\n").filter(Boolean).map((l) => {
    const [sha, date, author, ...subject] = l.split("\t");
    return { sha, date, author, subject: subject.join("\t") };
  });
}

async function checkOne(entry, prev, args) {
  const url = `https://github.com/${entry.repo}`;
  try {
    const { stdout } = await git(["ls-remote", "--symref", url, "HEAD", "refs/tags/*"]);
    const now = parseLsRemote(stdout);
    if (!now.head) throw new Error("no HEAD");
    const tags = newTags(prev?.tags, now.tags);
    const moved = prev?.head !== now.head;
    const commits = moved ? await commitsSince(entry, url, prev, now, args) : [];
    return { ...entry, url, ok: true, branch: now.branch, head: now.head, firstSeen: !prev, commits, newTags: prev ? tags : [], state: { head: now.head, branch: now.branch, tags: now.tags, checkedAt: new Date().toISOString() } };
  } catch (e) {
    return { ...entry, url, ok: false, error: String(e.stderr || e.message).split("\n")[0].slice(0, 200), state: prev };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export function digest(results) {
  const lines = [];
  const active = results.filter((r) => r.ok && (r.commits.length || r.newTags.length));
  const failed = results.filter((r) => !r.ok);
  lines.push(`# Upstream watch, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, "");
  lines.push(`${results.length} repos checked: ${active.length} with news, ${results.length - active.length - failed.length} quiet, ${failed.length} unreachable.`, "");
  const order = ["upstream", "harness", "vendored"];
  active.sort((a, b) => ((order.indexOf(a.group) + 1 || 9) - (order.indexOf(b.group) + 1 || 9)) || b.commits.length - a.commits.length);
  for (const r of active) {
    lines.push(`## ${r.name} (${r.repo}${r.path ? "/" + r.path : ""}) [${r.group}]`);
    lines.push(`Why we watch: ${r.why}`);
    if (r.newTags.length) lines.push(`New tags/releases: ${r.newTags.slice(0, 10).join(", ")}${r.newTags.length > 10 ? ` (+${r.newTags.length - 10})` : ""}`);
    if (r.commits.length) {
      lines.push(`${r.commits.length} new commit(s)${r.firstSeen ? " (first look, recent window)" : ""} on ${r.branch}:`);
      for (const c of r.commits.slice(0, 25)) lines.push(`- ${c.date} ${c.sha} ${c.subject}`);
      if (r.commits.length > 25) lines.push(`- ... ${r.commits.length - 25} more`);
    }
    lines.push("");
  }
  if (failed.length) {
    lines.push("## Unreachable");
    for (const r of failed) lines.push(`- ${r.repo}: ${r.error}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = JSON.parse(await readFile(listFile, "utf8")).repos;
  const picked = args.only ? list.filter((e) => args.only.includes(e.repo.toLowerCase())) : list;
  const state = existsSync(args.state) ? JSON.parse(await readFile(args.state, "utf8")) : { repos: {} };
  const key = (e) => (e.repo + (e.path ? "/" + e.path : "")).toLowerCase();
  const results = await pool(picked, args.concurrency, (e) => checkOne(e, state.repos[key(e)], args));
  if (args.write) {
    for (const r of results) if (r.state) state.repos[key(r)] = r.state;
    state.lastRun = new Date().toISOString();
    await mkdir(path.dirname(path.resolve(args.state)), { recursive: true });
    const tmp = args.state + ".tmp";
    await writeFile(tmp, JSON.stringify(state, null, 1));
    await rename(tmp, args.state);
  }
  if (args.json) process.stdout.write(JSON.stringify(results.map(({ state: _s, ...r }) => r), null, 1) + "\n");
  else process.stdout.write(digest(results) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
