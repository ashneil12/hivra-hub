import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPluginCommands: vi.fn(),
  listSkills: vi.fn(),
  discoverPi: vi.fn(),
}));

vi.mock("./pluginCommands", () => ({
  listPluginCommands: mocks.listPluginCommands,
}));

vi.mock("../../../integrations/harness/core/registry", () => ({
  getHarness: (id: string) =>
    id === "pi" ? { commands: { discover: mocks.discoverPi } } : undefined,
}));

vi.mock("../../../platform/tauri/fs", () => ({
  createPath: vi.fn(),
  homeDir: vi.fn(),
  listSkills: mocks.listSkills,
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

import { invalidateSkills, loadSkills } from "./skills";

beforeEach(() => {
  invalidateSkills();
  mocks.listPluginCommands.mockReset();
  mocks.listSkills.mockReset();
  mocks.discoverPi.mockReset();
  mocks.listSkills.mockResolvedValue([]);
  mocks.discoverPi.mockResolvedValue([]);
});

describe("plugin commands in the catalog", () => {
  it("offers a plugin command on Claude and Codex, and keeps a harness command when the names differ", async () => {
    mocks.listPluginCommands.mockResolvedValue([
      { name: "ship-it", description: "Ship", file: "hivra/commands/ship-it.md" },
      { name: "nope", description: 4, file: "hivra/commands/nope.md" },
    ]);
    const claude = await loadSkills({ harness: "claude", cwd: "/work/hivra" });
    expect(claude.find((skill) => skill.name === "ship-it")?.kind).toBe("native");
    expect(claude.some((skill) => skill.name === "nope")).toBe(false);
    const codex = await loadSkills({ harness: "codex", cwd: "/work/hivra" });
    expect(codex.find((skill) => skill.name === "ship-it")?.kind).toBe("native");
  });

  it("keeps the harness command when a plugin reuses its name", async () => {
    mocks.discoverPi.mockResolvedValue([
      { name: "ship", description: "From pi", invocation: "ship", source: "pi" },
    ]);
    mocks.listPluginCommands.mockResolvedValue([
      { name: "ship", description: "From a plugin", file: "hivra/commands/ship.md" },
      { name: "extra", description: "Extra", file: "hivra/commands/extra.md" },
    ]);
    const skills = await loadSkills({ harness: "pi", cwd: "/work/pi" });
    const ship = skills.find((skill) => skill.name === "ship");
    expect(ship?.description).toBe("From pi");
    expect(skills.find((skill) => skill.name === "extra")?.kind).toBe("native");
  });
});
