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
    expect(argumentProblem("/opt/node", ["../secret"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["~/secret"])).not.toBeNull();
    expect(argumentProblem("/usr/bin/python3", ["-m", "x"])).not.toBeNull();
    expect(argumentProblem("/usr/bin/python3", ["-Bm", "x"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["-pe", "1"])).not.toBeNull();
    expect(argumentProblem("/usr/bin/python3", ["-m", "/abs/mod.py"])).toBeNull();
  });
});

// Review #231 r2 repro (MEDIUM, functional; mirror of review_231_r2_a_model_slug_with_a_slash_is_accepted in
// more_agents.rs): a model name with a slash reads as a relative path, so the entry is refused when it is added.
describe("review #231 r2: a provider/model name is not a path", () => {
  it("allows a model slug with a slash, with or without =", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/agent", ["--model", "openai/gpt-4.1"])).toBeNull();
    expect(argumentProblem("/opt/agent", ["--model=anthropic/claude-sonnet-4"])).toBeNull();
    expect(argumentProblem("/opt/agent", ["--model", "Qwen/Qwen2.5-Coder-32B-Instruct"])).toBeNull();
  });
});

// Review #231 r3 repro (MEDIUM, Windows; mirror of review_231_r3_a_rooted_or_drive_relative_windows_path_is_refused_or_pinned
// in more_agents.rs): a path with a root and no drive, or a drive-relative parent, is not absolute on Windows, so Rust
// neither refuses nor pins it. The entry check here lets it through as well. (A leading `/` is absolute on macOS, so
// the forward-slash form is left to the Rust check, review_231_r3_a_forward_slash_rooted_path_on_windows_is_refused_or_pinned.)
describe("review #231 r3: a Windows path that is not absolute is not a model name", () => {
  it("refuses a rooted path without a drive and a drive-relative parent", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/node", ["\\Users\\ash\\agent"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["--config=\\Users\\ash\\cfg"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["C:..\\agent"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["C:foo"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["--config=C:foo"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["/Users/ash/agent"], "win32")).not.toBeNull();
    expect(argumentProblem("/opt/node", ["/Users/ash/agent"], "darwin")).toBeNull();
  });

  it("refuses a parent or home path after @ and still allows a scoped package", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/npx", ["@../args.txt"])).not.toBeNull();
    expect(argumentProblem("/opt/npx", ["@~/args"])).not.toBeNull();
    expect(argumentProblem("/opt/npx", ["--opts=@../args"])).not.toBeNull();
    expect(argumentProblem("/opt/npx", ["-y", "@scope/pkg"])).toBeNull();
  });

  it("refuses a relative file after a colon flag", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/node", ["--config:../x"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["-p:../x"])).not.toBeNull();
    expect(argumentProblem("/opt/node", ["-IC:\\foo"], "win32")).toBeNull();
  });

  it("allows an escape and a model tag, and refuses a fullwidth rooted path", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/agent", ["--delimiter=\\t"])).toBeNull();
    expect(argumentProblem("/opt/agent", ["--model=o:latest"])).toBeNull();
    expect(argumentProblem("/opt/agent", ["o:stable"])).toBeNull();
    expect(argumentProblem("/opt/agent", ["x:nightly"])).toBeNull();
    expect(argumentProblem("/opt/agent", ["\\Users\\ash"])).not.toBeNull();
    expect(argumentProblem("/opt/agent", ["\\t\\secret"])).not.toBeNull();
    expect(argumentProblem("/opt/agent", ["C:foo"])).not.toBeNull();
    const fullwidth = `${String.fromCharCode(0xff3c)}Users${String.fromCharCode(0xff3c)}ash`;
    expect(argumentProblem("/opt/agent", [fullwidth])).not.toBeNull();
  });

  it("refuses a file URL that is not a local file, and allows one that is", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/deno", ["file:../x"])).not.toBeNull();
    expect(argumentProblem("/opt/deno", ["file://evil/x"])).not.toBeNull();
    expect(argumentProblem("/opt/deno", ["FILE:///tmp/agent.ts"])).toBeNull();
  });
});

// Review #241 r2 repro (MEDIUM). The window refuses what the app refuses, so the two relative shapes the app lets
// through are let through here too: a colon flag whose file is followed by `=options` (`-javaagent:../x.jar=opts`,
// `--config:../x=y`), and a plain `key=../x` word (`codex-acp -c key=value`, `--set key=value`).
describe("review #241 r2: a relative file inside a flag with options or a key=value word is refused", () => {
  it("refuses a relative file after a colon flag that also has =options", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/java", ["-javaagent:../x.jar=opts"])).not.toBeNull();
    expect(argumentProblem("/opt/tool", ["--config:../x=y"])).not.toBeNull();
  });

  it("refuses a relative file after key= in a plain word", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/codex-acp", ["-c", "instructions_file=../x"])).not.toBeNull();
  });
});

describe("a drive colon is only a drive on Windows", () => {
  it("refuses -IC:\\secret off Windows and allows -IC:\\foo on Windows", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/node", ["-IC:\\secret"], "other")).not.toBeNull();
    expect(argumentProblem("/opt/node", ["-IC:\\foo"], "win32")).toBeNull();
  });

  it("treats a drive path as absolute only on Windows", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/node", ["C:\\agent.mjs"], "other")).not.toBeNull();
    expect(argumentProblem("/opt/node", ["C:\\agent.mjs"], "win32")).toBeNull();
    expect(argumentProblem("/opt/node", ["--require", "C:\\plugin.js"], "other")).not.toBeNull();
    expect(argumentProblem("/opt/node", ["--require", "C:\\plugin.js"], "win32")).toBeNull();
  });
});

describe("fullwidth separators and Windows best-fit slashes", () => {
  it("folds a fullwidth equals or colon before the split, and refuses yen, won and the division slash", async () => {
    const { argumentProblem } = await import("./moreAgents");
    const eq = `key${String.fromCharCode(0xff1d)}../x`;
    const colon = `--config${String.fromCharCode(0xff1a)}../x`;
    const yen = `${String.fromCharCode(0x00a5)}Users${String.fromCharCode(0x00a5)}ash`;
    const slash = `/tmp${String.fromCharCode(0x2215)}secret`;
    expect(argumentProblem("/opt/node", [eq])).not.toBeNull();
    expect(argumentProblem("/opt/node", [colon])).not.toBeNull();
    expect(argumentProblem("/opt/node", [yen])).not.toBeNull();
    expect(argumentProblem("/opt/node", [slash])).not.toBeNull();
    const won = `${String.fromCharCode(0x20a9)}Users${String.fromCharCode(0x20a9)}ash`;
    expect(argumentProblem("/opt/node", [won])).not.toBeNull();
    expect(argumentProblem("/opt/node", [`key${String.fromCharCode(0xff1d)}hello`])).toBeNull();
  });
});

describe("a file URL is percent-decoded the way the app decodes it", () => {
  it("refuses a broken escape and allows a decoded local path, including one that decodes to ..", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/deno", ["file:///tmp/%zz"])).not.toBeNull();
    expect(argumentProblem("/opt/deno", ["file:///tmp/%"])).not.toBeNull();
    expect(argumentProblem("/opt/deno", ["file:///tmp/%ff"])).not.toBeNull();
    expect(argumentProblem("/opt/deno", ["file:///tmp/my%20agent.ts"])).toBeNull();
    expect(argumentProblem("/opt/deno", ["file:///%2e%2e/x"])).toBeNull();
    expect(argumentProblem("/opt/deno", ["file:///tmp/agent.ts?v=1"])).not.toBeNull();
    expect(argumentProblem("/opt/deno", ["file:///tmp/agent.ts#section"])).not.toBeNull();
  });
});

// Review #241 r3 repro (MEDIUM; mirrors of review_241_r3_a_path_holding_a_url_marker_is_pinned_or_refused and
// review_241_r3_a_file_after_key_equals_in_a_flag_value_is_pinned_or_refused in more_agents.rs). The window calls any
// value that holds `://` anywhere a URL, so a relative path with a `x://` run in it is allowed, and it looks at a flag
// value only up to its first `=`, so `--config=key=~/x` is allowed.
describe("review #241 r3: a relative file behind :// or inside a flag's key=value is refused", () => {
  it("refuses ../../x://agent.mjs and key=../x://y", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/node", ["../../../../../../tmp/x://agent.mjs"])).not.toBeNull();
    expect(argumentProblem("/opt/codex-acp", ["-c", "instructions_file=../../../../tmp/x://y"])).not.toBeNull();
  });

  it("refuses --config=key=~/x", async () => {
    const { argumentProblem } = await import("./moreAgents");
    expect(argumentProblem("/opt/codex-acp", ["--config=instructions_file=~/x"])).not.toBeNull();
  });
});
