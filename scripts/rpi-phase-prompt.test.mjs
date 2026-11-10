import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findRecord, isTaskRecord, parseArgs, skillFile } from "./rpi-phase-prompt.mjs";

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

function file(body, name = "tasks.json") {
  const path = join(scratch(), name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

const TASK = {
  id: "task-save",
  title: "Fix the save",
  description: "The save drops the last line.",
};

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

describe("task records", () => {
  it("takes one record, a list of them, or a map by id", () => {
    assert.equal(isTaskRecord(TASK), true);
    assert.equal(isTaskRecord({ id: "t", title: "T" }), false);
    assert.equal(isTaskRecord({ id: "t", title: "T", description: 3 }), false);
    assert.equal(isTaskRecord({ id: "  ", title: "T", description: "D" }), false);
    assert.equal(isTaskRecord([TASK]), false);
    assert.equal(isTaskRecord(null), false);
    assert.deepEqual(findRecord(TASK, "task-save"), TASK);
    assert.equal(findRecord(TASK, "other"), undefined);
    assert.deepEqual(findRecord([{ id: "a", title: "A", description: "" }, TASK], "task-save"), TASK);
    assert.deepEqual(findRecord({ tasks: [TASK] }, "task-save"), TASK);
    assert.deepEqual(findRecord({ "task-save": { title: "Mapped", description: "By key." } }, "task-save"), {
      id: "task-save",
      title: "Mapped",
      description: "By key.",
    });
    assert.equal(findRecord([], "task-save"), undefined);
    assert.equal(findRecord([TASK], "  "), undefined);
  });

  it("takes the first of two records with the same id and ignores a broken one", () => {
    const first = { id: "dup", title: "First", description: "" };
    const second = { id: "dup", title: "Second", description: "" };
    assert.deepEqual(findRecord([first, second], "dup"), first);
    assert.deepEqual(findRecord([{ id: "dup", title: 7 }, first], "dup"), first);
  });
});

describe("the phase prompt script", () => {
  it("prints the research prompt from a real task record, with its title and description", () => {
    const record = file({ ...TASK, description: "The save drops the last line — café.\r\nAnd the blank one." }, "task.json");
    const result = run(["--phase", "research", "--record", record, "--repo", here]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Hivra runs this phase\./);
    assert.ok(result.stdout.includes("There is no artifact directory"));
    assert.ok(result.stdout.includes("Never wait for the user."));
    assert.ok(result.stdout.includes("The reply is the document."));
    assert.ok(result.stdout.includes("Task: task-save"));
    assert.ok(result.stdout.includes("Title: Fix the save"));
    assert.ok(result.stdout.includes("The save drops the last line — café."));
    assert.ok(!result.stdout.includes("\r"));
    assert.ok(result.stdout.includes(realpathSync(here)));
    assert.ok(result.stdout.includes("You are creating a technical map/documentation of the existing system"));
    const rules = result.stdout.indexOf("Never wait for the user.");
    const stall = result.stdout.indexOf("Please provide your research question");
    assert.ok(rules >= 0 && stall > rules);
    assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("Skill:")).length, 1);
  });

  it("finds the task id in a fixture store, and the outline uses the structure outline skill", () => {
    const store = file([{ id: "other", title: "Other", description: "No." }, TASK]);
    const result = run(["--phase", "outline", "--task", "task-save", "--tasks", store, "--repo", here]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Skill: create-structure-outline/);
    assert.ok(result.stdout.includes("Task: task-save"));
    assert.ok(result.stdout.includes("The save drops the last line."));
    const mapped = run(["--phase", "outline", "--task", "task-save", "--tasks", file({ "task-save": TASK }), "--repo", here]);
    assert.equal(mapped.status, 0);
    assert.ok(mapped.stdout.includes("Title: Fix the save"));
  });

  it("uses a task file whose folder has spaces and unicode", () => {
    const folder = join(scratch(), "tasks phase — ünï");
    mkdirSync(folder);
    const record = join(folder, "one task.json");
    writeFileSync(record, JSON.stringify(TASK));
    const result = run(["--phase", "design", "--record", record, "--repo", here]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Skill: design-discussion/);
    assert.ok(result.stdout.includes("Title: Fix the save"));
  });

  it("names the project, not the repository, when the two folders differ", () => {
    const project = join(scratch(), "projet — ünï");
    mkdirSync(project);
    const record = file(TASK, "task.json");
    const result = run(["--phase", "research", "--record", record, "--repo", here, "--project", project]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.includes(`The code is in ${realpathSync(project)}.`));
    assert.ok(!result.stdout.includes(`The code is in ${realpathSync(here)}.`));
    assert.ok(result.stdout.includes("Title: Fix the save"));
    const link = join(scratch(), "project-link");
    symlinkSync(project, link);
    const viaLink = run(["--phase", "research", "--record", record, "--repo", here, "--project", link]);
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.ok(viaLink.stdout.includes(`The code is in ${realpathSync(project)}.`));
  });

  it("refuses a project that is missing, is a file, or is a link to a file", () => {
    const record = file(TASK, "one.json");
    const notFolder = file("x", "plain.txt");
    const link = join(scratch(), "link");
    symlinkSync(notFolder, link);
    const cases = [
      ["--phase", "research", "--record", record, "--repo", here, "--project", join(here, "no-such-project")],
      ["--phase", "research", "--record", record, "--repo", here, "--project", notFolder],
      ["--phase", "research", "--record", record, "--repo", here, "--project", link],
    ];
    for (const args of cases) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
      assert.match(result.stderr, /^That project is not a folder\.\n$/, args.join(" "));
    }
  });

  it("uses the repository as the project when no project is given", () => {
    const record = file(TASK, "task.json");
    for (const extra of [[], ["--project", ""]]) {
      const result = run(["--phase", "research", "--record", record, "--repo", here, ...extra]);
      assert.equal(result.status, 0);
      assert.ok(result.stdout.includes(`The code is in ${realpathSync(here)}.`));
    }
  });

  it("prints nothing when the phase, the record or the repository is unusable", () => {
    const store = file([TASK]);
    const record = file(TASK, "one.json");
    const cases = [
      [],
      ["--phase", "research", "--repo", here],
      ["--phase", "research", "--task", "task-save", "--repo", here],
      ["--phase", "../research", "--record", record, "--repo", here],
      ["--phase", "not-a-skill", "--record", record, "--repo", here],
      ["--phase", "research", "--record", record, "--repo", join(here, "no-such-repo")],
      ["--phase", "research", "--task", "   ", "--tasks", store, "--repo", here],
      ["--phase", "research", "--task", "missing", "--tasks", store, "--repo", here],
      ["--phase", "research", "--record", store, "--repo", here],
      ["--phase", "research", "--record", record, "--tasks", store, "--repo", here],
      ["research", "task-save", here],
      ["--phase", "research", "--task", "task-save", "--tasks", join(here, "no-such-file.json"), "--repo", here],
      ["--phase", "research", "--task", "task-save", "--tasks", file("{not json"), "--repo", here],
      ["--phase", "research", "--task", "task-save", "--tasks", file({ id: "task-save", title: 3, description: "x" }), "--repo", here],
      ["--phase", "research", "--record", file({ id: "task-save", title: "No description" }), "--repo", here],
    ];
    for (const args of cases) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
      assert.match(result.stderr, /\S/, args.join(" "));
    }
  });
});

describe("parseArgs", () => {
  it("reads flags and refuses free text, a blank id and a record combined with a store", () => {
    assert.deepEqual(
      parseArgs(["node", "script", "--phase", "research", "--task", "task-1", "--tasks", "/tmp/tasks.json", "--repo", "/tmp/repo"]),
      { phase: "research", task: "task-1", tasks: "/tmp/tasks.json", record: "", repo: "/tmp/repo", project: "/tmp/repo" },
    );
    assert.deepEqual(
      parseArgs([
        "node",
        "script",
        "--phase",
        "research",
        "--record",
        "/tmp/task.json",
        "--repo",
        "/tmp/repo",
        "--project",
        "/tmp/project",
      ]),
      { phase: "research", task: "", tasks: "", record: "/tmp/task.json", repo: "/tmp/repo", project: "/tmp/project" },
    );
    assert.deepEqual(parseArgs(["node", "script", "--phase", "research", "--record", "/tmp/task.json", "--repo", "/tmp/repo"]), {
      phase: "research",
      task: "",
      tasks: "",
      record: "/tmp/task.json",
      repo: "/tmp/repo",
      project: "/tmp/repo",
    });
    // A repeated flag keeps the last value, like every other flag.
    assert.equal(
      parseArgs(["node", "script", "--phase", "research", "--record", "/tmp/t.json", "--repo", "/tmp/repo", "--project", "/tmp/a", "--project", "/tmp/b"])
        .project,
      "/tmp/b",
    );
    assert.equal(parseArgs(["node", "script", "--phase", "research", "--record", "/tmp/t.json", "--tasks", "/tmp/s.json", "--repo", "/tmp/repo"]), undefined);
    assert.equal(parseArgs(["node", "script", "--phase", "research", "--task", "   ", "--tasks", "/tmp/s.json", "--repo", "/tmp/repo"]), undefined);
    assert.equal(parseArgs(["node", "script", "research", "task-1", "/tmp/repo"]), undefined);
    assert.equal(parseArgs(["node", "script", "--nope"]), undefined);
  });
});
