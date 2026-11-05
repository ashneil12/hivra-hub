import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseArgs, skillFile } from "./rpi-phase-prompt.mjs";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const script = join(here, "scripts/rpi-phase-prompt.mjs");
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "rpi-phase-"));
  dirs.push(dir);
  return dir;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("skillFile", () => {
  it("stays inside the repository, including a path with spaces, unicode and dot-dot", () => {
    const root = join(scratch(), "répo phase");
    const skill = join(root, "src-tauri/plugins/hivra-rpi/skills/research");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "body\n");
    mkdirSync(join(root, "nested"));
    const via = join(root, "nested", "..");
    const found = skillFile(via, "research");
    assert.equal(found, realpathSync(join(skill, "SKILL.md")));
    assert.equal(skillFile(root, "../research"), undefined);
    assert.equal(skillFile(root, "research/../../package"), undefined);
    assert.equal(skillFile(join(root, "missing"), "research"), undefined);
  });

  it("refuses a skill file that points outside the repository", () => {
    const root = scratch();
    const skill = join(root, "src-tauri/plugins/hivra-rpi/skills/research");
    mkdirSync(skill, { recursive: true });
    const outside = join(scratch(), "secret.md");
    writeFileSync(outside, "nope\n");
    symlinkSync(outside, join(skill, "SKILL.md"));
    assert.equal(skillFile(root, "research"), undefined);
  });
});

describe("the phase prompt script", () => {
  it("prints the research prompt and nothing else", () => {
    const task = "The save drops the last line — café.";
    const result = run(["--phase", "research", "--task", task, "--repo", here]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Hivra runs this phase\./);
    assert.ok(result.stdout.includes("There is no artifact directory"));
    assert.ok(result.stdout.includes("Never wait for the user."));
    assert.ok(result.stdout.includes("The reply is the document."));
    assert.ok(result.stdout.includes(task));
    assert.ok(result.stdout.includes(realpathSync(here)));
    assert.ok(result.stdout.includes("You are creating a technical map/documentation of the existing system"));
    const rules = result.stdout.indexOf("Never wait for the user.");
    const stall = result.stdout.indexOf("Please provide your research question");
    assert.ok(rules >= 0 && stall > rules);
    assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("Skill:")).length, 1);
  });

  it("accepts the phase, the task and the repository as three words", () => {
    const result = run(["design", "Draw the save.", here]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Skill: design-discussion/);
    assert.ok(result.stdout.includes("Task: Draw the save."));
  });

  it("prints nothing when the phase, the task or the repository is unusable", () => {
    for (const args of [
      [],
      ["--phase", "research"],
      ["--phase", "../research", "--task", "A task", "--repo", here],
      ["--phase", "not-a-skill", "--task", "A task", "--repo", here],
      ["--phase", "research", "--task", "   ", "--repo", here],
      ["--phase", "research", "--task", "A task", "--repo", join(here, "no-such-repo")],
      ["research", "A task"],
    ]) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
      assert.match(result.stderr, /\S/);
    }
  });
});

describe("parseArgs", () => {
  it("reads flags and three words, and refuses a blank task", () => {
    assert.deepEqual(parseArgs(["node", "script", "--phase", "research", "--task", "A task", "--repo", "/tmp/repo"]), {
      phase: "research",
      task: "A task",
      repo: "/tmp/repo",
    });
    assert.equal(parseArgs(["node", "script", "research", "A task", "/tmp/repo"])?.task, "A task");
    assert.equal(parseArgs(["node", "script", "--phase", "research", "--task", "   ", "--repo", "/tmp/repo"]), undefined);
    assert.equal(parseArgs(["node", "script", "--nope"]), undefined);
  });
});
