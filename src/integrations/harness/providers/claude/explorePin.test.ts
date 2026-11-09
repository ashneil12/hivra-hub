import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXPLORE_PIN_FILE,
  EXPLORE_PIN_OTHER_SENTENCE,
  EXPLORE_PIN_SENTENCE,
  PLAN_PIN_FILE,
  type ExplorePinFile,
  type ExplorePinIo,
  ensureCheapExplorePin,
  exploreAgentFile,
  explorePinAllowed,
  explorePinModel,
} from "./explorePin";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `explore-pin-${name}-`));
  temps.push(dir);
  return dir;
}

/** A folder writer that creates a missing file once and never replaces one. */
function diskIo(): ExplorePinIo {
  return {
    async read(absolutePath) {
      try {
        return await readFile(absolutePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async create(cwd, files) {
      const root = path.resolve(cwd);
      const created: string[] = [];
      for (const file of files) {
        const absolute = path.resolve(cwd, file.relative);
        if (absolute !== path.join(root, file.relative)) {
          throw new Error("refused");
        }
        await mkdir(path.dirname(absolute), { recursive: true });
        try {
          await writeFile(absolute, file.content, { encoding: "utf8", flag: "wx" });
          created.push(file.relative);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
      }
      return created;
    },
  };
}

describe("the Explore agent file names a cheap model", () => {
  it("always has a plain model field, and Haiku when the session is on Anthropic", () => {
    expect(explorePinModel(undefined)).toBe("haiku");
    expect(explorePinModel("  ")).toBe("haiku");
    const text = exploreAgentFile("Explore", "haiku");
    expect(text).toContain("name: Explore");
    expect(text).toContain("model: haiku");
    expect(text).not.toMatch(/\r/);
    expect(text.split("\n").filter((line) => line.startsWith("model:")).length).toBe(1);
  });

  it("uses the worker's own model off Anthropic, and refuses an id that would break the file", () => {
    expect(explorePinModel("deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash");
    expect(exploreAgentFile("Plan", "deepseek-v4.1-flash")).toContain("model: deepseek-v4.1-flash");
    expect(exploreAgentFile("Plan", "deepseek-v4.1-flash")).toContain("name: Plan");
    expect(explorePinModel("haiku\nmodel: opus")).toBeUndefined();
    expect(explorePinModel("foo:bar")).toBeUndefined();
    expect(explorePinModel("../haiku")).toBeUndefined();
    expect(explorePinModel("model haiku")).toBeUndefined();
  });
});

describe("a fresh crew folder gets the pin, and an existing file is left alone", () => {
  it("creates Explore and Plan with Haiku, and says so", async () => {
    const cwd = await scratch("fresh");
    const result = await ensureCheapExplorePin({ cwd, io: diskIo() });
    const explore = await readFile(path.join(cwd, EXPLORE_PIN_FILE), "utf8");
    const plan = await readFile(path.join(cwd, PLAN_PIN_FILE), "utf8");
    expect(explore).toContain("model: haiku");
    expect(explore).toContain("name: Explore");
    expect(plan).toContain("model: haiku");
    expect(plan).toContain("name: Plan");
    expect(explore).not.toMatch(/\r/);
    expect(result.created).toEqual([EXPLORE_PIN_FILE, PLAN_PIN_FILE]);
    expect(result.sentence).toBe(EXPLORE_PIN_SENTENCE);
  });

  it("pins the worker model, not Haiku, when the session is off Anthropic", async () => {
    const cwd = path.join(await scratch("routed"), "my project", "café");
    await mkdir(cwd, { recursive: true });
    const result = await ensureCheapExplorePin({
      cwd,
      offAnthropicModel: "deepseek-v4.1-flash",
      io: diskIo(),
    });
    const explore = await readFile(path.join(cwd, EXPLORE_PIN_FILE), "utf8");
    expect(explore).toContain("model: deepseek-v4.1-flash");
    expect(explore).not.toMatch(/haiku/i);
    expect(result.sentence).toBe(EXPLORE_PIN_OTHER_SENTENCE);
  });

  it("does not replace a custom Explore, with or without a model line", async () => {
    const cwd = await scratch("custom");
    const agents = path.join(cwd, ".claude", "agents");
    await mkdir(agents, { recursive: true });
    const custom = "---\nname: Explore\nmodel: opus\n---\n\nAsh's own search.\n";
    const bare = "---\nname: Explore\n---\n\nNo model yet.\n";
    await writeFile(path.join(agents, "Explore.md"), custom);
    const withModel = await ensureCheapExplorePin({ cwd, io: diskIo() });
    expect(await readFile(path.join(agents, "Explore.md"), "utf8")).toBe(custom);
    expect(withModel.created).toEqual([PLAN_PIN_FILE]);
    expect(withModel.sentence).toBeUndefined();

    const other = await scratch("bare");
    const bareDir = path.join(other, ".claude", "agents");
    await mkdir(bareDir, { recursive: true });
    await writeFile(path.join(bareDir, "Explore.md"), bare);
    await writeFile(path.join(bareDir, "Plan.md"), "");
    const left = await ensureCheapExplorePin({ cwd: other, io: diskIo() });
    expect(await readFile(path.join(bareDir, "Explore.md"), "utf8")).toBe(bare);
    expect(await readFile(path.join(bareDir, "Plan.md"), "utf8")).toBe("");
    expect(left.created).toEqual([]);
    expect(left.sentence).toBeUndefined();
  });

  it("a second launch, and two launches at once, do not write the file twice", async () => {
    const cwd = await scratch("twice");
    const io = diskIo();
    const [first, second] = await Promise.all([
      ensureCheapExplorePin({ cwd, io }),
      ensureCheapExplorePin({ cwd, io }),
    ]);
    const explore = await readFile(path.join(cwd, EXPLORE_PIN_FILE), "utf8");
    expect(explore).toBe(exploreAgentFile("Explore", "haiku"));
    expect(explore.split("name: Explore").length).toBe(2);
    const again = await ensureCheapExplorePin({ cwd, io });
    expect(again.created).toEqual([]);
    expect(again.sentence).toBeUndefined();
    expect(await readFile(path.join(cwd, EXPLORE_PIN_FILE), "utf8")).toBe(explore);
    expect(first.created.length + second.created.length).toBeGreaterThan(0);
    const info = await stat(path.join(cwd, EXPLORE_PIN_FILE));
    expect(info.isFile()).toBe(true);
  });

  it("does not create a file when the read fails", async () => {
    const created: ExplorePinFile[] = [];
    const io: ExplorePinIo = {
      read: async () => {
        throw new Error("unreadable");
      },
      create: async (_cwd, files) => {
        created.push(...files);
        return files.map((file) => file.relative);
      },
    };
    const result = await ensureCheapExplorePin({ cwd: "/work/proj", io });
    expect(created).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.sentence).toBeUndefined();
  });

  it("does not claim a pin when the write reports nothing created", async () => {
    const io: ExplorePinIo = {
      read: async () => null,
      create: async () => [],
    };
    const result = await ensureCheapExplorePin({ cwd: "/work/proj", io });
    expect(result.sentence).toBeUndefined();
  });
});

describe("the pin never targets the user's Claude directory", () => {
  it("refuses a relative path, a parent segment, a remote folder, and anything under .claude", () => {
    expect(explorePinAllowed("proj")).toBe(false);
    expect(explorePinAllowed("")).toBe(false);
    expect(explorePinAllowed("/work/proj/../secret")).toBe(false);
    expect(explorePinAllowed("remote://box/work/proj")).toBe(false);
    expect(explorePinAllowed("/home/me/.claude")).toBe(false);
    expect(explorePinAllowed("/home/me/.claude/projects/app")).toBe(false);
    expect(explorePinAllowed("C:/Users/me/.claude/work")).toBe(false);
    expect(explorePinAllowed("/work/my project")).toBe(true);
    expect(explorePinAllowed("/work/proj", "/home/me")).toBe(true);
    expect(explorePinAllowed("/home/me", "/home/me")).toBe(false);
  });

  it("does not ask to write when the folder is the user's .claude directory", async () => {
    let writes = 0;
    const io: ExplorePinIo = {
      read: async () => null,
      create: async () => {
        writes += 1;
        return [EXPLORE_PIN_FILE];
      },
    };
    const home = "/home/me";
    for (const cwd of ["/home/me", "/home/me/.claude", "/home/me/.claude/projects/app", "/Home/Me/.claude"]) {
      const result = await ensureCheapExplorePin({ cwd, home, io });
      expect(result.created).toEqual([]);
    }
    expect(writes).toBe(0);
  });

  it("does not write a broken model id into the folder", async () => {
    let writes = 0;
    const io: ExplorePinIo = {
      read: async () => null,
      create: async () => {
        writes += 1;
        return [EXPLORE_PIN_FILE];
      },
    };
    const result = await ensureCheapExplorePin({
      cwd: "/work/proj",
      offAnthropicModel: "haiku\nmodel: opus",
      io,
    });
    expect(result.created).toEqual([]);
    expect(writes).toBe(0);
  });
});
