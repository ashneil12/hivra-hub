import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPath: vi.fn(),
  homeDir: vi.fn(),
  writeTextFile: vi.fn(),
  invalidateSkills: vi.fn(),
  invalidateProjectFiles: vi.fn(),
}));

vi.mock("../../../platform/tauri/fs", () => ({
  createPath: mocks.createPath,
  homeDir: mocks.homeDir,
  writeTextFile: mocks.writeTextFile,
}));

vi.mock("../../files/model/fileIndex", () => ({
  invalidateProjectFiles: mocks.invalidateProjectFiles,
}));

vi.mock("./skills", () => ({ invalidateSkills: mocks.invalidateSkills }));

import type { DiscoveredSkill } from "../../../platform/tauri/fs";
import {
  READY_SKILLS,
  installReadySkill,
  readySkillInstalled,
} from "./readySkills";

const discovered = (name: string, path = `/home/.agents/skills/${name}/SKILL.md`): DiscoveredSkill => ({
  name,
  description: `${name} does things`,
  path,
  source: "agents",
  scope: "user",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.homeDir.mockResolvedValue("/home");
  mocks.createPath.mockResolvedValue("/home/.agents/skills/find-components");
  mocks.writeTextFile.mockResolvedValue(undefined);
});

describe("the ready-made skills", () => {
  it("are real SKILL.md files the scanner can pick up", () => {
    expect(READY_SKILLS.length).toBeGreaterThan(0);
    for (const ready of READY_SKILLS) {
      const match = /^---\n([\s\S]*?)\n---\n/.exec(ready.markdown);
      expect(match, `${ready.id} has no frontmatter`).not.toBeNull();
      const front = match![1];
      // skills.rs reads the frontmatter's `name` and filters on a non-empty description.
      expect(front).toContain(`name: ${ready.name}`);
      expect(front).toMatch(/^description: \S/m);
      expect(ready.id).toBe(ready.name);
      expect(ready.title.length).toBeGreaterThan(0);
      expect(ready.what.length).toBeGreaterThan(0);
    }
  });
});

describe("readySkillInstalled", () => {
  it("is true when a skill of the same name is already on disk, in any scope", () => {
    expect(readySkillInstalled([discovered("find-components")], "find-components")).toBe(true);
    expect(
      readySkillInstalled(
        [discovered("other"), discovered("find-components", "/repo/.agents/skills/find-components/SKILL.md")],
        "find-components",
      ),
    ).toBe(true);
  });

  it("is false when it is missing, or when the id isn't a ready-made one", () => {
    expect(readySkillInstalled([], "find-components")).toBe(false);
    expect(readySkillInstalled([discovered("other")], "find-components")).toBe(false);
    expect(readySkillInstalled([discovered("find-components")], "no-such-skill")).toBe(false);
  });
});

describe("installReadySkill", () => {
  it("writes the catalog's markdown to ~/.agents/skills/<name>/SKILL.md, so every project gets it", async () => {
    const ready = READY_SKILLS[0];
    const path = await installReadySkill({ cwd: "/repo", id: ready.id });

    expect(mocks.homeDir).toHaveBeenCalled();
    expect(mocks.createPath).toHaveBeenCalledWith("/home", `.agents/skills/${ready.name}`, true);
    expect(path).toBe(`/home/.agents/skills/${ready.name}/SKILL.md`);
    expect(mocks.writeTextFile).toHaveBeenCalledWith(path, ready.markdown);
    expect(mocks.invalidateSkills).toHaveBeenCalledWith({ cwd: "/repo" });
    expect(mocks.invalidateProjectFiles).toHaveBeenCalledWith("/repo");
  });

  it("turns down an id that isn't one of the ready-made skills, before touching the disk", async () => {
    await expect(installReadySkill({ cwd: "/repo", id: "no-such-skill" })).rejects.toThrow(
      "That skill isn't one of the ready-made ones.",
    );
    expect(mocks.createPath).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });
});
