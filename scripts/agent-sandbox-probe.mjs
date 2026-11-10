#!/usr/bin/env node
// WP-178: measures what a macOS seatbelt boundary can and cannot stop, for the agent OS sandbox design doc
// (docs/hivra/work/WP-178-agent-os-sandbox.md). It builds a throwaway HOME and project under the OS temp dir,
// runs each probe through /usr/bin/sandbox-exec with a denylist profile, and prints one JSON document.
// It starts no agent, touches no app data, and never uses the real HOME. Run: node scripts/agent-sandbox-probe.mjs [--runs N]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function argRuns() {
  const i = process.argv.indexOf("--runs");
  const n = i >= 0 ? Number(process.argv[i + 1]) : 20;
  return Number.isInteger(n) && n > 0 ? n : 20;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// A denylist: everything is allowed except the listed secret paths (reads and writes) and the git hook and config
// writes. Written to a file outside the project, so the profile itself is never inside what it protects.
function denylistProfile(home, project) {
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath "${home}/.ssh"))`,
    `(deny file-read* file-write* (literal "${home}/.zshrc"))`,
    `(deny file-write* (subpath "${project}/.git/hooks"))`,
    `(deny file-write* (literal "${project}/.git/config"))`,
    "",
  ].join("\n");
}

function sandboxed(profile, argv, cwd) {
  return spawnSync(SANDBOX_EXEC, ["-f", profile, ...argv], { cwd, encoding: "utf8" });
}

// Refused means the sandbox said no: a non-zero exit with the sandbox's own error. A launch failure (exit 71) is not a
// refusal, so a probe that could not start is reported as an error, never as a pass.
function outcomeOf(r) {
  if (r.status === 0) return "allowed";
  const stderr = `${r.stderr || ""}${r.stdout || ""}`;
  if (r.status === 71 || /execvp\(\)/.test(stderr)) return "error";
  if (/Operation not permitted|Permission denied/.test(stderr) || r.status !== null) return "refused";
  return "error";
}

function main() {
  if (process.platform !== "darwin") {
    console.error("agent-sandbox-probe: macOS only (sandbox-exec). Other platforms are not measured yet.");
    process.exit(2);
  }
  if (!fs.existsSync(SANDBOX_EXEC)) {
    console.error("agent-sandbox-probe: /usr/bin/sandbox-exec is missing.");
    process.exit(2);
  }
  const runs = argRuns();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "wp178-probe-"));
  const home = path.join(root, "home");
  const project = path.join(home, "project");
  try {
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ssh", "id_test"), "probe-only, not a key\n");
    fs.writeFileSync(path.join(home, ".zshrc"), "export PROBE=1\n");
    fs.writeFileSync(path.join(home, "Documents", "note.txt"), "probe\n");
    fs.writeFileSync(path.join(project, "README.md"), "probe\n");
    execFileSync("git", ["init", "-q", project]);

    const profile = path.join(root, "denylist.sb");
    fs.writeFileSync(profile, denylistProfile(home, project));

    const probes = [
      { id: "read-ssh-key", expect: "refused", argv: ["/bin/cat", path.join(home, ".ssh", "id_test")] },
      { id: "read-zshrc", expect: "refused", argv: ["/bin/cat", path.join(home, ".zshrc")] },
      { id: "write-git-hooks", expect: "refused", argv: ["/bin/sh", "-c", "echo x > .git/hooks/pre-commit"] },
      { id: "write-git-config", expect: "refused", argv: ["/bin/sh", "-c", "echo x >> .git/config"] },
      { id: "read-outside-list", expect: "allowed", argv: ["/bin/cat", path.join(home, "Documents", "note.txt")] },
      { id: "write-project-src", expect: "allowed", argv: ["/bin/sh", "-c", "echo x > src/a.txt"] },
      { id: "read-project-readme", expect: "allowed", argv: ["/bin/cat", "README.md"] },
    ];
    const results = probes.map((p) => {
      const r = sandboxed(profile, p.argv, project);
      const outcome = outcomeOf(r);
      return { id: p.id, expect: p.expect, outcome, exitCode: r.status, matchesExpectation: outcome === p.expect };
    });

    const timeRuns = (argv, withSandbox) => {
      const times = [];
      let okRuns = 0;
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const r = withSandbox ? sandboxed(profile, argv, project) : spawnSync(argv[0], argv.slice(1), { cwd: project, encoding: "utf8" });
        times.push(performance.now() - t0);
        if (r.status === 0) okRuns++;
      }
      return { runs, okRuns, medianMs: Number(median(times).toFixed(1)), maxMs: Number(Math.max(...times).toFixed(1)) };
    };
    const trueArgv = ["/usr/bin/true"];
    const statusArgv = ["/usr/bin/git", "status", "--porcelain"];

    const out = {
      platform: process.platform,
      macos: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
      sandboxExec: SANDBOX_EXEC,
      home,
      profile: "denylist (allow default; deny .ssh, .zshrc, .git/hooks writes, .git/config write)",
      probes: results,
      timing: {
        plain: timeRuns(trueArgv, false),
        denylist: timeRuns(trueArgv, true),
        gitStatusPlain: timeRuns(statusArgv, false),
        gitStatusDenylist: timeRuns(statusArgv, true),
      },
      allowlist: {
        status: "not-measured",
        reason:
          "A deny-default profile with process-exec, process-fork, file-map-executable, mach, sysctl and read grants on the system folders did not start /usr/bin/true: sandbox-exec refused the exec (exit 71), a broader variant aborted (exit 134). Its startup cost is unknown until a working profile is found.",
      },
      notMeasured: ["linux (landlock)", "windows (appcontainer, restricted token, job objects)"],
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
