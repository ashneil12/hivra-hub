import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const listeners = vi.hoisted(() => new Map<string, (event: unknown) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: unknown) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

const {
  FIRST_CLASS_COMMANDS,
  MORE_AGENT_COPY,
  MoreAgentsChangedError,
  addMoreAgent,
  approveMoreAgent,
  argsFromLines,
  loadMoreAgents,
  newMoreAgentEntry,
  parseMoreAgentEntry,
  parseMoreAgentRows,
  removeMoreAgent,
  suggestMoreAgentId,
} = await import("./moreAgents");
const { HARNESSES } = await import("../../sessions/model/session");

const good = {
  id: "copilot",
  name: "Copilot CLI",
  command: "/usr/local/bin/copilot",
  args: ["--acp"],
  protocol: "acp-v1",
};

beforeEach(() => invoke.mockReset());

describe("More agents entries", () => {
  it("reads a good entry and ignores unknown fields", () => {
    const parsed = parseMoreAgentEntry({ ...good, colour: "red", abilities: { cancel: true, steer: "yes" } });
    expect(parsed).toEqual({
      ok: true,
      entry: { ...good, abilities: { cancel: true } },
    });
  });

  it("refuses every one of the eleven ids, so a registry agent is never a twelfth CLI", () => {
    for (const id of HARNESSES) {
      const parsed = parseMoreAgentEntry({ ...good, id });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe(MORE_AGENT_COPY.firstClass);
    }
  });

  it("refuses a command that is one of the eleven CLIs", () => {
    for (const command of ["claude", "/opt/homebrew/bin/codex", "C:\\tools\\devin.exe"]) {
      const parsed = parseMoreAgentEntry({ ...good, command });
      expect(parsed.ok).toBe(false);
    }
    expect(FIRST_CLASS_COMMANDS).toContain("cursor-agent");
  });

  it("runs acp-v1 only and keeps the arguments as literal words", () => {
    expect(parseMoreAgentEntry({ ...good, protocol: "acp-v2" }).ok).toBe(false);
    expect(parseMoreAgentEntry({ ...good, protocol: undefined }).ok).toBe(false);
    expect(parseMoreAgentEntry({ ...good, args: "--acp --verbose" }).ok).toBe(false);
    const parsed = parseMoreAgentEntry({ ...good, args: ["$HOME", "a b"] });
    expect(parsed.ok && parsed.entry.args).toEqual(["$HOME", "a b"]);
    // "~/x" is not expanded by anything that starts the agent, so it names a relative path and is refused.
    expect(parseMoreAgentEntry({ ...good, args: ["~/x"] }).ok).toBe(false);
  });

  it("refuses ids that are not plain slugs and commands that are not one line", () => {
    expect(parseMoreAgentEntry({ ...good, id: "Copilot" }).ok).toBe(false);
    expect(parseMoreAgentEntry({ ...good, id: "" }).ok).toBe(false);
    expect(parseMoreAgentEntry({ ...good, command: "copilot\nrm -rf /" }).ok).toBe(false);
    expect(parseMoreAgentEntry({ ...good, name: "" }).ok).toBe(false);
    expect(parseMoreAgentEntry(null).ok).toBe(false);
    expect(parseMoreAgentEntry([good]).ok).toBe(false);
  });

  it("keeps a bad entry as unusable and still loads the rest", () => {
    const rows = parseMoreAgentRows([good, { id: "broken" }, "nonsense", { ...good, name: "Again" }, { ...good, id: "other" }]);
    expect(rows.map((row) => row.usable)).toEqual([true, false, false, false, true]);
    expect(rows[1]).toMatchObject({ usable: false, id: "broken" });
    expect(rows[3]).toMatchObject({ usable: false, reason: "Another agent above already uses this id." });
    expect(parseMoreAgentRows("not a list")).toEqual([]);
  });

  it("builds an entry from the form, one argument per line", () => {
    expect(argsFromLines("--acp\n\n  --stdio  \r\n")).toEqual(["--acp", "  --stdio  "]);
    expect(newMoreAgentEntry({ id: "my-agent", name: "My agent", command: "my-agent", argsText: "acp" })).toEqual({
      ok: true,
      entry: { id: "my-agent", name: "My agent", command: "my-agent", args: ["acp"], protocol: "acp-v1", abilities: {} },
    });
    expect(suggestMoreAgentId("GitHub Copilot CLI!")).toBe("github-copilot-cli");
  });

  it("has no em or en dash in anything a person reads", () => {
    for (const text of Object.values(MORE_AGENT_COPY)) expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("More agents list writes", () => {
  it("writes on top of the revision it read, keeping bad entries untouched", async () => {
    invoke.mockResolvedValueOnce({ revision: 3, agents: [good, { id: "broken" }] });
    const list = await loadMoreAgents();
    expect(list.revision).toBe(3);
    invoke.mockImplementationOnce(async (_command: string, args: { expectedRevision: number; agents: unknown[] }) => ({
      revision: args.expectedRevision + 1,
      agents: args.agents,
    }));
    const entry = newMoreAgentEntry({ id: "second", name: "Second", command: "second-agent", argsText: "" });
    if (!entry.ok) throw new Error(entry.reason);
    const next = await addMoreAgent(list, entry.entry);
    expect(invoke).toHaveBeenLastCalledWith("more_agents_write", {
      expectedRevision: 3,
      agents: [good, { id: "broken" }, { id: "second", name: "Second", command: "second-agent", args: [], protocol: "acp-v1" }],
    });
    expect(next.revision).toBe(4);
    expect(next.rows).toHaveLength(3);
  });

  it("refuses to add an id already in the list, even a broken one", async () => {
    invoke.mockResolvedValueOnce({ revision: 1, agents: [{ id: "broken" }] });
    const list = await loadMoreAgents();
    await expect(
      addMoreAgent(list, { ...good, id: "broken", abilities: {}, protocol: "acp-v1" }),
    ).rejects.toThrow("already in the list");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("says the list changed elsewhere when the revision is stale", async () => {
    invoke.mockResolvedValueOnce({ revision: 1, agents: [good] });
    const list = await loadMoreAgents();
    invoke.mockRejectedValueOnce("stale revision: the list is at 2");
    await expect(removeMoreAgent(list, 0)).rejects.toBeInstanceOf(MoreAgentsChangedError);
  });

  it("removes only the row asked for", async () => {
    invoke.mockResolvedValueOnce({ revision: 5, agents: [good, { id: "broken" }] });
    const list = await loadMoreAgents();
    invoke.mockResolvedValueOnce({ revision: 6, agents: [{ id: "broken" }] });
    await removeMoreAgent(list, 0);
    expect(invoke).toHaveBeenLastCalledWith("more_agents_write", { expectedRevision: 5, agents: [{ id: "broken" }] });
  });
});

describe("More agents approvals", () => {
  it("says which entries the app has approved to run", async () => {
    invoke.mockResolvedValueOnce({ revision: 2, agents: [good], approved: ["copilot"] });
    const list = await loadMoreAgents();
    expect(list.approved).toEqual(["copilot"]);
  });

  it("treats a missing approval list as nothing approved", async () => {
    invoke.mockResolvedValueOnce({ revision: 2, agents: [good] });
    const list = await loadMoreAgents();
    expect(list.approved).toEqual([]);
  });

  it("asks the app to record or withdraw one entry's approval, and reads the list back", async () => {
    invoke.mockResolvedValueOnce({ revision: 2, agents: [good], approved: ["copilot"] });
    const list = await approveMoreAgent("copilot", true);
    expect(invoke).toHaveBeenLastCalledWith("more_agents_approve", { id: "copilot", allowed: true, shown: null });
    expect(list.approved).toEqual(["copilot"]);
  });
});

describe("a change made in another window reaches this window", () => {
  it("re-reads the list when the app announces a change, so a withdrawn run stops here too", async () => {
    const { subscribeMoreAgentsChanges } = await import("./moreAgents");
    const onChange = vi.fn();
    const stop = await subscribeMoreAgentsChanges(onChange);
    expect(listeners.has("more-agents-changed")).toBe(true);
    listeners.get("more-agents-changed")?.({});
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });
});


describe("argument rules match the app", () => {
  it("allows versions, dotted values, addresses and ordinary flags", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/npx", ["some-acp-agent@1.2.3", "--acp"])).toBeNull();
    expect(argumentProblem("/opt/agent", ["--model=gpt-4.1"])).toBeNull();
    expect(argumentProblem("/opt/agent", ["--host", "127.0.0.1"])).toBeNull();
    expect(argumentProblem("/opt/uvx", ["agent==0.3.1"])).toBeNull();
    expect(argumentProblem("/opt/claude", ["-m", "sonnet"])).toBeNull();
    expect(argumentProblem("/opt/agent", ["-mode", "fast"])).toBeNull();
  });

  it("refuses a relative file, an inline program and a loader that names no absolute file", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/node", ["agent.mjs"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["--env-file=.env"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["-r", "./x"])).not.toBeNull();
    expect(argumentProblem("/usr/bin/python3", ["-m", "x"])).not.toBeNull();
    expect(argumentProblem("/usr/bin/python3", ["-Bm", "x"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["-pe", "1"])).not.toBeNull();
    expect(argumentProblem("/usr/bin/python3", ["-m", "/abs/mod.py"])).toBeNull();
  });
});
