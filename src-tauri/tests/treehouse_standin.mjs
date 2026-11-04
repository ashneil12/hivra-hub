// Test double for treehouse's lease CLI. It runs real local git and never
// fetches. It is not treehouse, and it is not shipped.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const { flags, positionals } = parse(argv);
const command = positionals[0];
const root = flags.root ? path.resolve(String(flags.root)) : "";

if (!command || !root) {
  fail(1, "need a command and --root");
}
fs.mkdirSync(root, { recursive: true });
fs.appendFileSync(
  path.join(root, "argv.log"),
  `${JSON.stringify({ command, flags, positionals })}\n`,
);
if (flags["include-leased"] || flags.force || flags.all) {
  fail(2, "refusing a flag that would remove or reset a leased worktree");
}

const statePath = path.join(root, "slots.json");
const state = readState(statePath);

if (command === "get") {
  if (flags["no-fetch"] !== true) fail(1, "refusing to fetch");
  const refused = path.join(root, "refuse-get.txt");
  if (fs.existsSync(refused)) fail(1, fs.readFileSync(refused, "utf8"));
  const holder = String(flags["lease-holder"] ?? "");
  const branch = String(flags.b ?? "");
  if (!flags.lease || !flags.json || !holder || !branch) {
    fail(1, "get needs --lease --json --lease-holder and -b");
  }
  const repo = git(process.cwd(), "rev-parse", "--show-toplevel");
  const repoName = path.basename(repo);
  const existing = state.slots.find(
    (slot) => slot.lease_holder === holder && slot.branch === branch && fs.existsSync(slot.path),
  );
  if (existing) {
    process.stdout.write(`${JSON.stringify(leaseJson(existing))}\n`);
    process.exit(0);
  }
  const reusable = state.slots.find(
    (slot) => !slot.lease_id && fs.existsSync(slot.path) && !porcelain(slot.path),
  );
  if (reusable) {
    git(reusable.path, "checkout", "--detach");
    git(reusable.path, "checkout", "-B", branch, headFor(repo));
    reusable.status = "leased";
    reusable.branch = branch;
    reusable.lease_id = crypto.randomBytes(16).toString("hex");
    reusable.lease_holder = holder;
    reusable.leased_at = new Date().toISOString();
    reusable.base_branch = currentBranch(repo);
    writeState(statePath, state);
    process.stdout.write(`${JSON.stringify(leaseJson(reusable))}\n`);
    process.exit(0);
  }
  const slotName = String(
    state.slots.reduce((max, slot) => Math.max(max, Number(slot.name) || 0), 0) + 1,
  );
  const slotPath = applyTemplate(String(flags["worktree-path"] ?? ""), {
    pool: root,
    slot: slotName,
    repo: repoName,
    repo_parent: path.dirname(repo),
  });
  if (!slotPath || slotPath.includes("..")) fail(1, "worktree path is not usable");
  const head = headFor(repo);
  fs.mkdirSync(path.dirname(slotPath), { recursive: true });
  if (fs.existsSync(path.join(slotPath, ".git"))) {
    const dirty = porcelain(slotPath);
    if (dirty) fail(3, "left in place: the worktree has uncommitted changes");
    git(slotPath, "checkout", "--detach");
    git(slotPath, "checkout", "-B", branch, head);
  } else if (branchExists(repo, branch)) {
    git(repo, "worktree", "add", "--", slotPath, branch);
  } else {
    git(repo, "worktree", "add", "--no-track", "-b", branch, "--", slotPath, head);
  }
  const slot = {
    name: slotName,
    path: slotPath,
    status: "leased",
    branch,
    lease_id: crypto.randomBytes(16).toString("hex"),
    lease_holder: holder,
    leased_at: new Date().toISOString(),
    base_branch: currentBranch(repo),
  };
  state.slots.push(slot);
  writeState(statePath, state);
  process.stdout.write(`${JSON.stringify(leaseJson(slot))}\n`);
  process.exit(0);
}

if (command === "return") {
  const slotPath = path.resolve(positionals[1] ?? "");
  const leaseId = String(flags["if-lease-id"] ?? "");
  const slot = state.slots.find((entry) => path.resolve(entry.path) === slotPath);
  if (!slot || !leaseId || slot.lease_id !== leaseId) {
    fail(1, "lease id does not match, so the worktree was left in place");
  }
  if (fs.existsSync(path.join(slotPath, ".pool-busy"))) {
    fail(1, "left in place: a process is still running");
  }
  if (porcelain(slotPath)) {
    fail(3, "left in place: the worktree has uncommitted changes");
  }
  git(slotPath, "checkout", "--detach");
  git(slotPath, "reset", "--hard");
  slot.status = "available";
  slot.lease_id = "";
  slot.lease_holder = "";
  slot.leased_at = "";
  writeState(statePath, state);
  process.exit(0);
}

if (command === "status") {
  if (!flags.json) fail(1, "status needs --json");
  const rows = state.slots.map((slot) => {
    let status = slot.lease_id ? "leased" : "available";
    if (slot.path && porcelain(slot.path)) status = "dirty";
    if (slot.path && fs.existsSync(path.join(slot.path, ".pool-quarantine"))) status = "damaged";
    return {
      name: slot.name,
      path: slot.path,
      status,
      branch: slot.branch,
      lease_id: slot.lease_id,
      lease_holder: slot.lease_holder,
      leased_at: slot.leased_at || null,
      processes: [],
    };
  });
  process.stdout.write(`${JSON.stringify(rows)}\n`);
  process.exit(0);
}

if (command === "prune") {
  const lines = [];
  const keep = [];
  for (const slot of state.slots) {
    if (slot.lease_id || porcelain(slot.path)) {
      lines.push(`skip ${slot.path}: leased or not clean`);
      keep.push(slot);
      continue;
    }
    lines.push(`would remove ${slot.path}`);
    if (flags.yes) {
      const removed = spawnSync("git", ["worktree", "remove", "--", slot.path], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      if (removed.status !== 0) {
        lines.push(`skip ${slot.path}: ${removed.stderr.trim()}`);
        keep.push(slot);
      }
    } else {
      keep.push(slot);
    }
  }
  if (flags.yes) {
    state.slots = keep;
    writeState(statePath, state);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(0);
}

fail(1, `unknown command ${command}`);

function parse(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "-b") {
      flags.b = args[(i += 1)];
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || !Array.isArray(parsed.slots)) return { slots: [] };
    return parsed;
  } catch {
    return { slots: [] };
  }
}

function writeState(file, next) {
  const part = `${file}.${process.pid}.part`;
  fs.writeFileSync(part, JSON.stringify(next));
  fs.renameSync(part, file);
}

function leaseJson(slot) {
  return {
    path: slot.path,
    lease_id: slot.lease_id,
    lease_holder: slot.lease_holder,
    leased_at: slot.leased_at,
    base_branch: slot.base_branch ?? "",
  };
}

function applyTemplate(template, values) {
  return template.replace(/\{(pool|slot|repo|repo_parent)\}/g, (_, key) => values[key] ?? "");
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root || osTmp(), "standin-gitconfig"),
    },
  });
  if (result.status !== 0) {
    fail(1, (result.stderr || result.stdout || "git failed").trim());
  }
  return (result.stdout || "").trim();
}

function porcelain(cwd) {
  if (!fs.existsSync(cwd)) return "";
  return git(cwd, "status", "--porcelain", "--untracked-files=normal");
}

function branchExists(repo, branch) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--", `refs/heads/${branch}`], {
    cwd: repo,
    encoding: "utf8",
  });
  return result.status === 0;
}

function currentBranch(repo) {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function headFor(repo) {
  return git(repo, "rev-parse", "HEAD");
}

function osTmp() {
  return os.tmpdir();
}

function fail(code, message) {
  process.stderr.write(`${String(message).trim()}\n`);
  process.exit(code);
}
