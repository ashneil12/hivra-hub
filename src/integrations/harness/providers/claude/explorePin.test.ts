import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXPLORE_LOOKUP_MS,
  EXPLORE_PIN_SENTENCE,
  cheapExploreLaunch,
  exploreAgentsArg,
  exploreAgentsArgs,
  type ExploreLookup,
} from "./explorePin";

const free: ExploreLookup = async () => false;

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
  const base = { crew: true, anthropic: true, cwd: "/work/My Project" };

  it("gives a crew session on Anthropic the flag, and says so", async () => {
    const lookup = vi.fn(free);
    const out = await cheapExploreLaunch({ ...base, lookup });
    expect(out.args).toEqual(["--agents", exploreAgentsArg()]);
    expect(out.sentence).toBe(EXPLORE_PIN_SENTENCE);
    expect(lookup).toHaveBeenCalledWith({ cwd: "/work/My Project", providerAccountId: undefined });
  });

  it("passes the provider account to the lookup, so that account's own agents are read", async () => {
    const lookup = vi.fn(free);
    await cheapExploreLaunch({ ...base, providerAccountId: "work", lookup });
    expect(lookup).toHaveBeenCalledWith({ cwd: "/work/My Project", providerAccountId: "work" });
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
