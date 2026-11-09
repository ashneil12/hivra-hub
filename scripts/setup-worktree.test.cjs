// Tests for scripts/setup-worktree.mjs in throwaway repositories: linking node_modules only when the lockfiles match,
// env files only when missing, never replacing a real .env, and never following a link out of the worktree.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

// WP-105: git run in a temporary repo must stop at the temp parent and never discover this checkout.
{
  const existing = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = existing ? `${os.tmpdir()}${path.delimiter}${existing}` : os.tmpdir();
}

const SCRIPT = path.join(__dirname, "setup-worktree.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", message);
}

/** A main checkout with a lockfile, a real node_modules and env files, a worktree of it, and a fake npm. */
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "monocode-setup-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, "main");
  fs.mkdirSync(main);
  git(main, "init", "-qb", "main");
  fs.writeFileSync(path.join(main, ".gitignore"), "node_modules/\n.env\n.env.*\n!.env.example\n");
  fs.writeFileSync(path.join(main, "package.json"), '{"name":"x"}\n');
  fs.writeFileSync(path.join(main, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(main, ".env.example"), "EXAMPLE=1\n");
  commitAll(main, "initial");
  fs.mkdirSync(path.join(main, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(main, "node_modules", "pkg", "index.js"), "main install\n");
  fs.writeFileSync(path.join(main, ".env"), "SECRET=main\n");
  fs.writeFileSync(path.join(main, ".env.local"), "LOCAL=main\n");
  const tree = path.join(dir, "tree");
  git(main, "worktree", "add", "-qb", "feature", tree);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const npmLog = path.join(dir, "npm.log");
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh\necho "npm $* in $PWD" >> "${npmLog}"\nexit \${FAKE_NPM_EXIT:-0}\n`,
    { mode: 0o755 },
  );
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  return { dir, main, tree, bin, npmLog, outside };
}

function run(f, { args = [], cwd = f.tree, env = {} } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
      MONOCODE_PROJECT_ROOT: f.main,
      MONOCODE_WORKTREE_PATH: cwd,
      ...env,
    },
  });
  return { code: result.status, out: result.stdout + result.stderr };
}

const npmCalls = (f) => (fs.existsSync(f.npmLog) ? fs.readFileSync(f.npmLog, "utf8") : "");

test("links node_modules when the lockfiles match, and missing env files only", (t) => {
  const f = fixture(t);
  // A real .env.local already in the worktree: never replaced.
  fs.writeFileSync(path.join(f.tree, ".env.local"), "LOCAL=mine\n");
  const { code, out } = run(f);
  assert.equal(code, 0, out);
  const modules = path.join(f.tree, "node_modules");
  assert.ok(fs.lstatSync(modules).isSymbolicLink());
  assert.equal(fs.readlinkSync(modules), path.join(f.main, "node_modules"));
  assert.equal(npmCalls(f), "", "no install when it can link");
  assert.ok(fs.lstatSync(path.join(f.tree, ".env")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(f.tree, ".env"), "utf8"), "SECRET=main\n");
  assert.ok(!fs.lstatSync(path.join(f.tree, ".env.local")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(f.tree, ".env.local"), "utf8"), "LOCAL=mine\n");
  assert.equal(fs.readFileSync(path.join(f.main, ".env.local"), "utf8"), "LOCAL=main\n");
  // The tracked example is the worktree's own checked-out copy, not a link.
  assert.ok(!fs.lstatSync(path.join(f.tree, ".env.example")).isSymbolicLink());
  assert.match(out, /kept \.env\.local/);

  // Running again changes nothing.
  const again = run(f);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already linked to the main checkout/);
  assert.match(again.out, /kept \.env: something is already there/);
});

test("runs npm ci when the lockfile differs, and fails when npm ci fails", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.tree, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
  const { code, out } = run(f);
  assert.equal(code, 0, out);
  assert.ok(!fs.existsSync(path.join(f.tree, "node_modules")), "nothing linked");
  assert.match(npmCalls(f), new RegExp(`npm ci --no-audit --no-fund in ${f.tree}`));
  assert.match(out, /package-lock.json differs/);

  const failing = fixture(t);
  fs.writeFileSync(path.join(failing.tree, "package-lock.json"), "{}\n");
  const failed = run(failing, { env: { FAKE_NPM_EXIT: "7" } });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /npm ci failed \(exit 7\)/);
});

test("replaces only a stale link to the main checkout, never a real install or a foreign link", (t) => {
  const f = fixture(t);
  const modules = path.join(f.tree, "node_modules");
  fs.symlinkSync(path.join(f.main, "node_modules"), modules);
  fs.writeFileSync(path.join(f.tree, "package-lock.json"), "{}\n");
  assert.equal(run(f).code, 0);
  assert.ok(!fs.existsSync(modules) || !fs.lstatSync(modules).isSymbolicLink(), "the stale link is gone");
  assert.equal(fs.readFileSync(path.join(f.main, "node_modules", "pkg", "index.js"), "utf8"), "main install\n");
  assert.match(npmCalls(f), /npm ci/);

  const g = fixture(t);
  fs.symlinkSync(g.outside, path.join(g.tree, "node_modules"));
  const foreign = run(g);
  assert.match(foreign.out, /is a link to .*outside; left as it is/);
  assert.equal(fs.readlinkSync(path.join(g.tree, "node_modules")), g.outside);

  const h = fixture(t);
  fs.mkdirSync(path.join(h.tree, "node_modules"));
  assert.match(run(h).out, /node_modules already matches the lockfile; nothing to do/);
});

test("leaves a real node_modules in place when the lockfile already matches", (t) => {
  const f = fixture(t);
  const modules = path.join(f.tree, "node_modules");
  fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules, "kept.js"), "local\n");
  const { code, out } = run(f);
  assert.equal(code, 0, out);
  assert.equal(npmCalls(f), "");
  assert.match(out, /node_modules already matches the lockfile; nothing to do/);
  const stat = fs.lstatSync(modules);
  assert.ok(stat.isDirectory());
  assert.ok(!stat.isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(modules, "kept.js"), "utf8"), "local\n");
});

test("leaves a real node_modules in place when the lockfile differs", (t) => {
  const f = fixture(t);
  const modules = path.join(f.tree, "node_modules");
  fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules, "kept.js"), "local\n");
  fs.writeFileSync(path.join(f.tree, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
  const { code, out } = run(f);
  assert.equal(code, 0, out);
  assert.equal(npmCalls(f), "");
  assert.match(out, /node_modules is already installed here; left as it is/);
  const stat = fs.lstatSync(modules);
  assert.ok(stat.isDirectory());
  assert.ok(!stat.isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(modules, "kept.js"), "utf8"), "local\n");
});

test("never follows a link out of the worktree or links a linked source", (t) => {
  const f = fixture(t);
  // The main checkout's .env is itself a link to somewhere else: not linked onward.
  fs.rmSync(path.join(f.main, ".env"));
  fs.writeFileSync(path.join(f.outside, "secret.env"), "ELSEWHERE=1\n");
  fs.symlinkSync(path.join(f.outside, "secret.env"), path.join(f.main, ".env"));
  // A folder in the worktree is a link out of it: an env file under it is refused.
  fs.mkdirSync(path.join(f.main, "config"));
  fs.writeFileSync(path.join(f.main, "config", ".env"), "CONFIG=1\n");
  fs.symlinkSync(f.outside, path.join(f.tree, "config"));
  const { code, out } = run(f, { args: ["--env", "config/.env", "--env", "../escape/.env"] });
  assert.equal(code, 0, out);
  assert.ok(!fs.existsSync(path.join(f.tree, ".env")));
  assert.match(out, /skipped \.env: it is a link in the main checkout/);
  assert.match(out, /refused config\/\.env: config is a link/);
  assert.match(out, /skipped \.\.\/escape\/\.env: not a plain path/);
  assert.deepEqual(fs.readdirSync(f.outside), ["secret.env"], "nothing written outside the worktree");
});

test("does nothing in the main checkout", (t) => {
  const f = fixture(t);
  const before = fs.readdirSync(f.main).sort();
  const { code, out } = run(f, { cwd: f.main });
  assert.equal(code, 0, out);
  assert.match(out, /this is the main checkout; nothing to set up/);
  assert.deepEqual(fs.readdirSync(f.main).sort(), before);
  assert.equal(npmCalls(f), "");
});

test("finds the main checkout with git when the Hub didn't pass it", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: f.tree,
    encoding: "utf8",
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, MONOCODE_PROJECT_ROOT: "", MONOCODE_WORKTREE_PATH: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`main checkout ${f.main}`));
  assert.ok(fs.lstatSync(path.join(f.tree, "node_modules")).isSymbolicLink());
});
