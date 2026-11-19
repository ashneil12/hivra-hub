import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENTS_FLAG_MIN_VERSION,
  EXPLORE_LOOKUP_MS,
  EXPLORE_PIN_SENTENCE,
  addDirsOf,
  cheapExploreLaunch,
  exploreAgentsArg,
  exploreAgentsArgs,
  resetAgentsFlagCache,
  type ExploreLookup,
} from "./explorePin";

const free: ExploreLookup = async () => false;
/** A Claude Code that knows `--agents`, the way the app reads `--version`. */
const modern = { key: "claude", version: async () => "2.1.318 (Claude Code)" };

beforeEach(() => {
  resetAgentsFlagCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the cheap Explore agent is passed as a flag, not written as a file", () => {
  it("is one Explore agent on Haiku, with no Plan agent", () => {
    const parsed = JSON.parse(exploreAgentsArg()) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed)).toEqual(["Explore"]);
    expect(parsed.Explore.model).toBe("haiku");
    expect(typeof parsed.Explore.description).toBe("string");
    expect(String(parsed.Explore.prompt)).toMatch(/do not edit/i);
    expect(parsed.Explore.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(exploreAgentsArgs()).toEqual(["--agents", exploreAgentsArg()]);
  });
});

describe("cheapExploreLaunch decides per launch", () => {
  const base = { crew: true, anthropic: true, cwd: "/work/My Project", cli: modern };

  it("gives a crew session on Anthropic the flag, and says so", async () => {
    const lookup = vi.fn(free);
    const out = await cheapExploreLaunch({ ...base, lookup });
    expect(out.args).toEqual(["--agents", exploreAgentsArg()]);
    expect(out.sentence).toBe(EXPLORE_PIN_SENTENCE);
    expect(lookup).toHaveBeenCalledWith({ cwd: "/work/My Project", providerAccountId: undefined, addDirs: [] });
  });

  it("passes the provider account to the lookup, so that account's own agents are read", async () => {
    const lookup = vi.fn(free);
    await cheapExploreLaunch({ ...base, providerAccountId: "work", lookup });
    expect(lookup).toHaveBeenCalledWith({ cwd: "/work/My Project", providerAccountId: "work", addDirs: [] });
  });

  it("gives an ordinary chat nothing, and does not even look", async () => {
    const lookup = vi.fn(free);
    expect(await cheapExploreLaunch({ ...base, crew: false, lookup })).toEqual({ args: [] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("gives a session off Anthropic nothing", async () => {
    const lookup = vi.fn(free);
    expect(await cheapExploreLaunch({ ...base, anthropic: false, lookup })).toEqual({ args: [] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("never shadows an Explore the person already defined", async () => {
    expect(await cheapExploreLaunch({ ...base, lookup: async () => true })).toEqual({ args: [] });
  });

  it("a lookup that cannot answer is not proof that nothing is defined", async () => {
    const broken: ExploreLookup = async () => {
      throw new Error("denied");
    };
    expect(await cheapExploreLaunch({ ...base, lookup: broken })).toEqual({ args: [] });
    // Outside the app there is no lookup at all.
    expect(await cheapExploreLaunch(base)).toEqual({ args: [] });
  });

  it("a lookup that never answers does not hold the launch: it starts without the flag", async () => {
    vi.useFakeTimers();
    try {
      const hung: ExploreLookup = () => new Promise<boolean>(() => undefined);
      const pending = cheapExploreLaunch({ ...base, lookup: hung });
      await vi.advanceTimersByTimeAsync(EXPLORE_LOOKUP_MS + 1);
      expect(await pending).toEqual({ args: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a lookup that answers in time is used, and its timer does not linger", async () => {
    vi.useFakeTimers();
    try {
      const out = await cheapExploreLaunch({ ...base, lookup: free });
      expect(out.args).toEqual(["--agents", exploreAgentsArg()]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a remote, relative, empty or parent-segment folder is skipped without a lookup", async () => {
    const lookup = vi.fn(free);
    for (const cwd of ["remote://host/work", "work/proj", "", "  ", "/work/../etc"]) {
      expect(await cheapExploreLaunch({ ...base, cwd, lookup })).toEqual({ args: [] });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("accepts a Windows folder and a folder with spaces and unicode", async () => {
    const lookup = vi.fn(free);
    expect((await cheapExploreLaunch({ ...base, cwd: "C:\\Users\\Ash\\Projects\\proj", lookup })).args).toHaveLength(2);
    expect((await cheapExploreLaunch({ ...base, cwd: "/work/Ünï cødé proj", lookup })).args).toHaveLength(2);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe("the session's added folders are checked too", () => {
  const base = { crew: true, anthropic: true, cwd: "/work/My Project", cli: modern };

  it("hands the lookup every folder the session adds", async () => {
    const lookup = vi.fn(free);
    await cheapExploreLaunch({ ...base, addDirs: ["/work/shared", "../sibling"], lookup });
    expect(lookup).toHaveBeenCalledWith({
      cwd: "/work/My Project",
      providerAccountId: undefined,
      addDirs: ["/work/shared", "../sibling"],
    });
  });

  it("reads --add-dir out of the launch arguments, one folder or several, spaced or with =", () => {
    expect(addDirsOf(["--model", "x", "--add-dir", "/a", "--print"])).toEqual(["/a"]);
    expect(addDirsOf(["--add-dir", "/a", "/b c", "--verbose", "--add-dir=/d"])).toEqual(["/a", "/b c", "/d"]);
    expect(addDirsOf(["--add-dir"])).toEqual([]);
    expect(addDirsOf(["--model", "x"])).toEqual([]);
    expect(addDirsOf(["--add-dir", ""])).toEqual([]);
  });
});

describe("a Claude Code without --agents is never given it", () => {
  const base = { crew: true, anthropic: true, cwd: "/work/My Project" };
  const reading = (output: string) => ({ key: "claude", version: vi.fn(async () => output) });

  it("starts at the version that introduced the flag", () => {
    expect(AGENTS_FLAG_MIN_VERSION).toBe("2.0.0");
  });

  it("passes the flag from 2.0.0 on", async () => {
    for (const output of ["2.0.0 (Claude Code)", "2.1.318 (Claude Code)", "10.0.1", "claude 2.0.0"]) {
      resetAgentsFlagCache();
      const out = await cheapExploreLaunch({ ...base, cli: reading(output), lookup: free });
      expect(out.args, output).toEqual(["--agents", exploreAgentsArg()]);
    }
  });

  it("leaves the flag off for an older CLI, where an unknown option exits the process", async () => {
    for (const output of ["1.0.126 (Claude Code)", "1.99.99", "0.2.9"]) {
      resetAgentsFlagCache();
      expect(await cheapExploreLaunch({ ...base, cli: reading(output), lookup: free }), output).toEqual({ args: [] });
    }
  });

  it("leaves the flag off when the version can't be told: no output, a throw, no reader, a hang", async () => {
    expect(await cheapExploreLaunch({ ...base, cli: reading(""), lookup: free })).toEqual({ args: [] });
    expect(await cheapExploreLaunch({ ...base, cli: reading("not a version"), lookup: free })).toEqual({ args: [] });
    const broken = { key: "claude", version: async () => Promise.reject(new Error("spawn failed")) };
    expect(await cheapExploreLaunch({ ...base, cli: broken, lookup: free })).toEqual({ args: [] });
    expect(await cheapExploreLaunch({ ...base, lookup: free })).toEqual({ args: [] });

    vi.useFakeTimers();
    try {
      const hung = { key: "claude", version: () => new Promise<string>(() => undefined) };
      const pending = cheapExploreLaunch({ ...base, cli: hung, lookup: free });
      await vi.advanceTimersByTimeAsync(EXPLORE_LOOKUP_MS + 1);
      expect(await pending).toEqual({ args: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the version once per CLI, and never remembers an answer it did not get", async () => {
    const cli = reading("2.1.318 (Claude Code)");
    await cheapExploreLaunch({ ...base, cli, lookup: free });
    await cheapExploreLaunch({ ...base, cli, lookup: free });
    expect(cli.version).toHaveBeenCalledTimes(1);

    let calls = 0;
    const flaky = {
      key: "claude-flaky",
      version: async () => {
        calls += 1;
        if (calls === 1) throw new Error("not yet");
        return "2.1.318 (Claude Code)";
      },
    };
    expect(await cheapExploreLaunch({ ...base, cli: flaky, lookup: free })).toEqual({ args: [] });
    expect((await cheapExploreLaunch({ ...base, cli: flaky, lookup: free })).args).toHaveLength(2);
  });

  it("a different CLI path is read on its own", async () => {
    const old = { key: "/old/claude", version: async () => "1.0.126" };
    expect(await cheapExploreLaunch({ ...base, cli: old, lookup: free })).toEqual({ args: [] });
    expect((await cheapExploreLaunch({ ...base, cli: modern, lookup: free })).args).toHaveLength(2);
  });

  it("does not start the CLI when nothing would be passed anyway", async () => {
    const cli = reading("2.1.318");
    await cheapExploreLaunch({ ...base, crew: false, cli, lookup: free });
    await cheapExploreLaunch({ ...base, anthropic: false, cli, lookup: free });
    await cheapExploreLaunch({ ...base, cli, lookup: async () => true });
    expect(cli.version).not.toHaveBeenCalled();
  });
});
